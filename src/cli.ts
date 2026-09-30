// Command line interface. Every mutating command prints a compact
// "before -> after" view so operators can see what changed.

import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, createRepo } from "./db.ts";
import { createService } from "./service.ts";
import { generateRoad, generateDemand } from "./generator.ts";
import { METER_OFF } from "./engine.ts";
import type { DemandEntry, ScenarioParams } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const dbPath = process.env.CTM_DB ?? join(projectRoot, "data", "ctm.sqlite");
const db = openDb(dbPath);
const svc = createService(createRepo(db));

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  fail(`missing --${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function numArg(name: string): number {
  const v = Number(arg(name));
  if (!Number.isFinite(v)) fail(`--${name} must be a number`);
  return v;
}
function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p);
}

function printScenarioBrief() {
  console.log("scenarios:", svc.repo.listScenarios().map((s) => `${s.id}:${s.name}`).join(", ") || "(none)");
}

function fmtParams(p: ScenarioParams): string {
  return `cells=${p.cellLengthKm.length} vf=${p.vf} w=${p.w} rhoCrit=${p.rhoCrit} rhoJam=${p.rhoJam} dt=${p.dtHours}h mergeCell=${p.mergeCell} bottleneckCell=${p.bottleneckCell} priority=${p.mainlinePriority}`;
}

const command = process.argv[2];

try {
  switch (command) {
    case "init-road": {
      const name = arg("name");
      const seed = Number(opt("seed") ?? "1");
      const horizon = Number(opt("horizon") ?? "240");
      printScenarioBrief();
      const scenario = svc.createScenario(name);
      const params = generateRoad(seed);
      const demand = generateDemand(seed, {
        horizonSteps: horizon,
        incident: { startStep: Math.floor(horizon * 0.4), endStep: Math.floor(horizon * 0.7), capacityFactor: 0.5 },
      });
      const version = svc.addVersion(scenario.id, "baseline", params, demand, horizon, null);
      console.log(`created scenario #${scenario.id} ${scenario.name}`);
      console.log(`baseline version #${version.id}: ${fmtParams(params)}`);
      console.log(`capacity per cell: [${params.capacity.join(", ")}] veh/h`);
      break;
    }
    case "list": {
      for (const s of svc.repo.listScenarios()) {
        console.log(`scenario #${s.id} ${s.name}`);
        for (const v of svc.repo.listVersions(s.id)) {
          console.log(`  version #${v.id} ${v.label} (parent ${v.parent_version_id ?? "-"}) horizon=${v.horizonSteps}`);
          for (const r of svc.repo.listRuns(v.id)) {
            console.log(`    run #${r.id} ${r.status} seed=${r.seed}`);
          }
        }
      }
      break;
    }
    case "import-demand": {
      const vid = numArg("version");
      const file = resolvePath(arg("file"));
      const label = arg("label");
      const version = svc.requireVersion(vid);
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
        demand: DemandEntry[];
        horizonSteps?: number;
      };
      if (!Array.isArray(parsed.demand)) fail("file must contain a demand array");
      const before = `version #${version.id} demand entries=${version.demand.length}`;
      const nv = svc.forkVersion(vid, label, {
        demand: parsed.demand,
        horizonSteps: parsed.horizonSteps ?? version.horizonSteps,
      });
      console.log(`before: ${before}`);
      console.log(`after : new version #${nv.id} demand entries=${nv.demand.length} horizon=${nv.horizonSteps}`);
      break;
    }
    case "bottleneck": {
      const vid = numArg("version");
      const factor = numArg("factor");
      const label = arg("label");
      const version = svc.requireVersion(vid);
      const demand = version.demand.map((d) => ({ ...d }));
      const startStep = Number(opt("start") ?? "0");
      const endStep = Number(opt("end") ?? String(version.horizonSteps));
      for (const d of demand) {
        if (d.startStep >= startStep && d.endStep <= endStep) d.capacityFactor = factor;
      }
      const beforeCap = version.params.capacity[version.params.bottleneckCell];
      const nv = svc.forkVersion(vid, label, { demand });
      console.log(
        `before: version #${version.id} bottleneck cell ${version.params.bottleneckCell} base cap ${beforeCap} veh/h, interval factors=[${[
          ...new Set(version.demand.map((d) => d.capacityFactor)),
        ].join(",")}]`
      );
      console.log(
        `after : new version #${nv.id} factor ${factor} on steps [${startStep},${endStep}); base cap unchanged ${beforeCap} veh/h`
      );
      break;
    }
    case "meter": {
      const vid = numArg("version");
      const rate = numArg("rate");
      const label = arg("label");
      const version = svc.requireVersion(vid);
      const startStep = Number(opt("start") ?? "0");
      const endStep = Number(opt("end") ?? String(version.horizonSteps));
      const demand = version.demand.map((d) => {
        if (d.startStep >= startStep && d.endStep <= endStep) return { ...d, meterRate: rate };
        return { ...d };
      });
      const nv = svc.forkVersion(vid, label, { demand });
      const beforeMetered = version.demand.filter((d) => d.meterRate < METER_OFF / 2).length;
      const afterMetered = nv.demand.filter((d) => d.meterRate < METER_OFF / 2).length;
      console.log(`before: version #${version.id} metered entries=${beforeMetered}`);
      console.log(`after : new version #${nv.id} metered entries=${afterMetered} rate=${rate} veh/h on [${startStep},${endStep})`);
      break;
    }
    case "run": {
      const vid = numArg("version");
      const idem = opt("idempotency-key") ?? null;
      const seed = opt("seed") ? Number(opt("seed")) : undefined;
      const version = svc.requireVersion(vid);
      console.log(`before: version #${version.id} runs=${svc.repo.listRuns(vid).length}`);
      const run = svc.runVersion(vid, idem, seed);
      if (run.status !== "completed") fail(`simulation failed: ${run.error}`);
      const t = run.result!.totals;
      console.log(`after : run #${run.id} completed (seed ${run.seed}, idem ${idem ?? "-"})`);
      console.log(
        `  demand main=${t.mainDemandVeh} ramp=${t.rampDemandVeh} | entered=${t.enteredVeh} exited=${t.exitedVeh} onRoad=${t.onRoadVeh} unserved=${(t.mainUnservedVeh + t.rampUnservedVeh).toFixed(3)} delay=${t.totalDelayVehH.toFixed(3)} veh-h`
      );
      break;
    }
    case "query": {
      const rid = numArg("run");
      const step = Number(opt("step") ?? "0");
      const { result } = svc.requireCompletedRun(rid);
      const s = result.steps[Math.min(step, result.steps.length - 1)];
      console.log(`run #${rid} step ${s.step} t=${s.timeHours}h`);
      console.log(`density veh/km: [${s.density.map((x) => x.toFixed(2)).join(", ")}]`);
      console.log(`counts veh    : [${s.n.map((x) => x.toFixed(3)).join(", ")}]`);
      console.log(`queues veh    : main=${s.mainQueue.toFixed(3)} ramp=${s.rampQueue.toFixed(3)}`);
      console.log(`flows this step: in=${s.inflow.toFixed(3)} out=${s.outflow.toFixed(3)} (main admitted ${s.mainAdmitted.toFixed(3)}, ramp ${s.rampAdmitted.toFixed(3)})`);
      break;
    }
    case "ledger": {
      const rid = numArg("run");
      const ledger = svc.conservationLedger(rid);
      const out = opt("out");
      console.log(JSON.stringify(ledger, null, 2));
      if (out) {
        const target = resolvePath(out);
        writeFileSync(target, JSON.stringify(ledger, null, 2), "utf-8");
        console.log(`ledger exported to ${target}`);
      }
      if (!ledger.balanced) fail("conservation ledger is unbalanced");
      break;
    }
    case "compare": {
      const a = numArg("a");
      const b = numArg("b");
      const cmp = svc.compareRuns(a, b);
      console.log(`compare run #${a} vs #${b}`);
      for (const [k, v] of Object.entries(cmp.metrics_a)) {
        const delta = (cmp.delta_b_minus_a as Record<string, number>)[k];
        console.log(`  ${k.padEnd(20)} a=${(v as number).toFixed(3)} b=${(cmp.metrics_b as unknown as Record<string, number>)[k].toFixed(3)} delta=${delta.toFixed(3)}`);
      }
      break;
    }
    default:
      console.log(
        [
          "usage: ctm <command> [options]",
          "commands:",
          "  init-road --name N [--seed S] [--horizon H]",
          "  list",
          "  import-demand --version V --file demand.json --label L",
          "  bottleneck --version V --factor F --label L [--start S] [--end E]",
          "  meter --version V --rate R --label L [--start S] [--end E]",
          "  run --version V [--idempotency-key K] [--seed S]",
          "  query --run R [--step S]",
          "  ledger --run R [--out file.json]",
          "  compare --a RUN_A --b RUN_B",
        ].join("\n")
      );
  }
} catch (err) {
  fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
} finally {
  db.close();
}
