/**
 * Idempotent submit. Each test fails if the safety it names is removed:
 * the key row as a lock, the request hash check, the 50k cap, tenant scoping.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestDb, stageIds, WS_A, WS_B, type TestDb } from './helpers.js';

describe('POST /v1/bulk-moves idempotency', () => {
  let db: TestDb;
  let app: INestApplication;
  let stages: string[];

  const boot = async (): Promise<INestApplication> => {
    const { createApp } = await import('../src/api/create-app.js');
    const a = await createApp();
    await a.init();
    return a;
  };

  before(async () => {
    db = await createTestDb();
    process.env.DATABASE_URL = db.url;
    app = await boot();
    stages = await stageIds(db.pool, WS_A);
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  const submit = (key: string, body: object, ws = WS_A) =>
    request(app.getHttpServer()).post('/v1/bulk-moves').set('X-Workspace-Id', ws).set('Idempotency-Key', key).send(body);

  const jobsFor = async (ws: string): Promise<number> =>
    Number((await db.pool.query('SELECT count(*) FROM bulk_jobs WHERE workspace_id = $1', [ws])).rows[0].count);

  it('first submit is 202; replaying the same request is 200 with the same job, never 409', async () => {
    const body = { targetStageId: stages[5], filter: { stageId: stages[0] } };
    const first = await submit('key-replay', body).expect(202);
    const again = await submit('key-replay', body).expect(200);
    const third = await submit('key-replay', body).expect(200);
    assert.equal(again.body.jobId, first.body.jobId);
    assert.equal(third.body.jobId, first.body.jobId);
    assert.equal(again.body.replayed, true);

    const expected = await db.pool.query('SELECT count(*)::int AS n FROM opportunities WHERE workspace_id = $1 AND stage_id = $2', [WS_A, stages[0]]);
    const job = await db.pool.query('SELECT total FROM bulk_jobs WHERE id = $1', [first.body.jobId]);
    assert.equal(job.rows[0].total, expected.rows[0].n);
  });

  it('10 concurrent identical submits create exactly one job and all get its id', async () => {
    const before = await jobsFor(WS_A);
    const body = { targetStageId: stages[6], filter: { stageId: stages[1] } };
    const responses = await Promise.all(Array.from({ length: 10 }, () => submit('key-concurrent', body)));
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200, 202]);
    assert.equal(new Set(responses.map((r) => r.body.jobId)).size, 1);
    assert.equal(await jobsFor(WS_A), before + 1);
  });

  it('the same key with a different body is 422 and creates nothing', async () => {
    await submit('key-mismatch', { targetStageId: stages[7], filter: { status: 'open' } }).expect(202);
    const before = await jobsFor(WS_A);
    const res = await submit('key-mismatch', { targetStageId: stages[8], filter: { status: 'open' } }).expect(422);
    assert.match(res.body.message, /different request body/);
    assert.equal(await jobsFor(WS_A), before);
  });

  it('equivalent bodies hash the same (key order, id case, date format)', async () => {
    const a = await submit('key-canonical', {
      targetStageId: stages[9],
      filter: { createdFrom: '2025-01-01T00:00:00Z', ownerId: 'owner-3' },
    }).expect(202);
    const b = await submit('key-canonical', {
      filter: { ownerId: 'owner-3', createdFrom: '2025-01-01T00:00:00.000Z' },
      targetStageId: stages[9]!.toUpperCase(),
    }).expect(200);
    assert.equal(b.body.jobId, a.body.jobId);
  });

  it('dedupe state survives a process restart (it lives in Postgres, not memory)', async () => {
    const body = { targetStageId: stages[4], filter: { stageId: stages[2] } };
    const first = await submit('key-restart', body).expect(202);
    await app.close();
    app = await boot();
    const after = await submit('key-restart', body).expect(200);
    assert.equal(after.body.jobId, first.body.jobId);
  });

  it('keys are per workspace, and a job is invisible to other workspaces', async () => {
    const stagesB = await stageIds(db.pool, WS_B);
    const a = await submit('shared-key', { targetStageId: stages[3], filter: { status: 'won' } }, WS_A).expect(202);
    const b = await submit('shared-key', { targetStageId: stagesB[3], filter: { status: 'won' } }, WS_B).expect(202);
    assert.notEqual(a.body.jobId, b.body.jobId);
    await request(app.getHttpServer()).get(`/v1/bulk-moves/${a.body.jobId}`).set('X-Workspace-Id', WS_B).expect(404);
    // a stage from another workspace cannot be the target
    await submit('cross-tenant-stage', { targetStageId: stagesB[3], filter: {} }, WS_A).expect(404);
  });

  it('more than 50,000 matches is 422 and writes nothing (not even the key)', async () => {
    await db.pool.query(
      `INSERT INTO opportunities (workspace_id, stage_id, name, value_cents, status, owner_id)
       SELECT $1, $2, 'bulk filler', 1, 'open', 'owner-cap' FROM generate_series(1, 50001)`,
      [WS_A, stages[11]],
    );
    const before = await jobsFor(WS_A);
    await submit('key-too-big', { targetStageId: stages[0], filter: { ownerId: 'owner-cap' } }).expect(422);
    assert.equal(await jobsFor(WS_A), before);
    const keys = await db.pool.query("SELECT 1 FROM idempotency_keys WHERE key = 'key-too-big'");
    assert.equal(keys.rowCount, 0);
  });

  it('progress of a new job reads committed state: queued, 0 processed', async () => {
    const res = await submit('key-progress', { targetStageId: stages[2], filter: { stageId: stages[10] } }).expect(202);
    const p = await request(app.getHttpServer()).get(res.body.progressUrl).set('X-Workspace-Id', WS_A).expect(200);
    assert.equal(p.body.status, 'queued');
    assert.equal(p.body.health, 'queued');
    assert.equal(p.body.processed, 0);
    assert.equal(p.body.counts.pending, p.body.total);
  });

  it('without an Idempotency-Key, identical requests (also concurrent) still create only one job', async () => {
    const body = { targetStageId: stages[8], filter: { stageId: stages[9], status: 'open' } };
    const post = () => request(app.getHttpServer()).post('/v1/bulk-moves').set('X-Workspace-Id', WS_A).send(body);
    const before = await jobsFor(WS_A);
    const responses = await Promise.all(Array.from({ length: 5 }, post));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 200, 200, 200, 202]);
    assert.equal(new Set(responses.map((r) => r.body.jobId)).size, 1);
    const later = await post().expect(200);
    assert.equal(later.body.jobId, responses[0]!.body.jobId);
    assert.equal(await jobsFor(WS_A), before + 1);
  });

  it('rejects an empty Idempotency-Key and the same source/target stage with 400', async () => {
    await request(app.getHttpServer())
      .post('/v1/bulk-moves')
      .set('X-Workspace-Id', WS_A)
      .set('Idempotency-Key', '')
      .send({ targetStageId: stages[1], filter: {} })
      .expect(400);
    await submit('key-same-stage', { targetStageId: stages[1], filter: { stageId: stages[1] } }).expect(400);
  });
});
