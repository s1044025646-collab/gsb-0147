import type {
  BottleneckSchedule,
  DemandInterval,
  RampMeterSchedule,
  RoadParams,
  RunOverrides,
  SimResult,
  StepRecord,
} from "./types.js";
import { EPS, deriveFd, receiving, sending, validateRoad } from "./fd.js";
import { normalizeIntervals } from "./generator.js";

/** Allocate limited downstream supply R between two merge suppliers. */
export function allocateMerge(demandMain: number, demandRamp: number, supply: number, priority: number) {
  const dM = Math.max(0, demandMain);
  const dR = Math.max(0, demandRamp);
  const R = Math.max(0, supply);
  // Guaranteed priority shares (only bind when supply is short).
  let xM = Math.min(dM, R * priority);
  let xR = Math.min(dR, R * (1 - priority));
  // Spare capacity (either side under-used its share) goes to unsatisfied
  // demand of either side, so no usable share is wasted.
  let spare = R - xM - xR;
  if (spare > EPS) {
    const remM = dM - xM;
    const remR = dR - xR;
    const rem = remM + remR;
    if (rem <= spare + EPS) {
      xM += remM;
      xR += remR;
      spare = 0;
    } else if (rem > EPS) {
      xM += spare * (remM / rem);
      xR += spare * (remR / rem);
      spare = 0;
    }
  }
  // Guard against floating-point overshoot.
  if (xM + xR > R + 1e-6) {
    const scale = R / (xM + xR);
    xM *= scale;
    xR *= scale;
  }
  return { main: xM, ramp: xR };
}

function activeFactor(schedules: BottleneckSchedule[] | undefined, cell: number, t: number): number {
  let factor = 1;
  if (schedules) {
    for (const s of schedules) {
      if (s.cell === cell && t >= s.tStart && t < s.tEnd) factor = Math.min(factor, s.factor);
    }
  }
  return factor;
}

function activeMeter(schedules: RampMeterSchedule[] | undefined, t: number): number {
  let rate = Infinity;
  if (schedules) {
    for (const s of schedules) {
      if (t >= s.tStart && t < s.tEnd) rate = Math.min(rate, s.rate);
    }
  }
  return rate;
}

function validateOverrides(road: RoadParams, o: RunOverrides): void {
  for (const b of o.bottlenecks ?? []) {
    if (!Number.isInteger(b.cell) || b.cell < 0 || b.cell >= road.cellCount) {
      const e = new Error("bottleneck cell out of range");
      (e as Error & { code?: string }).code = "BAD_OVERRIDE";
      throw e;
    }
    if (!(b.factor >= 0 && b.factor <= 1)) {
      const e = new Error("bottleneck factor must be in [0,1] (0 = full blockage)");
      (e as Error & { code?: string }).code = "BAD_OVERRIDE";
      throw e;
    }
    if (b.tEnd <= b.tStart || b.tStart < 0 || b.tEnd > road.horizonSteps) {
      const e = new Error("bottleneck interval must lie within [0,horizonSteps)");
      (e as Error & { code?: string }).code = "BAD_OVERRIDE";
      throw e;
    }
  }
  for (const m of o.rampMeters ?? []) {
    if (m.rate < 0 || m.tEnd <= m.tStart || m.tStart < 0 || m.tEnd > road.horizonSteps) {
      const e = new Error("ramp meter interval/rate invalid");
      (e as Error & { code?: string }).code = "BAD_OVERRIDE";
      throw e;
    }
  }
}

export interface SimulateOptions {
  overrides?: RunOverrides;
  /** Initial vehicle counts per cell (defaults to empty road). */
  initialCounts?: number[];
}

/**
 * Run the triangular-fundamental-diagram cell transmission model.
 *
 * Every flow in step t is derived from the counts/queues at the END of t-1
 * (the "old" state). All new counts are written into a fresh array, so a cell
 * can never consume a value another cell produced during the same step.
 */
export function simulate(
  road: RoadParams,
  demand: DemandInterval[],
  opts: SimulateOptions = {},
): SimResult {
  validateRoad(road);
  normalizeIntervals(demand, road.horizonSteps);
  const overrides = opts.overrides ?? {};
  validateOverrides(road, overrides);

  const fd = deriveFd(road);
  const N = road.cellCount;
  const m = road.mergeCell;

  const demandAt = (t: number): DemandInterval => {
    const iv = demand.find((d) => t >= d.tStart && t < d.tEnd);
    if (!iv) throw new Error(`no demand for step ${t}`);
    return iv;
  };

  let counts: number[];
  if (opts.initialCounts) {
    if (opts.initialCounts.length !== N) {
      const e = new Error("initialCounts length must equal cellCount");
      (e as Error & { code?: string }).code = "BAD_INITIAL";
      throw e;
    }
    counts = opts.initialCounts.map((x) => {
      if (x < -EPS || x > fd.nJam + 1e-6) {
        const e = new Error("initial count out of [0,nJam]");
        (e as Error & { code?: string }).code = "BAD_INITIAL";
        throw e;
      }
      return Math.max(0, x);
    });
  } else {
    counts = new Array(N).fill(0);
  }
  const initialCounts = counts.slice();

  let upQueue = 0;
  let rampQueue = 0;
  const records: StepRecord[] = [];

  // Accumulators for the report / conservation ledger.
  let totalMainArrivals = 0;
  let totalRampArrivals = 0;
  let totalUpInflow = 0;
  let totalRampInflow = 0;
  let cumulativeOutflow = 0;
  let queueDelayVehH = 0;
  let networkVehH = 0;
  let congestionOnset: number | null = null;
  let peak = { value: -Infinity, t: 0, cell: 0 };
  const outflows: number[] = [];

  for (let t = 0; t < road.horizonSteps; t++) {
    const dem = demandAt(t);
    // 1) New arrivals join the boundary queues (never silently dropped).
    const upArrivals = dem.mainFlow * road.dt;
    const rampArrivals = dem.rampFlow * road.dt;
    const upAvail = upQueue + upArrivals;
    const rampAvail = rampQueue + rampArrivals;

    // 2) Sending/receiving from the OLD state, with active bottleneck factors.
    const S = new Array<number>(N);
    const R = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      const f = activeFactor(overrides.bottlenecks, i, t);
      S[i] = sending(counts[i], fd, f);
      R[i] = receiving(counts[i], fd, f);
    }

    // 3) Internal flows (vehicles) from the OLD state.
    const fOut = new Array<number>(N).fill(0); // discharge of each cell
    const fIn = new Array<number>(N).fill(0); // receipts of each cell

    // Mainline boundary admission into cell 0 (ramp never merges there).
    const admitUp = Math.min(upAvail, R[0]);
    fIn[0] += admitUp;

    // Ramp discharge limited by the active meter for this step.
    const meterStep = activeMeter(overrides.rampMeters, t) * road.dt;
    const rampDemand = Math.min(rampAvail, meterStep);

    // Merge: cell m-1 (mainline) and the ramp share cell m's receiving space.
    const merge = allocateMerge(S[m - 1], rampDemand, R[m], road.mergePriority);
    fOut[m - 1] += merge.main;
    fIn[m] += merge.main + merge.ramp;

    // All other mainline interfaces.
    for (let i = 0; i < N - 1; i++) {
      if (i + 1 === m) continue; // merge interface handled above
      const flow = Math.min(S[i], R[i + 1]);
      fOut[i] += flow;
      fIn[i + 1] += flow;
    }
    // Downstream sink: cell N-1 sends all it can.
    const sinkFlow = S[N - 1];
    fOut[N - 1] += sinkFlow;

    // 4) Synchronous state update into fresh arrays (old state untouched).
    const next = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      const v = counts[i] + fIn[i] - fOut[i];
      // Numerical clamp only at the guard level; mass balance is exact by build.
      next[i] = Math.max(0, v);
    }
    const nextUpQueue = Math.max(0, upAvail - admitUp);
    const nextRampQueue = Math.max(0, rampAvail - merge.ramp);

    totalMainArrivals += upArrivals;
    totalRampArrivals += rampArrivals;
    totalUpInflow += admitUp;
    totalRampInflow += merge.ramp;
    cumulativeOutflow += sinkFlow;
    queueDelayVehH += road.dt * (nextUpQueue + nextRampQueue);
    networkVehH += road.dt * next.reduce((a, b) => a + b, 0);
    outflows.push(sinkFlow);

    const density = next.map((c) => c / road.cellLength);
    for (let i = 0; i < N; i++) {
      if (density[i] > fd.kc && congestionOnset === null) congestionOnset = t;
      if (density[i] > peak.value) peak = { value: density[i], t, cell: i };
    }

    records.push({
      t,
      counts: next,
      density,
      upQueue: nextUpQueue,
      rampQueue: nextRampQueue,
      upInflow: admitUp,
      rampInflow: merge.ramp,
      outflow: sinkFlow,
      mergeMainFlow: merge.main,
      mergeRampFlow: merge.ramp,
      upArrivals,
      rampArrivals,
    });

    counts = next;
    upQueue = nextUpQueue;
    rampQueue = nextRampQueue;
  }

  const vehiclesOnRoad = counts.reduce((a, b) => a + b, 0);
  const queuedTotal = upQueue + rampQueue;
  const totalArrivals = totalMainArrivals + totalRampArrivals;
  const initialVehicles = initialCounts.reduce((a, b) => a + b, 0);
  const residual = initialVehicles + totalArrivals - cumulativeOutflow - vehiclesOnRoad - queuedTotal;

  const report = {
    steps: road.horizonSteps,
    finalDensity: counts.map((c) => c / road.cellLength),
    congestionOnset,
    peakDensity: peak.value === -Infinity ? { value: 0, t: 0, cell: 0 } : peak,
    cumulativeOutflow,
    servedVehicles: cumulativeOutflow,
    unservedQueued: queuedTotal,
    queueDelayVehH,
    networkVehH,
    totalVehH: networkVehH + queueDelayVehH,
    outflows,
    ledger: {
      initialVehicles,
      totalMainArrivals,
      totalRampArrivals,
      totalUpInflow,
      totalRampInflow,
      totalOutflow: cumulativeOutflow,
      totalVehiclesEntered: totalUpInflow + totalRampInflow,
      vehiclesOnRoad,
      upQueue,
      rampQueue,
      queuedTotal,
      residual,
    },
  };

  return { road, initialCounts, steps: records, report };
}
