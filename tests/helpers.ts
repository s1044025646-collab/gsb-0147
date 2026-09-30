import { join } from "node:path";
import { rmSync } from "node:fs";
import { openDb, createRepo } from "../src/db.ts";
import { createService } from "../src/service.ts";
import { METER_OFF } from "../src/engine.ts";
import type { DemandEntry, ScenarioParams } from "../src/types.ts";

export function tmpDb(label: string): { path: string; service: ReturnType<typeof createService>; close: () => void } {
  const path = join("data", `test-${label}-${process.pid}-${Math.floor(Math.random() * 1e9)}.sqlite`);
  const db = openDb(path);
  const service = createService(createRepo(db));
  return {
    path,
    service,
    close: () => {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    },
  };
}

// A small, CFL-safe homogeneous road used across the fixture tests.
export function tinyRoad(overrides: Partial<ScenarioParams> = {}): ScenarioParams {
  return {
    cellLengthKm: [0.5, 0.5, 0.5, 0.5],
    vf: 60,
    w: 15,
    rhoCrit: 30,
    // Triangular FD consistency: capacity = vf*rhoCrit = w*(rhoJam - rhoCrit)
    // => 1800 = 60*30 = 15*(150-30).
    rhoJam: 150,
    capacity: [1800, 1800, 1800, 1800],
    dtHours: 1 / 120, // 30 s; vf*dt/L = 60/120/0.5 = 1.0
    mergeCell: 2,
    bottleneckCell: -1,
    mainlinePriority: 0.6,
    initialDensity: [0, 0, 0, 0],
    ...overrides,
  };
}

export function flatDemand(
  steps: number,
  main: number,
  ramp = 0,
  extra: Partial<DemandEntry> = {}
): DemandEntry[] {
  return [
    {
      startStep: 0,
      endStep: steps,
      mainDemand: main,
      rampDemand: ramp,
      meterRate: METER_OFF,
      capacityFactor: 1,
      ...extra,
    },
  ];
}
