# Architecture

The diagrams and reference tables behind [DESIGN.md](../DESIGN.md). Every diagram here
matches the code (`src/engine/*`) and the schema (`migrations/*.sql`).

## 1. Components

```mermaid
flowchart LR
  client["Client"]
  subgraph api["API process (NestJS HTTP, pool max 20)"]
    ctrl["Controllers + DTO validation"]
    submit["engine/submit.ts"]
    prog["engine/progress.ts"]
  end
  subgraph workers["Worker processes x2 (NestJS app context, pool max 4 each)"]
    loop["engine/worker.ts: claim, slice, heartbeat, retry"]
    chunk["engine/chunk.ts: one chunk = one transaction"]
  end
  pg[("PostgreSQL 16: data, queue, progress, leases, idempotency, rate limits")]

  client -- "POST /v1/bulk-moves" --> ctrl --> submit
  client -- "GET /v1/bulk-moves/:id" --> ctrl --> prog
  submit -- "1 tx: key + job + snapshot" --> pg
  prog -- "reads committed rows" --> pg
  loop -- "claim: FOR UPDATE SKIP LOCKED" --> pg
  loop --> chunk
  chunk -- "fenced chunk tx" --> pg
```

There is no message broker. A job is a row: it commits in the same transaction that creates it,
and claiming it is a query. Nothing can be "lost in a queue".

## 2. Database schema

```mermaid
erDiagram
  WORKSPACES ||--o{ STAGES : "has ordered"
  WORKSPACES ||--o{ OPPORTUNITIES : owns
  STAGES ||--o{ OPPORTUNITIES : "current stage of"
  OPPORTUNITIES ||--o{ STAGE_TRANSITIONS : "history of"
  WORKSPACES ||--o{ BULK_JOBS : submits
  BULK_JOBS ||--|{ BULK_JOB_ITEMS : "frozen snapshot"
  OPPORTUNITIES ||--o{ BULK_JOB_ITEMS : "snapshotted as"
  BULK_JOBS ||--o{ IDEMPOTENCY_KEYS : "deduplicated by"
  BULK_JOBS |o--o{ STAGE_TRANSITIONS : "wrote (bulk)"

  WORKSPACES {
    uuid id PK
    text name
    int bulk_rate_per_sec "token bucket: rows per second"
    int bulk_burst "token bucket: capacity"
    float8 bulk_tokens "token bucket: current level"
    timestamptz bulk_tokens_at "token bucket: last refill"
  }
  STAGES {
    uuid id PK
    uuid workspace_id FK
    text name
    int position "UNIQUE (workspace_id, position)"
  }
  OPPORTUNITIES {
    uuid id PK
    uuid workspace_id FK
    uuid stage_id FK "FK (workspace_id, stage_id)"
    text name
    bigint value_cents
    text status "open, won, lost, abandoned"
    text owner_id
    bigint stage_rev "bumped on every stage change"
    timestamptz created_at
    timestamptz updated_at
  }
  STAGE_TRANSITIONS {
    bigint id PK
    uuid workspace_id
    uuid opportunity_id FK
    uuid from_stage_id FK
    uuid to_stage_id FK
    text source "manual or bulk"
    uuid bulk_job_id "UNIQUE (bulk_job_id, opportunity_id)"
    timestamptz created_at
  }
  BULK_JOBS {
    uuid id PK
    uuid workspace_id FK
    uuid target_stage_id FK
    jsonb filter
    text request_hash "keyless dedupe"
    text status "queued, processing, completed, failed"
    int total
    int cursor "last committed seq"
    int moved
    int skipped_conflict
    int skipped_noop
    text lease_owner
    bigint lease_version "fencing token"
    timestamptz lease_expires_at
    timestamptz heartbeat_at
    timestamptz last_slice_at "round-robin order"
    timestamptz throttled_until
    int attempts
    timestamptz next_attempt_at "backoff"
    text last_error
    text failure_reason
    timestamptz last_progress_at
  }
  BULK_JOB_ITEMS {
    uuid job_id PK
    int seq PK "1..total, no gaps"
    uuid opportunity_id
    uuid snapshot_stage_id
    bigint snapshot_stage_rev
    text outcome "null, moved, skipped_conflict, skipped_noop"
  }
  IDEMPOTENCY_KEYS {
    uuid workspace_id PK
    text key PK
    text request_hash "sha256 of canonical body"
    uuid job_id FK "DEFERRABLE"
  }
```

### Constraints that enforce correctness (not just documentation)

| Constraint | Table | What it guarantees |
|---|---|---|
| `CHECK (moved + skipped_conflict + skipped_noop = cursor)` | bulk_jobs | Progress can never drift from the work actually done |
| `CHECK (cursor BETWEEN 0 AND total)` and `CHECK (status <> 'completed' OR cursor = total)` | bulk_jobs | "Completed" is impossible before every item is processed |
| `UNIQUE (workspace_id) WHERE status = 'processing'` | bulk_jobs | One running job per workspace: two jobs never fight over a tenant's rows |
| `UNIQUE (bulk_job_id, opportunity_id) WHERE bulk_job_id IS NOT NULL` | stage_transitions | A job can never move the same deal twice |
| `PRIMARY KEY (workspace_id, key)` | idempotency_keys | One job per key per tenant; it is the lock for concurrent duplicates |
| Composite FKs `(workspace_id, stage_id) → stages (workspace_id, id)` | opportunities, transitions, jobs | Data can never point into another tenant |

### Indexes and why each exists

| Index | Used by |
|---|---|
| `bulk_job_items (job_id, seq)` (PK) | Every chunk: a range scan from the cursor. Chunk 100 costs the same as chunk 1. |
| `bulk_jobs (status, next_attempt_at) WHERE status IN ('queued','processing')` | The claim query only looks at unfinished jobs |
| `bulk_jobs (workspace_id) WHERE status = 'processing'` (unique) | Isolation rule above, and the claim's "workspace already busy?" check |
| `bulk_jobs (workspace_id, request_hash, created_at DESC)` | Keyless idempotency lookup |
| `opportunities (workspace_id, stage_id, created_at, id)` | Listing a stage (keyset pagination) and the bulk stage filter |
| `opportunities (workspace_id, owner_id)` / `(workspace_id, created_at)` | Bulk filters by owner and by date range |
| `stage_transitions (workspace_id, opportunity_id, created_at)` | A deal's history |

## 3. Job lifecycle

```mermaid
stateDiagram-v2
  [*] --> queued: submit returns 202
  queued --> processing: claimed, workspace not busy
  processing --> processing: slice ends, throttled, or transient error (lease released)
  processing --> completed: last chunk commits, cursor equals total
  processing --> failed: permanent error or 5 attempts
  failed --> queued: POST retry (continues from cursor)
  completed --> [*]
```

Once a job starts, it **stays `processing`** between time slices, rate-limit pauses and retries.
Only the lease is released. That prevents status flapping, and the unique index keeps a second
job in the same workspace from starting in a gap. Inside `processing`, the progress endpoint's
`health` field says what is happening:

| health | Condition (from committed columns, database clock) | Meaning for the user |
|---|---|---|
| `queued` | status = queued | Waiting for its first turn |
| `retrying` | attempts > 0 and next_attempt_at in the future | Transient error; retry scheduled |
| `throttled` | throttled_until in the future | Paused by the workspace rate limit: slow on purpose |
| `running` | lease_expires_at in the future | A worker is moving rows now |
| `waiting` | none of the above | Between slices: other workspaces are getting their turn (however long the queue) |
| `stalled` | lease still owned but expired over 5 s ago (worker died, nobody took over), or no committed progress for 5 min | Stuck: needs attention |
| `done` / `failed` | terminal status | Finished; `failureReason` explains a failure |

Each snapshot item ends with exactly one outcome:

| Current state of the deal when its chunk runs | Outcome |
|---|---|
| Already in the target stage | `skipped_noop` |
| Same stage **and** same `stage_rev` as at submit | `moved` (and one `bulk` transition) |
| Anything else (a human or an earlier job moved it) | `skipped_conflict`: the newer edit wins |

## 4. Sequence: submit (idempotent, also under concurrent duplicates)

```mermaid
sequenceDiagram
  participant A as Request A
  participant B as Request B (same key and body)
  participant API
  participant PG as Postgres
  A->>API: POST /v1/bulk-moves (Idempotency-Key k)
  API->>PG: BEGIN, INSERT idempotency_keys (k) ON CONFLICT DO NOTHING
  B->>API: POST /v1/bulk-moves (Idempotency-Key k)
  API->>PG: BEGIN, INSERT idempotency_keys (k) ON CONFLICT DO NOTHING
  Note over PG: B blocks on the unique index until A's transaction ends
  API->>PG: A: count matches (LIMIT 50001), INSERT job, INSERT snapshot items
  API->>PG: A: COMMIT
  API-->>A: 202 jobId
  PG-->>API: B: conflict, no row inserted
  API->>PG: B: SELECT key row, compare request_hash
  API-->>B: 200 same jobId (422 if the body differed, never 409)
```

Without a key, a transaction-scoped advisory lock on (workspace, request hash) plays the same
role as the key row.

## 5. Sequence: one worker slice

```mermaid
sequenceDiagram
  participant W as Worker
  participant PG as Postgres
  W->>PG: claim: least recently served job, FOR UPDATE SKIP LOCKED, lease_version + 1
  PG-->>W: job id, fence
  loop each chunk, until the 2 s slice ends
    W->>PG: BEGIN, SET LOCAL lock_timeout and statement_timeout
    W->>PG: SELECT job FOR UPDATE WHERE lease_version = fence
    Note over W,PG: no row means another worker owns the job: roll back and stop
    W->>PG: take tokens from the workspace bucket
    W->>PG: read items by (job_id, seq) range, lock their opportunities by id
    W->>PG: UPDATE moved rows, INSERT transitions, UPDATE item outcomes
    W->>PG: UPDATE job cursor and counters (completed if cursor = total)
    W->>PG: COMMIT
  end
  W->>PG: release lease, last_slice_at = now()
```

A heartbeat timer extends the lease, conditional on the fence. If tokens run out, the worker
releases the job early, sets `throttled_until`, and serves another workspace.

## 6. Sequence: crash and resume

```mermaid
sequenceDiagram
  participant W1 as Worker 1
  participant W2 as Worker 2
  participant PG as Postgres
  W1->>PG: chunk 60 COMMIT, cursor = 30000
  W1->>PG: chunk 61 in progress
  Note over W1: SIGKILL
  Note over PG: connection closes, chunk 61 rolls back, cursor stays 30000
  Note over PG: lease expires (up to 15 s)
  W2->>PG: claim: lease expired, lease_version + 1, attempts + 1
  W2->>PG: chunk tx from seq 30001
  Note over W1,PG: if Worker 1 had only stalled and woke up, its next write fails the fence check
  W2->>PG: last chunk: cursor = total, status completed
```

## 7. Sequence: a manual move and the job hit the same deal

```mermaid
sequenceDiagram
  participant U as User (PATCH stage)
  participant W as Worker chunk
  participant PG as Postgres
  U->>PG: SELECT deal FOR UPDATE (lock_timeout 1 s)
  U->>PG: UPDATE stage, stage_rev + 1, INSERT manual transition, COMMIT
  W->>PG: lock the chunk's deals FOR UPDATE
  PG-->>W: deal has stage_rev different from the snapshot
  W->>PG: outcome = skipped_conflict, deal untouched
  Note over U,W: if the chunk holds the lock first, the user waits milliseconds and moves the deal afterwards. The human acts last either way.
```

## 8. Locks, timeouts and pools

| Where | Setting | Why |
|---|---|---|
| Chunk transaction | `lock_timeout 2 s`, `statement_timeout 10 s`, 500 rows | Short, bounded transactions; row locks held well under a second |
| Manual move | `lock_timeout 1 s` + one retry, then `503` | An interactive request never waits behind bulk work for long |
| Submit | `statement_timeout 30 s` | Bounds the 50k snapshot insert |
| Lease / heartbeat | 15 s / 5 s | A dead worker's job is reclaimed within the lease time |
| Time slice | 2 s | Round-robin fairness between workspaces |
| Retries | backoff 0.5 s → 30 s with jitter, 5 attempts | Transient errors recover; a failure never loops forever |
| Pools | API 20, each worker 4 | Bulk work can never take the API's connections |
