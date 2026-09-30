import type { RoadParams } from "./types.js";

export const EPS = 1e-9;

/** Triangular fundamental diagram derived quantities. */
export interface FundamentalDiagram {
  /** Critical density kc = qmax / vf (veh/km). */
  kc: number;
  /** Cell holding capacity in vehicles: nJam = kj * dx. */
  nJam: number;
  /** Vehicles that can be sent at capacity in one step: qmax * dt. */
  qStep: number;
  /**
   * Backward-wave coefficient beta = w*dt/dx. It appears ONLY in the receiving
   * (congested) branch: R = min(Q, beta*(nJam - n)).
   */
  beta: number;
}

export function deriveFd(road: RoadParams): FundamentalDiagram {
  const { cellLength: dx, dt, freeFlowSpeed: vf, waveSpeed: w, jamDensity: kj, capacity: qmax } = road;
  return {
    kc: qmax / vf,
    nJam: kj * dx,
    qStep: qmax * dt,
    beta: (w * dt) / dx,
  };
}

/**
 * Validate physical parameters and the CFL condition
 *   vf * dt <= dx  and  w * dt <= dx.
 * Violating it lets a wave/vehicle traverse more than one cell per step and
 * breaks the numerical scheme. Throws Error with code 'CFL'.
 */
export function validateRoad(road: RoadParams): void {
  const fail = (code: string, message: string): never => {
    const err = new Error(message);
    (err as Error & { code?: string }).code = code;
    throw err;
  };

  if (!Number.isFinite(road.cellCount) || road.cellCount < 2 || !Number.isInteger(road.cellCount)) {
    fail("BAD_ROAD", "cellCount must be an integer >= 2");
  }
  for (const [key, val] of Object.entries({
    cellLength: road.cellLength,
    dt: road.dt,
    freeFlowSpeed: road.freeFlowSpeed,
    waveSpeed: road.waveSpeed,
    jamDensity: road.jamDensity,
    capacity: road.capacity,
    horizonSteps: road.horizonSteps,
  })) {
    if (!Number.isFinite(val) || val <= 0) fail("BAD_ROAD", `${key} must be a positive finite number`);
  }
  if (!Number.isInteger(road.horizonSteps) || road.horizonSteps <= 0) {
    fail("BAD_ROAD", "horizonSteps must be a positive integer");
  }
  if (road.mergeCell < 1 || road.mergeCell >= road.cellCount || !Number.isInteger(road.mergeCell)) {
    fail("BAD_ROAD", "mergeCell must be an integer in [1, cellCount-1]");
  }
  if (!(road.mergePriority >= 0 && road.mergePriority <= 1)) {
    fail("BAD_ROAD", "mergePriority must be in [0,1]");
  }
  // Triangle consistency: critical density must be below jam density.
  if (road.capacity / road.freeFlowSpeed >= road.jamDensity) {
    fail("BAD_ROAD", "infeasible triangle: kc = capacity/freeFlowSpeed must be < jamDensity");
  }

  const cflFree = road.freeFlowSpeed * road.dt;
  const cflWave = road.waveSpeed * road.dt;
  if (cflFree > road.cellLength + EPS || cflWave > road.cellLength + EPS) {
    fail(
      "CFL",
      `CFL violated: vf*dt=${cflFree.toFixed(5)}, w*dt=${cflWave.toFixed(5)}, dx=${road.cellLength}. ` +
        "Require vf*dt <= dx and w*dt <= dx (smaller dt or longer cells).",
    );
  }
}

/**
 * Sending function: vehicles cell i can discharge during a step.
 * Free-flow branch moves all vehicles present, bounded by capacity.
 *   S(n) = min(n, Q)
 */
export function sending(n: number, fd: FundamentalDiagram, capFactor = 1): number {
  const cap = fd.qStep * capFactor;
  return Math.max(0, Math.min(n, cap));
}

/**
 * Receiving function: vehicles cell i can absorb during a step.
 * Capacity branch plus the backward-wave (jam) availability branch.
 *   R(n) = min(Q, beta*(nJam - n))
 */
export function receiving(n: number, fd: FundamentalDiagram, capFactor = 1): number {
  const cap = fd.qStep * capFactor;
  return Math.max(0, Math.min(cap, fd.beta * (fd.nJam - n)));
}
