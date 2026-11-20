import pg from 'pg';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

/**
 * One pool per process. The API and the worker never share a pool, so a busy worker
 * can never take the connections interactive requests need.
 */
export function createPool(connectionString: string, max: number, name: string): Pool {
  const pool = new pg.Pool({ connectionString, max, application_name: name });
  // why: an idle client can error (e.g. Postgres restarts); without a listener Node crashes.
  pool.on('error', () => undefined);
  return pool;
}

export interface TxOptions {
  /** How long to wait for a row lock before giving up (SQLSTATE 55P03). */
  lockTimeoutMs?: number;
  /** Upper bound for any single statement (SQLSTATE 57014). */
  statementTimeoutMs?: number;
}

/**
 * Runs `fn` inside one READ COMMITTED transaction. Commits if it resolves,
 * rolls back if it throws. Timeouts are SET LOCAL so they end with the transaction.
 */
export async function withTx<T>(
  pool: Pool,
  fn: (client: Client) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (options.lockTimeoutMs !== undefined) {
      await client.query(`SET LOCAL lock_timeout = ${Math.trunc(options.lockTimeoutMs)}`);
    }
    if (options.statementTimeoutMs !== undefined) {
      await client.query(
        `SET LOCAL statement_timeout = ${Math.trunc(options.statementTimeoutMs)}`,
      );
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Postgres error code (SQLSTATE) of a driver error, if any. */
export function pgCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
