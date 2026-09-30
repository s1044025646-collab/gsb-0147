// Repeatable end-to-end demo against a project-local SQLite database.
// Uses a fixed seed and fixed idempotency keys, so repeated runs produce
// identical numeric results. Run with: npm run demo

import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, createRepo } from "./db.ts";
import { createService } from "./service.ts";
import { generateRoad, generateDemand } from "./generator.ts";
import { METER_OFF } from "./engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const dbPath = join(projectRoot, "data", "demo.sqlite");
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(dbPath + suffix, { force: true });
  } catch {
    /* ignore */
  }
}

const SEED = 20260929;
const HORIZON = 240; // 240 * 30s = 2 hours

const db = openDb(dbPath);
const svc = createService(createRepo(db));

const scenario = svc.createScenario("demo-corridor");
const params = generateRoad(SEED, { numCells: 8 });
const demand = generateDemand(SEED, {
  horizonSteps: HORIZON,
  peakMain: 2400,
  peakRamp: 1200,
  incident: { startStep: 96, endStep: 168, capacityFactor: 0.5 },
});
const baseline = svc.addVersion(scenario.id, "baseline", params, demand, HORIZON, null);

// Scheme A: baseline with the mid-horizon bottleneck incident.
const runA = svc.runVersion(baseline.id, "demo-baseline", SEED);

// Scheme B (new version): add ramp metering at 600 veh/h during the incident.
const meteredDemand = demand.map((d) =>
  d.startStep >= 96 && d.endStep <= 168 ? { ...d, meterRate: 300 } : { ...d }
);
const vMeter = svc.forkVersion(baseline.id, "incident-plus-ramp-meter-300", { demand: meteredDemand });
const runB = svc.runVersion(vMeter.id, "demo-metered", SEED);

// Scheme C (new version): a severe near-closure segment (20% capacity).
const closureDemand = demand.map((d) =>
  d.startStep === 120 ? { ...d, capacityFactor: 0.2 } : { ...d }
);
void METER_OFF;
const vClosure = svc.forkVersion(baseline.id, "incident-plus-severe-closure", { demand: closureDemand });
const runC = svc.runVersion(vClosure.id, "demo-closure", SEED);

function report(name: string, runId: number) {
  const ledger = svc.conservationLedger(runId);
  const { result } = svc.requireCompletedRun(runId);
  let firstCongested: number | null = null;
  let lastCongested: number | null = null;
  let maxDensity = 0;
  for (const s of result.steps) {
    const congested = s.density.some((rho) => rho > params.rhoCrit);
    if (congested) {
      if (firstCongested === null) firstCongested = s.step;
      lastCongested = s.step;
    }
    maxDensity = Math.max(maxDensity, ...s.density);
  }
  const fmt = (x: number) => x.toFixed(2);
  console.log(`\n== ${name} (run #${runId}) ==`);
  console.log(
    `demand total=${fmt(ledger.demand.total)} veh (main ${fmt(ledger.demand.main)}, ramp ${fmt(ledger.demand.ramp)})`
  );
  console.log(
    `exited=${fmt(ledger.exited)} veh | on road at end=${fmt(ledger.onRoadAtEnd)} veh | unserved queues=${fmt(
      ledger.unservedAtEnd.total
    )} veh (main ${fmt(ledger.unservedAtEnd.main)}, ramp ${fmt(ledger.unservedAtEnd.ramp)})`
  );
  console.log(
    `total delay=${fmt(ledger.totalDelayVehH)} veh-h | conservation balanced=${ledger.balanced} (residual ${fmt(
      ledger.gaps.totalResidual
    )})`
  );
  console.log(
    `congestion: first step ${firstCongested ?? "-"}, last step ${lastCongested ?? "-"}, peak density ${fmt(
      maxDensity
    )} veh/km (jam ${params.rhoJam})`
  );
  return ledger;
}

console.log("CTM + on-ramp repeatable demo");
console.log(`db: ${dbPath}`);
console.log(
  params.cellLengthKm.length +
    " cells x " +
    params.cellLengthKm[0] +
    " km, vf=" +
    params.vf +
    " km/h, w=" +
    params.w +
    " km/h, dt=" +
    params.dtHours +
    " h, horizon=" +
    HORIZON +
    " steps"
);
report("A baseline incident (bottleneck factor 0.5)", runA.id);
report("B incident + ramp meter 300 veh/h", runB.id);
report("C incident + one-segment severe capacity cut (0.2)", runC.id);

const cmp = svc.compareRuns(runA.id, runB.id);
console.log(
  `\ncompare B vs A: exited delta=${cmp.delta_b_minus_a.exitedVeh.toFixed(
    2
  )} veh, delay delta=${cmp.delta_b_minus_a.totalDelayVehH.toFixed(2)} veh-h, unserved delta=${cmp.delta_b_minus_a.unservedVeh.toFixed(2)} veh`
);

db.close();
