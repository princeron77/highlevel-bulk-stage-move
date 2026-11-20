/**
 * Applies migrations/*.sql in name order, each in its own transaction, exactly once.
 * Safe to run from several containers at once: an advisory lock serialises runners.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dbConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
// why: any constant works; it only has to be the same for every runner.
const LOCK_KEY = 7_220_011;

export async function migrate(connectionString: string): Promise<string[]> {
  const pool = createPool(connectionString, 1, 'migrate');
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
    await pool.end();
  }
  return applied;
}

const isMain = process.argv[1]?.endsWith('migrate.js');
if (isMain) {
  const applied = await migrate(dbConfig().connectionString);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema is up to date');
}
