// SQLite persistence layer. Migrations are idempotent and tracked in
// `schema_migrations`; every multi-statement write runs in a transaction so a
// failure rolls back completely.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DemandEntry, RunResult, RunRow, Scenario, ScenarioParams, Version } from "./types.ts";

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      parent_version_id INTEGER REFERENCES versions(id),
      params_json TEXT NOT NULL,
      demand_json TEXT NOT NULL,
      horizon_steps INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(scenario_id, label)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
      idempotency_key TEXT,
      seed INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed','failed')),
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(version_id, idempotency_key)
    );
  `);
  const applied = db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(1);
  void applied;
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface Repo {
  db: DatabaseSync;
  createScenario(name: string): Scenario;
  getScenario(id: number): Scenario | undefined;
  listScenarios(): Scenario[];
  addVersion(
    scenarioId: number,
    label: string,
    parentVersionId: number | null,
    params: ScenarioParams,
    demand: DemandEntry[],
    horizonSteps: number
  ): Version;
  getVersion(id: number): Version | undefined;
  listVersions(scenarioId: number): Version[];
  saveRun(
    versionId: number,
    seed: number,
    idempotencyKey: string | null,
    status: "completed" | "failed",
    result: RunResult | null,
    error: string | null
  ): RunRow;
  findRun(versionId: number, idempotencyKey: string | null): RunRow | undefined;
  getRun(id: number): RunRow | undefined;
  listRuns(versionId: number): RunRow[];
}

function rowToScenario(r: Record<string, unknown>): Scenario {
  return { id: r.id as number, name: r.name as string, created_at: r.created_at as string };
}

function rowToVersion(r: Record<string, unknown>): Version {
  return {
    id: r.id as number,
    scenario_id: r.scenario_id as number,
    label: r.label as string,
    parent_version_id: (r.parent_version_id ?? null) as number | null,
    params: JSON.parse(r.params_json as string) as ScenarioParams,
    demand: JSON.parse(r.demand_json as string) as DemandEntry[],
    horizonSteps: r.horizon_steps as number,
    created_at: r.created_at as string,
  };
}

function rowToRun(r: Record<string, unknown>): RunRow {
  return {
    id: r.id as number,
    version_id: r.version_id as number,
    status: r.status as "completed" | "failed",
    seed: r.seed as number,
    result: r.result_json ? (JSON.parse(r.result_json as string) as RunResult) : null,
    error: (r.error as string) ?? null,
    created_at: r.created_at as string,
  };
}

export function createRepo(db: DatabaseSync): Repo {
  return {
    db,
    createScenario(name) {
      const info = db.prepare("INSERT INTO scenarios(name) VALUES (?)").run(name);
      return this.getScenario(Number(info.lastInsertRowid))!;
    },
    getScenario(id) {
      const r = db.prepare("SELECT * FROM scenarios WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? rowToScenario(r) : undefined;
    },
    listScenarios() {
      return (db.prepare("SELECT * FROM scenarios ORDER BY id").all() as Record<string, unknown>[]).map(rowToScenario);
    },
    addVersion(scenarioId, label, parentVersionId, params, demand, horizonSteps) {
      const info = db
        .prepare(
          `INSERT INTO versions(scenario_id,label,parent_version_id,params_json,demand_json,horizon_steps)
           VALUES (?,?,?,?,?,?)`
        )
        .run(scenarioId, label, parentVersionId, JSON.stringify(params), JSON.stringify(demand), horizonSteps);
      return this.getVersion(Number(info.lastInsertRowid))!;
    },
    getVersion(id) {
      const r = db.prepare("SELECT * FROM versions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return r ? rowToVersion(r) : undefined;
    },
    listVersions(scenarioId) {
      return (
        db.prepare("SELECT * FROM versions WHERE scenario_id = ? ORDER BY id").all(scenarioId) as Record<
          string,
          unknown
        >[]
      ).map(rowToVersion);
    },
    saveRun(versionId, seed, idempotencyKey, status, result, error) {
      const info = db
        .prepare(
          `INSERT INTO runs(version_id,idempotency_key,seed,status,result_json,error)
           VALUES (?,?,?,?,?,?)`
        )
        .run(versionId, idempotencyKey, seed, status, result ? JSON.stringify(result) : null, error);
      return this.getRun(Number(info.lastInsertRowid))!;
    },
    findRun(versionId, idempotencyKey) {
      if (idempotencyKey == null) return undefined;
      const r = db
        .prepare("SELECT * FROM runs WHERE version_id = ? AND idempotency_key = ?")
        .get(versionId, idempotencyKey) as Record<string, unknown> | undefined;
      return r ? rowToRun(r) : undefined;
    },
    getRun(id) {
      const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return r ? rowToRun(r) : undefined;
    },
    listRuns(versionId) {
      return (
        db.prepare("SELECT * FROM runs WHERE version_id = ? ORDER BY id").all(versionId) as Record<
          string,
          unknown
        >[]
      ).map(rowToRun);
    },
  };
}
