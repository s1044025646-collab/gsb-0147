// HTTP JSON API. Binds to 127.0.0.1 only; port 0 lets the OS pick a free port.
// All errors carry an explicit machine-readable `error.code`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SimService, ValidationError, NotFoundError, ConflictError } from "./service.ts";

export interface ApiDeps {
  service: SimService;
}

interface JsonError {
  error: { code: string; message: string };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: JsonError = { error: { code, message } };
  send(res, status, body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("request body must be valid JSON");
  }
}

function requireObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ValidationError(`${what} must be a JSON object`);
  return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) throw new ValidationError(`${key} must be a non-empty string`);
  return v;
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`${key} must be a finite number`);
  return v;
}

function intParam(value: string | undefined, name: string): number {
  if (!/^\d+$/.test(value ?? "")) throw new ValidationError(`${name} must be a non-negative integer`);
  return Number(value);
}

function pagination(url: URL): { limit: number; offset: number } {
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");
  const limit = limitRaw == null ? 100 : intParam(limitRaw, "limit");
  const offset = offsetRaw == null ? 0 : intParam(offsetRaw, "offset");
  if (limit < 1 || limit > 1000) throw new ValidationError("limit must be between 1 and 1000");
  return { limit, offset };
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: unknown,
  query: Record<string, string>
) => void | Promise<void>;

export function createApp(deps: ApiDeps): Server {
  const svc = deps.service;
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [
    { method: "POST", pattern: /^\/api\/scenarios$/, keys: [], handler: createScenario },
    { method: "GET", pattern: /^\/api\/scenarios$/, keys: [], handler: listScenarios },
    { method: "GET", pattern: /^\/api\/scenarios\/(\d+)$/, keys: ["id"], handler: getScenario },
    { method: "POST", pattern: /^\/api\/scenarios\/(\d+)\/versions$/, keys: ["sid"], handler: addVersion },
    { method: "GET", pattern: /^\/api\/scenarios\/(\d+)\/versions$/, keys: ["sid"], handler: listVersions },
    { method: "GET", pattern: /^\/api\/versions\/(\d+)$/, keys: ["vid"], handler: getVersion },
    { method: "POST", pattern: /^\/api\/versions\/(\d+)\/fork$/, keys: ["vid"], handler: forkVersion },
    { method: "POST", pattern: /^\/api\/versions\/(\d+)\/runs$/, keys: ["vid"], handler: runVersion },
    { method: "GET", pattern: /^\/api\/runs\/(\d+)$/, keys: ["rid"], handler: getRun },
    { method: "GET", pattern: /^\/api\/runs\/(\d+)\/steps$/, keys: ["rid"], handler: getSteps },
    { method: "GET", pattern: /^\/api\/runs\/(\d+)\/ledger$/, keys: ["rid"], handler: getLedger },
    { method: "POST", pattern: /^\/api\/runs\/compare$/, keys: [], handler: compare },
    { method: "GET", pattern: /^\/api\/health$/, keys: [], handler: health },
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let body: unknown = {};
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") body = await readJson(req);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = url.pathname.match(route.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((k, i) => (params[k] = m[i + 1]));
        await route.handler(req, res, url, body, params);
        return;
      }
      sendError(res, 404, "NOT_FOUND", `no route for ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof ValidationError) return sendError(res, 400, err.code, err.message);
      if (err instanceof NotFoundError) return sendError(res, 404, err.code, err.message);
      if (err instanceof ConflictError) return sendError(res, 409, err.code, err.message);
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, "INTERNAL", message);
    }
  });
  return server;

  function health(_req: IncomingMessage, res: ServerResponse) {
    send(res, 200, { status: "ok" });
  }

  function createScenario(_req: IncomingMessage, res: ServerResponse, _u: URL, body: unknown) {
    const o = requireObject(body, "body");
    const scenario = svc.createScenario(str(o, "name"));
    send(res, 201, scenario);
  }

  function listScenarios(_req: IncomingMessage, res: ServerResponse) {
    send(res, 200, { items: svc.repo.listScenarios() });
  }

  function getScenario(_req: IncomingMessage, res: ServerResponse, _u: URL, _b: unknown, q: Record<string, string>) {
    const scenario = svc.requireScenario(intParam(q.id, "id"));
    send(res, 200, scenario);
  }

  function parseVersionBody(body: unknown): {
    label: string;
    params: import("./types.js").ScenarioParams;
    demand: import("./types.js").DemandEntry[];
    horizonSteps: number;
  } {
    const o = requireObject(body, "body");
    const params = requireObject(o.params, "params");
    const demandRaw = o.demand;
    if (!Array.isArray(demandRaw)) throw new ValidationError("demand must be an array");
    const p = params as unknown as import("./types.js").ScenarioParams;
    return {
      label: str(o, "label"),
      horizonSteps: Math.trunc(num(o, "horizonSteps")),
      params: {
        cellLengthKm: numArray(params, "cellLengthKm"),
        vf: num(params, "vf"),
        w: num(params, "w"),
        rhoCrit: num(params, "rhoCrit"),
        rhoJam: num(params, "rhoJam"),
        capacity: numArray(params, "capacity"),
        dtHours: num(params, "dtHours"),
        mergeCell: Math.trunc(num(params, "mergeCell")),
        bottleneckCell:
          params.bottleneckCell === undefined ? -1 : Math.trunc(num(params, "bottleneckCell")),
        mainlinePriority: num(params, "mainlinePriority"),
        initialDensity: params.initialDensity === undefined ? undefined : numArray(params, "initialDensity"),
      },
      demand: demandRaw.map((d, i) => parseDemand(requireObject(d, `demand[${i}]`), i)),
    };
  }

  function numArray(o: Record<string, unknown>, key: string): number[] {
    const v = o[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "number" || !Number.isFinite(x)))
      throw new ValidationError(`${key} must be an array of finite numbers`);
    return v as number[];
  }

  function parseDemand(o: Record<string, unknown>, i: number): import("./types.js").DemandEntry {
    const meter = o.meterRate;
    return {
      startStep: Math.trunc(num(o, "startStep")),
      endStep: Math.trunc(num(o, "endStep")),
      mainDemand: num(o, "mainDemand"),
      rampDemand: num(o, "rampDemand"),
      meterRate: meter === null || meter === "off" ? 1e12 : typeof meter === "number" ? meter : 1e12,
      capacityFactor: o.capacityFactor === undefined ? 1 : num(o, "capacityFactor"),
    };
  }

  function addVersion(_req: IncomingMessage, res: ServerResponse, _u: URL, body: unknown, q: Record<string, string>) {
    const sid = intParam(q.sid, "scenarioId");
    svc.requireScenario(sid);
    const parsed = parseVersionBody(body);
    const version = svc.addVersion(sid, parsed.label, parsed.params, parsed.demand, parsed.horizonSteps, null);
    send(res, 201, version);
  }

  function listVersions(_req: IncomingMessage, res: ServerResponse, _u: URL, _b: unknown, q: Record<string, string>) {
    const sid = intParam(q.sid, "scenarioId");
    svc.requireScenario(sid);
    send(res, 200, { items: svc.repo.listVersions(sid) });
  }

  function getVersion(_req: IncomingMessage, res: ServerResponse, _u: URL, _b: unknown, q: Record<string, string>) {
    send(res, 200, svc.requireVersion(intParam(q.vid, "versionId")));
  }

  function forkVersion(_req: IncomingMessage, res: ServerResponse, _u: URL, body: unknown, q: Record<string, string>) {
    const vid = intParam(q.vid, "versionId");
    const o = requireObject(body, "body");
    const version = svc.forkVersion(vid, str(o, "label"), {
      params: (o.params ?? undefined) as import("./types.js").ScenarioParams | undefined,
      demand:
        o.demand === undefined
          ? undefined
          : (o.demand as unknown[]).map((d, i) => parseDemand(requireObject(d, `demand[${i}]`), i)),
      horizonSteps:
        o.horizonSteps === undefined ? undefined : Math.trunc(num(o, "horizonSteps")),
    });
    send(res, 201, version);
  }

  function runVersion(req: IncomingMessage, res: ServerResponse, _u: URL, body: unknown, q: Record<string, string>) {
    const vid = intParam(q.vid, "versionId");
    const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const idem = req.headers["idempotency-key"];
    const key = typeof idem === "string" && idem ? idem : typeof o.idempotencyKey === "string" ? o.idempotencyKey : null;
    const seed = typeof o.seed === "number" ? o.seed : undefined;
    const run = svc.runVersion(vid, key, seed);
    send(res, 201, run);
  }

  function getRun(_req: IncomingMessage, res: ServerResponse, _u: URL, _b: unknown, q: Record<string, string>) {
    const run = svc.repo.getRun(intParam(q.rid, "runId"));
    if (!run) throwNotFound(`run ${q.rid} not found`);
    send(res, 200, run);
  }

  function getSteps(_req: IncomingMessage, res: ServerResponse, url: URL, _b: unknown, q: Record<string, string>) {
    const rid = intParam(q.rid, "runId");
    const { limit, offset } = pagination(url);
    send(res, 200, svc.getStepsPage(rid, limit, offset));
  }

  function getLedger(_req: IncomingMessage, res: ServerResponse, _u: URL, _b: unknown, q: Record<string, string>) {
    send(res, 200, svc.conservationLedger(intParam(q.rid, "runId")));
  }

  function compare(_req: IncomingMessage, res: ServerResponse, _u: URL, body: unknown) {
    const o = requireObject(body, "body");
    const a = Math.trunc(num(o, "runA"));
    const b = Math.trunc(num(o, "runB"));
    send(res, 200, svc.compareRuns(a, b));
  }
}

function throwNotFound(message: string): never {
  throw new NotFoundError(message);
}

export function listenLocal(server: Server, preferredPort = 0): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(preferredPort, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferredPort;
      const close = () =>
        new Promise<void>((resolveClose, rejectClose) =>
          server.close((err) => (err ? rejectClose(err) : resolveClose()))
        );
      resolve({ port, close });
    });
  });
}
