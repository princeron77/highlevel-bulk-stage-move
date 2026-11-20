/**
 * The bulk-move filter: normalisation (for a stable idempotency hash) and translation
 * to parameterised SQL. Values are always bound as parameters, never concatenated.
 */
import { DomainError } from './errors.js';
import type { OpportunityStatus } from './rows.js';

export interface BulkFilter {
  stageId?: string;
  ownerId?: string;
  status?: OpportunityStatus;
  minValueCents?: number;
  maxValueCents?: number;
  /** Inclusive lower bound on created_at (ISO 8601). */
  createdFrom?: string;
  /** Exclusive upper bound on created_at (ISO 8601). */
  createdTo?: string;
}

/**
 * Canonical form: lower-cased ids, dates as full UTC ISO strings, keys in a fixed order,
 * absent fields dropped. Two requests that mean the same thing hash the same.
 */
export function normalizeFilter(filter: BulkFilter): BulkFilter {
  const out: BulkFilter = {};
  if (filter.stageId !== undefined) out.stageId = filter.stageId.toLowerCase();
  if (filter.ownerId !== undefined) out.ownerId = filter.ownerId;
  if (filter.status !== undefined) out.status = filter.status;
  if (filter.minValueCents !== undefined) out.minValueCents = filter.minValueCents;
  if (filter.maxValueCents !== undefined) out.maxValueCents = filter.maxValueCents;
  if (filter.createdFrom !== undefined) out.createdFrom = new Date(filter.createdFrom).toISOString();
  if (filter.createdTo !== undefined) out.createdTo = new Date(filter.createdTo).toISOString();

  if (out.minValueCents !== undefined && out.maxValueCents !== undefined && out.minValueCents > out.maxValueCents) {
    throw new DomainError('invalid', 'filter.minValueCents must be <= filter.maxValueCents');
  }
  if (out.createdFrom !== undefined && out.createdTo !== undefined && out.createdFrom >= out.createdTo) {
    throw new DomainError('invalid', 'filter.createdFrom must be before filter.createdTo');
  }
  return out;
}

export interface SqlWhere {
  /** e.g. "o.workspace_id = $1 AND o.stage_id = $2" */
  clause: string;
  params: unknown[];
}

/**
 * Builds the WHERE clause. Placeholders start after `offset` existing parameters, so the
 * caller can put its own parameters first.
 */
export function filterToSql(workspaceId: string, filter: BulkFilter, offset = 0): SqlWhere {
  const params: unknown[] = [workspaceId];
  const parts = [`o.workspace_id = $${offset + 1}`];
  const add = (sql: (placeholder: string) => string, value: unknown): void => {
    params.push(value);
    parts.push(sql(`$${offset + params.length}`));
  };
  if (filter.stageId !== undefined) add((p) => `o.stage_id = ${p}::uuid`, filter.stageId);
  if (filter.ownerId !== undefined) add((p) => `o.owner_id = ${p}`, filter.ownerId);
  if (filter.status !== undefined) add((p) => `o.status = ${p}`, filter.status);
  if (filter.minValueCents !== undefined) add((p) => `o.value_cents >= ${p}::bigint`, filter.minValueCents);
  if (filter.maxValueCents !== undefined) add((p) => `o.value_cents <= ${p}::bigint`, filter.maxValueCents);
  if (filter.createdFrom !== undefined) add((p) => `o.created_at >= ${p}::timestamptz`, filter.createdFrom);
  if (filter.createdTo !== undefined) add((p) => `o.created_at < ${p}::timestamptz`, filter.createdTo);
  return { clause: parts.join(' AND '), params };
}
