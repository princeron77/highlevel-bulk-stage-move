/**
 * Submitting a bulk stage move: idempotency, the 50k cap and the frozen snapshot,
 * all in ONE transaction. Either the key, the job and its snapshot all exist, or none do.
 */
import { createHash, randomUUID } from 'node:crypto';
import { MAX_BULK_SIZE } from '../config.js';
import { withTx, type Client, type Pool } from '../db/pool.js';
import { DomainError, notFound } from './errors.js';
import { filterToSql, normalizeFilter, type BulkFilter } from './filter.js';

export interface SubmitInput {
  targetStageId: string;
  filter: BulkFilter;
}

export interface SubmitResult {
  jobId: string;
  /** true when this exact request was already accepted earlier: nothing new was created. */
  replayed: boolean;
}

/** sha256 over the canonical request. The workspace is part of it, so keys never collide across tenants. */
export function requestHash(workspaceId: string, targetStageId: string, filter: BulkFilter): string {
  const canonical = JSON.stringify({ workspaceId, targetStageId: targetStageId.toLowerCase(), filter });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Without an Idempotency-Key, an identical request (same canonical body, same workspace) is
 * treated as a retry while the earlier job is still queued/processing or was created within
 * this window. After that, the same body is a new, intentional move.
 */
export const KEYLESS_DEDUPE_WINDOW_MINUTES = 10;

export async function submitBulkMove(
  pool: Pool,
  workspaceId: string,
  idempotencyKey: string | undefined,
  input: SubmitInput,
): Promise<SubmitResult> {
  const filter = normalizeFilter(input.filter);
  const targetStageId = input.targetStageId.toLowerCase();
  if (filter.stageId === targetStageId) {
    throw new DomainError('invalid', 'filter.stageId and targetStageId are the same stage');
  }
  const hash = requestHash(workspaceId, targetStageId, filter);

  // why: generous statement timeout; snapshotting 50k rows is one INSERT ... SELECT (~1 s).
  return withTx(
    pool,
    async (client) => {
      const jobId = randomUUID();
      if (idempotencyKey === undefined) return submitWithoutKey(client, workspaceId, jobId, targetStageId, filter, hash);

      // why: the key row is the lock. A concurrent duplicate blocks on this INSERT until the
      // first transaction commits, then gets no row back and reads the winner's job below.
      // So duplicates never race, never create a second job, and never see a 409.
      const claimed = await client.query(
        `INSERT INTO idempotency_keys (workspace_id, key, request_hash, job_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, key) DO NOTHING`,
        [workspaceId, idempotencyKey, hash, jobId],
      );
      if (claimed.rowCount === 0) return replay(client, workspaceId, idempotencyKey, hash);

      await createJobWithSnapshot(client, workspaceId, jobId, targetStageId, filter, hash);
      return { jobId, replayed: false };
    },
    { statementTimeoutMs: 30_000 },
  );
}

/** Keyless path: dedupe by the request hash instead of a client-supplied key. */
async function submitWithoutKey(
  client: Client,
  workspaceId: string,
  jobId: string,
  targetStageId: string,
  filter: BulkFilter,
  hash: string,
): Promise<SubmitResult> {
  // why: a transaction-scoped advisory lock on (workspace, request) serialises identical
  // keyless requests, the same way the key row does for keyed ones. It is released at commit.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${workspaceId}:${hash}`]);
  const recent = await client.query<{ id: string }>(
    `SELECT id FROM bulk_jobs
     WHERE workspace_id = $1 AND request_hash = $2
       AND (status IN ('queued', 'processing') OR created_at > now() - $3 * interval '1 minute')
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, hash, KEYLESS_DEDUPE_WINDOW_MINUTES],
  );
  if (recent.rows[0]) return { jobId: recent.rows[0].id, replayed: true };
  await createJobWithSnapshot(client, workspaceId, jobId, targetStageId, filter, hash);
  return { jobId, replayed: false };
}

async function replay(client: Client, workspaceId: string, key: string, hash: string): Promise<SubmitResult> {
  const { rows } = await client.query<{ request_hash: string; job_id: string }>(
    'SELECT request_hash, job_id FROM idempotency_keys WHERE workspace_id = $1 AND key = $2',
    [workspaceId, key],
  );
  const existing = rows[0];
  if (!existing) {
    // The holder rolled back between our INSERT and SELECT; asking the client to retry is safe.
    throw new DomainError('busy', 'A request with this Idempotency-Key is being retried; try again');
  }
  if (existing.request_hash !== hash) {
    // 422, not 409: the request is understood but this key already means something else.
    throw new DomainError('unprocessable', 'Idempotency-Key was already used with a different request body');
  }
  return { jobId: existing.job_id, replayed: true };
}

async function createJobWithSnapshot(
  client: Client,
  workspaceId: string,
  jobId: string,
  targetStageId: string,
  filter: BulkFilter,
  hash: string,
): Promise<void> {
  const stage = await client.query('SELECT 1 FROM stages WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    targetStageId,
  ]);
  if (stage.rowCount === 0) throw notFound('Target stage');

  // Cheap pre-check: stop counting at 50,001, so an oversized request costs one bounded
  // index scan and writes nothing.
  const where = filterToSql(workspaceId, filter);
  const counted = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM opportunities o WHERE ${where.clause} LIMIT ${MAX_BULK_SIZE + 1}) s`,
    where.params,
  );
  if ((counted.rows[0]?.n ?? 0) > MAX_BULK_SIZE) {
    throw new DomainError('unprocessable', `Filter matches more than ${MAX_BULK_SIZE} opportunities`);
  }

  await client.query(
    `INSERT INTO bulk_jobs (id, workspace_id, target_stage_id, filter, total, request_hash)
     VALUES ($1, $2, $3, $4, 0, $5)`,
    [jobId, workspaceId, targetStageId, JSON.stringify(filter), hash],
  );

  // The snapshot: which opportunities, and the stage + stage_rev each had at submit time.
  // why: seq = row_number() in id order gives 1..total with no gaps, so the job's cursor is
  // also its processed count, and chunks lock rows in a consistent (id) order.
  const snapWhere = filterToSql(workspaceId, filter, 1);
  const inserted = await client.query(
    `INSERT INTO bulk_job_items (job_id, seq, opportunity_id, snapshot_stage_id, snapshot_stage_rev)
     SELECT $1, row_number() OVER (ORDER BY o.id), o.id, o.stage_id, o.stage_rev
     FROM (SELECT * FROM opportunities o WHERE ${snapWhere.clause} ORDER BY o.id LIMIT ${MAX_BULK_SIZE + 1}) o`,
    [jobId, ...snapWhere.params],
  );
  const total = inserted.rowCount ?? 0;
  // why: rows can be created between the count and the snapshot (READ COMMITTED);
  // the snapshot's own row count is the truth.
  if (total > MAX_BULK_SIZE) {
    throw new DomainError('unprocessable', `Filter matches more than ${MAX_BULK_SIZE} opportunities`);
  }
  await client.query('UPDATE bulk_jobs SET total = $2 WHERE id = $1', [jobId, total]);
}
