#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../db/database.js";
import { Repo } from "../db/repo.js";
import { generateDemand, makeFictionalRoad } from "../core/generator.js";
import { validateRoad } from "../core/fd.js";
import { compareRuns, conservationLedger, runScenario } from "../core/service.js";
import { runDemo } from "./demo.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(here, "..", "..", "data", "app.db");

interface CliCtx {
  repo: Repo;
  dbPath: string;
}

function fmt(n: number, d = 3): string {
  return (Math.round(n * 10 ** d) / 10 ** d).toFixed(d);
}

function header(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function printRoadSummary(repo: Repo, scnId: string): void {
  const scn = repo.getScenario(scnId)!;
  const demand = repo.getDemand(scnId);
  process.stdout.write(
    `scenario=${scn.id} name="${scn.name}" v${scn.version} cells=${scn.road.cellCount} ` +
      `dx=${scn.road.cellLength}km dt=${(scn.road.dt * 3600).toFixed(1)}s ` +
      `vf=${scn.road.freeFlowSpeed} w=${scn.road.waveSpeed} kj=${scn.road.jamDensity} ` +
      `cap=${scn.road.capacity} mergeCell=${scn.road.mergeCell} priority=${scn.road.mergePriority}\n` +
      `demand intervals=${demand.length} horizon=${scn.road.horizonSteps} steps\n`,
  );
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const dbPath = process.env.CTM_DB
    ? resolve(process.env.CTM_DB)
    : args.find((a) => a.startsWith("--db="))?.slice(5)
      ? resolve(args.find((a) => a.startsWith("--db="))!.slice(5))
      : DEFAULT_DB;
  const db = openDatabase(dbPath);
  const repo = new Repo(db);
  const ctx: CliCtx = { repo, dbPath };

  try {
    switch (command) {
      case "init-road":
        return cmdInitRoad(ctx, args);
      case "import-demand":
        return cmdImportDemand(ctx, args);
      case "run":
        return cmdRun(ctx, args);
      case "query":
        return cmdQuery(ctx, args);
      case "compare":
        return cmdCompare(ctx, args);
      case "ledger":
        return cmdLedger(ctx, args);
      case "list":
        return cmdList(ctx, args);
      case "demo":
        return await runDemo(ctx);
      case "help":
      default:
        printHelp();
        return command === "help" ? 0 : 2;
    }
  } finally {
    db.close();
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function cmdInitRoad(ctx: CliCtx, args: string[]): number {
  const file = flag(args, "file");
  let name = flag(args, "name") ?? "fictional";
  let seed = Number(flag(args, "seed") ?? "7");
  let spec;
  if (file) {
    const body = parseJsonFile(file) as {
      name?: string;
      seed?: number;
      road?: Parameters<typeof makeFictionalRoad>[0];
      demandOptions?: Parameters<typeof generateDemand>[1];
    };
    name = body.name ?? name;
    seed = body.seed ?? seed;
    const road = makeFictionalRoad(body.road ?? {});
    const demand = generateDemand(road, { seed, ...(body.demandOptions ?? {}) });
    spec = { name, road, demand };
  } else {
    const road = makeFictionalRoad({});
    const demand = generateDemand(road, { seed });
    spec = { name, road, demand };
  }
  validateRoad(spec.road);
  header("BEFORE create");
  const before = ctx.repo.listScenarios(100, 0).total;
  process.stdout.write(`scenarios in db: ${before}\n`);
  const created = ctx.repo.createScenario(spec, seed);
  header("AFTER create");
  printRoadSummary(ctx.repo, created.id);
  process.stdout.write(`scenario id: ${created.id}\n`);
  return 0;
}

function cmdImportDemand(ctx: CliCtx, args: string[]): number {
  const scnId = flag(args, "scenario");
  const file = flag(args, "file");
  if (!scnId || !file) throw new Error("usage: import-demand --scenario <id> --file <demand.json>");
  header("BEFORE import");
  const before = ctx.repo.getScenario(scnId);
  if (!before) throw new Error(`scenario ${scnId} not found`);
  process.stdout.write(`version=${before.version} intervals=${ctx.repo.getDemand(scnId).length}\n`);
  const body = parseJsonFile(file) as { demand: Parameters<Repo["replaceDemand"]>[1] };
  const updated = ctx.repo.updateScenario(scnId, { demand: body.demand });
  header("AFTER import");
  process.stdout.write(`version=${updated.version} intervals=${body.demand.length} (old runs remain tied to v${before.version})\n`);
  return 0;
}

function buildOverrides(args: string[]) {
  const overrides: {
    bottlenecks?: { cell: number; factor: number; tStart: number; tEnd: number }[];
    rampMeters?: { rate: number; tStart: number; tEnd: number }[];
  } = {};
  const bottleneck = flag(args, "bottleneck"); // cell:factor:tStart:tEnd
  if (bottleneck) {
    const [cell, factor, tStart, tEnd] = bottleneck.split(":").map(Number);
    overrides.bottlenecks = [{ cell, factor, tStart, tEnd }];
  }
  const meter = flag(args, "meter"); // rate:tStart:tEnd
  if (meter) {
    const [rate, tStart, tEnd] = meter.split(":").map(Number);
    overrides.rampMeters = [{ rate, tStart, tEnd }];
  }
  const file = flag(args, "overrides");
  if (file) Object.assign(overrides, parseJsonFile(file) as typeof overrides);
  return overrides;
}

function cmdRun(ctx: CliCtx, args: string[]): number {
  const scnId = flag(args, "scenario");
  if (!scnId) throw new Error("usage: run --scenario <id> [--label ..] [--idempotency-key ..] [--bottleneck cell:factor:t0:t1] [--meter rate:t0:t1]");
  const label = flag(args, "label") ?? "run";
  const key = flag(args, "idempotency-key");
  const overrides = buildOverrides(args);
  header("BEFORE run");
  printRoadSummary(ctx.repo, scnId);
  process.stdout.write(`existing runs: ${ctx.repo.listRuns(scnId, 1000, 0).total}\n`);
  const { run, reused, report } = runScenario(ctx.repo, scnId, label, overrides, key ?? null);
  header(reused ? "AFTER run (reused idempotent)" : "AFTER run (new)");
  process.stdout.write(
    `run=${run.id} label="${label}" v${run.scenarioVersion}\n` +
      `outflow=${fmt(report.cumulativeOutflow)} veh  served=${fmt(report.servedVehicles)} veh  ` +
      `unservedQueued=${fmt(report.unservedQueued)} veh\n` +
      `congestionOnset=${report.congestionOnset ?? "-"}  peakDensity=${fmt(report.peakDensity.value)} veh/km\n` +
      `queueDelay=${fmt(report.queueDelayVehH)} veh·h  totalDelay=${fmt(report.totalVehH)} veh·h  ` +
      `residual=${fmt(report.ledger.residual, 9)} veh\n`,
  );
  return 0;
}

function cmdQuery(ctx: CliCtx, args: string[]): number {
  const runId = flag(args, "run");
  if (!runId) throw new Error("usage: query --run <id> [--from t] [--to t]");
  const run = ctx.repo.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const from = Number(flag(args, "from") ?? "0");
  const toArg = flag(args, "to");
  const { rows } = ctx.repo.getSteps(runId, run.scenarioVersion >= 0 ? 1_000_000 : 100, 0);
  const to = toArg != null ? Number(toArg) : Infinity;
  header(`steps for run ${runId} (t ${from}..${toArg ?? "end"})`);
  process.stdout.write("  t | density(veh/km) by cell            | upQ    rampQ  | out\n");
  for (const s of rows) {
    if (s.t < from || s.t > to) continue;
    const dens = s.density.map((d) => fmt(d, 1).padStart(6)).join(" ");
    process.stdout.write(
      `${String(s.t).padStart(4)} | ${dens} | ${fmt(s.upQueue).padStart(6)} ${fmt(s.rampQueue).padStart(6)} | ${fmt(s.outflow)}\n`,
    );
  }
  return 0;
}

function cmdCompare(ctx: CliCtx, args: string[]): number {
  const a = flag(args, "a");
  const b = flag(args, "b");
  if (!a || !b) throw new Error("usage: compare --a <runId> --b <runId>");
  const cmp = compareRuns(ctx.repo, a, b);
  header(`compare ${cmp.a.label} -> ${cmp.b.label}`);
  for (const m of cmp.metrics) {
    process.stdout.write(`${m.metric.padEnd(22)} a=${fmt(m.a)} b=${fmt(m.b)} delta=${fmt(m.delta)} ${m.unit}\n`);
  }
  return 0;
}

function cmdLedger(ctx: CliCtx, args: string[]): number {
  const runId = flag(args, "run");
  const out = flag(args, "out");
  if (!runId) throw new Error("usage: ledger --run <id> [--out file.json]");
  const ledger = conservationLedger(ctx.repo, runId);
  header(`conservation ledger ${runId}`);
  for (const [k, v] of Object.entries(ledger)) {
    process.stdout.write(`${k.padEnd(22)} ${fmt(Number(v), 6)} veh\n`);
  }
  if (out) {
    writeFileSync(resolve(out), JSON.stringify({ runId, ledger }, null, 2));
    process.stdout.write(`\nexported -> ${resolve(out)}\n`);
  }
  return 0;
}

function cmdList(ctx: CliCtx, args: string[]): number {
  const scnId = flag(args, "scenario");
  if (scnId) {
    const { rows } = ctx.repo.listRuns(scnId, 1000, 0);
    for (const r of rows) process.stdout.write(`${r.id}  v${r.scenarioVersion}  ${r.label}\n`);
  } else {
    const { rows } = ctx.repo.listScenarios(1000, 0);
    for (const s of rows) process.stdout.write(`${s.id}  v${s.version}  ${s.name}\n`);
  }
  return 0;
}

function printHelp(): void {
  process.stdout.write(
    [
      "ctm <command> [--db=path]",
      "  init-road   [--name s] [--seed n] [--file road.json]",
      "  import-demand --scenario <id> --file demand.json",
      "  run         --scenario <id> [--label s] [--idempotency-key k]",
      "              [--bottleneck cell:factor:tStart:tEnd] [--meter rate:tStart:tEnd]",
      "              [--overrides file.json]",
      "  query       --run <id> [--from t] [--to t]",
      "  compare     --a <runId> --b <runId>",
      "  ledger      --run <id> [--out file.json]",
      "  list        [--scenario <id>]",
      "  demo        (reproducible end-to-end walkthrough)",
      "",
    ].join("\n"),
  );
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`error [${(err as { code?: string }).code ?? "ERROR"}]: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
