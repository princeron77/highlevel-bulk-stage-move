/**
 * All runtime configuration, read once from environment variables.
 * Defaults match docker-compose.yml so `docker compose up` needs no .env file.
 */
function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export interface DbConfig {
  connectionString: string;
}

export interface WorkerConfig {
  /** Rows per chunk transaction. Small enough to keep row locks short. */
  chunkSize: number;
  /** Max time one worker spends on one job before yielding to other workspaces. */
  sliceMs: number;
  /** A claimed job is owned for this long unless the heartbeat extends it. */
  leaseMs: number;
  heartbeatMs: number;
  /** Sleep when there is nothing to claim. */
  idleMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Test hook: exit the process right after this many chunks commit (0 = off). */
  crashAfterChunks: number;
}

export function dbConfig(): DbConfig {
  return {
    connectionString: str(
      'DATABASE_URL',
      'postgres://app:app@localhost:5432/opportunities',
    ),
  };
}

export function apiPort(): number {
  return int('PORT', 3000);
}

export function workerConfig(): WorkerConfig {
  return {
    chunkSize: int('BULK_CHUNK_SIZE', 500),
    sliceMs: int('BULK_SLICE_MS', 2000),
    leaseMs: int('BULK_LEASE_MS', 15000),
    heartbeatMs: int('BULK_HEARTBEAT_MS', 5000),
    idleMs: int('BULK_IDLE_MS', 250),
    maxAttempts: int('BULK_MAX_ATTEMPTS', 5),
    backoffBaseMs: int('BULK_BACKOFF_BASE_MS', 500),
    backoffMaxMs: int('BULK_BACKOFF_MAX_MS', 30000),
    crashAfterChunks: int('CRASH_AFTER_CHUNKS', 0),
  };
}

/** Hard cap from the brief: one bulk move touches at most this many opportunities. */
export const MAX_BULK_SIZE = 50_000;
