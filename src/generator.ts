// Deterministic fictional road / demand generator.
// Randomness is injected through a seeded PRNG (mulberry32), so identical
// seeds always reproduce identical scenarios.

import type { DemandEntry, ScenarioParams } from "./types.ts";
import { METER_OFF } from "./engine.ts";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RoadGenOptions {
  numCells?: number;      // default 8
  cellLengthKm?: number;  // default 0.5 km
  vf?: number;            // default 90 km/h
  w?: number;             // default 20 km/h
  rhoCrit?: number;       // default 30 veh/km
  rhoJam?: number;        // default 120 veh/km
  baseCapacity?: number;  // veh/h, default 1800
  dtHours?: number;       // default 1/120 h = 30 s
  mergeCell?: number;     // default floor(numCells/2)
  bottleneckCell?: number; // default numCells - 2
  mainlinePriority?: number; // default 0.6
}

export function generateRoad(seed: number, opts: RoadGenOptions = {}): ScenarioParams {
  const rand = mulberry32(seed);
  const numCells = opts.numCells ?? 8;
  // 30 s steps with vf = 90 km/h require L >= 0.75 km (CFL).
  const l = opts.cellLengthKm ?? 0.8;
  // Consistent triangular FD: capacity = vf*rhoCrit = w*(rhoJam-rhoCrit) = 1800.
  const capacityBase = opts.baseCapacity ?? 1800;
  const params: ScenarioParams = {
    cellLengthKm: Array.from({ length: numCells }, () => l),
    vf: opts.vf ?? 60,
    w: opts.w ?? 15,
    rhoCrit: opts.rhoCrit ?? 30,
    rhoJam: opts.rhoJam ?? 150,
    // jitter stays at or below the FD envelope (1800 veh/h).
    capacity: Array.from({ length: numCells }, () => Math.round(capacityBase * (0.9 + rand() * 0.1))),
    dtHours: opts.dtHours ?? 1 / 120,
    mergeCell: opts.mergeCell ?? Math.floor(numCells / 2),
    bottleneckCell: opts.bottleneckCell ?? numCells - 2,
    mainlinePriority: opts.mainlinePriority ?? 0.6,
    initialDensity: new Array(numCells).fill(0),
  };
  // Fictional incident: the bottleneck cell carries a slightly lower capacity.
  params.capacity[params.bottleneckCell] = Math.round(capacityBase * 0.72);
  return params;
}

export interface DemandGenOptions {
  horizonSteps: number;
  peakMain?: number;   // veh/h
  peakRamp?: number;   // veh/h
  incident?: { startStep: number; endStep: number; capacityFactor: number };
  meterPlan?: { startStep: number; endStep: number; meterRate: number };
}

// Smooth bell-shaped demand centered around mid-horizon, bucketed into
// `segmentSteps`-long entries, plus an optional incident and ramp metering.
export function generateDemand(seed: number, opts: DemandGenOptions): DemandEntry[] {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const peakMain = opts.peakMain ?? 2200;
  const peakRamp = opts.peakRamp ?? 1100;
  const H = opts.horizonSteps;
  const segmentSteps = Math.max(1, Math.round(H / 12));
  const out: DemandEntry[] = [];
  for (let start = 0; start < H; start += segmentSteps) {
    const end = Math.min(H, start + segmentSteps);
    const mid = (start + end) / 2 / H;
    const bell = Math.exp(-9 * (mid - 0.5) * (mid - 0.5));
    const jitter = 0.9 + rand() * 0.2;
    const d: DemandEntry = {
      startStep: start,
      endStep: end,
      mainDemand: Math.round(peakMain * bell * jitter),
      rampDemand: Math.round(peakRamp * bell * (0.85 + rand() * 0.3)),
      meterRate: METER_OFF,
      capacityFactor: 1,
    };
    if (opts.incident && start >= opts.incident.startStep && end <= opts.incident.endStep) {
      d.capacityFactor = opts.incident.capacityFactor;
    }
    if (opts.meterPlan && start >= opts.meterPlan.startStep && end <= opts.meterPlan.endStep) {
      d.meterRate = opts.meterPlan.meterRate;
    }
    out.push(d);
  }
  return out;
}
