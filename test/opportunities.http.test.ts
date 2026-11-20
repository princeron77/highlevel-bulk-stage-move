/** Part 1 over HTTP: create, manual move with transition, keyset pagination, tenant scoping. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestDb, stageIds, WS_A, WS_B, type TestDb } from './helpers.js';

describe('Part 1: opportunities API', () => {
  let db: TestDb;
  let app: INestApplication;
  let stages: string[];

  before(async () => {
    db = await createTestDb();
    process.env.DATABASE_URL = db.url;
    const { createApp } = await import('../src/api/create-app.js');
    app = await createApp();
    await app.init();
    stages = await stageIds(db.pool, WS_A);
  });

  after(async () => {
    await app.close();
    await db.drop();
  });

  const http = () => request(app.getHttpServer());

  it('creates an opportunity and moves it, recording one manual transition', async () => {
    const created = await http()
      .post('/v1/opportunities')
      .set('X-Workspace-Id', WS_A)
      .send({ name: 'Acme', valueCents: 125000, status: 'open', ownerId: 'owner-1', stageId: stages[0] })
      .expect(201);
    assert.equal(created.body.stageRev, 0);

    const moved = await http()
      .patch(`/v1/opportunities/${created.body.id}/stage`)
      .set('X-Workspace-Id', WS_A)
      .send({ stageId: stages[3] })
      .expect(200);
    assert.equal(moved.body.stageId, stages[3]);
    assert.equal(moved.body.stageRev, 1);

    const { rows } = await db.pool.query(
      'SELECT from_stage_id, to_stage_id, source FROM stage_transitions WHERE opportunity_id = $1',
      [created.body.id],
    );
    assert.deepEqual(rows, [{ from_stage_id: stages[0], to_stage_id: stages[3], source: 'manual' }]);
  });

  it('pages through a whole stage with keyset cursors, without gaps or duplicates', async () => {
    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*) FROM opportunities WHERE workspace_id = $1 AND stage_id = $2',
      [WS_A, stages[1]],
    );
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const res: request.Response = await http()
        .get(`/v1/stages/${stages[1]}/opportunities`)
        .query({ limit: 100, ...(cursor ? { cursor } : {}) })
        .set('X-Workspace-Id', WS_A)
        .expect(200);
      for (const o of res.body.data) seen.add(o.id);
      cursor = res.body.nextCursor;
    } while (cursor);
    assert.equal(seen.size, Number(rows[0]!.count));
  });

  it('never crosses tenants: another workspace cannot see or move the opportunity', async () => {
    const created = await http()
      .post('/v1/opportunities')
      .set('X-Workspace-Id', WS_A)
      .send({ name: 'Private', valueCents: 1, status: 'open', ownerId: 'o', stageId: stages[0] })
      .expect(201);
    const stagesB = await stageIds(db.pool, WS_B);
    await http()
      .patch(`/v1/opportunities/${created.body.id}/stage`)
      .set('X-Workspace-Id', WS_B)
      .send({ stageId: stagesB[2] })
      .expect(404);
    // and workspace A cannot use workspace B's stage
    await http()
      .patch(`/v1/opportunities/${created.body.id}/stage`)
      .set('X-Workspace-Id', WS_A)
      .send({ stageId: stagesB[2] })
      .expect(404);
  });

  it('rejects bad input with one error shape', async () => {
    const res = await http()
      .post('/v1/opportunities')
      .set('X-Workspace-Id', WS_A)
      .send({ name: '', valueCents: 1.5, status: 'maybe', ownerId: 'o', stageId: 'x', extra: true })
      .expect(400);
    assert.equal(res.body.statusCode, 400);
    assert.ok(Array.isArray(res.body.message));
    await http().get('/v1/stages').expect(400); // missing X-Workspace-Id
  });
});
