# BENCHMARKS

Measured with `bench/run.ts` against a running stack: API, **2 workers** and Postgres 16, with
the large seed (500,000 opportunities in one workspace, plus 5 small workspaces). Raw outputs
are in [`bench/results/`](bench/results). Re-run them with the commands at the end.

## Hardware

| | |
|---|---|
| Reference run | Linux VM, **2 vCPU** (Intel Xeon @ 2.10 GHz), 8 GB RAM |
| Placement | Postgres 16, API, both workers **and** the load generator on the same 2 vCPUs |
| Node | 22 |
| Settings | defaults: chunk 500, slice 2 s, lease 15 s, token bucket 2,000 rows/s (burst 4,000) per workspace |

Everything shares two cores, so these are conservative. *Laptop numbers: to be added from
`npm run bench` on an Apple M-series machine.*

## 1. Bulk move of 50,000

| Run | Wall-clock (submit → completed) | Sustained throughput | Submit request |
|---|---:|---:|---:|
| Default (rate limit 2,000 rows/s) | **23.9 s** | **2,184 rows/s** | 760 ms |
| Rate limit disabled (for comparison) | 8.3 s | 6,665 rows/s | 516 ms |

- **The default is deliberately capped by the workspace's token bucket.** That cap is the
  isolation mechanism doing its job. With the cap removed, the same 2 workers move about
  6,700 rows/s on this machine.
- **Submit** includes validating the filter, counting with `LIMIT 50001`, and writing the
  50,000-row snapshot, all in one transaction.
- **Sustained throughput** = rows ÷ time from the first committed chunk to completion.

## 2. Interactive requests during the bulk run

Closed-loop load for the whole run:
- **Same workspace:** 2 clients listing a stage (`GET /v1/stages/:id/opportunities?limit=20`)
  and 2 clients making manual stage moves (`PATCH /v1/opportunities/:id/stage`).
- **Different workspace:** the same mix.
- **Baseline:** 15 s of the same load with no bulk job running, measured right before.

Latency in ms. Errors were **0** in every row.

**Default settings (rate limit on), uninterrupted run:**

| Workspace | Request | Baseline p95 / p99 | During bulk p95 / p99 | Throughput (req/s) baseline → during |
|---|---|---:|---:|---:|
| Same (large, 500k) | read  | 13.8 / 21.1 | 13.6 / 21.0 | 284 → 280 |
| Same (large, 500k) | write | 30.9 / 44.9 | 33.2 / 48.0 | 114 → 107 |
| Other (small)      | read  | 13.8 / 21.5 | 13.5 / 21.7 | 284 → 279 |
| Other (small)      | write | 30.3 / 46.6 | 32.3 / 50.8 | 114 → 107 |

**Rate limit disabled (what the limiter protects):**

| Workspace | Request | Baseline p95 / p99 | During bulk p95 / p99 | Throughput (req/s) baseline → during |
|---|---|---:|---:|---:|
| Same (large, 500k) | read  | 14.0 / 22.5 | 14.8 / 24.3 | 286 → 242 (−15%) |
| Same (large, 500k) | write | 30.6 / 46.3 | 35.5 / 52.1 | 115 → 90 (−22%) |
| Other (small)      | read  | 14.1 / 22.1 | 14.4 / 23.8 | 284 → 244 (−14%) |
| Other (small)      | write | 31.0 / 43.6 | 35.1 / 52.8 | 116 → 91 (−22%) |

**Reading it:**
- **With the limiter on,** interactive latency in both workspaces stays within noise of the
  baseline, and interactive throughput drops by 1–6%.
- **With the limiter off,** the job finishes 3× faster, but takes 14–22% of interactive
  throughput from *every* workspace. On a 2-core box they all share the same CPU and disk.
  That is the trade-off the per-workspace rate encodes.
- **Same vs other workspace look alike.** Row-level locking keeps the bulk job out of
  interactive requests' way; the remaining cost is shared CPU/IO, which hits all tenants equally.
  Those are the numbers that would grow first on shared hardware (DESIGN.md §5, "the hole").

## 3. Kill and resume

Both workers were killed with `SIGKILL` once the job reached 30,000 committed rows, then
restarted 1 s later (`bench/run.ts --kill`).

| Metric | Result |
|---|---:|
| Killed at | 30,000 / 49,999 committed |
| Workers down | 1.0 s |
| Kill → completed | **10.0 s** |
| Total wall-clock | 23.9 s |

**Proof the result is correct.** This SQL is run by the benchmark; the counts come from that run:

| Check | Value |
|---|---:|
| Items without an outcome | 0 |
| `moved` deals not in the target stage (excluding deals a human moved again afterwards) | 0 |
| `skipped_conflict` items with no manual edit after submit | 0 |
| Bulk transitions = `moved` | 49,968 = 49,968 |
| Deals with more than one bulk transition | 0 |
| `moved + skipped_conflict + skipped_noop = total` | 49,968 + 29 + 2 = 49,999 ✔ |

- **Real collisions.** The 29 `skipped_conflict` rows are deals the concurrent manual-move clients
  touched after submit, so the collision rule was exercised under load, not just in a test. The
  uninterrupted run had 19.
- **Why recovery is fast here.** The kill landed while the job was between time slices, so no
  lease had to expire. **Worst case:** if a worker dies holding the lease, the job waits up to the
  lease time (15 s) before another worker reclaims it. The deterministic version of this is the
  `kill and resume` test, which exits a real worker process after its 3rd chunk while holding
  the lease.
- **Total is 49,999, not 50,000.** The filter selects the 50,000 newest deals of the biggest
  stage, but one of them was moved by the load clients before submit.

## Method

- **Filter:** the 50,000 newest opportunities of the large workspace's currently biggest stage,
  into its currently smallest stage. That way the benchmark re-runs on the same data.
- **Clients:** closed loop, so each client sends its next request when the previous one returns.
  4 clients per workspace: 2 readers and 2 writers. Manual-move targets are random rows of
  that workspace.
- **Percentiles:** over successful requests; errors are counted separately (there were none).
- **Progress:** polled every 250 ms from `GET /v1/bulk-moves/:id`. The full timeline (processed,
  health) is in each JSON file.

## Reproduce

```bash
docker compose up -d --build                         # postgres, api, 2 workers
docker compose run --rm init node dist/scripts/seed.js large   # adds the 500k workspace (~20 s)
npm ci && npm run build
npm run bench                                        # uninterrupted
npm run bench:kill                                   # kill both workers at 30k, restart
```
The defaults expect the API on `localhost:3000` and Postgres on `localhost:5432`.
`KILL_CMD` and `START_CMD` override how workers are killed and restarted.
