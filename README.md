# Bulk Stage Move — Opportunities service

Move up to **50,000 deals** between pipeline stages in one action, as a background job that is:

- **Idempotent.** A retried request returns the same job (`200`), even when duplicates arrive at
  the same time. It never returns `409`.
- **Resumable.** Kill a worker at any point, and the job continues from its last committed chunk.
- **Observably progressing.** Progress comes from committed rows, with a `health` field that tells
  slow, stuck and failed apart.
- **Correct under concurrent edits.** A deal someone moved by hand is skipped, not overwritten.
- **Well-behaved.** Per-workspace rate limit, round-robin time slices, one job per workspace at a time.

**Stack:** NestJS 12 + TypeScript (strict) + PostgreSQL 16, with raw parameterised SQL through
`pg`. No Redis, Kafka or BullMQ: Postgres is the queue (see [DESIGN.md](DESIGN.md)).

| Document | What's in it |
|---|---|
| [DESIGN.md](DESIGN.md) | Chunking and cursor, idempotency, concurrency, snapshot vs live, isolation, 10×, next steps |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Diagrams: components, database schema (ER), job state machine, sequence diagrams for submit, chunk, crash recovery and collisions; every index and lock explained |
| [BENCHMARKS.md](BENCHMARKS.md) | 50k move, p95/p99 during the move, kill and resume, hardware, method |
| [docs/API.md](docs/API.md) | Every endpoint with a curl example |
| `http://localhost:3000/docs` | Swagger UI (OpenAPI), generated from the code |

## Run it (one command)

Needs Docker Desktop.

```bash
docker compose up --build
```

This starts Postgres, runs the migrations, seeds **5 small workspaces** (3,000 deals each),
starts the **API** on `:3000` and **2 workers**, and **runs the whole test suite once**. Look for
`test-1 | ℹ pass 23` in the output. The test container then exits; the rest of the stack keeps running.

- Swagger UI: <http://localhost:3000/docs>
- Health: <http://localhost:3000/health>

## Run the tests

They already run as part of `docker compose up`. To run only the tests, with a proper exit code
(for example in CI):

```bash
docker compose run --rm --build test
```

The tests run against a real Postgres. Each test file creates and drops its own database.

| Test file | What it proves |
|---|---|
| `test/submit-idempotency.test.ts` | Replay → same job, `200`. 10 concurrent duplicates → 1 job. Different body → `422`. **No key: identical requests (also concurrent) → 1 job.** >50k → `422` with nothing written. Dedupe survives a restart. Tenant scoping. |
| `test/worker.test.ts` | **Kill and resume** (a real worker process exits mid-job holding its lease). **Collision** (a manual edit wins). **Fencing** (a zombie worker can't write). **Isolation** (workspace B finishes while A's big job runs). **Database connection killed mid-chunk** → rollback and retry, then completion. Transient retry. Permanent failure, then a manual resume that completes. |
| `test/filters.test.ts` | 16 filter combinations (each field alone and combined, an empty match). The snapshot equals an independent re-implementation of the filter. |
| `test/opportunities.http.test.ts` | Part 1: create, manual move with transition, keyset paging, tenant scoping, error shape. |

The safety tests were checked by deleting each mechanism. Removing the fence, the `stage_rev`
check or the request-hash check turns the matching test red.

Without Docker (Node 24, see `.nvmrc`, and a local Postgres):
```bash
npm ci && npm run build
TEST_DATABASE_URL=postgres://app:app@localhost:5432/postgres npm test
```

## Seed data

| Mode | What | Command |
|---|---|---|
| small (default) | 5 workspaces × 3,000 deals, 12 stages each | runs automatically on `docker compose up` |
| large | + 1 workspace with **500,000** deals across 12 stages, uneven (skewed to early stages), created over ~18 months | `docker compose run --rm init node dist/scripts/seed.js large` (~20 s) |

The seed is deterministic, so every machine gets the same data. Workspace ids are fixed:

- Small: `b0000000-0000-4000-8000-000000000001` … `…005`
- Large: `a0000000-0000-4000-8000-000000000000`

## Try it

```bash
WS=b0000000-0000-4000-8000-000000000001
curl -s localhost:3000/v1/stages -H "X-Workspace-Id: $WS"            # pick two stage ids
curl -s -XPOST localhost:3000/v1/bulk-moves -H "X-Workspace-Id: $WS" \
  -H "Idempotency-Key: demo-1" -H 'content-type: application/json' \
  -d '{"targetStageId":"<stage B>","filter":{"stageId":"<stage A>"}}'   # 202 {jobId}
curl -s localhost:3000/v1/bulk-moves/<jobId> -H "X-Workspace-Id: $WS" # progress
```

`scripts/demo/` has the same flows as small scripts: submit, replay, conflict, kill a worker,
fairness, and verify.

## Edge cases: what happens if…

These are the questions from HighLevel's preparation pointers. Each answer names the mechanism
and the test that proves it.

| What happens if… | Answer | Proof |
|---|---|---|
| **…the same API request is submitted multiple times?** | Same `Idempotency-Key` + same body → `200` with the original job, **never 409**, including concurrent duplicates (the key row is the lock). No key → identical requests are deduplicated by body hash. Same key + different body → `422`. | `submit-idempotency.test.ts` (10 concurrent → 1 job; 5 concurrent keyless → 1 job; survives an API restart) |
| **…the client never got the response and retries?** | Same as above. The key, job and snapshot commit in one transaction, so a retry either finds all of them or none. | same |
| **…two workers pick up conflicting jobs?** | `FOR UPDATE SKIP LOCKED` means one claim per job. A partial unique index allows **one processing job per workspace**, so two jobs never touch one tenant's rows at once. A worker whose lease was taken over is **fenced** (`lease_version`) and cannot write. | `worker.test.ts`: fencing, isolation |
| **…two jobs target the same records?** | They run one after the other. The second job's snapshot remembers each row's `stage_rev`; rows the first job moved count as `skipped_conflict`, so the later job never silently undoes the earlier one. | collision rule, `chunk.ts` `classify()` |
| **…a user edits a record the job is about to move?** | The manual edit wins. The job sees a changed `stage_rev` and records `skipped_conflict` (listed at `/items?outcome=skipped_conflict`). | `worker.test.ts`: collision; benchmark had 19–29 real collisions under load |
| **…a worker crashes halfway?** | The open chunk rolls back. The cursor was committed with the last finished chunk. The lease expires and any worker resumes from the cursor: no row is skipped or applied twice. | `worker.test.ts`: kill and resume (a real process exits holding its lease); `bench --kill` |
| **…the database connection drops during execution?** | The chunk transaction rolls back. The error is classified as transient, so the job backs off exponentially with jitter and retries, then completes. A dead connection is discarded, not reused. | `worker.test.ts`: connection killed mid-chunk (`pg_terminate_backend`) |
| **…an error keeps happening?** | Transient errors retry up to 5 times; permanent errors fail at once. Either way the job ends `failed` with a `failureReason` and **never stays stuck**. `POST /v1/bulk-moves/:id/retry` resumes it from its cursor once the cause is fixed. | `worker.test.ts`: permanent failure + resume |
| **…a job exceeds the 50,000 limit?** | `422` before anything is written (counted with `LIMIT 50001`, re-checked on the snapshot itself). | `submit-idempotency.test.ts` |
| **…a queue loses a job?** | There is no separate queue to lose it: the job row *is* the queue. It commits in the same transaction as the `202` response's data, and claiming is a query, not a message. A job whose worker vanished has an expired lease and is reclaimed; one with no progress shows `health: stalled`. | kill and resume; progress `health` |
| **…many customers submit large jobs at once?** | Round-robin time slices (2 s) across workspaces, plus a per-workspace token bucket. No job can hold a worker while another workspace waits. Interactive latency stays at baseline. | `worker.test.ts`: isolation; BENCHMARKS.md §2 |
| **…is the job genuinely complete?** | `completed` is set only when `cursor = total`, in the same fenced transaction as the last chunk. A CHECK guarantees `moved + skipped_conflict + skipped_noop = cursor`, and every item has an outcome. **`percent` is never 100 before that.** | verify SQL in every worker test and benchmark |

## Endpoints

All endpoints take `X-Workspace-Id: <uuid>` (tenant scope; not authentication).

| Method | Path | |
|---|---|---|
| `GET` | `/v1/stages` | Stages of the workspace, in order |
| `POST` | `/v1/opportunities` | Create a deal |
| `PATCH` | `/v1/opportunities/:id/stage` | Move one deal (records a transition, bumps `stageRev`) |
| `GET` | `/v1/stages/:stageId/opportunities?limit&cursor` | List a stage (keyset pagination) |
| `POST` | `/v1/bulk-moves` | Submit a bulk move. `Idempotency-Key` recommended. `202` new / `200` replay / `422` key reused with another body, or >50k |
| `GET` | `/v1/bulk-moves/:jobId` | Progress: `status`, `processed`, `percent`, counts, `health` |
| `GET` | `/v1/bulk-moves/:jobId/items?outcome=` | Per-deal outcomes, e.g. which ones were skipped as conflicts |
| `POST` | `/v1/bulk-moves/:jobId/retry` | Resume a **failed** job from its committed progress. `202` re-queued / `200` already running / `422` already completed |
| `GET` | `/health` | Liveness and database check |

## What is implemented

- **Everything in Part 1 and Part 2 of the brief**, including all five properties, the seeding
  script and the three measurements.
- **Bulk filter:** `stageId`, `ownerId`, `status`, `minValueCents`/`maxValueCents`,
  `createdFrom`/`createdTo` (combined with AND).
- **Job statuses:** `queued → processing → completed | failed`. Progress adds `health`
  (`running`, `throttled`, `waiting`, `retrying`, `stalled`, `done`, `failed`).
- **Retries:** transient database errors back off exponentially with jitter, up to 5 attempts.
  Permanent errors fail the job with a reason. A worker that dies holding a lease counts as an attempt.
  A failed job can be resumed with `POST /v1/bulk-moves/:id/retry`. It continues from its cursor,
  so nothing already applied is redone.
- **Graceful shutdown:** on SIGTERM a worker finishes its current chunk and hands the job back.

## What is not implemented

- **Out of scope per the brief:** auth, UI, board or summary views, rollups, events, deployment, CI/K8s,
  custom fields.
- **Not built, but described in DESIGN.md §7:** cancel, outbox events, poison-row isolation,
  an asynchronous snapshot for very large moves, and a global (cross-tenant) write budget.

## Assumptions

- One pipeline per workspace (the brief describes "a pipeline"), so stages belong to the workspace.
- `X-Workspace-Id` is trusted as the tenant. With real auth it would come from the token.
- **The filter is a snapshot taken at submit time.** Deals that start matching later are not
  moved; deals a human moves in the meantime are skipped as conflicts (DESIGN.md §3–4).
- Money is integer cents. Status values are `open | won | lost | abandoned`.
- `createdFrom` is inclusive and `createdTo` is exclusive.
- `Idempotency-Key` is recommended. Without it, an identical request (same workspace and canonical
  body) is treated as a retry while the earlier job is queued or processing, or was created in the
  last 10 minutes. After that, the same body counts as a new, intentional move.

## Project layout

```
src/
  engine/      the core, plain TypeScript, no Nest:
               submit.ts, worker.ts, chunk.ts, progress.ts, filter.ts, retry.ts, opportunities.ts
  api/         NestJS HTTP layer: controllers and DTOs (validation + Swagger)
  worker/      NestJS application context that runs the worker loop
  db/          pg pool and the transaction helper
migrations/    plain SQL, numbered, every index commented with why
scripts/       migrate.ts, seed.ts, demo/
bench/         benchmark runner and raw results
test/          node:test integration tests against real Postgres
```
