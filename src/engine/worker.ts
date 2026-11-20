/**
 * The bulk-move worker loop: claim a job fairly, run a short time slice of chunks under a
 * fenced lease, then give the job back so other workspaces get a turn.
 *
 * All state lives in Postgres. A worker can be killed at any instant: the open chunk rolls
 * back, its lease expires, and any worker resumes the job from the committed cursor.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { WorkerConfig } from '../config.js';
import { pgCode, withTx, type Pool } from '../db/pool.js';
import { applyChunk, takeTokens } from './chunk.js';
import { backoffMs, isTransient } from './retry.js';

export interface Claim {
  id: string;
  workspaceId: string;
  targetStageId: string;
  /** Fencing token: every write this worker makes is conditional on it. */
  fence: string;
  attempts: number;
}

export interface WorkerLogger {
  log(message: string, context?: object): void;
  warn(message: string, context?: object): void;
  error(message: string, context?: object): void;
}

export interface WorkerHooks {
  /** Test-only: called inside each chunk transaction before it writes. */
  beforeChunk?: (claim: Claim, fromSeq: number) => void | Promise<void>;
}

type ChunkResult = 'progress' | 'completed' | 'stale' | { throttledMs: number };

/** Thrown when this worker's fence no longer matches: another worker owns the job now. */
class LeaseLost extends Error {}

export class BulkWorker {
  private chunksCommitted = 0;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: WorkerConfig,
    readonly workerId: string,
    private readonly logger: WorkerLogger,
    private readonly hooks: WorkerHooks = {},
  ) {}

  /** Main loop. Stops (after finishing the current chunk) when `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const worked = await this.tick(signal);
        if (!worked) await sleep(this.cfg.idleMs, undefined, { signal }).catch(() => undefined);
      } catch (error) {
        // why: a database outage must not kill the loop; leases make any lost work safe to redo.
        this.logger.error('worker loop error', { err: String(error) });
        await sleep(this.cfg.idleMs * 4, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  /** Claims one job and runs one time slice of it. Returns false if there was nothing to do. */
  async tick(signal?: AbortSignal): Promise<boolean> {
    const claim = await this.claim();
    if (!claim) return false;
    if (claim.attempts >= this.cfg.maxAttempts) {
      await this.fail(claim, 'gave up after repeated worker crashes or errors');
      return true;
    }
    await this.runSlice(claim, signal);
    return true;
  }

  /**
   * Fair claim. Eligible: queued jobs whose workspace has nothing processing, and processing
   * jobs nobody holds (between slices, or their worker died), once their backoff has passed.
   * Order: least recently served first (new jobs have NULL and go first) -> round-robin.
   */
  async claim(): Promise<Claim | null> {
    try {
      const { rows } = await this.pool.query<Claim & { fence: string }>(
        `WITH next AS (
           SELECT j.id FROM bulk_jobs j
           WHERE j.next_attempt_at <= now()
             AND ( (j.status = 'processing' AND (j.lease_expires_at IS NULL OR j.lease_expires_at < now()))
                OR (j.status = 'queued' AND NOT EXISTS (
                      SELECT 1 FROM bulk_jobs p WHERE p.workspace_id = j.workspace_id AND p.status = 'processing')) )
           ORDER BY j.last_slice_at NULLS FIRST, j.created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE bulk_jobs j
         SET status = 'processing',
             -- a lease that was still owned when it expired means that worker died: count it
             attempts = j.attempts + CASE WHEN j.lease_owner IS NOT NULL THEN 1 ELSE 0 END,
             lease_owner = $1,
             lease_version = j.lease_version + 1,
             lease_expires_at = now() + $2 * interval '1 millisecond',
             heartbeat_at = now(),
             started_at = coalesce(j.started_at, now())
         FROM next WHERE j.id = next.id
         RETURNING j.id, j.workspace_id AS "workspaceId", j.target_stage_id AS "targetStageId",
                   j.lease_version::text AS fence, j.attempts`,
        [this.workerId, this.cfg.leaseMs],
      );
      return rows[0] ?? null;
    } catch (error) {
      // why: two workers can pick two queued jobs of one workspace at the same moment; the
      // one-processing-per-workspace unique index rejects the second. Nothing was claimed.
      if (pgCode(error) === '23505') return null;
      throw error;
    }
  }

  private async runSlice(claim: Claim, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.cfg.sliceMs;
    const heartbeat = setInterval(() => void this.heartbeat(claim), this.cfg.heartbeatMs);
    try {
      for (;;) {
        const result = await this.processChunk(claim);
        if (result === 'completed' || result === 'stale') return;
        if (typeof result === 'object') return await this.release(claim, result.throttledMs);
        await this.afterCommit();
        if (Date.now() >= deadline || signal?.aborted) return await this.release(claim, 0);
      }
    } catch (error) {
      await this.recordFailure(claim, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** One fenced chunk transaction. */
  async processChunk(claim: Claim): Promise<ChunkResult> {
    try {
      return await withTx(
        this.pool,
        async (client) => {
          // why: the fence. If another worker has claimed the job since, lease_version moved
          // on and this matches nothing, so a zombie worker can never write.
          const { rows } = await client.query<{ cursor: number; total: number }>(
            `SELECT cursor, total FROM bulk_jobs
             WHERE id = $1 AND lease_version = $2 AND lease_owner = $3 FOR UPDATE`,
            [claim.id, claim.fence, this.workerId],
          );
          const job = rows[0];
          if (!job) throw new LeaseLost();

          const toSeq = Math.min(job.cursor + this.cfg.chunkSize, job.total);
          const waitMs = toSeq > job.cursor ? await takeTokens(client, claim.workspaceId, toSeq - job.cursor) : 0;
          if (waitMs > 0) return { throttledMs: waitMs };

          await this.hooks.beforeChunk?.(claim, job.cursor);
          const counts = toSeq > job.cursor ? await applyChunk(client, claim, job.cursor, toSeq) : { moved: 0, skippedConflict: 0, skippedNoop: 0 };
          const done = toSeq === job.total;
          await client.query(
            `UPDATE bulk_jobs
             SET cursor = $3, moved = moved + $4, skipped_conflict = skipped_conflict + $5,
                 skipped_noop = skipped_noop + $6, last_progress_at = now(), heartbeat_at = now(),
                 attempts = 0, throttled_until = NULL,
                 status = CASE WHEN $7 THEN 'completed' ELSE status END,
                 finished_at = CASE WHEN $7 THEN now() END,
                 lease_owner = CASE WHEN $7 THEN NULL ELSE lease_owner END,
                 lease_expires_at = CASE WHEN $7 THEN NULL ELSE lease_expires_at END
             WHERE id = $1 AND lease_version = $2`,
            [claim.id, claim.fence, toSeq, counts.moved, counts.skippedConflict, counts.skippedNoop, done],
          );
          return done ? 'completed' : 'progress';
        },
        // why: short bounds keep every chunk transaction (and the row locks it holds) brief.
        { lockTimeoutMs: 2000, statementTimeoutMs: 10_000 },
      );
    } catch (error) {
      if (error instanceof LeaseLost) {
        this.logger.warn('lease lost; another worker owns the job now', { jobId: claim.id, fence: claim.fence });
        return 'stale';
      }
      throw error;
    }
  }

  /** Test hook for deterministic kill-and-resume: die right after the N-th commit. */
  private async afterCommit(): Promise<void> {
    this.chunksCommitted += 1;
    if (this.cfg.crashAfterChunks > 0 && this.chunksCommitted >= this.cfg.crashAfterChunks) {
      this.logger.warn('CRASH_AFTER_CHUNKS reached: exiting without releasing the lease', {});
      process.exit(137);
    }
  }

  /** Ends this slice. Status stays 'processing'; the next claim (by anyone) continues it. */
  private async release(claim: Claim, throttledMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE bulk_jobs
       SET lease_owner = NULL, lease_expires_at = NULL, last_slice_at = now(),
           next_attempt_at = now() + $3 * interval '1 millisecond',
           throttled_until = CASE WHEN $3 > 0 THEN now() + $3 * interval '1 millisecond' END
       WHERE id = $1 AND lease_version = $2`,
      [claim.id, claim.fence, throttledMs],
    );
  }

  private async heartbeat(claim: Claim): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE bulk_jobs SET lease_expires_at = now() + $3 * interval '1 millisecond', heartbeat_at = now()
         WHERE id = $1 AND lease_version = $2 AND lease_owner IS NOT NULL`,
        [claim.id, claim.fence, this.cfg.leaseMs],
      );
    } catch (error) {
      // why: a missed heartbeat is not fatal. Worst case the lease expires and the fence
      // stops this worker's next write; the job itself stays correct.
      this.logger.warn('heartbeat failed', { jobId: claim.id, err: String(error) });
    }
  }

  /** Transient errors back off and retry; permanent errors (or too many attempts) fail the job. */
  private async recordFailure(claim: Claim, error: unknown): Promise<void> {
    const attempt = claim.attempts + 1;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    if (!isTransient(error) || attempt >= this.cfg.maxAttempts) {
      this.logger.error('bulk job failed', { jobId: claim.id, attempt, err: message });
      return this.fail(claim, isTransient(error) ? `retries exhausted: ${message}` : `permanent error: ${message}`);
    }
    const delay = backoffMs(attempt, this.cfg.backoffBaseMs, this.cfg.backoffMaxMs);
    this.logger.warn('transient error; will retry', { jobId: claim.id, attempt, delayMs: delay, err: message });
    await this.pool
      .query(
        `UPDATE bulk_jobs
         SET attempts = $3, last_error = $4, next_attempt_at = now() + $5 * interval '1 millisecond',
             lease_owner = NULL, lease_expires_at = NULL, last_slice_at = now()
         WHERE id = $1 AND lease_version = $2`,
        [claim.id, claim.fence, attempt, message, delay],
      )
      // If even this write fails (database down), the lease simply expires and the job is
      // reclaimed later with the attempt counted.
      .catch((e: unknown) => this.logger.error('could not record failure', { jobId: claim.id, err: String(e) }));
  }

  private async fail(claim: Claim, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE bulk_jobs
       SET status = 'failed', failure_reason = $3, last_error = coalesce(last_error, $3),
           finished_at = now(), lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_version = $2`,
      [claim.id, claim.fence, reason],
    );
  }
}
