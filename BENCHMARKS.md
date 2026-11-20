# BENCHMARKS

Measured with `bench/run.ts` against the running stack (API, **2 workers**, Postgres 16, all in
Docker Desktop), with the large seed: 500,000 opportunities in one workspace, plus 5 small
workspaces. Raw results are in [`bench/results/`](bench/results). Re-run them with the commands
at the end.

## Hardware

| | |
|---|---|
| Machine | **MacBook Pro, Apple M3 Pro (11 cores), 18 GB RAM**, macOS 26 |
| Placement | Postgres, API, both workers **and** the load generator on the same laptop (Docker Desktop) |
| Software | Node 24, PostgreSQL 16, NestJS 12 |
| Settings | defaults: chunk 500 rows, 2 s time slice, 15 s lease, token bucket **2,000 rows/s per workspace** (burst 4,000) |

## 1. Bulk move of 50,000

| | Result |
|---|---:|
| Wall-clock, submit → `completed` | **23.9 s** |
| Sustained throughput | **2,161 rows/s** |
| Submit request (validate, count, write the 50,000-row snapshot) | 236 ms |

- **The throughput is set by the workspace's rate limit (2,000 rows/s + burst), not by the
  machine.** That limit is the isolation mechanism. With it switched off, the same 2 workers ran
  about 3× faster even on a 2-vCPU VM (see [Reference run](#reference-run-2-vcpu-linux-vm)), but
  took 14–22% of everyone's interactive throughput.
- **Sustained throughput** = rows ÷ time from the first committed chunk to completion.

## 2. Interactive requests during the bulk run

Closed-loop load for the whole run, per workspace: 2 clients **listing a stage**
(`GET /v1/stages/:id/opportunities?limit=20`) and 2 clients making **manual stage moves**
(`PATCH /v1/opportunities/:id/stage`). The **baseline** is the same load for 15 s with no bulk
job, measured right before.

Latency in ms. **Errors: 0** in every row (about 150,000 requests in this run).

| Workspace | Request | Baseline p95 / p99 | **During bulk p95 / p99** | Throughput (req/s) baseline → during |
|---|---|---:|---:|---:|
| Same (large, 500k) | read  | 1.9 / 3.0 | **2.3 / 4.5** | 1,441 → 1,324 |
| Same (large, 500k) | write | 4.3 / 6.8 | **5.6 / 10.1** | 642 → 570 |
| Other (small)      | read  | 1.8 / 2.9 | **2.3 / 4.4** | 1,440 → 1,325 |
| Other (small)      | write | 4.2 / 6.6 | **5.5 / 9.9** | 645 → 573 |

**Reading it:**
- While 50,000 deals move, interactive p99 stays **under 5 ms for reads and about 10 ms for
  writes**. The job adds 1–4 ms to the tail and costs 8–11% of interactive throughput.
- **Same workspace and other workspace are indistinguishable.** Row locks are short and
  per-chunk, so the bulk job doesn't get in a tenant's own way. The remaining cost is shared
  CPU, and it is spread evenly. On this laptop the load generator, Postgres, the API and both
  workers all compete for the same cores, so this is a conservative number. This shared-resource
  cost is the "hole" named in DESIGN.md §5.
- **Real collisions under load:** after submit, the same-workspace writers also move a sample
  of the job's own deals by hand. **152 were skipped as conflicts and every one of them had a
  later manual edit**, which the verification query checks. The manual-edit-wins rule held at
  full speed.

## 3. Kill and resume

Both workers were killed with `SIGKILL` at 30,000 committed rows and restarted with
`docker compose start worker` (`bench/run.ts --kill`). The same interactive load ran the whole time.

| | Result |
|---|---:|
| Killed at | **30,000 / 50,000** committed |
| Workers down | 2.3 s |
| Kill → `completed` | **10.4 s** |
| Total wall-clock | 24.8 s |
| Interactive p99 during the run | ≤ 4.6 ms reads, ≤ 9.7 ms writes, **0 errors** |

**Proof the result is correct** (SQL run by the benchmark, values from this run):

| Check | Value |
|---|---:|
| Items without an outcome | **0** |
| `moved` deals not in the target stage (excluding deals a human moved again afterwards) | **0** |
| `skipped_conflict` items without a manual edit after submit | **0** |
| Bulk transitions = `moved` | 49,834 = 49,834 |
| Deals with more than one bulk transition | **0** |
| `moved + skipped_conflict + skipped_noop = total` | 49,834 + 150 + 16 = **50,000** ✔ |

- **Why recovery was fast.** The kill landed while the job was between time slices (its
  timeline shows `waiting` at 30,000), so no lease had to expire. The job resumed as soon as the
  workers were back. **Worst case:** a worker dies while holding the lease, and the job waits
  up to the lease time (15 s) before another worker reclaims it. The `kill and resume` test
  covers exactly that case: a real worker process exits after its 3rd chunk while holding the lease.
- **Max latency during this run was 74–139 ms**, versus 45–78 ms uninterrupted, from two
  containers restarting on the same laptop. p95 and p99 were unaffected.

## Method

- **Filter:** the 50,000 newest opportunities of the large workspace's currently biggest stage,
  moved into its currently smallest stage. That way the benchmark re-runs on the same data.
- **Load:** closed loop, so each client sends its next request when the previous one returns.
  Manual moves never target the job's source stage, so the load can't change the 50k match
  between computing the filter and submitting.
- **Percentiles:** over successful requests; errors are counted separately (there were none).
- **Progress:** polled every 250 ms. Each JSON file has the full timeline (processed, health).
- **Kill:** issued with an async child process, so the benchmark's own clients keep running and
  measuring during the kill.

## Reference run (2-vCPU Linux VM)

The same benchmark on a much smaller machine (2 vCPU Intel Xeon @ 2.1 GHz, 8 GB, Node 22,
everything on the same 2 cores), plus one run **with the rate limit switched off** to show what
the limiter protects. Files: [`bench/results/vm-reference/`](bench/results/vm-reference).

| Run | 50k wall-clock | Throughput | Interactive throughput, during vs baseline |
|---|---:|---:|---:|
| Rate limit on (default) | 23.9 s | 2,184 rows/s | −1% to −6% |
| **Rate limit off** | 8.3 s | 6,665 rows/s | **−14% to −22%** |

So the job could run about 3× faster, but it would take that capacity from every tenant on the
database. The per-workspace rate is the knob that trades one job's speed against everyone
else's latency, and it's a per-workspace column, so it can be set per plan.

## Reproduce

```bash
docker compose up -d --build                                   # postgres, api, 2 workers (+ tests)
docker compose run --rm init node dist/scripts/seed.js large   # adds the 500k workspace (~8 s on an M3)
npm ci && npm run build
npm run bench                                                  # uninterrupted
npm run bench:kill                                             # kill both workers at 30k, restart
```
The defaults expect the API on `localhost:3000` and Postgres on `localhost:5432`.
`KILL_CMD` and `START_CMD` override how workers are killed and restarted.
