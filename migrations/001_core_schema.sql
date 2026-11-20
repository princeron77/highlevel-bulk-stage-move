-- Core domain: workspaces (tenants), ordered stages, opportunities, transitions.
-- Every tenant-owned table carries workspace_id, and cross-table references include it
-- in the foreign key, so the database itself refuses a row that points into another tenant.

CREATE TABLE workspaces (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  -- Token bucket for bulk work in this workspace (rows per second).
  -- why: the bucket lives on the tenant row so the limit holds across all workers and restarts.
  bulk_rate_per_sec  integer NOT NULL DEFAULT 2000 CHECK (bulk_rate_per_sec > 0),
  bulk_burst         integer NOT NULL DEFAULT 4000 CHECK (bulk_burst > 0),
  bulk_tokens        double precision NOT NULL DEFAULT 4000,
  bulk_tokens_at     timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  name          text NOT NULL,
  position      integer NOT NULL CHECK (position >= 0),
  -- why: one pipeline per workspace (documented assumption); position orders its stages.
  UNIQUE (workspace_id, position),
  -- why: target of composite FKs below, so a stage can only be used inside its own workspace.
  UNIQUE (workspace_id, id)
);

CREATE TABLE opportunities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  stage_id      uuid NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- why: integer cents, never floating point, for money.
  value_cents   bigint NOT NULL CHECK (value_cents >= 0),
  status        text NOT NULL CHECK (status IN ('open', 'won', 'lost', 'abandoned')),
  owner_id      text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 100),
  -- why: bumped on every stage change. The bulk job compares it with the value it saw at
  -- submit time to detect a manual move in between (optimistic concurrency).
  stage_rev     bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, stage_id) REFERENCES stages (workspace_id, id)
);

-- why: serves "list a stage" with keyset pagination on (created_at, id), and the stage filter of bulk moves.
CREATE INDEX opportunities_stage_list_idx
  ON opportunities (workspace_id, stage_id, created_at, id);
-- why: bulk filters by owner and by created_at range without scanning the whole workspace.
CREATE INDEX opportunities_owner_idx   ON opportunities (workspace_id, owner_id);
CREATE INDEX opportunities_created_idx ON opportunities (workspace_id, created_at);

CREATE TABLE stage_transitions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id    uuid NOT NULL,
  opportunity_id  uuid NOT NULL REFERENCES opportunities (id),
  from_stage_id   uuid NOT NULL,
  to_stage_id     uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('manual', 'bulk')),
  bulk_job_id     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (from_stage_id <> to_stage_id),
  CHECK ((source = 'bulk') = (bulk_job_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, from_stage_id) REFERENCES stages (workspace_id, id),
  FOREIGN KEY (workspace_id, to_stage_id)   REFERENCES stages (workspace_id, id)
);

-- why: row-level idempotency. A job can record at most one transition per opportunity,
-- so even a replayed chunk can never double-apply.
CREATE UNIQUE INDEX stage_transitions_one_per_job_idx
  ON stage_transitions (bulk_job_id, opportunity_id)
  WHERE bulk_job_id IS NOT NULL;
CREATE INDEX stage_transitions_history_idx
  ON stage_transitions (workspace_id, opportunity_id, created_at);
