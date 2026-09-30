// Core domain types for the CTM + on-ramp simulation.
//
// Units (explicitly):
//   vehicle counts        : veh
//   density               : veh/km
//   flow / demand / meter : veh/h (rates)
//   speed / wave speed    : km/h
//   cell length           : km
//   time step / horizon   : h (hours; e.g. 1/120 h = 30 s)

export interface ScenarioParams {
  cellLengthKm: number[];      // length of each cell, km
  vf: number;                  // free-flow speed, km/h
  w: number;                   // congestion (backward) wave speed, km/h (positive number, propagates upstream)
  rhoCrit: number;             // critical density, veh/km
  rhoJam: number;              // jam density, veh/km
  capacity: number[];          // per-cell capacity, veh/h
  dtHours: number;             // simulation time step, h
  mergeCell: number;           // index of the cell where the on-ramp joins (0-based)
  bottleneckCell: number;      // index of the cell whose capacity is reduced (use -1 for none)
  mainlinePriority: number;    // priority weight for mainline at the merge; ramp gets (1 - value), range (0,1)
  initialDensity?: number[];   // optional initial density per cell, veh/km (defaults to empty)
}

// A demand profile entry for a half-open interval [startStep, endStep).
export interface DemandEntry {
  startStep: number;
  endStep: number;
  mainDemand: number;   // upstream mainline boundary demand, veh/h
  rampDemand: number;   // on-ramp boundary demand, veh/h
  meterRate: number;    // ramp meter limit, veh/h (Infinity / a very large sentinel means no metering)
  capacityFactor: number; // multiplicative bottleneck factor applied to `bottleneckCell`; 1 = normal
}

export interface RunStep {
  step: number;
  timeHours: number;
  density: number[];     // veh/km per cell
  n: number[];           // vehicle count per cell at the start/held state of this step
  mainQueue: number;     // vehicles waiting at the upstream mainline boundary
  rampQueue: number;     // vehicles waiting at the on-ramp boundary
  inflow: number;        // vehicles that entered the road this step (main boundary + ramp admitted)
  outflow: number;       // vehicles that left the downstream boundary this step
  mainAdmitted: number;
  rampAdmitted: number;
  mainArrivals: number;
  rampArrivals: number;
  delay: number;         // delay accumulated during this step, veh-h
  activeMeter: number;   // meter limit applied this step (veh/h), Infinity if none
  activeCapFactor: number;
}

export interface RunResult {
  steps: RunStep[];
  totals: {
    mainDemandVeh: number;
    rampDemandVeh: number;
    enteredVeh: number;
    exitedVeh: number;
    onRoadVeh: number;
    mainUnservedVeh: number;
    rampUnservedVeh: number;
    totalDelayVehH: number;
  };
  cfl: { satisfied: boolean; maxRatio: number; limit: number };
}

export interface Scenario {
  id: number;
  name: string;
  created_at: string;
}

export interface Version {
  id: number;
  scenario_id: number;
  label: string;
  parent_version_id: number | null;
  params: ScenarioParams;
  demand: DemandEntry[];
  horizonSteps: number;
  created_at: string;
}

export interface RunRow {
  id: number;
  version_id: number;
  status: "completed" | "failed";
  seed: number;
  result: RunResult | null;
  error: string | null;
  created_at: string;
}
