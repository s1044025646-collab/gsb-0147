import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDb, tinyRoad, flatDemand } from "./helpers.ts";
import { openDb, createRepo, tx } from "../src/db.ts";
import { createService, ValidationError, NotFoundError } from "../src/service.ts";

test("scheme change creates a NEW version and run; old version untouched", () => {
  const h = tmpDb("svc-fork");
  try {
    const s = h.service;
    const sc = s.createScenario("fork-demo");
    const v1 = s.addVersion(sc.id, "baseline", tinyRoad(), flatDemand(20, 2000), 20, null);
    const run1 = s.runVersion(v1.id, "k1");
    const v2 = s.forkVersion(v1.id, "metered", {
      demand: flatDemand(20, 2000, 0, { meterRate: 400 }),
    });
    assert.notEqual(v2.id, v1.id);
    assert.equal(v2.parent_version_id, v1.id);
    assert.equal(s.requireVersion(v1.id).demand[0].meterRate, 1e12);
    assert.equal(v2.demand[0].meterRate, 400);
    const run2 = s.runVersion(v2.id, "k2");
    assert.notEqual(run2.id, run1.id);
    assert.equal(s.repo.listRuns(v1.id).length, 1);
  } finally {
    h.close();
  }
});

test("idempotent run submission returns the same run", () => {
  const h = tmpDb("idem");
  try {
    const s = h.service;
    const sc = s.createScenario("idem");
    const v = s.addVersion(sc.id, "v", tinyRoad(), flatDemand(10, 1800), 10, null);
    const a = s.runVersion(v.id, "fixed-key-123");
    const b = s.runVersion(v.id, "fixed-key-123");
    assert.equal(a.id, b.id);
    assert.deepEqual(a.result, b.result);
  } finally {
    h.close();
  }
});

test("invalid version is rejected before any write (validation error path)", () => {
  const h = tmpDb("invalid");
  try {
    const s = h.service;
    const sc = s.createScenario("invalid");
    assert.throws(
      () => s.addVersion(sc.id, "bad", tinyRoad({ dtHours: 1 / 10 }), flatDemand(5, 1000), 5, null),
      (e: Error) => e instanceof ValidationError && /CFL/.test(e.message)
    );
    assert.equal(s.repo.listVersions(sc.id).length, 0);
    assert.throws(() => s.requireScenario(9999), NotFoundError);
  } finally {
    h.close();
  }
});

test("transaction rolls back when save fails mid-way", () => {
  const h = tmpDb("rollback");
  try {
    const s = h.service;
    const sc = s.createScenario("rb");
    const v = s.addVersion(sc.id, "v", tinyRoad(), flatDemand(5, 1800), 5, null);
    // Insert a scenario inside a transaction, then force a failure before commit;
    // the whole transaction must roll back (no half-applied writes).
    const countBefore = s.repo.listScenarios().length;
    assert.throws(() =>
      tx(h.service.repo.db, () => {
        h.service.repo.db.prepare("INSERT INTO scenarios(name) VALUES (?)").run("should-rollback");
        throw new Error("boom");
      })
    );
    assert.equal(s.repo.listScenarios().length, countBefore);
    assert.equal(s.repo.getScenario(v.id + 1000), undefined);
    // A subsequent transaction works normally (connection still usable).
    assert.doesNotThrow(() =>
      tx(h.service.repo.db, () =>
        h.service.repo.db.prepare("INSERT INTO scenarios(name) VALUES (?)").run("after-rollback")
      )
    );
    assert.ok(s.repo.listScenarios().some((x) => x.name === "after-rollback"));
  } finally {
    h.close();
  }
});

test("state survives a process-style close/reopen (persistence + rerunnable migration)", () => {
  const h = tmpDb("restart");
  let runId = 0;
  let ledgerBalanced = false;
  try {
    const s1 = h.service;
    const sc = s1.createScenario("persist");
    const v = s1.addVersion(sc.id, "v", tinyRoad(), flatDemand(20, 2200, 700), 20, null);
    runId = s1.runVersion(v.id, "persist-key").id;
    ledgerBalanced = s1.conservationLedger(runId).balanced;
    h.service.repo.db.close();

    const db2 = openDb(h.path);
    const s2 = createService(createRepo(db2));
    const rerun = s2.repo.findRun(v.id, "persist-key");
    assert.ok(rerun && rerun.id === runId);
    assert.equal(s2.conservationLedger(runId).balanced, true);
    const page = s2.getStepsPage(runId, 5, 2);
    assert.equal(page.total, 20);
    assert.equal(page.limit, 5);
    assert.equal(page.offset, 2);
    assert.equal(page.items.length, 5);
    assert.equal(page.hasMore, true);
    db2.close();
  } finally {
    assert.equal(ledgerBalanced, true);
    h.close();
  }
});

test("conservation ledger balances and reports unserved vehicles (not counted as served)", () => {
  const h = tmpDb("ledger");
  try {
    const s = h.service;
    const sc = s.createScenario("led");
    // Very short horizon with heavy demand guarantees a residual queue at the end.
    const v = s.addVersion(sc.id, "v", tinyRoad(), flatDemand(3, 2400), 3, null);
    const run = s.runVersion(v.id, null);
    const l = s.conservationLedger(run.id);
    assert.equal(l.balanced, true);
    assert.ok(l.unservedAtEnd.total > 0);
    assert.ok(l.exited + l.onRoadAtEnd + l.unservedAtEnd.total - l.demand.total < 1e-6);
  } finally {
    h.close();
  }
});

test("metering shifts unserved vehicles to the ramp queue; comparison reflects it", () => {
  const h = tmpDb("meter");
  try {
    const s = h.service;
    const sc = s.createScenario("meter");
    const v1 = s.addVersion(sc.id, "open", tinyRoad(), flatDemand(30, 2000, 1200), 30, null);
    const v2 = s.forkVersion(v1.id, "metered", { demand: flatDemand(30, 2000, 1200, { meterRate: 300 }) });
    const r1 = s.runVersion(v1.id, "open");
    const r2 = s.runVersion(v2.id, "metered");
    const cmp = s.compareRuns(r1.id, r2.id);
    assert.ok(cmp.metrics_b.unservedVeh >= cmp.metrics_a.unservedVeh - 1e-9);
    assert.ok(Number.isFinite(cmp.delta_b_minus_a.totalDelayVehH));
  } finally {
    h.close();
  }
});
