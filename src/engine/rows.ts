/** Row shapes returned by SQL, and their API representation. */
export interface OpportunityRow {
  id: string;
  workspace_id: string;
  stage_id: string;
  name: string;
  value_cents: string; // bigint arrives as string from pg
  status: OpportunityStatus;
  owner_id: string;
  stage_rev: string; // bigint
  created_at: Date;
  updated_at: Date;
}

export const OPPORTUNITY_STATUSES = ['open', 'won', 'lost', 'abandoned'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export interface Opportunity {
  id: string;
  stageId: string;
  name: string;
  valueCents: number;
  status: OpportunityStatus;
  ownerId: string;
  stageRev: number;
  createdAt: string;
  updatedAt: string;
}

export function toOpportunity(row: OpportunityRow): Opportunity {
  return {
    id: row.id,
    stageId: row.stage_id,
    name: row.name,
    // why: safe as a JS number; values are capped far below 2^53 cents.
    valueCents: Number(row.value_cents),
    status: row.status,
    ownerId: row.owner_id,
    stageRev: Number(row.stage_rev),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const OPPORTUNITY_COLUMNS =
  'id, workspace_id, stage_id, name, value_cents, status, owner_id, stage_rev, created_at, updated_at';
