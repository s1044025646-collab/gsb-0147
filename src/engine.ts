// Self-contained Cell Transmission Model with a triangular fundamental diagram
// and a single priority on-ramp merge.
//
// Every time step is computed from the OLD state (vehicle counts held in `n`);
// all flows are resolved first and counts are written into `nNew` afterwards.
// Nothing mutates cell state while flows are being calculated, so vehicles can
// never be duplicated or vanish during an update.

import type { DemandEntry, RunResult, RunStep, ScenarioParams } from "./types.ts";

export const METER_OFF = 1e12; // sentinel: ramp metering disabled
export const NO_BOTTLENECK = -1;

export interface EngineConfig {
  params: ScenarioParams;
  demand: DemandEntry[];
  horizonSteps: number;
}

// Demand at a given step (rates, veh/h). Outside every interval everything is 0
// except the meter (off) and the capacity factor (1).
export function demandAt(demand: Demand[], step: number): DemandEntry {
  for (const d of demand) {
    if (step >= d.startStep && step < d.endStep) return d;
  }
  return { startStep: step, endStep: step + 1, mainDemand: 0, rampDemand: 0, meterRate: METER_OFF, capacityFactor: 1 };
}

type Demand = DemandEntry;

// CFL: within one step a free-flow wave and a backward wave may not cross more
// than one cell. Ratio v*dt/L must be <= 1 for every cell.
export function checkCfl(params: ScenarioParams): { satisfied: boolean; maxRatio: number; limit: number } {
  let maxRatio = 0;
  for (const l of params.cellLengthKm) {
    maxRatio = Math.max(maxRatio, params.vf * params.dtHours / l, params.w * params.dtHours / l);
  }
  return { satisfied: maxRatio <= 1 + 1e-9, maxRatio, limit: 1 };
}

export function validateParams(params: ScenarioParams): string[] {
  const errors: string[] = [];
  const n = params.cellLengthKm.length;
  if (n < 2) errors.push("at least two cells are required");
  if (!(params.dtHours > 0)) errors.push("dtHours must be > 0");
  if (!(params.vf > 0)) errors.push("vf must be > 0");
  if (!(params.w > 0)) errors.push("w must be > 0");
  if (!(params.rhoJam > 0)) errors.push("rhoJam must be > 0");
  if (!(params.rhoCrit > 0) || params.rhoCrit >= params.rhoJam)
    errors.push("rhoCrit must be > 0 and smaller than rhoJam");
  if (params.capacity.length !== n) errors.push("capacity must have one entry per cell");
  if (params.capacity.some((c) => !(c > 0))) errors.push("every capacity must be > 0");
  if (params.cellLengthKm.some((l) => !(l > 0))) errors.push("every cell length must be > 0");
  const fdCapFreeFlow = params.vf * params.rhoCrit;
  if (params.capacity.some((c) => c > fdCapFreeFlow + 1e-6))
    errors.push(`each cell capacity must be <= vf*rhoCrit = ${fdCapFreeFlow}`);
  const fdCapJam = params.w * (params.rhoJam - params.rhoCrit);
  if (Math.abs(fdCapFreeFlow - fdCapJam) > 1e-6)
    errors.push(
      `fundamental diagram inconsistent: vf*rhoCrit (${fdCapFreeFlow}) != w*(rhoJam-rhoCrit) (${fdCapJam})`
    );
  if (params.capacity.some((c) => c > fdCapJam + 1e-6))
    errors.push(`each cell capacity must be <= w*(rhoJam-rhoCrit) = ${fdCapJam}`);
  if (!Number.isInteger(params.mergeCell) || params.mergeCell < 0 || params.mergeCell >= n)
    errors.push("mergeCell must be a valid cell index");
  if (
    !Number.isInteger(params.bottleneckCell) ||
    (params.bottleneckCell !== -1 && (params.bottleneckCell < 0 || params.bottleneckCell >= n))
  )
    errors.push("bottleneckCell must be -1 or a valid cell index");
  if (!(params.mainlinePriority > 0 && params.mainlinePriority < 1))
    errors.push("mainlinePriority must be strictly between 0 and 1");
  if (params.initialDensity) {
    if (params.initialDensity.length !== n) errors.push("initialDensity must have one entry per cell");
    if (params.initialDensity.some((r) => r < 0 || r > params.rhoJam + 1e-9))
      errors.push("initial densities must lie in [0, rhoJam]");
  }
  const cfl = checkCfl(params);
  if (!cfl.satisfied) errors.push(`CFL violated: v*dt/L ratio ${cfl.maxRatio.toFixed(4)} > 1`);
  return errors;
}

export function validateDemand(demand: DemandEntry[], horizonSteps: number): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(horizonSteps) || horizonSteps <= 0) errors.push("horizonSteps must be a positive integer");
  if (!Array.isArray(demand)) {
    errors.push("demand must be an array");
    return errors;
  }
  let cursor = 0;
  for (let k = 0; k < demand.length; k++) {
    const d = demand[k];
    if (!Number.isInteger(d.startStep) || !Number.isInteger(d.endStep) || d.endStep <= d.startStep)
      errors.push(`demand[${k}] must have integer startStep < endStep`);
    if (d.startStep !== cursor) errors.push(`demand[${k}] must start at ${cursor} (no gaps or overlaps)`);
    if (d.endStep > horizonSteps) errors.push(`demand[${k}] exceeds horizonSteps`);
    if (d.mainDemand < 0 || d.rampDemand < 0) errors.push(`demand[${k}] rates must be >= 0`);
    if (d.meterRate < 0) errors.push(`demand[${k}] meterRate must be >= 0`);
    if (!(d.capacityFactor > 0) || d.capacityFactor > 1)
      errors.push(`demand[${k}] capacityFactor must be within (0, 1]`);
    cursor = d.endStep;
  }
  return errors;
}

// Split a receiving capacity R between a priority (mainline) source A and a
// secondary (ramp) source B. Priority shares p/(1-p) are targets; whenever one
// side cannot use its target share, the slack is offered to the other side.
// Priority therefore changes the split only while total supply is insufficient.
export function mergeSplit(
  aMain: number,
  bRamp: number,
  capacity: number,
  pMain: number
): { main: number; ramp: number } {
  if (aMain + bRamp <= capacity + 1e-9) return { main: aMain, ramp: bRamp };
  let fMain = Math.min(aMain, capacity * pMain);
  let fRamp = Math.min(bRamp, capacity * (1 - pMain));
  let slack = capacity - fMain - fRamp;
  // First pass of unused shares.
  if (slack > 1e-9) {
    const addMain = Math.min(slack, Math.max(0, aMain - fMain));
    fMain += addMain;
    slack -= addMain;
  }
  if (slack > 1e-9) {
    fRamp = Math.min(bRamp, fRamp + slack);
  }
  // Second pass (ramp may have left room after main took slack).
  slack = capacity - fMain - fRamp;
  if (slack > 1e-9) {
    fMain = Math.min(aMain, fMain + slack);
  }
  return { main: fMain, ramp: fRamp };
}

function effectiveCapacity(params: ScenarioParams, cell: number, factor: number): number {
  let cap = params.capacity[cell];
  if (params.bottleneckCell === cell) cap *= factor;
  return cap;
}

export function simulate(cfg: EngineConfig): RunResult {
  const { params, demand, horizonSteps } = cfg;
  const p = params;
  const nCells = p.cellLengthKm.length;
  const dt = p.dtHours;
  const cfl = checkCfl(p);

  // State: vehicles per cell (OLD state while a step is evaluated).
  let n: number[] = p.initialDensity
    ? p.initialDensity.map((rho, i) => rho * p.cellLengthKm[i])
    : new Array(nCells).fill(0);
  let mainQueue = 0;
  let rampQueue = 0;

  let totalMainDemand = 0;
  let totalRampDemand = 0;
  let totalEntered = 0;
  let totalExited = 0;
  let totalDelay = 0;

  const steps: RunStep[] = [];

  for (let step = 0; step < horizonSteps; step++) {
    const d = demandAt(demand, step);
    const mainArrivals = Math.max(0, d.mainDemand) * dt;
    const rampArrivals = Math.max(0, d.rampDemand) * dt;

    // Boundary queues persist across steps; unmet upstream demand is never lost.
    mainQueue += mainArrivals;
    rampQueue += rampArrivals;
    totalMainDemand += mainArrivals;
    totalRampDemand += rampArrivals;

    const qCap: number[] = [];
    const sending: number[] = [];
    const receiving: number[] = [];
    for (let i = 0; i < nCells; i++) {
      const cap = effectiveCapacity(p, i, d.capacityFactor);
      qCap[i] = cap * dt;
      const jamCount = p.rhoJam * p.cellLengthKm[i];
      sending[i] = Math.min(n[i], qCap[i]);
      // Triangular FD jam branch: receiving flow = w * (rhoJam - rho) in rate form.
      const jamBranch = (p.w * dt / p.cellLengthKm[i]) * (jamCount - n[i]);
      receiving[i] = Math.min(qCap[i], jamBranch);
    }

    // Internal flows for boundaries that are NOT the merge boundary.
    const flowInto: number[] = new Array(nCells).fill(0);
    const flowOut: number[] = new Array(nCells).fill(0);

    for (let i = 1; i < nCells; i++) {
      if (i === p.mergeCell) continue; // handled by the merge allocation below
      const f = Math.min(sending[i - 1], receiving[i]);
      flowOut[i - 1] += f;
      flowInto[i] += f;
    }

    let mainAdmitted = 0;
    let rampAdmitted = 0;

    if (p.mergeCell === 0) {
      // The ramp merges directly at the upstream boundary cell.
      const meter = Math.min(rampQueue, Math.max(0, d.meterRate) * dt);
      const { main, ramp } = mergeSplit(mainQueue, meter, receiving[0], p.mainlinePriority);
      mainAdmitted = main;
      rampAdmitted = ramp;
      flowInto[0] += main + ramp;
    } else {
      // Internal merge: main feed is the upstream neighbor's sending flow.
      const m = p.mergeCell;
      const meter = Math.min(rampQueue, Math.max(0, d.meterRate) * dt);
      const { main, ramp } = mergeSplit(sending[m - 1], meter, receiving[m], p.mainlinePriority);
      flowOut[m - 1] += main;
      flowInto[m] += main + ramp;
      rampAdmitted = ramp;

      // Upstream mainline boundary feeding cell 0.
      const f0 = Math.min(mainQueue, receiving[0]);
      mainAdmitted = f0;
      flowInto[0] += f0;
    }

    // Infinite-capacity downstream sink.
    const exited = sending[nCells - 1];
    flowOut[nCells - 1] += exited;

    // Queues are reduced by what was actually admitted.
    mainQueue -= mainAdmitted;
    rampQueue -= rampAdmitted;

    // Synchronous state update: build nNew entirely from old n and the flows.
    const nNew: number[] = new Array(nCells).fill(0);
    let stepRoadDelay = 0;
    for (let i = 0; i < nCells; i++) {
      nNew[i] = n[i] + flowInto[i] - flowOut[i];
      if (!(nNew[i] >= -1e-9)) {
        throw new Error(`negative vehicle count in cell ${i}: ${nNew[i]}`);
      }
      if (nNew[i] > p.rhoJam * p.cellLengthKm[i] * (1 + 1e-7)) {
        throw new Error(`jam density exceeded in cell ${i}: ${nNew[i]}`);
      }
      // Congestion delay from speed below vf on the triangular FD.
      const rho = n[i] / p.cellLengthKm[i];
      const speed = rho > 0 ? Math.min(p.vf, (p.w * (p.rhoJam - rho)) / rho) : p.vf;
      stepRoadDelay += n[i] * dt * Math.max(0, 1 - speed / p.vf);
    }

    // Waiting delay uses the post-admission queues (vehicles still waiting).
    const stepQueueDelay = mainQueue * dt + rampQueue * dt;
    const stepDelay = stepRoadDelay + stepQueueDelay;
    totalDelay += stepDelay;

    totalEntered += mainAdmitted + rampAdmitted;
    totalExited += exited;

    const density = nNew.map((count, i) => count / p.cellLengthKm[i]);
    steps.push({
      step,
      timeHours: step * dt,
      density,
      n: nNew.map((x) => round6(x)),
      mainQueue: round6(mainQueue),
      rampQueue: round6(rampQueue),
      inflow: round6(mainAdmitted + rampAdmitted),
      outflow: round6(exited),
      mainAdmitted: round6(mainAdmitted),
      rampAdmitted: round6(rampAdmitted),
      mainArrivals: round6(mainArrivals),
      rampArrivals: round6(rampArrivals),
      delay: round6(stepDelay),
      activeMeter: d.meterRate >= METER_OFF / 2 ? Infinity : d.meterRate,
      activeCapFactor: d.capacityFactor,
    });

    n = nNew;
  }

  const onRoad = n.reduce((a, b) => a + b, 0);
  return {
    steps,
    totals: {
      mainDemandVeh: round6(totalMainDemand),
      rampDemandVeh: round6(totalRampDemand),
      enteredVeh: round6(totalEntered),
      exitedVeh: round6(totalExited),
      onRoadVeh: round6(onRoad),
      mainUnservedVeh: round6(mainQueue),
      rampUnservedVeh: round6(rampQueue),
      totalDelayVehH: round6(totalDelay),
    },
    cfl,
  };
}

export function round6(x: number): number {
  return Math.abs(x) < 5e-12 ? 0 : Math.round(x * 1e6) / 1e6;
}
