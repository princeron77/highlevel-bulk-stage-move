/**
 * Bulk-filter correctness over many filter combinations: the frozen snapshot must contain
 * exactly the opportunities an independent JavaScript re-implementation of the filter selects.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { submitBulkMove } from '../src/engine/submit.js';
import type { BulkFilter } from '../src/engine/filter.js';
import { createTestDb, stageIds, WS_A, type TestDb } from './helpers.js';

interface Row { id: string; stage_id: string; owner_id: string; status: string; value_cents: string; created_at: Date }

describe('bulk filter combinations', () => {
  let db: TestDb;
  let stages: string[];
  let rows: Row[];

  before(async () => {
    db = await createTestDb();
    stages = await stageIds(db.pool, WS_A);
    rows = (await db.pool.query<Row>(
      'SELECT id, stage_id, owner_id, status, value_cents, created_at FROM opportunities WHERE workspace_id = $1', [WS_A],
    )).rows;
  });
  after(async () => db.drop());

  const expected = (f: BulkFilter): string[] =>
    rows
      .filter((r) =>
        (f.stageId === undefined || r.stage_id === f.stageId) &&
        (f.ownerId === undefined || r.owner_id === f.ownerId) &&
        (f.status === undefined || r.status === f.status) &&
        (f.minValueCents === undefined || Number(r.value_cents) >= f.minValueCents) &&
        (f.maxValueCents === undefined || Number(r.value_cents) <= f.maxValueCents) &&
        (f.createdFrom === undefined || r.created_at >= new Date(f.createdFrom)) &&
        (f.createdTo === undefined || r.created_at < new Date(f.createdTo)))
      .map((r) => r.id)
      .sort();

  it('snapshot == independent filter for every field alone and in combination', async () => {
    const mid = new Date(Date.now() - 270 * 86400_000).toISOString(); // middle of the ~18-month range
    const late = new Date(Date.now() - 60 * 86400_000).toISOString();
    const combos: BulkFilter[] = [
      {},
      { stageId: stages[0] },
      { ownerId: 'owner-1' },
      { status: 'won' },
      { minValueCents: 1_000_000 },
      { maxValueCents: 50_000 },
      { minValueCents: 100_000, maxValueCents: 400_000 },
      { createdFrom: mid },
      { createdTo: mid },
      { createdFrom: mid, createdTo: late },
      { stageId: stages[0], status: 'open' },
      { stageId: stages[1], ownerId: 'owner-2', status: 'open' },
      { ownerId: 'owner-3', minValueCents: 20_000, createdFrom: mid },
      { stageId: stages[2], status: 'lost', maxValueCents: 2_000_000, createdTo: late },
      { stageId: stages[0], ownerId: 'owner-1', status: 'open', minValueCents: 10_000, maxValueCents: 5_000_000, createdFrom: mid, createdTo: late },
      { ownerId: 'nobody' }, // matches nothing: an empty job is valid and completes immediately
    ];
    let nonEmpty = 0;
    for (const [i, filter] of combos.entries()) {
      const { jobId } = await submitBulkMove(db.pool, WS_A, `combo-${i}`, { targetStageId: stages[11]!, filter });
      const snap = await db.pool.query<{ opportunity_id: string }>(
        'SELECT opportunity_id FROM bulk_job_items WHERE job_id = $1 ORDER BY opportunity_id', [jobId]);
      const want = expected(filter);
      assert.deepEqual(snap.rows.map((r) => r.opportunity_id).sort(), want, `filter ${JSON.stringify(filter)}`);
      if (want.length > 0) nonEmpty++;
    }
    assert.ok(nonEmpty >= 12, 'most combinations select real data, so the comparison means something');
  });
});
