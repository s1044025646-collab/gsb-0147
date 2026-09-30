# CTM Ramp Simulator

Windows-local **backend only** for a one-dimensional freeway **congestion wave**
and single **on-ramp merge** simulation. It implements, from scratch, a
**triangular-fundamental-diagram Cell Transmission Model (CTM)** with explicit
per-cell sending/receiving flows and a priority merge allocator.

There is **no web UI, no vehicle routing, and no connection to real traffic
hardware**. It exposes an HTTP API, a CLI, a fictitious road/demand generator,
and an automated test suite. Persistence uses the built-in `node:sqlite`.

## Units (explicit)

| Quantity | Field | Unit |
| --- | --- | --- |
| Length | `cellLength` | km |
| Time step | `dt` | hours (e.g. `10/3600`) |
| Speed | `freeFlowSpeed`, `waveSpeed` | km/h |
| Density | `jamDensity`, densities | veh/km |
| Flow / demand | `capacity`, demand | veh/h |
| Vehicle counts | counts, queues | veh |

Per-step transferred vehicles = `flow(veh/h) * dt(h)`.

## Model

- Sending `S_i = min(n_i, Q_i)` and receiving `R_i = min(Q_i, w·dt/dx·(nJam − n_i))`,
  where `Q_i = capacity_i·dt` and `nJam = jamDensity·dx`.
- Interface flow is `min(S_upstream, R_downstream)`.
- Merge cell: mainline and the ramp share the merge cell's receiving space via
  `allocateMerge`. The `mergePriority` share **only binds when supply is short**;
  any unused share is given to the other side's unsatisfied demand.
- **Synchronous update:** every flow in step `t` is computed from the end-of-`t-1`
  snapshot; new counts are written to a fresh array (no in-place overwrite, so no
  vehicles can be created mid-step).
- **CFL check:** requires `vf·dt ≤ dx` and `w·dt ≤ dx`, else error code `CFL`.
- Over-capacity upstream demand accumulates in a **boundary queue** (mainline and
  ramp separately); it is never silently dropped. A queue at final time is
  reported as **unserved** and is not counted in served/outflow.
- Bottlenecks scale a cell's capacity by `factor ∈ [0,1]` (`0` = full blockage);
  ramp meters cap ramp inflow to `rate` over a time window.
- Conservation ledger: `initial + arrivals = outflow + onRoad + finalQueues`
  (residual ≈ 0).

## Requirements

- Node.js **≥ 22.5** (uses built-in `node:sqlite`; developed on Node 25).
- npm. No native modules; only TypeScript/tsx dev dependencies.

## Install & build

```powershell
npm install
npm run build
```

## Test

```powershell
npm test
```

Covers free flow, queue formation/dissipation, full blockage, a demand pulse,
merge competition, illegal time step (CFL), small hand-computed cases,
vehicle conservation/non-negativity/density cap across every step, synchronous
determinism, fixed-input reproducibility, validation/error paths, transaction
rollback, idempotent resubmission, and persistence across a restart.

## Reproducible demo (CLI)

```powershell
npm run build
npm run demo
```

The demo is fully seeded (no `Math.random`, no wall clock in the math) and
creates a baseline, a bottleneck-capacity run, and a bottleneck+ramp-metering
run, then prints comparison, the conservation ledger, and an idempotency check.

### CLI commands

```powershell
# create a fictitious corridor + generated demand (seeded)
node dist/cli/index.js init-road --name demo --seed 42

# import/replace a demand table (bumps scenario version -> forces new runs)
node dist/cli/index.js import-demand --scenario <id> --file examples/demand.sample.json

# run: baseline, bottleneck capacity drop, ramp metering
node dist/cli/index.js run --scenario <id> --label base --idempotency-key k1
node dist/cli/index.js run --scenario <id> --label cap --bottleneck 5:0.45:60:160
node dist/cli/index.js run --scenario <id> --label metered --bottleneck 5:0.45:60:160 --meter 250:60:160

# query per-step density and queues; compare schemes; export conservation ledger
node dist/cli/index.js query --run <runId> --from 50 --to 70
node dist/cli/index.js compare --a <runA> --b <runB>
node dist/cli/index.js ledger --run <runId> --out tmp/ledger.json
node dist/cli/index.js list
```

The CLI prints a **BEFORE/AFTER** state summary for mutating operations.
All data files default under `data/`; pass `--db=<path>` or set `CTM_DB` to
redirect (kept inside the project in normal use).

## HTTP API (start / stop)

```powershell
npm run build
npm start          # binds 127.0.0.1 only, OS-assigned free port; prints URL, writes tmp/server.pid
npm stop           # stops only the recorded project process
```

Direct single-process mode (also loopback, port 0):

```powershell
npm run serve
```

### Endpoints

- `GET  /health`
- `POST /scenarios` — `{fictional:true,seed,name}` or `{name,road,demand}`
- `GET  /scenarios?page&limit`
- `GET  /scenarios/:id`
- `PUT  /scenarios/:id/demand` — `{demand:[...]}` (bumps version)
- `POST /scenarios/:id/runs` — `{label,idempotencyKey?,bottlenecks?,rampMeters?}`
- `GET  /scenarios/:id/runs?page&limit`
- `GET  /runs/:id/steps?page&limit`
- `GET  /runs/:id/report`
- `GET  /runs/:id/ledger`
- `GET  /runs/:a/compare/:b`

Errors use a stable body `{error:{code,message,details?}}` and codes
`VALIDATION` (400), `CFL` / `BAD_ROAD` / `BAD_DEMAND` / `BAD_OVERRIDE` (422),
`NOT_FOUND` (404), `CONFLICT` (409, stale idempotency key after a scheme edit),
`INTERNAL` (500). List endpoints return
`{data,page:{page,limit,total,totalPages}}`.

### Versioning & idempotency

A scenario has a monotonically increasing `version`. Any road/demand change
bumps it; runs are immutable and always recorded against the version they used,
so a modification produces a **new run**. Repeating a run request with the same
`idempotencyKey` returns the stored run; reusing an old key after the scenario
changed yields `409 CONFLICT` rather than stale results.

## Reports

Each run reports congestion onset/peak density, cumulative outflow,
**served = cumulative outflow**, vehicles still queued at the end (**unserved**),
cumulative queue delay (veh·h), total vehicle-hours, per-step outflows, and the
conservation ledger.

## Data, temp files & cleanup

- SQLite database: `data/app.db` (WAL). Generated and temporary files live only
  in `data/` and `tmp/` inside this project.
- `npm run clean` removes `dist/`, `data/`, `tmp/` and stops only the recorded
  project API process. Start/stop scripts manage solely the child node process
  they spawn; nothing outside the project is touched.
- Migrations in `src/db/database.ts` are tracked in `schema_migrations` and are
  safe to run repeatedly, including after a restart.
