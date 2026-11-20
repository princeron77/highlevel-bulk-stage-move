/**
 * Part 1: the small interactive surface (create, manual move, list a stage).
 * Plain functions over a Pool so they are testable without Nest.
 */
import { pgCode, withTx, type Client, type Pool } from '../db/pool.js';
import { DomainError, notFound } from './errors.js';
import {
  OPPORTUNITY_COLUMNS,
  toOpportunity,
  type Opportunity,
  type OpportunityRow,
  type OpportunityStatus,
} from './rows.js';

export interface CreateOpportunityInput {
  name: string;
  valueCents: number;
  status: OpportunityStatus;
  ownerId: string;
  stageId: string;
}

async function assertStageInWorkspace(db: Pool | Client, workspaceId: string, stageId: string): Promise<void> {
  const found = await db.query('SELECT 1 FROM stages WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    stageId,
  ]);
  if (found.rowCount === 0) throw notFound('Stage');
}

export async function createOpportunity(
  pool: Pool,
  workspaceId: string,
  input: CreateOpportunityInput,
): Promise<Opportunity> {
  await assertStageInWorkspace(pool, workspaceId, input.stageId);
  const { rows } = await pool.query<OpportunityRow>(
    `INSERT INTO opportunities (workspace_id, stage_id, name, value_cents, status, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${OPPORTUNITY_COLUMNS}`,
    [workspaceId, input.stageId, input.name, input.valueCents, input.status, input.ownerId],
  );
  return toOpportunity(rows[0]!);
}

/** One attempt at a manual move, inside one short transaction. */
async function moveOnce(
  pool: Pool,
  workspaceId: string,
  opportunityId: string,
  toStageId: string,
): Promise<Opportunity> {
  // why: 1 s lock wait. A bulk chunk holds a row for well under a second, so a manual move
  // normally just waits it out; a longer wait means something is wrong and we say "busy".
  return withTx(
    pool,
    async (client) => {
      await assertStageInWorkspace(client, workspaceId, toStageId);
      // why: FOR UPDATE serialises this move with the bulk job's update of the same row.
      const current = await client.query<OpportunityRow>(
        `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities
         WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [workspaceId, opportunityId],
      );
      const row = current.rows[0];
      if (!row) throw notFound('Opportunity');
      if (row.stage_id === toStageId) return toOpportunity(row); // already there: no-op, no transition

      // why: stage_rev + 1 is what lets a running bulk job see that a human touched this row.
      const updated = await client.query<OpportunityRow>(
        `UPDATE opportunities
         SET stage_id = $3, stage_rev = stage_rev + 1, updated_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING ${OPPORTUNITY_COLUMNS}`,
        [workspaceId, opportunityId, toStageId],
      );
      await client.query(
        `INSERT INTO stage_transitions (workspace_id, opportunity_id, from_stage_id, to_stage_id, source)
         VALUES ($1, $2, $3, $4, 'manual')`,
        [workspaceId, opportunityId, row.stage_id, toStageId],
      );
      return toOpportunity(updated.rows[0]!);
    },
    { lockTimeoutMs: 1000, statementTimeoutMs: 5000 },
  );
}

/** Manual move with one automatic retry if the row was briefly locked by a bulk chunk. */
export async function moveOpportunity(
  pool: Pool,
  workspaceId: string,
  opportunityId: string,
  toStageId: string,
): Promise<Opportunity> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await moveOnce(pool, workspaceId, opportunityId, toStageId);
    } catch (error) {
      if (pgCode(error) !== '55P03') throw error; // 55P03 = lock_not_available
      if (attempt >= 2) throw new DomainError('busy', 'Opportunity is busy, retry shortly');
    }
  }
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

interface CursorPosition {
  createdAt: string; // microsecond-precision UTC timestamp, exactly as Postgres stores it
  id: string;
}

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

function decodeCursor(cursor: string): CursorPosition {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPosition;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') throw new Error();
    if (Number.isNaN(Date.parse(parsed.createdAt))) throw new Error();
    return parsed;
  } catch {
    throw new DomainError('invalid', 'cursor is not valid');
  }
}

/**
 * Keyset pagination on (created_at, id): every page is an index range scan, so page 1,000
 * costs the same as page 1 (OFFSET would scan and discard all earlier rows).
 */
export async function listStage(
  pool: Pool,
  workspaceId: string,
  stageId: string,
  limit: number,
  cursor?: string,
): Promise<Page<Opportunity>> {
  await assertStageInWorkspace(pool, workspaceId, stageId);
  const after = cursor ? decodeCursor(cursor) : null;
  const { rows } = await pool.query<OpportunityRow & { cursor_ts: string }>(
    `SELECT ${OPPORTUNITY_COLUMNS},
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
     FROM opportunities
     WHERE workspace_id = $1 AND stage_id = $2
       AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4::uuid))
     ORDER BY created_at, id
     LIMIT $5`,
    [workspaceId, stageId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    data: page.map(toOpportunity),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.cursor_ts, id: last.id }) : null,
  };
}

export interface Stage {
  id: string;
  name: string;
  position: number;
}

export async function listStages(pool: Pool, workspaceId: string): Promise<Stage[]> {
  const { rows } = await pool.query<Stage>(
    'SELECT id, name, position FROM stages WHERE workspace_id = $1 ORDER BY position',
    [workspaceId],
  );
  return rows;
}
