import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, type DB } from "../db/database.js";
import { Repo } from "../db/repo.js";
import { generateDemand, makeFictionalRoad } from "../core/generator.js";
import { compareRuns, conservationLedger, runScenario } from "../core/service.js";
import { parseDemand, parseOverrides, parsePagination, parseRoad, ValidationError } from "./validation.js";
import { validateRoad } from "../core/fd.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(here, "..", "..", "data", "app.db");

interface AppContext {
  db: DB;
  repo: Repo;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.length;
    if (size > 1_000_000) throw new ValidationError("request body too large (>1MB)");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ValidationError("body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError("invalid JSON body");
  }
}

function pageEnvelope(rows: unknown[], total: number, page: number, limit: number) {
  return {
    data: rows,
    page: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

export function createApp(ctx: AppContext) {
  const { repo } = ctx;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      // Health
      if (req.method === "GET" && path === "/health") return send(res, 200, { status: "ok" });

      // Create scenario
      if (req.method === "POST" && path === "/scenarios") {
        const body = await readJson(req);
        let spec;
        if (body.fictional === true) {
          const seed = Number(body.seed ?? 1);
          const roadOpts = (body.road && typeof body.road === "object" ? body.road : {}) as Parameters<
            typeof makeFictionalRoad
          >[0];
          const road = makeFictionalRoad(roadOpts);
          const demandOptions = (body.demandOptions ?? {}) as Partial<Parameters<typeof generateDemand>[1]>;
          const demand = generateDemand(road, { seed: Number.isFinite(seed) ? seed : 1, ...demandOptions });
          spec = { name: String(body.name ?? "fictional"), road, demand };
        } else {
          const road = parseRoad(body);
          validateRoad(road);
          const demand = parseDemand(body);
          spec = { name: String(body.name ?? "scenario"), road, demand };
        }
        validateRoad(spec.road);
        const created = repo.createScenario(spec, body.seed != null ? Number(body.seed) : null);
        return send(res, 201, { data: scenarioDto(created, spec.demand) });
      }

      const scnMatch = path.match(/^\/scenarios\/([^/]+)$/);
      if (req.method === "GET" && scnMatch) {
        const scn = repo.getScenario(scnMatch![1]);
        if (!scn) return send(res, 404, errorBody("NOT_FOUND", "scenario not found"));
        return send(res, 200, { data: scenarioDto(scn, repo.getDemand(scn.id)) });
      }
      if (req.method === "GET" && path === "/scenarios") {
        const { page, limit, offset } = parsePagination(url.searchParams);
        const { rows, total } = repo.listScenarios(limit, offset);
        return send(res, 200, pageEnvelope(rows.map((s) => scenarioDto(s)), total, page, limit));
      }

      // Import / replace demand
      const demandMatch = path.match(/^\/scenarios\/([^/]+)\/demand$/);
      if (req.method === "PUT" && demandMatch) {
        const scn = repo.getScenario(demandMatch![1]);
        if (!scn) return send(res, 404, errorBody("NOT_FOUND", "scenario not found"));
        const demand = parseDemand(await readJson(req));
        const updated = repo.updateScenario(scn.id, { demand });
        return send(res, 200, { data: { version: updated.version } });
      }

      // Create run (new run per scheme modification)
      const runMatch = path.match(/^\/scenarios\/([^/]+)\/runs$/);
      if (req.method === "POST" && runMatch) {
        const body = await readJson(req);
        const overrides = parseOverrides(body);
        const label = String(body.label ?? "run");
        const idem = body.idempotencyKey != null ? String(body.idempotencyKey) : null;
        const result = runScenario(repo, runMatch![1], label, overrides, idem);
        return send(res, result.reused ? 200 : 201, {
          data: { run: result.run, report: result.report, reused: result.reused },
        });
      }
      if (req.method === "GET" && runMatch) {
        const { page, limit, offset } = parsePagination(url.searchParams);
        const { rows, total } = repo.listRuns(runMatch![1], limit, offset);
        return send(res, 200, pageEnvelope(rows, total, page, limit));
      }

      const stepsMatch = path.match(/^\/runs\/([^/]+)\/steps$/);
      if (req.method === "GET" && stepsMatch) {
        const run = repo.getRun(stepsMatch![1]);
        if (!run) return send(res, 404, errorBody("NOT_FOUND", "run not found"));
        const { page, limit, offset } = parsePagination(url.searchParams);
        const { rows, total } = repo.getSteps(run.id, limit, offset);
        return send(res, 200, pageEnvelope(rows, total, page, limit));
      }

      const reportMatch = path.match(/^\/runs\/([^/]+)\/report$/);
      if (req.method === "GET" && reportMatch) {
        const report = repo.getReport(reportMatch![1]);
        if (!report) return send(res, 404, errorBody("NOT_FOUND", "run not found"));
        return send(res, 200, { data: report });
      }

      const ledgerMatch = path.match(/^\/runs\/([^/]+)\/ledger$/);
      if (req.method === "GET" && ledgerMatch) {
        return send(res, 200, { data: conservationLedger(repo, ledgerMatch![1]) });
      }

      const compareMatch = path.match(/^\/runs\/([^/]+)\/compare\/([^/]+)$/);
      if (req.method === "GET" && compareMatch) {
        return send(res, 200, { data: compareRuns(repo, compareMatch![1], compareMatch![2]) });
      }

      return send(res, 404, errorBody("NOT_FOUND", `no route for ${req.method} ${path}`));
    } catch (e) {
      return mapError(res, e);
    }
  });
}

function mapError(res: ServerResponse, e: unknown): void {
  if (e instanceof ValidationError) return send(res, 400, errorBody("VALIDATION", e.message, e.details));
  const code = (e as { code?: string })?.code;
  if (code === "CFL") return send(res, 422, errorBody("CFL", (e as Error).message));
  if (code === "BAD_ROAD" || code === "BAD_DEMAND" || code === "BAD_OVERRIDE" || code === "BAD_INITIAL") {
    return send(res, 422, errorBody(code, (e as Error).message));
  }
  if (code === "NOT_FOUND") return send(res, 404, errorBody("NOT_FOUND", (e as Error).message));
  if (code === "CONFLICT") return send(res, 409, errorBody("CONFLICT", (e as Error).message));
  return send(res, 500, errorBody("INTERNAL", (e as Error)?.message ?? "internal error"));
}

function scenarioDto(s: import("../db/repo.js").ScenarioRow, demand?: unknown) {
  return {
    id: s.id,
    name: s.name,
    seed: s.seed,
    version: s.version,
    road: s.road,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...(demand !== undefined ? { demand } : {}),
  };
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** Bind only to loopback; port 0 lets the OS assign a free port automatically. */
export function startServer(dbPath = DEFAULT_DB, host = "127.0.0.1", port = 0): Promise<StartedServer> {
  const db = openDatabase(dbPath);
  const repo = new Repo(db);
  const server = createApp({ db, repo });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      const close = () =>
        new Promise<void>((res) => {
          server.close(() => {
            db.close();
            res();
          });
        });
      resolveStart({ server, port: bound, close });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.CTM_DB || DEFAULT_DB;
  startServer(dbPath).then(({ port }) => {
    process.stdout.write(`CTM API listening on http://127.0.0.1:${port} (db ${dbPath})\n`);
  });
}
