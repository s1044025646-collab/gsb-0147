import type { RoadParams, RunOverrides } from "../core/types.js";

export class ValidationError extends Error {
  code = "VALIDATION";
  details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

function num(v: unknown, field: string, opts: { min?: number; integer?: boolean; optional?: boolean } = {}): number | undefined {
  if (v === undefined || v === null) {
    if (opts.optional) return undefined;
    throw new ValidationError(`${field} is required`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`${field} must be a finite number`);
  if (opts.integer && !Number.isInteger(v)) throw new ValidationError(`${field} must be an integer`);
  if (opts.min !== undefined && v < opts.min) throw new ValidationError(`${field} must be >= ${opts.min}`);
  return v;
}

export function parseRoad(body: Record<string, unknown>): RoadParams {
  const r = body.road;
  if (!r || typeof r !== "object") throw new ValidationError("road is required");
  const road = r as Record<string, unknown>;
  return {
    cellCount: num(road.cellCount, "road.cellCount", { min: 2, integer: true })!,
    cellLength: num(road.cellLength, "road.cellLength", { min: 0 })!,
    dt: num(road.dt, "road.dt", { min: 0 })!,
    horizonSteps: num(road.horizonSteps, "road.horizonSteps", { min: 1, integer: true })!,
    freeFlowSpeed: num(road.freeFlowSpeed, "road.freeFlowSpeed", { min: 0 })!,
    waveSpeed: num(road.waveSpeed, "road.waveSpeed", { min: 0 })!,
    jamDensity: num(road.jamDensity, "road.jamDensity", { min: 0 })!,
    capacity: num(road.capacity, "road.capacity", { min: 0 })!,
    mergeCell: num(road.mergeCell, "road.mergeCell", { min: 0, integer: true })!,
    mergePriority: num(road.mergePriority, "road.mergePriority", { min: 0 })!,
  };
}

export function parseDemand(body: Record<string, unknown>) {
  if (!Array.isArray(body.demand)) throw new ValidationError("demand must be an array");
  return body.demand.map((raw, i) => {
    const d = raw as Record<string, unknown>;
    return {
      tStart: num(d.tStart, `demand[${i}].tStart`, { min: 0, integer: true })!,
      tEnd: num(d.tEnd, `demand[${i}].tEnd`, { min: 1, integer: true })!,
      mainFlow: num(d.mainFlow, `demand[${i}].mainFlow`, { min: 0 })!,
      rampFlow: num(d.rampFlow, `demand[${i}].rampFlow`, { min: 0 })!,
    };
  });
}

export function parseOverrides(body: Record<string, unknown>): RunOverrides {
  const out: RunOverrides = {};
  if (body.bottlenecks !== undefined) {
    if (!Array.isArray(body.bottlenecks)) throw new ValidationError("bottlenecks must be an array");
    out.bottlenecks = body.bottlenecks.map((raw, i) => {
      const b = raw as Record<string, unknown>;
      return {
        cell: num(b.cell, `bottlenecks[${i}].cell`, { min: 0, integer: true })!,
        factor: num(b.factor, `bottlenecks[${i}].factor`, { min: 0 })!,
        tStart: num(b.tStart, `bottlenecks[${i}].tStart`, { min: 0, integer: true })!,
        tEnd: num(b.tEnd, `bottlenecks[${i}].tEnd`, { min: 1, integer: true })!,
      };
    });
  }
  if (body.rampMeters !== undefined) {
    if (!Array.isArray(body.rampMeters)) throw new ValidationError("rampMeters must be an array");
    out.rampMeters = body.rampMeters.map((raw, i) => {
      const m = raw as Record<string, unknown>;
      return {
        rate: num(m.rate, `rampMeters[${i}].rate`, { min: 0 })!,
        tStart: num(m.tStart, `rampMeters[${i}].tStart`, { min: 0, integer: true })!,
        tEnd: num(m.tEnd, `rampMeters[${i}].tEnd`, { min: 1, integer: true })!,
      };
    });
  }
  return out;
}

export function parsePagination(query: URLSearchParams, maxLimit = 500) {
  const page = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.get("limit") ?? "100", 10) || 100));
  return { page, limit, offset: (page - 1) * limit };
}
