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
  // why: FOR UPDATE OF o locks the chunk's rows in id order (seq follows id order). A manual
  // move waits for this short transaction, or this waits for it (lock_timeout bounds both).
  const { rows } = await client.query<LockedItem>(
    `SELECT i.seq, i.opportunity_id, i.snapshot_stage_id, i.snapshot_stage_rev,
            o.stage_id AS current_stage_id, o.stage_rev AS current_stage_rev
     FROM bulk_job_items i
     JOIN opportunities o ON o.id = i.opportunity_id AND o.workspace_id = $2
     WHERE i.job_id = $1 AND i.seq > $3 AND i.seq <= $4
     ORDER BY i.seq
     FOR UPDATE OF o`,
    [job.id, job.workspaceId, fromSeq, toSeq],
  );
  if (rows.length !== toSeq - fromSeq) {
    throw new Error(`Chunk ${fromSeq}-${toSeq} of job ${job.id} found ${rows.length} rows`);
  }

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

  const marked = await client.query(
    `UPDATE bulk_job_items i SET outcome = v.outcome
     FROM unnest($2::int[], $3::text[]) AS v(seq, outcome)
     WHERE i.job_id = $1 AND i.seq = v.seq AND i.outcome IS NULL`,
    [job.id, rows.map((r) => r.seq), outcomes],
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
 */
export async function takeTokens(client: Client, workspaceId: string, n: number): Promise<number> {
  const { rows } = await client.query<{ available: number; rate: number; taken: boolean }>(
    `WITH b AS (
       SELECT least(bulk_burst, bulk_tokens + extract(epoch FROM now() - bulk_tokens_at) * bulk_rate_per_sec) AS available,
              bulk_rate_per_sec AS rate
       FROM workspaces WHERE id = $1 FOR UPDATE
     ), upd AS (
       UPDATE workspaces w SET bulk_tokens = b.available - $2, bulk_tokens_at = now()
       FROM b WHERE w.id = $1 AND b.available >= $2
       RETURNING 1
     )
     SELECT b.available, b.rate, EXISTS (SELECT 1 FROM upd) AS taken FROM b`,
    [workspaceId, n],
  );
  const bucket = rows[0];
  if (!bucket) throw new Error(`Workspace ${workspaceId} not found`);
  if (bucket.taken) return 0;
  return Math.ceil(((n - bucket.available) / bucket.rate) * 1000);
}
