/**
 * The worker's safety mechanisms. Each test names the mechanism it proves and would fail
 * if that mechanism were removed.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { workerConfig, type WorkerConfig } from '../src/config.js';
import { BulkWorker, type WorkerHooks } from '../src/engine/worker.js';
import { submitBulkMove } from '../src/engine/submit.js';
import { moveOpportunity } from '../src/engine/opportunities.js';
import { getProgress, retryFailedJob } from '../src/engine/progress.js';
import { createTestDb, stageIds, WS_A, WS_B, type TestDb } from './helpers.js';

const silent = { log() {}, warn() {}, error() {} };

function worker(db: TestDb, id: string, overrides: Partial<WorkerConfig> = {}, hooks: WorkerHooks = {}): BulkWorker {
  const cfg = { ...workerConfig(), chunkSize: 100, sliceMs: 60_000, idleMs: 10, backoffBaseMs: 1, backoffMaxMs: 5, ...overrides };
  return new BulkWorker(db.pool, cfg, id, silent, hooks);
}

/** Runs ticks until the job is completed or failed (or gives up). */
async function drain(w: BulkWorker, db: TestDb, jobId: string, maxTicks = 500): Promise<string> {
  for (let i = 0; i < maxTicks; i++) {
    const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM bulk_jobs WHERE id = $1', [jobId]);
    const status = rows[0]!.status;
    if (status === 'completed' || status === 'failed') return status;
    if (!(await w.tick())) await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

/** The brief's definition of "correct", checked straight from the tables. */
async function verifyJob(db: TestDb, jobId: string): Promise<void> {
  const { rows } = await db.pool.query(
    `SELECT
       (SELECT count(*) FROM bulk_job_items WHERE job_id = $1 AND outcome IS NULL)::int AS unprocessed,
       (SELECT count(*) FROM bulk_job_items i JOIN opportunities o ON o.id = i.opportunity_id
          WHERE i.job_id = $1 AND i.outcome = 'moved' AND o.stage_id <> j.target_stage_id)::int AS moved_but_wrong_stage,
       (SELECT count(*) FROM stage_transitions WHERE bulk_job_id = $1)::int AS transitions,
       j.moved, j.cursor, j.total, j.status
     FROM bulk_jobs j WHERE j.id = $1`,
    [jobId],
  );
  const r = rows[0];
  assert.equal(r.status, 'completed');
  assert.equal(r.unprocessed, 0, 'every snapshot item has an outcome');
  assert.equal(r.moved_but_wrong_stage, 0, 'every moved opportunity is in the target stage');
  assert.equal(r.transitions, r.moved, 'exactly one bulk transition per moved opportunity');
  assert.equal(r.cursor, r.total);
}

describe('bulk worker', () => {
  let db: TestDb;
  let stagesA: string[];
  let stagesB: string[];

  before(async () => {
    db = await createTestDb();
    stagesA = await stageIds(db.pool, WS_A);
    stagesB = await stageIds(db.pool, WS_B);
  });
  after(async () => db.drop());

  it('moves the snapshot and records the outcome of every item', async () => {
    const { jobId } = await submitBulkMove(db.pool, WS_A, 'w-basic', { targetStageId: stagesA[6]!, filter: { stageId: stagesA[0]! } });
    assert.equal(await drain(worker(db, 'w1'), db, jobId), 'completed');
    await verifyJob(db, jobId);
  });

  it('collision: a manual move during the job wins; the job skips that row as a conflict', async () => {
    const { jobId } = await submitBulkMove(db.pool, WS_A, 'w-collision', { targetStageId: stagesA[7]!, filter: { stageId: stagesA[1]! } });
    // sliceMs 0: each tick runs exactly one chunk, then hands the job back.
    const w = worker(db, 'w1', { chunkSize: 10, sliceMs: 0 });
    const items = await db.pool.query<{ opportunity_id: string }>(
      'SELECT opportunity_id FROM bulk_job_items WHERE job_id = $1 ORDER BY seq', [jobId]);
    const late = items.rows.at(-1)!.opportunity_id; // in the last chunk, not yet processed

    await w.tick(); // first chunk committed: the job is now processing
    await moveOpportunity(db.pool, WS_A, late, stagesA[9]!); // a human moves one of its rows
    assert.equal(await drain(w, db, jobId), 'completed');

    const opp = await db.pool.query('SELECT stage_id FROM opportunities WHERE id = $1', [late]);
    assert.equal(opp.rows[0].stage_id, stagesA[9], 'the manual edit is kept, not overwritten');
    const item = await db.pool.query('SELECT outcome FROM bulk_job_items WHERE job_id = $1 AND opportunity_id = $2', [jobId, late]);
    assert.equal(item.rows[0].outcome, 'skipped_conflict');
    const job = await getProgress(db.pool, WS_A, jobId, 15000);
    assert.equal(job.counts.skippedConflict, 1);
    await verifyJob(db, jobId);
  });

  it('fencing: a worker whose lease was taken over cannot write anything', async () => {
    const { jobId } = await submitBulkMove(db.pool, WS_A, 'w-fence', { targetStageId: stagesA[8]!, filter: { stageId: stagesA[2]! } });
    const zombie = worker(db, 'zombie');
    const zombieClaim = (await zombie.claim())!;
    // The zombie stalls (GC pause, network partition) and its lease expires...
    await db.pool.query("UPDATE bulk_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [jobId]);
    const healthy = worker(db, 'healthy');
    const healthyClaim = (await healthy.claim())!;
    assert.notEqual(healthyClaim.fence, zombieClaim.fence);

    // ...then wakes up and tries to write a chunk with its old fence.
    assert.equal(await zombie.processChunk(zombieClaim), 'stale');
    const job = await db.pool.query('SELECT cursor FROM bulk_jobs WHERE id = $1', [jobId]);
    assert.equal(job.rows[0].cursor, 0, 'the zombie wrote nothing');

    // The healthy worker's own write with the current fence goes through.
    assert.equal(await healthy.processChunk(healthyClaim), 'progress');
    await db.pool.query("UPDATE bulk_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [jobId]);
    assert.equal(await drain(healthy, db, jobId), 'completed');
    await verifyJob(db, jobId);
  });

  it('isolation: with one worker, a small job in workspace B finishes while A\'s big job is still running', async () => {
    // Workspace A is rate limited to 500 rows/s, so its 3,000-row job takes several slices.
    await db.pool.query('UPDATE workspaces SET bulk_rate_per_sec = 500, bulk_burst = 200, bulk_tokens = 200 WHERE id = $1', [WS_A]);
    const big = await submitBulkMove(db.pool, WS_A, 'w-big', { targetStageId: stagesA[11]!, filter: {} });
    const small = await submitBulkMove(db.pool, WS_B, 'w-small', { targetStageId: stagesB[11]!, filter: { stageId: stagesB[3]! } });
    const w = worker(db, 'only-worker', { sliceMs: 200 });

    await drain(w, db, small.jobId);
    const a = await getProgress(db.pool, WS_A, big.jobId, 15000);
    assert.equal(a.status, 'processing', 'A is not finished...');
    assert.ok(a.processed < a.total, '...but B already is: A could not hog the worker');

    await db.pool.query('UPDATE workspaces SET bulk_rate_per_sec = 100000, bulk_burst = 100000 WHERE id = $1', [WS_A]);
    assert.equal(await drain(w, db, big.jobId), 'completed');
    await verifyJob(db, big.jobId);
  });

  it('retry: a transient error (40001) backs off and the job still completes', async () => {
    const { jobId } = await submitBulkMove(db.pool, WS_B, 'w-transient', { targetStageId: stagesB[6]!, filter: { stageId: stagesB[0]! } });
    let failures = 1;
    const w = worker(db, 'flaky', {}, {
      beforeChunk: () => {
        if (failures-- > 0) throw Object.assign(new Error('could not serialize access'), { code: '40001' });
      },
    });
    await w.tick();
    const mid = await db.pool.query('SELECT attempts, last_error, cursor FROM bulk_jobs WHERE id = $1', [jobId]);
    assert.equal(mid.rows[0].attempts, 1);
    assert.equal(mid.rows[0].cursor, 0, 'the failed chunk rolled back');
    assert.equal(await drain(w, db, jobId), 'completed');
    await verifyJob(db, jobId);
  });

  it('retry: a permanent error fails the job with a reason instead of retrying forever', async () => {
    const { jobId } = await submitBulkMove(db.pool, WS_B, 'w-permanent', { targetStageId: stagesB[7]!, filter: { stageId: stagesB[1]! } });
    const w = worker(db, 'broken', {}, { beforeChunk: () => { throw new Error('bug: invariant violated'); } });
    assert.equal(await drain(w, db, jobId), 'failed');
    const job = await getProgress(db.pool, WS_B, jobId, 15000);
    assert.equal(job.health, 'failed');
    assert.match(job.failureReason!, /permanent error/);
    // After the cause is fixed, the failed job can be resumed and finishes correctly.
    assert.equal(await retryFailedJob(db.pool, WS_B, jobId), 'requeued');
    assert.equal(await retryFailedJob(db.pool, WS_B, jobId), 'already_active', 'retrying the retry is a no-op');
    assert.equal(await drain(worker(db, 'w1'), db, jobId), 'completed');
    await verifyJob(db, jobId);
  });

  it('kill and resume: SIGKILL-style exit mid-job, then another worker finishes it correctly', async () => {
    const { jobId } = await submitBulkMove(db.pool, WS_B, 'w-kill', { targetStageId: stagesB[10]!, filter: {} });
    // A real worker process that exits (code 137) right after its 3rd chunk commits,
    // holding its lease, exactly like being killed.
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ['dist/src/main.worker.js'], {
        env: { ...process.env, DATABASE_URL: db.url, CRASH_AFTER_CHUNKS: '3', BULK_CHUNK_SIZE: '100', BULK_LEASE_MS: '500', LOG_LEVEL: 'silent' },
        stdio: 'ignore',
      });
      child.on('exit', resolve);
    });
    assert.equal(code, 137);

    // Half-applied state, as the user sees it: committed progress only, no lies.
    const mid = await getProgress(db.pool, WS_B, jobId, 500);
    assert.equal(mid.status, 'processing');
    assert.equal(mid.processed, 300, 'exactly the 3 committed chunks');
    const applied = await db.pool.query('SELECT count(*)::int AS n FROM stage_transitions WHERE bulk_job_id = $1', [jobId]);
    assert.equal(applied.rows[0].n, mid.counts.moved, 'what is applied matches what progress says');

    await new Promise((r) => setTimeout(r, 600)); // the dead worker's lease expires
    assert.equal(await drain(worker(db, 'rescuer'), db, jobId), 'completed');
    await verifyJob(db, jobId);
  });
});
