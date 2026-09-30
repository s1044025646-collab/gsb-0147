import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

let counter = 0;

/** Open (creating the file/folder) and run idempotent migrations. */
export function openDatabase(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  migrate(db);
  return db;
}

/**
 * Idempotent migrations tracked in schema_migrations. Safe to run repeatedly
 * against the same database (used on every startup / restart).
 */
export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (const m of MIGRATIONS) {
    const row = db.prepare("SELECT version FROM schema_migrations WHERE version=?").get(m.version) as
      | { version: number }
      | undefined;
    if (!row) {
      db.exec("BEGIN");
      try {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations(version,name) VALUES(?,?)").run(m.version, m.name);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }
}

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "scenarios",
    sql: `
    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      seed INTEGER,
      road_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS demand_intervals (
      scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      t_start INTEGER NOT NULL,
      t_end INTEGER NOT NULL,
      main_flow REAL NOT NULL,
      ramp_flow REAL NOT NULL,
      PRIMARY KEY (scenario_id, t_start)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      scenario_version INTEGER NOT NULL,
      label TEXT NOT NULL,
      overrides_json TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(scenario_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS run_steps (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      t INTEGER NOT NULL,
      counts_json TEXT NOT NULL,
      density_json TEXT NOT NULL,
      up_queue REAL NOT NULL,
      ramp_queue REAL NOT NULL,
      up_inflow REAL NOT NULL,
      ramp_inflow REAL NOT NULL,
      outflow REAL NOT NULL,
      merge_main REAL NOT NULL,
      merge_ramp REAL NOT NULL,
      PRIMARY KEY (run_id, t)
    );
    CREATE TABLE IF NOT EXISTS run_reports (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      report_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_scenario ON runs(scenario_id);
    CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps(run_id, t);
    `,
  },
];

export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  const t = process.hrtime.bigint().toString(36);
  return `${prefix}_${Date.now().toString(36)}${t}${counter.toString(36)}`;
}

/** Run fn in a transaction with rollback on any error. */
export function withTransaction<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
