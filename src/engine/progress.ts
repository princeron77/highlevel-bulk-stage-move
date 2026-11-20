/**
 * Progress is read from committed rows only. Nothing lives in worker memory, so a worker
 * restart can never make the numbers lie.
 */
import type { Pool } from '../db/pool.js';
import { notFound } from './errors.js';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

/**
 * How the job is doing right now, so a user can tell slow from stuck from failed:
 * - queued     waiting for its first turn (another job in this workspace may be running)
 * - running    a worker holds a live lease and is moving rows
 * - throttled  a worker holds it but the workspace's rate limit is pausing it (slow, on purpose)
 * - waiting    between time slices, waiting for its next turn (normal under load)
 * - retrying   a transient error happened; it will retry at nextAttemptAt
 * - stalled    no live worker and no progress for over 2x the lease time (stuck: needs attention)
 * - done / failed  finished
 */
export type JobHealth = 'queued' | 'running' | 'throttled' | 'waiting' | 'retrying' | 'stalled' | 'done' | 'failed';

export interface JobProgress {
  jobId: string;
  status: JobStatus;
  health: JobHealth;
  targetStageId: string;
  filter: unknown;
  total: number;
  processed: number;
  percent: number;
  counts: { moved: number; skippedConflict: number; skippedNoop: number; pending: number };
  attempts: number;
  lastError: string | null;
  failureReason: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  startedAt: string | null;
  lastProgressAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
}

interface JobRow {
  id: string;
  status: JobStatus;
  target_stage_id: string;
  filter: unknown;
  total: number;
  cursor: number;
  moved: number;
  skipped_conflict: number;
  skipped_noop: number;
  attempts: number;
  last_error: string | null;
  failure_reason: string | null;
  next_attempt_at: Date;
  created_at: Date;
  started_at: Date | null;
  last_progress_at: Date | null;
  heartbeat_at: Date | null;
  finished_at: Date | null;
  lease_live: boolean;
  throttled: boolean;
  retry_pending: boolean;
  quiet_ms: number;
}

export function computeHealth(row: JobRow, leaseMs: number): JobHealth {
  if (row.status === 'completed') return 'done';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'queued') return 'queued';
  if (row.retry_pending) return 'retrying';
  if (row.throttled) return 'throttled';
  if (row.lease_live) return 'running';
  return row.quiet_ms > 2 * leaseMs ? 'stalled' : 'waiting';
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function getProgress(
  pool: Pool,
  workspaceId: string,
  jobId: string,
  leaseMs: number,
): Promise<JobProgress> {
  // why: time comparisons use the database clock, the same clock the worker writes with.
  const { rows } = await pool.query<JobRow>(
    `SELECT id, status, target_stage_id, filter, total, cursor, moved, skipped_conflict, skipped_noop,
            attempts, last_error, failure_reason, next_attempt_at, created_at, started_at,
            last_progress_at, heartbeat_at, finished_at,
            coalesce(lease_expires_at > now(), false)            AS lease_live,
            coalesce(throttled_until > now(), false)             AS throttled,
            (attempts > 0 AND next_attempt_at > now())           AS retry_pending,
            (extract(epoch FROM now() - coalesce(last_progress_at, started_at, created_at)) * 1000)::float8
                                                                 AS quiet_ms
     FROM bulk_jobs WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, jobId],
  );
  const row = rows[0];
  if (!row) throw notFound('Bulk move job'); // also for another workspace's job: no existence leak

  return {
    jobId: row.id,
    status: row.status,
    health: computeHealth(row, leaseMs),
    targetStageId: row.target_stage_id,
    filter: row.filter,
    total: row.total,
    processed: row.cursor,
    percent: row.total === 0 ? 100 : Math.floor((row.cursor / row.total) * 1000) / 10,
    counts: {
      moved: row.moved,
      skippedConflict: row.skipped_conflict,
      skippedNoop: row.skipped_noop,
      pending: row.total - row.cursor,
    },
    attempts: row.attempts,
    lastError: row.last_error,
    failureReason: row.failure_reason,
    nextAttemptAt: row.retry_pending ? iso(row.next_attempt_at) : null,
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    lastProgressAt: iso(row.last_progress_at),
    heartbeatAt: iso(row.heartbeat_at),
    finishedAt: iso(row.finished_at),
  };
}

export interface JobItem {
  seq: number;
  opportunityId: string;
  snapshotStageId: string;
  outcome: string | null;
}

/** Per-opportunity outcomes, e.g. ?outcome=skipped_conflict to see which deals a human moved. */
export async function listItems(
  pool: Pool,
  workspaceId: string,
  jobId: string,
  outcome: string | undefined,
  afterSeq: number,
  limit: number,
): Promise<{ data: JobItem[]; nextAfterSeq: number | null }> {
  const owned = await pool.query('SELECT 1 FROM bulk_jobs WHERE workspace_id = $1 AND id = $2', [workspaceId, jobId]);
  if (owned.rowCount === 0) throw notFound('Bulk move job');
  const { rows } = await pool.query<{ seq: number; opportunity_id: string; snapshot_stage_id: string; outcome: string | null }>(
    `SELECT seq, opportunity_id, snapshot_stage_id, outcome
     FROM bulk_job_items
     WHERE job_id = $1 AND seq > $2 AND ($3::text IS NULL OR outcome IS NOT DISTINCT FROM nullif($3, 'pending'))
     ORDER BY seq LIMIT $4`,
    [jobId, afterSeq, outcome ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    data: page.map((r) => ({ seq: r.seq, opportunityId: r.opportunity_id, snapshotStageId: r.snapshot_stage_id, outcome: r.outcome })),
    nextAfterSeq: hasMore ? page.at(-1)!.seq : null,
  };
}
