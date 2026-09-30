import type { DB } from "./database.js";
import { newId, withTransaction } from "./database.js";
import type {
  DemandInterval,
  RoadParams,
  RunOverrides,
  ScenarioSpec,
  SimResult,
} from "../core/types.js";

export interface ScenarioRow {
  id: string;
  name: string;
  seed: number | null;
  road: RoadParams;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface RunRow {
  id: string;
  scenarioId: string;
  scenarioVersion: number;
  label: string;
  overrides: RunOverrides;
  idempotencyKey: string | null;
  createdAt: string;
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

export class Repo {
  constructor(
    private db: DB,
    private clock: () => Date = () => new Date(),
  ) {}

  createScenario(spec: ScenarioSpec, seed: number | null = null, id?: string): ScenarioRow {
    return withTransaction(this.db, () => {
      const sid = id ?? newId("scn");
      const ts = nowIso(this.clock);
      this.db
        .prepare(
          `INSERT INTO scenarios(id,name,seed,road_json,created_at,updated_at,version)
           VALUES(?,?,?,?,?,?,1)`,
        )
        .run(sid, spec.name, seed, JSON.stringify(spec.road), ts, ts);
      this.replaceDemand(sid, spec.demand);
      return this.getScenario(sid)!;
    });
  }

  replaceDemand(scenarioId: string, demand: DemandInterval[]): void {
    this.db.prepare("DELETE FROM demand_intervals WHERE scenario_id=?").run(scenarioId);
    const stmt = this.db.prepare(
      `INSERT INTO demand_intervals(scenario_id,t_start,t_end,main_flow,ramp_flow)
       VALUES(?,?,?,?,?)`,
    );
    for (const d of demand) stmt.run(scenarioId, d.tStart, d.tEnd, d.mainFlow, d.rampFlow);
  }

  /** Any change to the scenario definition bumps its version (forces new runs). */
  updateScenario(id: string, patch: { name?: string; road?: RoadParams; demand?: DemandInterval[] }): ScenarioRow {
    return withTransaction(this.db, () => {
      const current = this.getScenario(id);
      if (!current) throw coded("NOT_FOUND", `scenario ${id} not found`);
      const name = patch.name ?? current.name;
      const road = patch.road ?? current.road;
      const demand = patch.demand ?? this.getDemand(id);
      this.db
        .prepare(
          `UPDATE scenarios SET name=?, road_json=?, updated_at=?, version=version+1 WHERE id=?`,
        )
        .run(name, JSON.stringify(road), nowIso(this.clock), id);
      this.replaceDemand(id, demand);
      return this.getScenario(id)!;
    });
  }

  getScenario(id: string): ScenarioRow | null {
    const row = this.db.prepare("SELECT * FROM scenarios WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      seed: (row.seed as number | null) ?? null,
      road: JSON.parse(row.road_json as string) as RoadParams,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      version: row.version as number,
    };
  }

  getSpec(id: string): ScenarioSpec | null {
    const row = this.getScenario(id);
    if (!row) return null;
    return { name: row.name, road: row.road, demand: this.getDemand(id) };
  }

  getDemand(scenarioId: string): DemandInterval[] {
    const rows = this.db
      .prepare("SELECT * FROM demand_intervals WHERE scenario_id=? ORDER BY t_start")
      .all(scenarioId) as Record<string, unknown>[];
    return rows.map((r) => ({
      tStart: r.t_start as number,
      tEnd: r.t_end as number,
      mainFlow: r.main_flow as number,
      rampFlow: r.ramp_flow as number,
    }));
  }

  listScenarios(limit: number, offset: number): { rows: ScenarioRow[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) c FROM scenarios").get() as { c: number }).c;
    const rows = this.db
      .prepare("SELECT * FROM scenarios ORDER BY created_at DESC, id LIMIT ? OFFSET ?")
      .all(limit, offset) as Record<string, unknown>[];
    return { rows: rows.map((r) => this.getScenario(r.id as string)!), total };
  }

  /**
   * Idempotent run creation: a repeated (scenarioId, idempotencyKey) returns the
   * existing run instead of recomputing/duplicating. A scenario edit bumps its
   * version and makes an old key conflict, forcing a fresh run.
   */
  insertRunWithOverrides(
    scenarioId: string,
    label: string,
    overrides: RunOverrides,
    result: SimResult,
    opts: { idempotencyKey?: string | null } = {},
  ): { run: RunRow; reused: boolean } {
    return withTransaction(this.db, () => {
      const scn = this.getScenario(scenarioId);
      if (!scn) throw coded("NOT_FOUND", `scenario ${scenarioId} not found`);
      if (opts.idempotencyKey) {
        const existing = this.db
          .prepare("SELECT scenario_version FROM runs WHERE scenario_id=? AND idempotency_key=?")
          .get(scenarioId, opts.idempotencyKey) as { scenario_version: number } | undefined;
        if (existing) {
          if (existing.scenario_version !== scn.version) {
            throw coded(
              "CONFLICT",
              "scenario changed since this idempotency key was used; create a new run/key",
            );
          }
          const row = this.db
            .prepare("SELECT * FROM runs WHERE scenario_id=? AND idempotency_key=?")
            .get(scenarioId, opts.idempotencyKey) as Record<string, unknown>;
          return { run: this.runRow(row), reused: true };
        }
      }
      const rid = newId("run");
      this.db
        .prepare(
          `INSERT INTO runs(id,scenario_id,scenario_version,label,overrides_json,idempotency_key,created_at)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          rid,
          scenarioId,
          scn.version,
          label,
          JSON.stringify(overrides ?? {}),
          opts.idempotencyKey ?? null,
          nowIso(this.clock),
        );
      this.persistSteps(rid, result);
      this.db
        .prepare("INSERT INTO run_reports(run_id,report_json) VALUES(?,?)")
        .run(rid, JSON.stringify(result.report));
      return { run: this.getRun(rid)!, reused: false };
    });
  }

  private persistSteps(runId: string, result: SimResult): void {
    const stmt = this.db.prepare(
      `INSERT INTO run_steps(run_id,t,counts_json,density_json,up_queue,ramp_queue,
        up_inflow,ramp_inflow,outflow,merge_main,merge_ramp)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of result.steps) {
      stmt.run(
        runId,
        s.t,
        JSON.stringify(s.counts),
        JSON.stringify(s.density),
        s.upQueue,
        s.rampQueue,
        s.upInflow,
        s.rampInflow,
        s.outflow,
        s.mergeMainFlow,
        s.mergeRampFlow,
      );
    }
  }

  private runRow(r: Record<string, unknown>): RunRow {
    return {
      id: r.id as string,
      scenarioId: r.scenario_id as string,
      scenarioVersion: r.scenario_version as number,
      label: r.label as string,
      overrides: JSON.parse(r.overrides_json as string) as RunOverrides,
      idempotencyKey: (r.idempotency_key as string | null) ?? null,
      createdAt: r.created_at as string,
    };
  }

  getRun(id: string): RunRow | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? this.runRow(r) : null;
  }

  listRuns(scenarioId: string, limit: number, offset: number): { rows: RunRow[]; total: number } {
    const total = (
      this.db.prepare("SELECT COUNT(*) c FROM runs WHERE scenario_id=?").get(scenarioId) as { c: number }
    ).c;
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE scenario_id=? ORDER BY created_at, id LIMIT ? OFFSET ?")
      .all(scenarioId, limit, offset) as Record<string, unknown>[];
    return { rows: rows.map((r) => this.runRow(r)), total };
  }

  getSteps(runId: string, limit: number, offset: number): { rows: StepDto[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) c FROM run_steps WHERE run_id=?").get(runId) as {
      c: number;
    }).c;
    const rows = this.db
      .prepare("SELECT * FROM run_steps WHERE run_id=? ORDER BY t LIMIT ? OFFSET ?")
      .all(runId, limit, offset) as Record<string, unknown>[];
    return { rows: rows.map(this.stepRow), total };
  }

  private stepRow(r: Record<string, unknown>): StepDto {
    return {
      t: r.t as number,
      counts: JSON.parse(r.counts_json as string) as number[],
      density: JSON.parse(r.density_json as string) as number[],
      upQueue: r.up_queue as number,
      rampQueue: r.ramp_queue as number,
      upInflow: r.up_inflow as number,
      rampInflow: r.ramp_inflow as number,
      outflow: r.outflow as number,
      mergeMainFlow: r.merge_main as number,
      mergeRampFlow: r.merge_ramp as number,
    };
  }

  getReport(runId: string): SimResult["report"] | null {
    const r = this.db.prepare("SELECT report_json FROM run_reports WHERE run_id=?").get(runId) as
      | { report_json: string }
      | undefined;
    return r ? (JSON.parse(r.report_json) as SimResult["report"]) : null;
  }
}

export interface StepDto {
  t: number;
  counts: number[];
  density: number[];
  upQueue: number;
  rampQueue: number;
  upInflow: number;
  rampInflow: number;
  outflow: number;
  mergeMainFlow: number;
  mergeRampFlow: number;
}

export function coded(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e as Error & { code: string };
}
