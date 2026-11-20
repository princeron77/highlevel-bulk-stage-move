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
| [BENCHMARKS.md](BENCHMARKS.md) | 50k move, p95/p99 during the move, kill and resume, hardware, method |
| [docs/API.md](docs/API.md) | Every endpoint with a curl example |
| `http://localhost:3000/docs` | Swagger UI (OpenAPI), generated from the code |

## Run it (one command)

Needs Docker Desktop.

```bash
docker compose up --build
```

This starts Postgres, runs the migrations, seeds **5 small workspaces** (3,000 deals each),
then starts the **API** on `:3000` and **2 workers**.

- Swagger UI: <http://localhost:3000/docs>
- Health: <http://localhost:3000/health>

## Run the tests

```bash
docker compose --profile test run --rm --build test
```

The tests run against a real Postgres. Each test file creates and drops its own database.

| Test file | What it proves |
|---|---|
| `test/submit-idempotency.test.ts` | Replay → same job, `200`. 10 concurrent duplicates → 1 job. Different body → `422`. >50k → `422` with nothing written. Dedupe survives a restart. Tenant scoping. |
| `test/worker.test.ts` | **Kill and resume** (a real worker process exits mid-job holding its lease). **Collision** (a manual edit wins). **Fencing** (a zombie worker can't write). **Isolation** (workspace B finishes while A's big job runs). Transient retry. Permanent failure. |
| `test/opportunities.http.test.ts` | Part 1: create, manual move with transition, keyset paging, tenant scoping, error shape. |

The safety tests were checked by deleting each mechanism. Removing the fence, the `stage_rev`
check or the request-hash check turns the matching test red.

Without Docker (Node 22 and a local Postgres):
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

## Endpoints

All endpoints take `X-Workspace-Id: <uuid>` (tenant scope; not authentication).

| Method | Path | |
|---|---|---|
| `GET` | `/v1/stages` | Stages of the workspace, in order |
| `POST` | `/v1/opportunities` | Create a deal |
| `PATCH` | `/v1/opportunities/:id/stage` | Move one deal (records a transition, bumps `stageRev`) |
| `GET` | `/v1/stages/:stageId/opportunities?limit&cursor` | List a stage (keyset pagination) |
| `POST` | `/v1/bulk-moves` | Submit a bulk move. Requires `Idempotency-Key`. `202` new / `200` replay / `422` mismatch or >50k |
| `GET` | `/v1/bulk-moves/:jobId` | Progress: `status`, `processed`, `percent`, counts, `health` |
| `GET` | `/v1/bulk-moves/:jobId/items?outcome=` | Per-deal outcomes, e.g. which ones were skipped as conflicts |
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
- **Graceful shutdown:** on SIGTERM a worker finishes its current chunk and hands the job back.

## What is not implemented

- **Out of scope per the brief:** auth, UI, board or summary views, rollups, events, CI/K8s,
  custom fields.
- **Not built, but described in DESIGN.md §7:** cancel, outbox events, poison-row isolation,
  an asynchronous snapshot for very large moves, and a global (cross-tenant) write budget.
- **Deployment.** Out of scope in the brief, but the recruiter asked for a link, so
  [deploy/README.md](deploy/README.md) runs the same compose file on one small VM.

## Assumptions

- One pipeline per workspace (the brief describes "a pipeline"), so stages belong to the workspace.
- `X-Workspace-Id` is trusted as the tenant. With real auth it would come from the token.
- **The filter is a snapshot taken at submit time.** Deals that start matching later are not
  moved; deals a human moves in the meantime are skipped as conflicts (DESIGN.md §3–4).
- Money is integer cents. Status values are `open | won | lost | abandoned`.
- `createdFrom` is inclusive and `createdTo` is exclusive.
- `Idempotency-Key` is required on submit. A missing key returns `400` rather than guessing.

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
