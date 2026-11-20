/**
 * Seeds demo data with set-based SQL (generate_series), never row-by-row.
 *
 *   small: 5 small workspaces x 3,000 opportunities (used by `docker compose up` and tests)
 *   large: small + 1 workspace with 500,000 opportunities across 12 stages,
 *          unevenly distributed, created over ~18 months (used by benchmarks)
 *
 * Workspace ids are fixed so README examples and demo scripts can use them.
 * Re-running is safe: a workspace that already exists is skipped.
 */
import { dbConfig } from '../src/config.js';
import { createPool, type Pool } from '../src/db/pool.js';

export const LARGE_WORKSPACE_ID = 'a0000000-0000-4000-8000-000000000000';
export const SMALL_WORKSPACE_IDS = [1, 2, 3, 4, 5].map(
  (n) => `b0000000-0000-4000-8000-00000000000${n}`,
);

const STAGE_NAMES = [
  'New Lead', 'Contacted', 'Qualified', 'Discovery', 'Demo Scheduled', 'Proposal Sent',
  'Negotiation', 'Contract Sent', 'Verbal Commit', 'Closed Won', 'Closed Lost', 'On Hold',
];

async function seedWorkspace(pool: Pool, id: string, name: string, count: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      'INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [id, name],
    );
    if (created.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    // Stage ids are derived from (workspace, position) so they are stable across re-seeds.
    await client.query(
      `INSERT INTO stages (id, workspace_id, name, position)
       SELECT md5($1::text || ':' || (ord - 1))::uuid, $1::uuid, n, ord - 1
       FROM unnest($2::text[]) WITH ORDINALITY AS t(n, ord)`,
      [id, STAGE_NAMES],
    );
    // why: setseed makes every machine produce the same data, so benchmarks are reproducible.
    await client.query('SELECT setseed(0.42)');
    await client.query(
      `INSERT INTO opportunities
         (workspace_id, stage_id, name, value_cents, status, owner_id, created_at, updated_at)
       SELECT $1::uuid,
              md5($1::text || ':' || stage_pos)::uuid,
              'Deal #' || g,
              10000 + floor(power(random(), 3) * 5000000)::bigint,
              CASE WHEN r < 0.80 THEN 'open' WHEN r < 0.88 THEN 'won'
                   WHEN r < 0.97 THEN 'lost' ELSE 'abandoned' END,
              'owner-' || (1 + floor(power(random(), 1.5) * 40))::int,
              created, created
       FROM generate_series(1, $2::int) AS g,
            LATERAL (SELECT
              -- squaring skews the distribution towards early stages (uneven, like real pipelines)
              least(11, floor(power(random(), 2) * 12))::int AS stage_pos,
              random() AS r,
              now() - random() * interval '540 days' AS created
              -- the reference to g forces a fresh draw per row
              WHERE g IS NOT NULL) d`,
      [id, count],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function seed(connectionString: string, mode: 'small' | 'large'): Promise<void> {
  const pool = createPool(connectionString, 2, 'seed');
  try {
    for (const [i, id] of SMALL_WORKSPACE_IDS.entries()) {
      const started = Date.now();
      const done = await seedWorkspace(pool, id, `Small workspace ${i + 1}`, 3000);
      console.log(`${done ? 'Seeded' : 'Skipped (exists)'} small workspace ${id} in ${Date.now() - started} ms`);
    }
    if (mode === 'large') {
      const started = Date.now();
      const done = await seedWorkspace(pool, LARGE_WORKSPACE_ID, 'Large workspace', 500_000);
      console.log(`${done ? 'Seeded' : 'Skipped (exists)'} large workspace ${LARGE_WORKSPACE_ID} in ${Date.now() - started} ms`);
    }
    await pool.query('ANALYZE');
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1]?.endsWith('seed.js');
if (isMain) {
  const mode = process.argv[2] === 'large' ? 'large' : 'small';
  await seed(dbConfig().connectionString, mode);
}
