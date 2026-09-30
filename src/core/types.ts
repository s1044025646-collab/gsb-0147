/**
 * Unit conventions (stated explicitly, used everywhere):
 *  - length            dx, L            kilometres (km)
 *  - time              dt, times        hours (h)
 *  - speed             vf, w            kilometres per hour (km/h)
 *  - density           k, kj, kc        vehicles per kilometre (veh/km)
 *  - flow / rate       q, demand        vehicles per hour (veh/h)
 *  - vehicle counts    N, queues        vehicles (veh), fractional during a step
 *
 * Per-step transferred vehicles = flow(veh/h) * dt(h).
 */

export interface RoadParams {
  /** Number of homogeneous cells (segments). */
  cellCount: number;
  /** Cell length dx in km. */
  cellLength: number;
  /** Time step dt in hours. */
  dt: number;
  /** Number of simulated steps (horizon). */
  horizonSteps: number;
  /** Free-flow speed vf in km/h. */
  freeFlowSpeed: number;
  /** Congestion (backward) wave speed magnitude w in km/h (>= 0). */
  waveSpeed: number;
  /** Jam density kj in veh/km. */
  jamDensity: number;
  /** Cell capacity / saturation flow qmax in veh/h. */
  capacity: number;
  /** Index of the cell the on-ramp merges into (0-based, must be >= 1). */
  mergeCell: number;
  /**
   * Merge priority in [0,1] given to the mainline when downstream supply is
   * insufficient. The ramp receives (1 - priority). Spare capacity on either
   * side can always be consumed by the other side.
   */
  mergePriority: number;
}

/** Half-open time interval [tStart, tEnd) in step indices. */
export interface ScheduleInterval {
  tStart: number;
  tEnd: number;
}

/** Capacity factor applied to a single cell (bottleneck). factor in (0,1]. */
export interface BottleneckSchedule extends ScheduleInterval {
  cell: number;
  factor: number;
}

/** On-ramp metering cap in veh/h over [tStart,tEnd). */
export interface RampMeterSchedule extends ScheduleInterval {
  rate: number;
}

/** Piecewise-constant boundary demand, veh/h over [tStart,tEnd) steps. */
export interface DemandInterval {
  tStart: number;
  tEnd: number;
  mainFlow: number;
  rampFlow: number;
}

export interface RunOverrides {
  bottlenecks?: BottleneckSchedule[];
  rampMeters?: RampMeterSchedule[];
}

export interface ScenarioSpec {
  name: string;
  road: RoadParams;
  demand: DemandInterval[];
}

/** Immutable snapshot of one simulated time step. */
export interface StepRecord {
  t: number;
  /** Vehicle count in every cell at the END of step t. */
  counts: number[];
  /** Density veh/km in every cell at the END of step t. */
  density: number[];
  /** Mainline upstream boundary queue (veh) at end of step. */
  upQueue: number;
  /** On-ramp boundary queue (veh) at end of step. */
  rampQueue: number;
  /** Vehicles admitted from the mainline boundary during step. */
  upInflow: number;
  /** Vehicles admitted from the ramp during step. */
  rampInflow: number;
  /** Vehicles discharged past the downstream sink during step. */
  outflow: number;
  /** Mainline flow accepted into the merge cell during step. */
  mergeMainFlow: number;
  /** Ramp flow accepted into the merge cell during step. */
  mergeRampFlow: number;
  /** Mainline arrivals presented at the boundary during step. */
  upArrivals: number;
  /** Ramp arrivals presented during step. */
  rampArrivals: number;
}

export interface ConservationLedger {
  initialVehicles: number;
  totalMainArrivals: number;
  totalRampArrivals: number;
  totalUpInflow: number;
  totalRampInflow: number;
  totalOutflow: number;
  totalVehiclesEntered: number;
  vehiclesOnRoad: number;
  upQueue: number;
  rampQueue: number;
  queuedTotal: number;
  /** Conservation residual; ~0 means no vehicles created/lost. */
  residual: number;
}

export interface RunReport {
  steps: number;
  finalDensity: number[];
  /** First step at which any cell density exceeds the critical density. */
  congestionOnset: number | null;
  /** Highest density observed (veh/km) and its step/cell. */
  peakDensity: { value: number; t: number; cell: number };
  /** Cumulative vehicles discharged at the downstream sink. */
  cumulativeOutflow: number;
  /** Vehicles that completed the trip (== cumulative outflow). */
  servedVehicles: number;
  /** Vehicles still waiting upstream / at the ramp at final time: NOT served. */
  unservedQueued: number;
  /** Cumulative vehicle-hours spent in boundary+ramp queues. */
  queueDelayVehH: number;
  /** Total vehicle-hours on the network (sum of counts * dt). */
  networkVehH: number;
  /** Total vehicle-hours including queues. */
  totalVehH: number;
  /** Per-step outflows. */
  outflows: number[];
  ledger: ConservationLedger;
}

export interface SimResult {
  road: RoadParams;
  initialCounts: number[];
  steps: StepRecord[];
  report: RunReport;
}

export interface Rng {
  next(): number;
}
