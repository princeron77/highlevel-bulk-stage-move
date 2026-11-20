-- Bulk stage move: the job (which is also the queue), its frozen snapshot, and idempotency keys.

CREATE TABLE bulk_jobs (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES workspaces (id),
  target_stage_id   uuid NOT NULL,
  filter            jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),

  -- Progress. cursor = highest snapshot seq whose outcome is committed.
  total             integer NOT NULL CHECK (total BETWEEN 0 AND 50000),
  cursor            integer NOT NULL DEFAULT 0,
  moved             integer NOT NULL DEFAULT 0,
  skipped_conflict  integer NOT NULL DEFAULT 0,
  skipped_noop      integer NOT NULL DEFAULT 0,

  -- Lease. lease_version is the fencing token: bumped on every claim, and every write a
  -- worker makes is conditional on it, so a worker that lost its lease cannot write.
  lease_owner       text,
  lease_version     bigint NOT NULL DEFAULT 0,
  lease_expires_at  timestamptz,
  heartbeat_at      timestamptz,
  -- Fair scheduling: the claim query serves the job that waited longest since its last slice.
  last_slice_at     timestamptz,
  -- Set while the job is paused by its workspace's token bucket (for progress health).
  throttled_until   timestamptz,

  -- Retries.
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  failure_reason    text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  last_progress_at  timestamptz,
  finished_at       timestamptz,

  FOREIGN KEY (workspace_id, target_stage_id) REFERENCES stages (workspace_id, id),
  CHECK (cursor BETWEEN 0 AND total),
  -- why: progress can never drift from reality; every committed item has exactly one outcome.
  CHECK (moved + skipped_conflict + skipped_noop = cursor),
  CHECK (status <> 'completed' OR cursor = total),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);

-- why: at most one job per workspace is processing at a time. Two jobs in one workspace
-- could overlap and fight over the same rows; this makes them run one after another.
CREATE UNIQUE INDEX bulk_jobs_one_processing_per_workspace_idx
  ON bulk_jobs (workspace_id)
  WHERE status = 'processing';

-- why: the claim query only ever looks at unfinished jobs; this keeps it small and fast.
CREATE INDEX bulk_jobs_claimable_idx
  ON bulk_jobs (status, next_attempt_at)
  WHERE status IN ('queued', 'processing');

CREATE TABLE bulk_job_items (
  job_id              uuid NOT NULL REFERENCES bulk_jobs (id),
  -- 1..total with no gaps (row_number at submit), so "cursor" doubles as processed count.
  seq                 integer NOT NULL CHECK (seq > 0),
  opportunity_id      uuid NOT NULL,
  -- What the opportunity looked like when the job was submitted.
  snapshot_stage_id   uuid NOT NULL,
  snapshot_stage_rev  bigint NOT NULL,
  outcome             text CHECK (outcome IN ('moved', 'skipped_conflict', 'skipped_noop')),
  -- why: this primary key is the index that makes chunking cheap: each chunk is a
  -- range scan "seq > cursor ORDER BY seq LIMIT n", no matter how big the job is.
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE idempotency_keys (
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  key           text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  -- sha256 of the canonical request; same key + different body is rejected with 422.
  request_hash  text NOT NULL,
  -- why: DEFERRABLE so the key can be inserted first (it acts as the lock for concurrent
  -- duplicates) and the job row in the same transaction afterwards.
  job_id        uuid NOT NULL REFERENCES bulk_jobs (id) DEFERRABLE INITIALLY DEFERRED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);
