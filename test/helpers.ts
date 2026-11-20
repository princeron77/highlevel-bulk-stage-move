/**
 * Test harness: every test file gets its own fresh database (migrated + small seed),
 * so files never see each other's data and can be re-run on a clean machine.
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { migrate } from '../scripts/migrate.js';
import { seed, SMALL_WORKSPACE_IDS } from '../scripts/seed.js';
import { createPool, type Pool } from '../src/db/pool.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5432/postgres';

export interface TestDb {
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const dbUrl = url.toString();
  await migrate(dbUrl);
  await seed(dbUrl, 'small');
  const pool = createPool(dbUrl, 10, 'test');

  return {
    url: dbUrl,
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export const WS_A = SMALL_WORKSPACE_IDS[0]!;
export const WS_B = SMALL_WORKSPACE_IDS[1]!;

/** Stage ids in position order for a workspace. */
export async function stageIds(pool: Pool, workspaceId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM stages WHERE workspace_id = $1 ORDER BY position',
    [workspaceId],
  );
  return rows.map((r) => r.id);
}
