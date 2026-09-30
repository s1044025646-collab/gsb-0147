import { assert, test } from "./harness.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "../src/api/server.js";

let server: StartedServer;
let base: string;

async function jsonFetch(path: string, init?: RequestInit & { body?: unknown }) {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("API end-to-end: validation, error codes, pagination, idempotency, persistence binding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctm-api-"));
  server = await startServer(join(dir, "api.db"), "127.0.0.1", 0);
  assert.ok(server.port > 0, "auto port assigned");
  base = `http://127.0.0.1:${server.port}`;

  const health = await jsonFetch("/health");
  assert.equal(health.status, 200);

  // Validation error code.
  const bad = await jsonFetch("/scenarios", {
    method: "POST",
    body: { name: "x", road: { cellCount: 1 } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "VALIDATION");

  // CFL surfaced as a distinct error code.
  const cfl = await jsonFetch("/scenarios", {
    method: "POST",
    body: {
      name: "cfl",
      road: {
        cellCount: 4, cellLength: 0.1, dt: 36 / 3600, horizonSteps: 5,
        freeFlowSpeed: 100, waveSpeed: 20, jamDensity: 120, capacity: 2000,
        mergeCell: 2, mergePriority: 0.5,
      },
      demand: [{ tStart: 0, tEnd: 5, mainFlow: 100, rampFlow: 0 }],
    },
  });
  assert.equal(cfl.status, 422);
  assert.equal(cfl.body.error.code, "CFL");

  // Fictional generator scenario.
  const created = await jsonFetch("/scenarios", {
    method: "POST",
    body: { fictional: true, name: "corridor", seed: 4 },
  });
  assert.equal(created.status, 201);
  const scnId = created.body.data.id;
  assert.equal(created.body.data.version, 1);

  // Run baseline (idempotency key).
  const run1 = await jsonFetch(`/scenarios/${scnId}/runs`, {
    method: "POST",
    body: { label: "base", idempotencyKey: "k-base" },
  });
  assert.equal(run1.status, 201);
  const baseRun = run1.body.data.run.id;
  assert.equal(run1.body.data.reused, false);

  const run1again = await jsonFetch(`/scenarios/${scnId}/runs`, {
    method: "POST",
    body: { label: "base", idempotencyKey: "k-base" },
  });
  assert.equal(run1again.status, 200);
  assert.equal(run1again.body.data.reused, true);
  assert.equal(run1again.body.data.run.id, baseRun);

  // Bottleneck scheme -> new run.
  const run2 = await jsonFetch(`/scenarios/${scnId}/runs`, {
    method: "POST",
    body: {
      label: "cap",
      idempotencyKey: "k-cap",
      bottlenecks: [{ cell: 5, factor: 0.4, tStart: 20, tEnd: 200 }],
    },
  });
  assert.equal(run2.status, 201);
  assert.notEqual(run2.body.data.run.id, baseRun);

  // Pagination on steps.
  const page = await jsonFetch(`/runs/${baseRun}/steps?page=2&limit=25`);
  assert.equal(page.status, 200);
  assert.equal(page.body.data.length, 25);
  assert.equal(page.body.page.page, 2);
  assert.equal(page.body.page.limit, 25);
  assert.equal(page.body.page.total, created.body.data.road.horizonSteps);

  // Ledger + compare.
  const ledger = await jsonFetch(`/runs/${baseRun}/ledger`);
  assert.equal(ledger.status, 200);
  assert.ok(Math.abs(ledger.body.data.residual) < 1e-6);
  const cmp = await jsonFetch(`/runs/${baseRun}/compare/${run2.body.data.run.id}`);
  assert.equal(cmp.status, 200);
  assert.ok(Array.isArray(cmp.body.data.metrics));

  // 404 code.
  const missing = await jsonFetch("/runs/nope/report");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");

  await server.close();
});
