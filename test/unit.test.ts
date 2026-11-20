/** Pure functions: the collision rule, health states, request hashing, retry policy. No database. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type LockedItem } from '../src/engine/chunk.js';
import { computeHealth } from '../src/engine/progress.js';
import { requestHash } from '../src/engine/submit.js';
import { normalizeFilter } from '../src/engine/filter.js';
import { backoffMs, isTransient } from '../src/engine/retry.js';

const item = (over: Partial<LockedItem>): LockedItem => ({
  seq: 1, opportunity_id: 'o', snapshot_stage_id: 'A', snapshot_stage_rev: '3',
  current_stage_id: 'A', current_stage_rev: '3', ...over,
});

describe('classify (the collision rule)', () => {
  it('unchanged since submit -> moved', () => assert.equal(classify(item({}), 'T'), 'moved'));
  it('a human moved it to another stage -> skipped_conflict', () =>
    assert.equal(classify(item({ current_stage_id: 'B', current_stage_rev: '4' }), 'T'), 'skipped_conflict'));
  it('moved away and back (same stage, newer rev) -> skipped_conflict: the edit still wins', () =>
    assert.equal(classify(item({ current_stage_rev: '5' }), 'T'), 'skipped_conflict'));
  it('already in the target stage -> skipped_noop, even if a human put it there', () =>
    assert.equal(classify(item({ current_stage_id: 'T', current_stage_rev: '4' }), 'T'), 'skipped_noop'));
});

describe('computeHealth', () => {
  const base = { status: 'processing' as const, lease_live: false, throttled: false, retry_pending: false, quiet_ms: 0 };
  const h = (o: object) => computeHealth({ ...base, ...o } as Parameters<typeof computeHealth>[0], 15000);
  it('terminal and queued states', () => {
    assert.equal(h({ status: 'completed' }), 'done');
    assert.equal(h({ status: 'failed' }), 'failed');
    assert.equal(h({ status: 'queued' }), 'queued');
  });
  it('slow vs stuck vs retrying', () => {
    assert.equal(h({ lease_live: true }), 'running');
    assert.equal(h({ throttled: true }), 'throttled');
    assert.equal(h({ retry_pending: true }), 'retrying');
    assert.equal(h({ quiet_ms: 5000 }), 'waiting');
    assert.equal(h({ quiet_ms: 31000 }), 'stalled', 'no lease and no progress for > 2x lease');
  });
});

describe('requestHash + normalizeFilter (idempotency identity)', () => {
  const hash = (ws: string, t: string, f: object) => requestHash(ws, t, normalizeFilter(f));
  it('equivalent requests hash the same', () =>
    assert.equal(
      hash('w', 'T', { ownerId: 'o', createdFrom: '2025-01-01T00:00:00Z', stageId: 'ABC' }),
      hash('w', 't', { stageId: 'abc', createdFrom: '2025-01-01T00:00:00.000Z', ownerId: 'o' }),
    ));
  it('different workspace, target or filter -> different hash', () => {
    const h0 = hash('w', 'T', { status: 'open' });
    assert.notEqual(h0, hash('w2', 'T', { status: 'open' }));
    assert.notEqual(h0, hash('w', 'U', { status: 'open' }));
    assert.notEqual(h0, hash('w', 'T', { status: 'won' }));
  });
  it('rejects inverted ranges', () => {
    assert.throws(() => normalizeFilter({ minValueCents: 10, maxValueCents: 5 }));
    assert.throws(() => normalizeFilter({ createdFrom: '2025-02-01T00:00:00Z', createdTo: '2025-01-01T00:00:00Z' }));
  });
});

describe('retry policy', () => {
  it('backoff grows exponentially, is capped, and is jittered within [exp/2, exp]', () => {
    assert.equal(backoffMs(1, 500, 30000, () => 0), 250);
    assert.equal(backoffMs(1, 500, 30000, () => 1), 500);
    assert.equal(backoffMs(4, 500, 30000, () => 1), 4000);
    assert.equal(backoffMs(20, 500, 30000, () => 1), 30000);
  });
  it('transient: serialization, deadlock, lock/statement timeout, connection loss', () => {
    for (const code of ['40001', '40P01', '55P03', '57014', '57P01', '08006', 'ECONNRESET']) {
      assert.equal(isTransient(Object.assign(new Error('x'), { code })), true, code);
    }
    assert.equal(isTransient(new Error('Connection terminated unexpectedly')), true);
  });
  it('permanent: constraint violations, bad data, plain bugs', () => {
    for (const code of ['23505', '23514', '22P02']) {
      assert.equal(isTransient(Object.assign(new Error('x'), { code })), false, code);
    }
    assert.equal(isTransient(new Error('bug: invariant violated')), false);
  });
});
