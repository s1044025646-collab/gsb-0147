import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, mergeSplit, validateParams, checkCfl, METER_OFF } from "../src/engine.ts";
import { tinyRoad, flatDemand } from "./helpers.ts";

test("hand calculation: free-flow pulse advances one cell per 30s step", () => {
  // qCap = 1800 veh/h * (1/120) h = 15 veh/step. Njam = 150*0.5 = 75.
  // Empty road; 1800 veh/h at the upstream boundary => 15 veh admitted per step.
  const result = simulate({ params: tinyRoad(), demand: flatDemand(6, 1800), horizonSteps: 6 });
  const out = result.steps.map((s) => s.outflow);
  // Vehicles enter cell 0 at the end of step 0, then advance one cell per step;
  // the first 15 leave the sink during step 4.
  assert.deepEqual(out.slice(0, 4), [0, 0, 0, 0]);
  assert.equal(out[4], 15);
  assert.equal(out[5], 15);
  // At step 0 exactly 15 vehicles occupy only the first cell.
  assert.deepEqual(result.steps[0].n, [15, 0, 0, 0]);
  assert.deepEqual(result.steps[1].n, [15, 15, 0, 0]);
});

test("merge split: priority applies only under scarcity and spare share is reused", () => {
  // Plenty of room: both fully served regardless of priority.
  assert.deepEqual(mergeSplit(10, 8, 30, 0.6), { main: 10, ramp: 8 });
  // Scarcity: main targets 60% of 30 = 18, ramp wants 8 (< 12) so ramp
  // takes 8 and main takes the remaining 22.
  assert.deepEqual(mergeSplit(100, 8, 30, 0.6), { main: 22, ramp: 8 });
  // Both want it all: strict 60/40 split.
  assert.deepEqual(mergeSplit(100, 100, 30, 0.6), { main: 18, ramp: 12 });
});

test("queue forms when demand exceeds entry capacity and is never silently dropped", () => {
  // 2400 veh/h => 20 arrivals per step but only 15 can enter: 5 queue/step.
  const result = simulate({ params: tinyRoad(), demand: flatDemand(4, 2400), horizonSteps: 4 });
  assert.equal(result.steps[0].mainQueue, 5);
  assert.equal(result.steps[1].mainQueue, 10);
  assert.equal(result.steps[3].mainQueue, 20);
  const t = result.totals;
  assert.ok(Math.abs(t.mainDemandVeh - 80) < 1e-9);
  assert.ok(Math.abs(t.mainDemandVeh - t.enteredVeh - t.mainUnservedVeh) < 1e-9);
});

test("queue dissipates after demand stops (served vehicles drain, queues go to zero)", () => {
  const demand = [
    { ...flatDemand(3, 2400)[0] },
    {
      startStep: 3,
      endStep: 20,
      mainDemand: 0,
      rampDemand: 0,
      meterRate: METER_OFF,
      capacityFactor: 1,
    },
  ];
  const result = simulate({ params: tinyRoad(), demand, horizonSteps: 20 });
  // By the end every queued vehicle has entered and eventually exited.
  assert.equal(result.totals.mainUnservedVeh, 0);
  assert.ok(result.steps.at(-1)!.mainQueue === 0);
  assert.ok(Math.abs(result.totals.mainDemandVeh - result.totals.exitedVeh - result.totals.onRoadVeh) < 1e-6);
});

test("full blockage: zero capacity downstream pins inflow and packs cells to jam density", () => {
  const params = tinyRoad({ bottleneckCell: 3, capacity: [1800, 1800, 1800, 1800] });
  // capacityFactor 0 at the last cell for the whole horizon.
  const result = simulate({
    params,
    demand: flatDemand(40, 1800, 0, { capacityFactor: 0 }),
    horizonSteps: 40,
  });
  const last = result.steps.at(-1)!;
  // Jam count per cell = 75 veh; receiving of downstream collapses and the queue grows.
  assert.ok(last.n[3] <= 75 + 1e-6);
  assert.equal(last.outflow, 0);
  assert.ok(last.mainQueue > 0);
  assert.ok(last.density[3] <= 150 + 1e-6);
});

test("demand pulse is conserved and finite", () => {
  const demand = [
    { startStep: 0, endStep: 2, mainDemand: 2000, rampDemand: 0, meterRate: METER_OFF, capacityFactor: 1 },
    { startStep: 2, endStep: 30, mainDemand: 0, rampDemand: 0, meterRate: METER_OFF, capacityFactor: 1 },
  ];
  const result = simulate({ params: tinyRoad(), demand, horizonSteps: 30 });
  const t = result.totals;
  assert.ok(Number.isFinite(t.totalDelayVehH));
  assert.ok(Math.abs(t.mainDemandVeh - t.exitedVeh - t.onRoadVeh - t.mainUnservedVeh) < 1e-6);
});

test("ramp merge competition with fixed priority splits capacity at the merge cell", () => {
  // Merge at cell 2. Saturate mainline and ramp; only 15 veh/step can enter
  // cell 2, shared 60% main / 40% ramp while both are queued.
  // Pre-load the mainline cells so cell 1 has sending flow, and queue ramp demand.
  const result = simulate(
    { params: tinyRoad({ mergeCell: 2, mainlinePriority: 0.6, initialDensity: [30, 30, 0, 0] }), demand: flatDemand(1, 0, 2400), horizonSteps: 1 }
  );
  const s = result.steps[0];
  // receiving of empty cell2 = 15; cell1 wants 15, ramp wants 15 -> 9/6 split.
  assert.ok(Math.abs(s.rampAdmitted - 6) < 1e-6, JSON.stringify(s));
  assert.ok(Math.abs(s.n[2] - 15) < 1e-6);
});

test("invalid time step is rejected by CFL validation", () => {
  const bad = tinyRoad({ dtHours: 1 / 30 }); // vf*dt/L = 60/30/0.5 = 4 > 1
  const cfl = checkCfl(bad);
  assert.equal(cfl.satisfied, false);
  const errors = validateParams(bad);
  assert.ok(errors.some((e) => e.includes("CFL")));
});

test("all fixtures: non-negative counts, density cap, and strict conservation every step", () => {
  const cases = [
    { params: tinyRoad(), demand: flatDemand(30, 1800) },
    { params: tinyRoad({ bottleneckCell: 3 }), demand: flatDemand(30, 2400, 900, { capacityFactor: 0.4 }) },
    { params: tinyRoad({ mergeCell: 0 }), demand: flatDemand(30, 1500, 800) },
  ];
  for (const cfg of cases) {
    const r = simulate({ ...cfg, horizonSteps: 30 });
    const initialOnRoad = cfg.params.initialDensity
      ? cfg.params.initialDensity.reduce((acc, rho, i) => acc + rho * cfg.params.cellLengthKm[i], 0)
      : 0;
    let cumMain = 0;
    let cumRamp = 0;
    let cumIn = 0;
    let cumOut = 0;
    for (const s of r.steps) {
      cumMain += s.mainArrivals;
      cumRamp += s.rampArrivals;
      cumIn += s.inflow;
      cumOut += s.outflow;
      for (let i = 0; i < s.n.length; i++) {
        assert.ok(s.n[i] >= -1e-9, `negative n ${s.n[i]}`);
        assert.ok(s.density[i] <= 150 + 1e-6, `jam exceeded ${s.density[i]}`);
      }
      // arrivals = on road + exited + queues at every step
      const onRoad = s.n.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(initialOnRoad + cumMain + cumRamp - onRoad - cumOut - s.mainQueue - s.rampQueue) < 1e-3);
      void cumIn;
    }
    assert.ok(Math.abs(r.totals.mainDemandVeh + r.totals.rampDemandVeh - r.totals.exitedVeh - r.totals.onRoadVeh - r.totals.mainUnservedVeh - r.totals.rampUnservedVeh) < 1e-5);
  }
});

test("synchronous update: flows use the old state within a step", () => {
  // A single occupied cell at capacity density cannot also receive a vehicle in the same
  // step in a way that would create mass; hand check via a packed upstream scenario.
  const params = tinyRoad({ initialDensity: [0, 150, 0, 0] }); // cell 1 at jam density (75 veh)
  const r = simulate({ params, demand: flatDemand(1, 0, 0), horizonSteps: 1 });
  // Cell 1 (jam count 75) sends min(75,15)=15; cell 2 receives 15.
  assert.deepEqual(r.steps[0].n, [0, 60, 15, 0]);
});

test("fixed input reproduces identical results", () => {
  const cfg = { params: tinyRoad(), demand: flatDemand(20, 2200, 500), horizonSteps: 20 };
  const a = simulate(cfg);
  const b = simulate(cfg);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
