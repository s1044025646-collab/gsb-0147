import type { Repo, RunRow } from "../db/repo.js";
import { coded } from "../db/repo.js";
import { simulate } from "./engine.js";
import type { RunOverrides, RunReport } from "./types.js";

export interface CreatedRun {
  run: RunRow;
  reused: boolean;
  report: RunReport;
}

/** Compute a run from the persisted scenario and store it (new run per change). */
export function runScenario(
  repo: Repo,
  scenarioId: string,
  label: string,
  overrides: RunOverrides,
  idempotencyKey?: string | null,
): CreatedRun {
  const spec = repo.getSpec(scenarioId);
  if (!spec) throw coded("NOT_FOUND", `scenario ${scenarioId} not found`);
  const result = simulate(spec.road, spec.demand, { overrides });
  const { run, reused } = repo.insertRunWithOverrides(
    scenarioId,
    label,
    overrides,
    result,
    { idempotencyKey: idempotencyKey ?? null },
  );
  return { run, reused, report: result.report };
}

export interface RunComparison {
  a: { runId: string; label: string };
  b: { runId: string; label: string };
  metrics: {
    metric: string;
    a: number;
    b: number;
    delta: number;
    unit: string;
  }[];
}

/** Compare two runs (e.g. baseline vs bottleneck / ramp metering scheme). */
export function compareRuns(repo: Repo, runIdA: string, runIdB: string): RunComparison {
  const a = repo.getRun(runIdA);
  const b = repo.getRun(runIdB);
  if (!a) throw coded("NOT_FOUND", `run ${runIdA} not found`);
  if (!b) throw coded("NOT_FOUND", `run ${runIdB} not found`);
  const ra = repo.getReport(runIdA)!;
  const rb = repo.getReport(runIdB)!;
  const row = (metric: string, x: number, y: number, unit: string) => ({
    metric,
    a: round(x),
    b: round(y),
    delta: round(y - x),
    unit,
  });
  return {
    a: { runId: a.id, label: a.label },
    b: { runId: b.id, label: b.label },
    metrics: [
      row("cumulativeOutflow", ra.cumulativeOutflow, rb.cumulativeOutflow, "veh"),
      row("servedVehicles", ra.servedVehicles, rb.servedVehicles, "veh"),
      row("unservedQueued", ra.unservedQueued, rb.unservedQueued, "veh"),
      row("queueDelay", ra.queueDelayVehH, rb.queueDelayVehH, "veh·h"),
      row("totalDelay", ra.totalVehH, rb.totalVehH, "veh·h"),
      row("peakDensity", ra.peakDensity.value, rb.peakDensity.value, "veh/km"),
      row("conservationResidual", ra.ledger.residual, rb.ledger.residual, "veh"),
    ],
  };
}

export function conservationLedger(repo: Repo, runId: string): RunReport["ledger"] {
  const report = repo.getReport(runId);
  if (!report) throw coded("NOT_FOUND", `run ${runId} not found`);
  return report.ledger;
}

function round(x: number): number {
  return Math.abs(x) < 1e-9 ? 0 : Math.round(x * 1e6) / 1e6;
}
