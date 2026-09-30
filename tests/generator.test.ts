import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRoad, generateDemand, mulberry32 } from "../src/generator.ts";
import { validateParams, validateDemand } from "../src/engine.ts";

test("seeded generator is deterministic and produces valid road + demand", () => {
  const a = generateRoad(42);
  const b = generateRoad(42);
  assert.deepEqual(a, b);
  assert.deepEqual(validateParams(a), []);
  const da = generateDemand(42, { horizonSteps: 240 });
  const db = generateDemand(42, { horizonSteps: 240 });
  assert.deepEqual(da, db);
  assert.deepEqual(validateDemand(da, 240), []);
  assert.equal(da[0].startStep, 0);
  assert.equal(da.at(-1)!.endStep, 240);
});

test("mulberry32 is a usable deterministic PRNG in [0,1)", () => {
  const r1 = mulberry32(1);
  const r2 = mulberry32(1);
  const xs = Array.from({ length: 100 }, () => r1());
  const ys = Array.from({ length: 100 }, () => r2());
  assert.deepEqual(xs, ys);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean > 0.2 && mean < 0.8);
});

test("incident and meter plan land inside matching demand segments", () => {
  const demand = generateDemand(7, {
    horizonSteps: 240,
    incident: { startStep: 0, endStep: 120, capacityFactor: 0.4 },
    meterPlan: { startStep: 0, endStep: 60, meterRate: 300 },
  });
  assert.ok(demand.some((d) => d.capacityFactor === 0.4));
  assert.ok(demand.some((d) => d.meterRate === 300));
  assert.deepEqual(validateDemand(demand, 240), []);
});
