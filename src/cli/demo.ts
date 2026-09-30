import type { Repo } from "../db/repo.js";
import { generateDemand, makeFictionalRoad } from "../core/generator.js";
import { compareRuns, conservationLedger, runScenario } from "../core/service.js";

interface CliCtx {
  repo: Repo;
  dbPath: string;
}

/**
 * Fully deterministic end-to-end demo. Same seed + inputs always produce the
 * same numbers (no wall-clock or Math.random dependence).
 */
export async function runDemo(ctx: CliCtx): Promise<number> {
  const { repo } = ctx;
  const say = (m: string) => process.stdout.write(`${m}\n`);

  say("CTM deterministic end-to-end demo");
  say(`db: ${ctx.dbPath}`);

  const seed = 42;
  const road = makeFictionalRoad({ cellCount: 8, mergeCell: 4, horizonSteps: 240 });
  const demand = generateDemand(road, { seed, peakLoad: 1.05, rampLoad: 0.18 });
  const scn = repo.createScenario({ name: "demo-corridor", road, demand }, seed);
  say(`\n[1] scenario ${scn.id} v${scn.version} (${road.cellCount} cells, ${road.horizonSteps} steps)`);

  // Baseline run.
  const base = runScenario(repo, scn.id, "baseline", {}, "demo-baseline");
  say(
    `[2] baseline: outflow=${base.report.cumulativeOutflow.toFixed(2)} ` +
      `unserved=${base.report.unservedQueued.toFixed(2)} onset=${base.report.congestionOnset ?? "-"}`,
  );

  // Bottleneck: cell 5 drops to 45% capacity for a window -> new run.
  const bottleneck = runScenario(
    repo,
    scn.id,
    "bottleneck-cell5",
    { bottlenecks: [{ cell: 5, factor: 0.45, tStart: 60, tEnd: 160 }] },
    "demo-bottleneck",
  );
  say(
    `[3] bottleneck: outflow=${bottleneck.report.cumulativeOutflow.toFixed(2)} ` +
      `unserved=${bottleneck.report.unservedQueued.toFixed(2)} onset=${bottleneck.report.congestionOnset ?? "-"}`,
  );

  // Bottleneck + ramp metering to protect the merge.
  const metered = runScenario(
    repo,
    scn.id,
    "bottleneck+metering",
    {
      bottlenecks: [{ cell: 5, factor: 0.45, tStart: 60, tEnd: 160 }],
      rampMeters: [{ rate: 250, tStart: 60, tEnd: 160 }],
    },
    "demo-metered",
  );
  say(
    `[4] metered:    outflow=${metered.report.cumulativeOutflow.toFixed(2)} ` +
      `unserved=${metered.report.unservedQueued.toFixed(2)} onset=${metered.report.congestionOnset ?? "-"}`,
  );

  say("\n[5] compare baseline -> bottleneck");
  const cmp = compareRuns(repo, base.run.id, bottleneck.run.id);
  for (const m of cmp.metrics) say(`    ${m.metric.padEnd(20)} delta=${m.delta.toFixed(3)} ${m.unit}`);

  say("\n[6] conservation ledger (metered)");
  const ledger = conservationLedger(repo, metered.run.id);
  say(`    arrivals=${(ledger.totalMainArrivals + ledger.totalRampArrivals).toFixed(3)}`);
  say(`    served(outflow)=${ledger.totalOutflow.toFixed(3)} onRoad=${ledger.vehiclesOnRoad.toFixed(3)} queued=${ledger.queuedTotal.toFixed(3)}`);
  say(`    residual=${ledger.residual.toExponential(2)} (must be ~0; final queues are NOT served)`);

  // Idempotency: repeat baseline with same key -> reused, identical run id.
  const again = runScenario(repo, scn.id, "baseline", {}, "demo-baseline");
  say(`\n[7] idempotent resubmit reused=${again.reused} sameRun=${again.run.id === base.run.id}`);
  say("\nDemo complete.");
  return 0;
}
