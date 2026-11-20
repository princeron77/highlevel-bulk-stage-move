/**
 * One chunk = one transaction. Everything a chunk changes (opportunities, transitions,
 * item outcomes, the job's cursor and counters) commits together or not at all.
 * A crash at any point leaves the job exactly at its last committed cursor.
 */
import type { Client } from '../db/pool.js';

export type Outcome = 'moved' | 'skipped_conflict' | 'skipped_noop';

export interface LockedItem {
  seq: number;
  opportunity_id: string;
  snapshot_stage_id: string;
  snapshot_stage_rev: string;
  current_stage_id: string;
  current_stage_rev: string;
}

/**
 * The collision rule, as a pure function.
 * - already in the target stage            -> skipped_noop (nothing to do)
 * - unchanged since submit (stage AND rev) -> moved
 * - anything else (a human moved it, even away and back) -> skipped_conflict: the manual edit wins
 */
export function classify(item: LockedItem, targetStageId: string): Outcome {
  if (item.current_stage_id === targetStageId) return 'skipped_noop';
  const unchanged =
    item.current_stage_id === item.snapshot_stage_id && item.current_stage_rev === item.snapshot_stage_rev;
  return unchanged ? 'moved' : 'skipped_conflict';
}

export interface ChunkJob {
  id: string;
  workspaceId: string;
  targetStageId: string;
}

export interface ChunkCounts {
  moved: number;
  skippedConflict: number;
  skippedNoop: number;
}

/**
 * Locks the chunk's opportunities, applies the collision rule, moves the unchanged ones,
 * writes transitions and item outcomes. The caller owns the transaction and the fence check.
 */
export async function applyChunk(
  client: Client,
  job: ChunkJob,
  fromSeq: number,
  toSeq: number,
): Promise<ChunkCounts> {
  // Step 1: the chunk's snapshot items, by primary key (job_id, seq): always an index range scan.
  const items = await client.query<{ seq: number; opportunity_id: string; snapshot_stage_id: string; snapshot_stage_rev: string }>(
    `SELECT seq, opportunity_id, snapshot_stage_id, snapshot_stage_rev
     FROM bulk_job_items WHERE job_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq`,
    [job.id, fromSeq, toSeq],
  );
  // Step 2: lock exactly those opportunities by primary key, in id order.
  // why: two simple primary-key lookups instead of one join, so the plan never depends on
  // table statistics. A freshly inserted 50k snapshot has none until autoanalyze runs, and a
  // join could then fall back to scanning the whole opportunities table on every chunk.
  // FOR UPDATE: a manual move waits for this short transaction, or this waits for it
  // (lock_timeout bounds both).
  const locked = await client.query<{ id: string; stage_id: string; stage_rev: string }>(
    `SELECT id, stage_id, stage_rev FROM opportunities
     WHERE workspace_id = $1 AND id = ANY($2::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [job.workspaceId, items.rows.map((r) => r.opportunity_id)],
  );
  if (items.rows.length !== toSeq - fromSeq || locked.rows.length !== items.rows.length) {
    throw new Error(`Chunk ${fromSeq}-${toSeq} of job ${job.id} found ${items.rows.length} items, ${locked.rows.length} rows`);
  }
  const current = new Map(locked.rows.map((r) => [r.id, r]));
  const rows: LockedItem[] = items.rows.map((item) => {
    const row = current.get(item.opportunity_id)!;
    return { ...item, current_stage_id: row.stage_id, current_stage_rev: row.stage_rev };
  });

  const outcomes = rows.map((item) => classify(item, job.targetStageId));
  const toMove = rows.filter((_, i) => outcomes[i] === 'moved');

  if (toMove.length > 0) {
    await client.query(
      `UPDATE opportunities SET stage_id = $3, stage_rev = stage_rev + 1, updated_at = now()
       WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [job.workspaceId, toMove.map((r) => r.opportunity_id), job.targetStageId],
    );
    // why: the unique (bulk_job_id, opportunity_id) index makes a replayed chunk fail loudly
    // instead of writing a second transition.
    await client.query(
      `INSERT INTO stage_transitions (workspace_id, opportunity_id, from_stage_id, to_stage_id, source, bulk_job_id)
       SELECT $1, t.id, t.from_stage, $4, 'bulk', $5
       FROM unnest($2::uuid[], $3::uuid[]) AS t(id, from_stage)`,
      [job.workspaceId, toMove.map((r) => r.opportunity_id), toMove.map((r) => r.current_stage_id), job.targetStageId, job.id],
    );
  }

  // why: a primary-key range (job_id, seq) plus an array lookup by position. No join, so no
  // plan choice: the same fast index scan whether or not the snapshot has statistics yet.
  // outcomes[k] belongs to seq fromSeq + 1 + k (items are contiguous and in seq order).
  const marked = await client.query(
    `UPDATE bulk_job_items SET outcome = ($4::text[])[seq - $2]
     WHERE job_id = $1 AND seq > $2 AND seq <= $3 AND outcome IS NULL`,
    [job.id, fromSeq, toSeq, outcomes],
  );
  if (marked.rowCount !== rows.length) {
    throw new Error(`Chunk ${fromSeq}-${toSeq} of job ${job.id} was already processed`);
  }

  return {
    moved: toMove.length,
    skippedConflict: outcomes.filter((o) => o === 'skipped_conflict').length,
    skippedNoop: outcomes.filter((o) => o === 'skipped_noop').length,
  };
}

/**
 * Per-workspace token bucket, refilled by elapsed time, stored on the workspace row.
 * Returns 0 if `n` tokens were taken, otherwise how many ms until they would be available.
 * Runs inside the chunk transaction, so tokens are only spent if the chunk commits.
 *
 * A chunk may need more tokens than the bucket can ever hold (burst < chunk size, e.g. a tenant
 * on a very low limit). Waiting for `n` would then throttle the job forever, so the chunk is
 * allowed once the bucket is full and the balance goes negative: the next chunks wait longer,
 * and the long-run rate is still exactly bulk_rate_per_sec.
 */
export async function takeTokens(client: Client, workspaceId: string, n: number): Promise<number> {
  const { rows } = await client.query<{ available: number; rate: number; need: number; taken: boolean }>(
    `WITH b AS (
       SELECT least(bulk_burst, bulk_tokens + extract(epoch FROM now() - bulk_tokens_at) * bulk_rate_per_sec) AS available,
              bulk_rate_per_sec AS rate, least($2, bulk_burst) AS need
       FROM workspaces WHERE id = $1 FOR UPDATE
     ), upd AS (
       UPDATE workspaces w SET bulk_tokens = b.available - $2, bulk_tokens_at = now()
       FROM b WHERE w.id = $1 AND b.available >= b.need
       RETURNING 1
     )
     SELECT b.available, b.rate, b.need, EXISTS (SELECT 1 FROM upd) AS taken FROM b`,
    [workspaceId, n],
  );
  const bucket = rows[0];
  if (!bucket) throw new Error(`Workspace ${workspaceId} not found`);
  if (bucket.taken) return 0;
  return Math.max(1, Math.ceil(((bucket.need - bucket.available) / bucket.rate) * 1000));
}
