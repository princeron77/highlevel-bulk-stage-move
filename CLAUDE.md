# Bulk Stage Move — HighLevel SDE-3 take-home

One hard thing done with care: a background job that moves up to 50,000 opportunities
between stages and stays idempotent, resumable, observable, correct under concurrent
manual edits, and fair to other tenants. Part 1 (basic CRUD) exists only to give it somewhere to run.

The assignment brief is kept locally in `.private/` (gitignored). Read it before planning any milestone.
The author must be able to defend every line in a review. Optimise for code that is
**obviously correct and easy to explain**, not clever.

## Hard rules (from the brief and the recruiter)
- Retrying the same request must **never return 409**.
  - First submit: `202`. Same key and same body: `200` with the same `jobId`, including concurrent duplicates.
  - Same key with a different body: `422`.
- The job must resume after a crash, retry transient errors with backoff, and stay safe under concurrency.
- Job status values are exactly `queued | processing | completed | failed`.
- `docker compose up` on a clean machine migrates, seeds a small dataset, and starts the API and 2 workers.
  `docker compose --profile test up --exit-code-from test` runs the tests.
- **Out of scope, do not build:** UI, auth, board/summary views, per-stage counts or rollups,
  rich filtering/sorting, downstream events, CI/K8s, custom fields, contacts/notes/tasks,
  exhaustive validation.

## Stack
- Node 22 LTS, TypeScript `strict`, NestJS (latest stable), PostgreSQL 16.
- `pg` driver with raw parameterised SQL. No ORM. Every hot-path query should be readable on its own.
- `class-validator` DTOs with a global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`).
- `@nestjs/swagger` decorators on every endpoint and DTO. Swagger UI is served at `/docs`.
- `nestjs-pino` for structured logs, including `jobId`, `workspaceId` and `fence` on worker logs.
- Tests: Node's built-in `node:test` on the compiled output, plus supertest for HTTP. Integration tests run
  against real Postgres, never mocks, for the hard parts. (Nest 12 is ESM-only; this avoids Jest's ESM issues.)
- ESM project (`"type": "module"`): relative imports end in `.js`.
- No Redis, Kafka or BullMQ: the `bulk_jobs` table is the queue. Justify this in DESIGN.md.
- Ask before adding any dependency not listed here.

## Architecture
Two processes from one codebase:
- `api` is HTTP.
- `worker` uses `NestFactory.createApplicationContext`, with no HTTP.

The engine (`submit`, `claim`, `processChunk`) is plain TS classes that take a `Pool`,
so it can be tested without Nest. Each process has its own pool. The worker pool is small (max 4)
so it can never take connections from the API.

### Tables (plain numbered SQL migrations in `migrations/`)
- **`workspaces`**: also stores the token bucket (`rate_tokens`, `rate_refilled_at`, `rate_per_sec`, `rate_burst`).
- **`stages`**: `(workspace_id, position)`. Assumption: one pipeline per workspace (README).
- **`opportunities`**: `name`, `value_cents bigint`, `status`, `owner_id`, `stage_id`, `stage_rev bigint`, timestamps.
- **`stage_transitions`**: `from`, `to`, `source 'manual'|'bulk'`, `bulk_job_id null`.
  - `UNIQUE (bulk_job_id, opportunity_id) WHERE bulk_job_id IS NOT NULL`: row-level idempotency.
- **`idempotency_keys`**: `PRIMARY KEY (workspace_id, key)`, plus `request_hash` and `job_id`.
  - `job_id` is an FK to `bulk_jobs`, `DEFERRABLE INITIALLY DEFERRED`.
- **`bulk_jobs`**:
  - Job definition: `workspace_id`, `target_stage_id`, `filter jsonb`, `status`, `total`.
  - Progress: `cursor` (last committed seq), `moved`, `skipped_conflict`, `skipped_noop`.
  - Lease: `lease_owner`, `lease_version` (the fence), `lease_expires_at`, `heartbeat_at`.
  - Fairness: `last_slice_at`.
  - Retries: `attempts`, `next_attempt_at`, `last_error`, `failure_reason`.
  - Timestamps: `last_progress_at`, `created_at`, `started_at`, `finished_at`.
  - Partial unique index: one `processing` job per workspace.
- **`bulk_job_items`**: `(job_id, seq)` primary key, `opportunity_id`, `snapshot_stage_id`,
  `snapshot_stage_rev`, `outcome null|moved|skipped_conflict|skipped_noop`.
  - `seq` is `row_number() OVER (ORDER BY opportunity id)`, so it runs 1..total with no gaps.
  - This PK is the index that makes chunking cheap.

### Submit (one transaction, READ COMMITTED)
1. Validate and normalise the body, then compute `request_hash = sha256(canonical JSON incl. workspaceId)`.
2. Generate `jobId` in the app.
3. `INSERT INTO idempotency_keys … ON CONFLICT DO NOTHING RETURNING`. This row is the lock:
   a concurrent duplicate blocks here until the winner commits.
4. If no row came back, read the existing key. If the hash matches, return `200` with the existing job.
   If it differs, return `422`. **Never 409.**
5. Count matches with `LIMIT 50001`. Over 50,000 returns `422` and writes nothing.
6. Insert the job and its snapshot items (`INSERT … SELECT … row_number()`), set `total`, commit, return `202`.

### Worker loop
1. **Claim.** One short tx with `FOR UPDATE SKIP LOCKED`.
   - Eligible: `queued` jobs whose workspace has no `processing` job, plus `processing` jobs
     with no live lease and `next_attempt_at <= now()`.
   - Order by `last_slice_at NULLS FIRST, created_at`. This is round-robin across workspaces.
   - On claim: set `processing` and `lease_owner`, bump `lease_version` (the fence), and set `lease_expires_at`.
2. **Time slice.** Process chunks for at most `SLICE_MS` (about 2 s). Then release the lease and set
   `last_slice_at = now()`, so other workspaces get the worker. Status stays `processing`.
3. **Heartbeat.** A `setInterval` extends the lease `WHERE lease_version = fence`.
   A failed heartbeat only logs; it never crashes the worker.
4. **Chunk.** One tx, fenced, set-based (no per-row loops):
   - `SET LOCAL lock_timeout`, then `SET LOCAL statement_timeout`.
   - `SELECT … FOR UPDATE` the job `WHERE id AND lease_version = $fence`. 0 rows means a stale
     worker: roll back and stop.
   - Take tokens from the workspace bucket. If there aren't enough, release the slice early.
   - Lock the chunk's opportunities in id order. Then, in a few CTE statements:
     - Move rows where `stage_id = snapshot_stage_id AND stage_rev = snapshot_stage_rev`.
     - Mark rows already at the target as `skipped_noop`.
     - Mark everything else as `skipped_conflict` (**manual edits win**).
     - Insert `bulk` transitions for the moved rows.
     - Set item outcomes.
   - Advance `cursor` and the counters, set `last_progress_at`. If `cursor = total`, set `completed`
     in the same fenced tx.
5. **Errors.** Classify by pg code.
   - Transient (`40001`, `40P01`, `55P03`, `57014`, `57P01`, `08*`, connection resets): `attempts + 1`,
     exponential backoff with jitter in `next_attempt_at`, release the lease.
   - Permanent, or 5 attempts: `failed` with `failure_reason`.
6. **Test hook.** `CRASH_AFTER_CHUNKS=N` makes the worker `process.exit(137)` right after chunk N
   commits, for deterministic kill-resume tests.

### Manual single move (Part 1)
- One tx: `SET LOCAL lock_timeout '1s'`, `SELECT … FOR UPDATE`, update `stage_id`, `stage_rev + 1`,
  insert a `manual` transition.
- One automatic retry on a lock timeout.

### Progress, `GET /v1/bulk-moves/:id`
- From committed rows only: `status`, `total`, `processed` (= `cursor`), `percent`, outcome counts,
  `attempts`, `lastError`, `heartbeatAt`, `lastProgressAt`.
- `health`:
  - `queued`
  - `running`: lease is live and progress is recent.
  - `throttled`: lease is live but waiting on tokens.
  - `retrying`: `next_attempt_at` is in the future.
  - `stalled`: no live lease and no progress for over 2× the lease time.
  - `done`, `failed`

## API (all routes need `X-Workspace-Id`, which comes from the header and never from the body)
- `POST  /v1/opportunities`
- `PATCH /v1/opportunities/:id/stage`
- `GET   /v1/stages/:stageId/opportunities?limit&cursor` (keyset pagination on `(created_at, id)`)
- `POST  /v1/bulk-moves` (requires `Idempotency-Key`)
- `GET   /v1/bulk-moves/:jobId`
- `GET   /v1/bulk-moves/:jobId/items?outcome=` (should-have)
- `GET   /health`

Errors use one JSON shape: `{ statusCode, error, message, requestId }`.
Reading another workspace's job returns 404.

## Code conventions
- Layout: `src/api/*`, `src/worker/*`, `src/engine/*` (pure, Nest-free), `src/db/*`, `src/common/*`,
  `scripts/` (migrate, seed), `migrations/` (plain SQL), `test/`, `bench/`.
- Every lock, timeout, isolation choice and index gets a one-line `// why:` comment.
- No `any`. Explicit row types for every query. Functions stay under about 40 lines.
- Money is integer cents. All timestamps are `timestamptz` in UTC.
- No dead scaffold: delete the default `app.controller` / `app.service`, unused scripts and files.
- `.env.example` must match `docker-compose.yml` exactly.

## Tests that must exist (each must fail if its safety mechanism is removed)
- **Idempotency:**
  - A replay returns the same id with `200`.
  - 10 parallel identical submits create exactly 1 job.
  - A different body with the same key returns `422`.
  - 50,001 matches returns `422` with nothing written.
- **Kill-resume:** `CRASH_AFTER_CHUNKS`, restart, then `completed`. The verify SQL finds no deal in the
  wrong stage and exactly one transition per moved deal.
- **Collision:** a manual move during the job gives `skipped_conflict`, and the manual stage is kept.
- **Fencing:** a stale `lease_version` cannot write.
- **Fairness:** with one worker, workspace B's small job completes while A's 50k job is still `processing`.
- **Transient retry:** an injected `40001` once leads to a retry and then completion. A permanent error leads to `failed`.
- **Progress honesty:** after a restart, progress equals the committed `cursor`.

## Docs to keep current
- `README.md`: run, seed, test, endpoints, assumptions, implemented vs not implemented.
- `DESIGN.md`: 2–3 pages, with exactly the brief's 7 headings, plus mermaid diagrams.
- `BENCHMARKS.md`: hardware, method and raw outputs. Measure manual-move (write) p95/p99 too, not only reads.
- `docs/API.md`: one curl example per endpoint, matching `scripts/demo/*.sh`.

## How to work in this repo
- Plan first (plan mode) for each milestone. Show the plan and wait for approval before editing.
- Small commits with conventional messages, one logical change each. Never squash.
- After each milestone, run lint, build and tests, and fix anything red. Then print a short
  "Explain-back": the 5 questions a reviewer would ask about this diff, each with a 2-line answer.
- If something in the brief is ambiguous, choose, then write the assumption in README "Assumptions".
