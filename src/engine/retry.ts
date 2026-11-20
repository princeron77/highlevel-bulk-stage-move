/** Which failures are worth retrying, and how long to wait before the next attempt. */
import { pgCode } from '../db/pool.js';

/** SQLSTATEs that mean "try again later", not "this job can never succeed". */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (our lock_timeout)
  '57014', // query_canceled (our statement_timeout)
  '57P01', // admin_shutdown (Postgres restarting)
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

const TRANSIENT_NODE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

export function isTransient(error: unknown): boolean {
  const code = pgCode(error);
  if (code !== undefined) {
    // Class 08 = connection exceptions.
    return TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_NODE_CODES.has(code);
  }
  const message = error instanceof Error ? error.message : String(error);
  // node-postgres reports a dropped socket with these messages and no code.
  return /Connection terminated|connection timeout|Client has encountered a connection error/i.test(message);
}

/**
 * Exponential backoff with "equal jitter": half fixed, half random. The random half stops
 * many failed jobs from retrying at the same instant after a shared outage.
 */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}
