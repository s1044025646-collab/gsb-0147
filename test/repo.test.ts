import { assert, approx, test } from "./harness.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, withTransaction } from "../src/db/database.js";
import { Repo } from "../src/db/repo.js";
import { generateDemand, makeFictionalRoad } from "../src/core/generator.js";
import { compareRuns, runScenario } from "../src/core/service.js";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "ctm-test-"));
  return join(dir, "app.db");
}

function seedScenario(repo: Repo, seed = 3) {
  const road = makeFictionalRoad({ horizonSteps: 80 });
  const demand = generateDemand(road, { seed, peakLoad: 1.1 });
  return repo.createScenario({ name: "t", road, demand }, seed);
}

test("migration is idempotent on reopen", () => {
  const path = tempDb();
  openDatabase(path).close();
  const db = openDatabase(path);
  const row = db.prepare("SELECT COUNT(*) c FROM schema_migrations").get() as { c: number };
  assert.equal(row.c, 1);
  db.close();
});

test("scenario edit bumps version and forces a new run; old key conflicts", () => {
  const dbPath = tempDb();
  const db = openDatabase(dbPath);
  const repo = new Repo(db);
  const scn = seedScenario(repo);
  const first = runScenario(repo, scn.id, "a", {}, "key-1");
  assert.equal(first.reused, false);

  // Same key -> reused (idempotent).
  const again = runScenario(repo, scn.id, "a", {}, "key-1");
  assert.equal(again.reused, true);
  assert.equal(again.run.id, first.run.id);

  // Modify the scheme (demand) -> version bump.
  const updated = repo.updateScenario(scn.id, {
    demand: generateDemand(scn.road, { seed: 9 }),
  });
  assert.equal(updated.version, 2);

  // Old idempotency key now conflicts rather than silently reusing stale output.
  assert.throws(
    () => runScenario(repo, scn.id, "a", {}, "key-1"),
    (e: Error & { code?: string }) => e.code === "CONFLICT",
  );
  // A fresh key creates a new run.
  const next = runScenario(repo, scn.id, "a2", {}, "key-2");
  assert.equal(next.reused, false);
  assert.notEqual(next.run.id, first.run.id);
  db.close();
});

test("transaction rolls back on error (no partial scenario/demand)", () => {
  const db = openDatabase(tempDb());
  const repo = new Repo(db);
  const before = repo.listScenarios(100, 0).total;
  assert.throws(() =>
    withTransaction(db, () => {
      const road = makeFictionalRoad({});
      repo.createScenario({ name: "partial", road, demand: generateDemand(road, { seed: 1 }) }, 1);
      throw new Error("boom");
    }),
  );
  assert.equal(repo.listScenarios(100, 0).total, before);
  db.close();
});

test("run stored then reopened from disk persists steps and ledger (restart)", () => {
  const dbPath = tempDb();
  let runId = "";
  let expectOutflow = 0;
  let expectResidual = 0;
  {
    const db = openDatabase(dbPath);
    const repo = new Repo(db);
    const scn = seedScenario(repo, 21);
    const r = runScenario(repo, scn.id, "persist", {
      bottlenecks: [{ cell: scn.road.mergeCell, factor: 0.5, tStart: 10, tEnd: 50 }],
    }, "k");
    runId = r.run.id;
    expectOutflow = r.report.cumulativeOutflow;
    expectResidual = r.report.ledger.residual;
    db.close();
  }
  // Simulate process restart: open a brand new handle on the same file.
  const db2 = openDatabase(dbPath);
  const repo2 = new Repo(db2);
  const run = repo2.getRun(runId);
  assert.ok(run);
  const { rows, total } = repo2.getSteps(runId, 1000, 0);
  assert.equal(total, 80);
  assert.equal(rows.length, 80);
  const report = repo2.getReport(runId)!;
  approx(report.cumulativeOutflow, expectOutflow, 1e-9);
  approx(report.ledger.residual, expectResidual, 1e-12);
  db2.close();
});

test("compare and ledger services report distinct schemes", () => {
  const db = openDatabase(tempDb());
  const repo = new Repo(db);
  const scn = seedScenario(repo, 11);
  const a = runScenario(repo, scn.id, "base", {}, "a").run.id;
  const b = runScenario(
    repo,
    scn.id,
    "cap",
    { bottlenecks: [{ cell: scn.road.mergeCell, factor: 0.4, tStart: 0, tEnd: 80 }] },
    "b",
  ).run.id;
  const cmp = compareRuns(repo, a, b);
  const unserved = cmp.metrics.find((m) => m.metric === "unservedQueued")!;
  assert.ok(unserved.delta >= -1e-9);
  assert.throws(() => compareRuns(repo, a, "nope"), (e) => (e as Error & { code?: string }).code === "NOT_FOUND");
  db.close();
});
