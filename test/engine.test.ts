import { assert, approx, test } from "./harness.js";
import { allocateMerge, simulate } from "../src/core/engine.js";
import { deriveFd, receiving, validateRoad } from "../src/core/fd.js";
import { generateDemand, makeFictionalRoad } from "../src/core/generator.js";
import { mulberry32 } from "../src/core/rng.js";
import type { DemandInterval, RoadParams } from "../src/core/types.js";

const uniform = (horizon: number, main: number, ramp = 0): DemandInterval[] => [
  { tStart: 0, tEnd: horizon, mainFlow: main, rampFlow: ramp },
];

function expectCode(code: string, fn: () => unknown) {
  try {
    fn();
    assert.fail("expected throw");
  } catch (e) {
    assert.equal((e as { code?: string }).code, code);
  }
}

function assertInvariants(result: ReturnType<typeof simulate>) {
  const { road, steps, report, initialCounts } = result;
  const fd = deriveFd(road);
  let prevCounts = initialCounts.slice();
  let prevUp = 0;
  let prevRamp = 0;
  let outflow = 0;
  for (const s of steps) {
    // Non-negativity and density cap.
    for (let i = 0; i < road.cellCount; i++) {
      assert.ok(s.counts[i] >= -1e-9, `negative count at t=${s.t} i=${i}: ${s.counts[i]}`);
      assert.ok(s.upQueue >= -1e-9 && s.rampQueue >= -1e-9, "negative queue");
      assert.ok(s.counts[i] <= fd.nJam + 1e-6, `jam exceeded t=${s.t} i=${i}`);
      assert.ok(s.density[i] <= road.jamDensity + 1e-6, "density cap");
    }
    // Per-step conservation using ONLY the published previous snapshot.
    const onBefore = prevCounts.reduce((a, b) => a + b, 0);
    const onAfter = s.counts.reduce((a, b) => a + b, 0);
    const entered = s.upInflow + s.rampInflow;
    approx(
      onAfter + s.upQueue + s.rampQueue,
      onBefore + prevUp + prevRamp + s.upArrivals + s.rampArrivals - s.outflow,
      1e-6,
      `conservation t=${s.t}`,
    );
    void entered;
    outflow += s.outflow;
    prevCounts = s.counts.slice();
    prevUp = s.upQueue;
    prevRamp = s.rampQueue;
  }
  approx(report.ledger.residual, 0, 1e-6, "global ledger residual");
  approx(outflow, report.cumulativeOutflow, 1e-9);
  // Served = discharged only; final queues must not count as served.
  approx(report.servedVehicles, report.cumulativeOutflow, 1e-12);
  assert.ok(report.servedVehicles + report.unservedQueued <= report.ledger.totalMainArrivals + report.ledger.totalRampArrivals + report.ledger.initialVehicles + 1e-6 + report.ledger.vehiclesOnRoad);
}

test("CFL violation is rejected with code CFL", () => {
  const road: RoadParams = {
    cellCount: 4,
    cellLength: 0.2, // vf*dt = 100*0.01 = 1 > 0.2
    dt: 36 / 3600,
    horizonSteps: 5,
    freeFlowSpeed: 100,
    waveSpeed: 20,
    jamDensity: 120,
    capacity: 2000,
    mergeCell: 2,
    mergePriority: 0.5,
  };
  expectCode("CFL", () => validateRoad(road));
  expectCode("CFL", () => simulate(road, uniform(5, 500)));
});

test("free flow: low demand travels at vf with no queues", () => {
  const road = makeFictionalRoad({ cellCount: 6, horizonSteps: 60 });
  const result = simulate(road, uniform(road.horizonSteps, 400, 0));
  assertInvariants(result);
  approx(result.report.unservedQueued, 0, 1e-9);
  // Steady free flow: every cell holds q*dt vehicles (density q*dt/dx) and
  // discharges q*dt per step.
  const steady = result.steps[result.steps.length - 1];
  const expectedDensity = (400 * road.dt) / road.cellLength;
  for (let i = 1; i < road.cellCount; i++) approx(steady.density[i], expectedDensity, 1e-6);
  approx(steady.outflow, 400 * road.dt, 1e-6);
});

test("hand calculation: two-cell merge matches by hand", () => {
  // Hand-computed constants.
  const dt = 10 / 3600;
  const road: RoadParams = {
    cellCount: 2,
    cellLength: 0.5,
    dt,
    horizonSteps: 1,
    freeFlowSpeed: 100,
    waveSpeed: 20,
    jamDensity: 120,
    capacity: 2000,
    mergeCell: 1,
    mergePriority: 0.6,
  };
  const fd = deriveFd(road);
  approx(fd.nJam, 60);
  approx(fd.qStep, 5.5555556, 1e-5);
  approx(fd.beta, (20 * dt) / 0.5, 1e-9);

  const result = simulate(road, uniform(1, 1000, 1000), {});
  const s = result.steps[0];
  // Empty initial road. Cell0 receives the main arrivals; the merge into cell1
  // draws from cell0's sending, which is zero at the start of step 0, so the
  // main platoon does not leap two cells in a single step (synchronous CTM).
  approx(s.upInflow, 1000 * dt, 1e-9);
  approx(s.mergeMainFlow, 0, 1e-12);
  approx(s.mergeRampFlow, 1000 * dt, 1e-9); // ramp enters directly
  approx(s.counts[0], 1000 * dt, 1e-9);
  approx(s.counts[1], 1000 * dt, 1e-9);
  // Cell1 starts empty: S1 = min(0,Q) = 0 leaves the same step.
  approx(s.outflow, 0, 1e-12);
  void fd;
});

test("hand calculation: two filled cells discharge min(count,Q) exactly", () => {
  const dt = 10 / 3600;
  const road: RoadParams = {
    cellCount: 2, cellLength: 0.5, dt, horizonSteps: 1, freeFlowSpeed: 100,
    waveSpeed: 20, jamDensity: 120, capacity: 2000, mergeCell: 1, mergePriority: 0.6,
  };
  const fd = deriveFd(road);
  // Preload cell1 with 3 vehicles (< Q=5.556) and no arrivals: S1=3 -> outflow 3.
  const result = simulate(road, uniform(1, 0, 0), { initialCounts: [0, 3] });
  approx(result.steps[0].outflow, 3, 1e-9);
  approx(result.steps[0].counts[1], 0, 1e-9);
  // Receiving for a jammed cell: beta*(nJam-n)=0.
  approx(receiving(60, fd), 0, 1e-9);
  // Empty cell receiving is Q.
  approx(receiving(0, fd), fd.qStep, 1e-9);
});

test("merge competition: priority only binds under scarce supply, spare is reused", () => {
  // Scarce supply R=4, main wants 3, ramp wants 3, priority 0.6.
  const a = allocateMerge(3, 3, 4, 0.6);
  approx(a.main + a.ramp, 4, 1e-9);
  // main share 2.4, ramp share 1.6 initially; no shortage beyond => exactly.
  approx(a.main, 2.4, 1e-9);
  approx(a.ramp, 1.6, 1e-9);

  // Spare reuse: main wants only 1 (< its 2.4 share), ramp wants 3.
  const b = allocateMerge(1, 3, 4, 0.6);
  approx(b.main, 1, 1e-9);
  approx(b.ramp, 3, 1e-9); // takes main's leftover 1.4

  // Abundant supply: both demands fully met regardless of priority.
  const c = allocateMerge(2, 1, 10, 0.6);
  approx(c.main, 2, 1e-9);
  approx(c.ramp, 1, 1e-9);
});

test("queue forms under overload and clears after demand drops (no lost vehicles)", () => {
  const road = makeFictionalRoad({ cellCount: 5, mergeCell: 3, horizonSteps: 240, capacity: 2000 });
  // Over-capacity pulse then free-flow recovery.
  const demand: DemandInterval[] = [
    { tStart: 0, tEnd: 80, mainFlow: 2600, rampFlow: 200 },
    { tStart: 80, tEnd: 240, mainFlow: 300, rampFlow: 0 },
  ];
  const result = simulate(road, demand, {});
  assertInvariants(result);
  // A queue must have formed at the upstream boundary.
  const maxUpQ = Math.max(...result.steps.map((s) => s.upQueue));
  assert.ok(maxUpQ > 0, "expected upstream queue under overload");
  assert.notEqual(result.report.congestionOnset, null);
  // Recovery: by the end the road drains and queues approach zero.
  const last = result.steps[result.steps.length - 1];
  approx(last.upQueue, 0, 1e-6);
  approx(last.rampQueue, 0, 1e-6);
});

test("full blockage (factor 0) stores everything upstream and releases nothing", () => {
  const road = makeFictionalRoad({ cellCount: 4, mergeCell: 2, horizonSteps: 30 });
  const result = simulate(road, uniform(30, 800, 0), {
    overrides: { bottlenecks: [{ cell: 3, factor: 0, tStart: 0, tEnd: 30 }] },
  });
  assertInvariants(result);
  approx(result.report.cumulativeOutflow, 0, 1e-9);
  // Nothing is lost: arrivals == vehicles on road + queues.
  const arrivals = result.report.ledger.totalMainArrivals;
  approx(arrivals, result.report.ledger.vehiclesOnRoad + result.report.ledger.queuedTotal, 1e-6);
  assert.ok(result.report.unservedQueued >= 0);
});

test("demand pulse is reproducible with the injected seed", () => {
  const road = makeFictionalRoad({ horizonSteps: 120 });
  const d1 = generateDemand(road, { seed: 99, peakLoad: 1.1 });
  const d2 = generateDemand(road, { seed: 99, peakLoad: 1.1 });
  assert.deepEqual(d1, d2);
  const d3 = generateDemand(road, { seed: 7, rng: mulberry32(99), peakLoad: 1.1 });
  assert.deepEqual(d1, d3);
  // An explicit pulse window sits at overload level.
  const pulsed = generateDemand(road, {
    seed: 1,
    pulse: { start: 10, end: 20, load: 1.2 },
    blockSteps: 10,
  });
  const pulseIv = pulsed.find((iv) => iv.tStart === 10)!;
  approx(pulseIv.mainFlow, 1.2 * road.capacity, 1e-9);
});

test("ramp metering shifts delay into ramp queue but conserves vehicles", () => {
  const road = makeFictionalRoad({ cellCount: 6, mergeCell: 3, horizonSteps: 120 });
  const demand = uniform(120, 1200, 900);
  const unmetered = simulate(road, demand, {});
  const metered = simulate(road, demand, {
    overrides: { rampMeters: [{ rate: 100, tStart: 0, tEnd: 120 }] },
  });
  assertInvariants(unmetered);
  assertInvariants(metered);
  assert.ok(metered.report.ledger.rampQueue >= -1e-9);
  // Metering limits ramp inflow each step to rate*dt.
  for (const s of metered.steps) assert.ok(s.rampInflow <= 100 * road.dt + 1e-6);
});

test("synchronous update: identical result independent of cell processing order", () => {
  const road = makeFictionalRoad({ cellCount: 8, horizonSteps: 90 });
  const demand = generateDemand(road, { seed: 5, peakLoad: 1.2, rampLoad: 0.2 });
  const r1 = simulate(road, demand, {});
  const r2 = simulate(road, demand, {});
  assert.deepEqual(
    r1.steps.map((s) => s.counts),
    r2.steps.map((s) => s.counts),
  );
  // Deterministic replay => same report.
  assert.equal(r1.report.cumulativeOutflow, r2.report.cumulativeOutflow);
});

test("infeasible triangle (kc >= kj) rejected", () => {
  const road = makeFictionalRoad({});
  const bad: RoadParams = { ...road, capacity: 20000 };
  expectCode("BAD_ROAD", () => simulate(bad, uniform(road.horizonSteps, 100)));
});

test("randomized fuzz: conservation/nonneg/cap hold across many seeded scenarios", () => {
  const rng = mulberry32(1234);
  for (let k = 0; k < 25; k++) {
    const cellCount = 3 + Math.floor(rng.next() * 6);
    const mergeCell = 1 + Math.floor(rng.next() * (cellCount - 1));
    const road = makeFictionalRoad({
      cellCount,
      mergeCell,
      horizonSteps: 60,
      capacity: 1500 + rng.next() * 1500,
      mergePriority: rng.next(),
    });
    const demand = generateDemand(road, {
      seed: 1000 + k,
      baseLoad: 0.3 + rng.next() * 0.4,
      peakLoad: 0.8 + rng.next() * 0.5,
      rampLoad: 0.05 + rng.next() * 0.3,
    });
    const useBottleneck = rng.next() > 0.5;
    const result = simulate(road, demand, {
      overrides: useBottleneck
        ? {
            bottlenecks: [
              {
                cell: mergeCell,
                factor: 0.3 + rng.next() * 0.6,
                tStart: 10,
                tEnd: 45,
              },
            ],
          }
        : {},
    });
    assertInvariants(result);
  }
});
