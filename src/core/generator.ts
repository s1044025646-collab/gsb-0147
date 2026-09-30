import type { DemandInterval, RoadParams, Rng, ScenarioSpec } from "./types.js";
import { deriveFd, validateRoad } from "./fd.js";
import { mulberry32 } from "./rng.js";

export interface GenerateDemandOptions {
  seed: number;
  /** Base mainline flow as fraction of capacity, in [0,1]. */
  baseLoad?: number;
  /** Peak mainline flow as fraction of capacity, typically > baseLoad. */
  peakLoad?: number;
  /** On-ramp flow as fraction of capacity. */
  rampLoad?: number;
  /** Step interval at which the piecewise demand changes. */
  blockSteps?: number;
  /** Optional demand pulse [pulseStart, pulseEnd) in step indices. */
  pulse?: { start: number; end: number; load: number };
  rng?: Rng;
}

/**
 * Produce a fictitious, reproducible piecewise-constant boundary demand.
 * Randomness is confined to +/- jitter and injected via a seeded RNG.
 */
export function generateDemand(road: RoadParams, opts: GenerateDemandOptions): DemandInterval[] {
  validateRoad(road);
  const rng = opts.rng ?? mulberry32(opts.seed);
  const block = opts.blockSteps ?? Math.max(1, Math.round(road.horizonSteps / 8));
  const base = (opts.baseLoad ?? 0.55) * road.capacity;
  const peak = (opts.peakLoad ?? 0.95) * road.capacity;
  const ramp = (opts.rampLoad ?? 0.12) * road.capacity;

  const inPulse = (t: number): boolean =>
    !!opts.pulse && t >= opts.pulse.start && t < opts.pulse.end;

  const intervals: DemandInterval[] = [];
  for (let start = 0; start < road.horizonSteps; start += block) {
    const end = Math.min(road.horizonSteps, start + block);
    // Alternate base/peak blocks, with small deterministic jitter.
    const blockIndex = Math.floor(start / block);
    const usePeak = blockIndex % 2 === 1;
    let level = usePeak ? peak : base;
    level *= 0.92 + rng.next() * 0.16; // +/- ~8%
    if (inPulse(start)) level = opts.pulse!.load * road.capacity;
    const rampLevel = ramp * (0.85 + rng.next() * 0.3);
    intervals.push({
      tStart: start,
      tEnd: end,
      mainFlow: Math.max(0, level),
      rampFlow: Math.max(0, rampLevel),
    });
  }
  normalizeIntervals(intervals, road.horizonSteps);
  return intervals;
}

/** Validate a demand table covers every step [0,horizon) without overlap/gap. */
export function normalizeIntervals(intervals: DemandInterval[], horizon: number): void {
  const bad = (m: string): never => {
    const e = new Error(m);
    (e as Error & { code?: string }).code = "BAD_DEMAND";
    throw e;
  };
  if (!Array.isArray(intervals) || intervals.length === 0) bad("demand must be a non-empty array");
  const sorted = [...intervals].sort((a, b) => a.tStart - b.tStart);
  if (sorted[0].tStart !== 0) bad("demand must start at step 0");
  for (let i = 0; i < sorted.length; i++) {
    const iv = sorted[i];
    if (!Number.isInteger(iv.tStart) || !Number.isInteger(iv.tEnd) || iv.tEnd <= iv.tStart) {
      bad("demand intervals must have integer half-open [tStart,tEnd)");
    }
    if (iv.mainFlow < 0 || iv.rampFlow < 0) bad("demand flows must be non-negative");
    if (i > 0 && iv.tStart !== sorted[i - 1].tEnd) bad("demand intervals must be contiguous");
  }
  if (sorted[sorted.length - 1].tEnd !== horizon) bad("demand must cover [0,horizonSteps)");
}

export interface FictionalRoadOptions {
  cellCount?: number;
  cellLength?: number;
  dtHours?: number;
  horizonSteps?: number;
  vf?: number;
  w?: number;
  kj?: number;
  capacity?: number;
  mergeCell?: number;
  mergePriority?: number;
}

/** A plausible fictitious freeway (units documented in types.ts). */
export function makeFictionalRoad(o: FictionalRoadOptions = {}): RoadParams {
  const road: RoadParams = {
    cellCount: o.cellCount ?? 8,
    cellLength: o.cellLength ?? 0.5,
    dt: o.dtHours ?? 10 / 3600, // 10 seconds expressed in hours
    horizonSteps: o.horizonSteps ?? 360, // 1 hour
    freeFlowSpeed: o.vf ?? 100,
    waveSpeed: o.w ?? 22,
    jamDensity: o.kj ?? 120,
    capacity: o.capacity ?? 2000,
    mergeCell: o.mergeCell ?? 4,
    mergePriority: o.mergePriority ?? 0.6,
  };
  validateRoad(road);
  return road;
}

export function makeScenario(name: string, seed: number, roadOpts: FictionalRoadOptions = {}): ScenarioSpec {
  const road = makeFictionalRoad(roadOpts);
  const demand = generateDemand(road, { seed });
  return { name, road, demand };
}

export { deriveFd };
