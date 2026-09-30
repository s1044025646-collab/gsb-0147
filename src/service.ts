// Application service: validates inputs, executes simulations, makes every
// scheme change a NEW immutable version/run, enforces idempotency, and produces
// conservation ledgers and scheme comparisons.

import { randomBytes } from "node:crypto";
import { simulate, validateDemand, validateParams } from "./engine.ts";
import { createRepo, tx, type Repo } from "./db.ts";
import type {
  DemandEntry,
  RunResult,
  RunRow,
  ScenarioParams,
  Version,
} from "./types.ts";

export class ValidationError extends Error {
 code = "VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
export class NotFoundError extends Error {
  code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
export class ConflictError extends Error {
  code = "CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface Clock {
  now(): string;
  randomSeed(): number;
}

export const defaultClock: Clock = {
  now: () => new Date().toISOString(),
  randomSeed: () => (randomBytes(4).readUInt32BE(0) >>> 0),
};

export class SimService {
  repo: Repo;
  clock: Clock;
  constructor(repo: Repo, clock: Clock = defaultClock) {
    this.repo = repo;
    this.clock = clock;
  }

  createScenario(name: string) {
    if (!name || !name.trim()) throw new ValidationError("name is required");
    return this.repo.createScenario(name.trim());
  }

  requireScenario(id: number) {
    const s = this.repo.getScenario(id);
    if (!s) throw new NotFoundError(`scenario ${id} not found`);
    return s;
  }

  requireVersion(id: number): Version {
    const v = this.repo.getVersion(id);
    if (!v) throw new NotFoundError(`version ${id} not found`);
    return v;
  }

  addVersion(
    scenarioId: number,
    label: string,
    params: ScenarioParams,
    demand: DemandEntry[],
    horizonSteps: number,
    parentVersionId: number | null
  ): Version {
    this.requireScenario(scenarioId);
    if (!label || !label.trim()) throw new ValidationError("label is required");
    const pErrs = validateParams(params);
    if (pErrs.length) throw new ValidationError(pErrs.join("; "));
    const dErrs = validateDemand(demand, horizonSteps);
    if (dErrs.length) throw new ValidationError(dErrs.join("; "));
    return tx(this.repo.db, () =>
      this.repo.addVersion(scenarioId, label.trim(), parentVersionId, params, demand, horizonSteps)
    );
  }

  // Create a new version from an existing one after applying changes. Scheme
  // edits never mutate a stored version; they always fork a new one.
  forkVersion(
    parentVersionId: number,
    label: string,
    patch: {
      params?: Partial<ScenarioParams>;
      demand?: DemandEntry[];
      horizonSteps?: number;
    }
  ): Version {
    const parent = this.requireVersion(parentVersionId);
    const params = { ...parent.params, ...(patch.params ?? {}) };
    const demand = patch.demand ?? parent.demand;
    const horizonSteps = patch.horizonSteps ?? parent.horizonSteps;
    return this.addVersion(parent.scenario_id, label, params, demand, horizonSteps, parent.id);
  }

  // Run a version. Repeating the same (versionId, idempotencyKey) returns the
  // stored run instead of recomputing it.
  runVersion(versionId: number, idempotencyKey: string | null, seed?: number): RunRow {
    const version = this.requireVersion(versionId);
    if (idempotencyKey) {
      const existing = this.repo.findRun(versionId, idempotencyKey);
      if (existing) return existing;
    }
    const usedSeed = seed ?? this.clock.randomSeed();
    try {
      const result = simulate({ params: version.params, demand: version.demand, horizonSteps: version.horizonSteps });
      return tx(this.repo.db, () =>
        this.repo.saveRun(versionId, usedSeed, idempotencyKey, "completed", result, null)
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return tx(this.repo.db, () =>
        this.repo.saveRun(versionId, usedSeed, idempotencyKey, "failed", null, message)
      );
    }
  }

 requireCompletedRun(runId: number): { run: RunRow; result: RunResult } {
    const run = this.repo.getRun(runId);
    if (!run) throw new NotFoundError(`run ${runId} not found`);
    if (run.status !== "completed" || !run.result)
      throw new ConflictError(`run ${runId} did not complete: ${run.error ?? "unknown error"}`);
    return { run, result: run.result };
  }

  getStepsPage(runId: number, limit: number, offset: number) {
    const { result } = this.requireCompletedRun(runId);
    const total = result.steps.length;
    const items = result.steps.slice(offset, offset + limit);
    return { items, total, limit, offset, hasMore: offset + items.length < total };
  }

  // Conservation ledger (vehicles are integers in the model; rounding is tiny).
  conservationLedger(runId: number) {
    const { run, result } = this.requireCompletedRun(runId);
    const t = result.totals;
    const totalDemand = t.mainDemandVeh + t.rampDemandVeh;
    const totalUnserved = t.mainUnservedVeh + t.rampUnservedVeh;
    // Every demanded vehicle is either still queued (unserved) or entered;
    // every entered vehicle is either on the road or exited.
    const enterGap = totalDemand - totalUnserved - t.enteredVeh;
    const onRoadGap = t.enteredVeh - t.exitedVeh - t.onRoadVeh;
    const residual = totalDemand - t.exitedVeh - t.onRoadVeh - totalUnserved;
    return {
      run_id: run.id,
      units: { count: "veh", flow: "veh/h", time: "h", density: "veh/km" },
      demand: { main: t.mainDemandVeh, ramp: t.rampDemandVeh, total: totalDemand },
      entered: t.enteredVeh,
      exited: t.exitedVeh,
      onRoadAtEnd: t.onRoadVeh,
      unservedAtEnd: { main: t.mainUnservedVeh, ramp: t.rampUnservedVeh, total: totalUnserved },
      gaps: {
        demandMinusUnservedMinusEntered: enterGap,
        enteredMinusExitedMinusOnRoad: onRoadGap,
        totalResidual: residual,
      },
      balanced: Math.abs(residual) < 1e-4,
      totalDelayVehH: t.totalDelayVehH,
    };
  }

  compareRuns(runIdA: number, runIdB: number) {
    const a = this.conservationLedger(runIdA);
    const b = this.conservationLedger(runIdB);
    const resA = this.requireCompletedRun(runIdA).result;
    const resB = this.requireCompletedRun(runIdB).result;
    const rhoCritA = this.repo.getVersion(this.repo.getRun(runIdA)!.version_id)!.params.rhoCrit;
    const rhoCritB = this.repo.getVersion(this.repo.getRun(runIdB)!.version_id)!.params.rhoCrit;
    const summarize = (r: RunResult, rhoCrit: number) => {
      let maxDensity = 0;
      let congestedCellSteps = 0;
      let peakMainQueue = 0;
      let peakRampQueue = 0;
      for (const s of r.steps) {
        peakMainQueue = Math.max(peakMainQueue, s.mainQueue);
        peakRampQueue = Math.max(peakRampQueue, s.rampQueue);
        for (const rho of s.density) {
          maxDensity = Math.max(maxDensity, rho);
          if (rho > rhoCrit) congestedCellSteps++;
        }
      }
      return {
        exitedVeh: r.totals.exitedVeh,
        totalDelayVehH: r.totals.totalDelayVehH,
        unservedVeh: r.totals.mainUnservedVeh + r.totals.rampUnservedVeh,
        maxDensity,
        congestedCellSteps,
        peakMainQueue,
        peakRampQueue,
      };
    };
    const sumA = summarize(resA, rhoCritA);
    const sumB = summarize(resB, rhoCritB);
    return {
      run_a: runIdA,
      run_b: runIdB,
      metrics_a: sumA,
      metrics_b: sumB,
      delta_b_minus_a: Object.fromEntries(
        Object.keys(sumA).map((k) => [k, (sumB as Record<string, number>)[k] - (sumA as Record<string, number>)[k]])
      ),
      ledger_a: a,
      ledger_b: b,
    };
  }
}

export function createService(repo: Repo, clock?: Clock) {
  return new SimService(repo, clock);
}
