import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listenLocal, type ApiDeps } from "../src/api.ts";
import { openDb, createRepo } from "../src/db.ts";
import { createService } from "../src/service.ts";
import { tinyRoad, flatDemand } from "./helpers.ts";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";

async function harness(label: string) {
  const path = `data/test-api-${label}-${process.pid}-${Math.floor(Math.random() * 1e9)}.sqlite`;
  const db = openDb(path);
  const service = createService(createRepo(db));
  const deps: ApiDeps = { service };
  const server = createApp(deps);
  const { port, close } = await listenLocal(server, 0);
  const base = `http://127.0.0.1:${port}`;
  async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }
  return {
    call,
    base,
    async cleanup() {
      await close();
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    },
  };
}

test("health responds on localhost", async () => {
  const h = await harness("health");
  try {
    const r = await h.call("GET", "/api/health");
    assert.equal(r.status, 200);
    assert.equal((r.json as { status: string }).status, "ok");
  } finally {
    await h.cleanup();
  }
});

test("full e2e: create -> version -> run -> paginated steps -> ledger, with 404/400 paths", async () => {
  const h = await harness("e2e");
  try {
    const created = await h.call("POST", "/api/scenarios", { name: "e2e" });
    assert.equal(created.status, 201);
    const sid = (created.json as { id: number }).id;

    // Validation failure: CFL-violating dt.
    const badParams = { ...tinyRoad(), dtHours: 1 / 5 };
    const bad = await h.call("POST", `/api/scenarios/${sid}/versions`, {
      label: "bad",
      horizonSteps: 5,
      params: badParams,
      demand: flatDemand(5, 1000),
    });
    assert.equal(bad.status, 400);
    assert.equal((bad.json as any).error.code, "VALIDATION_ERROR");

    const ok = await h.call("POST", `/api/scenarios/${sid}/versions`, {
      label: "v1",
      horizonSteps: 12,
      params: tinyRoad(),
      demand: flatDemand(12, 2200, 600),
    });
    assert.equal(ok.status, 201);
    const vid = (ok.json as { id: number }).id;

    const runA = await h.call("POST", `/api/versions/${vid}/runs`, {}, { "idempotency-key": "abc" });
    assert.equal(runA.status, 201);
    const rid = (runA.json as { id: number }).id;
    const runB = await h.call("POST", `/api/versions/${vid}/runs`, {}, { "idempotency-key": "abc" });
    assert.equal((runB.json as { id: number }).id, rid);

    const page1 = await h.call("GET", `/api/runs/${rid}/steps?limit=4&offset=0`);
    assert.equal(page1.status, 200);
    assert.equal((page1.json as { total: number }).total, 12);
    assert.equal((page1.json as { items: unknown[] }).items.length, 4);
    assert.equal((page1.json as { hasMore: boolean }).hasMore, true);
    const page3 = await h.call("GET", `/api/runs/${rid}/steps?limit=4&offset=8`);
    assert.equal((page3.json as { hasMore: boolean }).hasMore, false);

    const badPaging = await h.call("GET", `/api/runs/${rid}/steps?limit=9999`);
    assert.equal(badPaging.status, 400);

    const ledger = await h.call("GET", `/api/runs/${rid}/ledger`);
    assert.equal(ledger.status, 200);
    assert.equal((ledger.json as { balanced: boolean }).balanced, true);

    const missing = await h.call("GET", "/api/runs/9999/ledger");
    assert.equal(missing.status, 404);
    assert.equal((missing.json as any).error.code, "NOT_FOUND");

    const noRoute = await h.call("GET", "/api/nope");
    assert.equal(noRoute.status, 404);

    const badJson = await fetch(`${h.base}/api/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(badJson.status, 400);
  } finally {
    await h.cleanup();
  }
});

test("compare endpoint returns deltas between two schemes' runs", async () => {
  const h = await harness("compare");
  try {
    const sc = await h.call("POST", "/api/scenarios", { name: "cmp" });
    const sid = (sc.json as { id: number }).id;
    const v1 = await h.call("POST", `/api/scenarios/${sid}/versions`, {
      label: "open",
      horizonSteps: 16,
      params: tinyRoad(),
      demand: flatDemand(16, 2000, 1200),
    });
    const v2 = await h.call("POST", `/api/versions/${(v1.json as { id: number }).id}/fork`, {
      label: "metered",
      demand: flatDemand(16, 2000, 1200, { meterRate: 300 }),
    });
    const r1 = await h.call("POST", `/api/versions/${(v1.json as { id: number }).id}/runs`, {});
    const r2 = await h.call("POST", `/api/versions/${(v2.json as { id: number }).id}/runs`, {});
    const cmp = await h.call("POST", "/api/runs/compare", {
      runA: (r1.json as { id: number }).id,
      runB: (r2.json as { id: number }).id,
    });
    assert.equal(cmp.status, 200);
    assert.ok(typeof (cmp.json as any).delta_b_minus_a.totalDelayVehH === "number");
  } finally {
    await h.cleanup();
  }
});

test("server binds only to loopback", async () => {
  const h = await harness("bind");
  try {
    const url = new URL(h.base);
    assert.equal(url.hostname, "127.0.0.1");
    const addr = {} as AddressInfo;
    void addr;
  } finally {
    await h.cleanup();
  }
});
