/**
 * Benchmark for BENCHMARKS.md. Measures, against a running stack (API + workers):
 *   1. a 50,000-opportunity bulk move: wall-clock and sustained throughput
 *   2. interactive p95/p99 during the move, in the same workspace and in a different one,
 *      for reads (list a stage) and writes (manual stage move), against a no-bulk baseline
 *   3. with --kill: kill all workers at ~30,000, restart them, time to completion
 * and then verifies the result with SQL. Raw results go to bench/results/*.json.
 *
 *   npm run build && node dist/bench/run.js [--kill]
 * Env: BASE_URL (default http://localhost:3000), DATABASE_URL (default compose's),
 *      KILL_CMD / START_CMD (default: docker compose kill/start of the worker service).
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { dbConfig } from '../src/config.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { LARGE_WORKSPACE_ID, SMALL_WORKSPACE_IDS } from '../scripts/seed.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const KILL = process.argv.includes('--kill');
const KILL_AT = 30_000;
const KILL_CMD = process.env.KILL_CMD ?? 'docker compose kill -s SIGKILL worker';
const START_CMD = process.env.START_CMD ?? 'docker compose start worker';
const CLIENTS_PER_TARGET = 4;
const OTHER_WS = SMALL_WORKSPACE_IDS[0]!;
// why: async, never execSync. A blocking call would freeze this process's own load clients,
// and the frozen time would be recorded as request latency (a measurement artifact).
const sh = promisify(exec);

interface Target {
  name: string;
  workspaceId: string;
  stageIds: string[];
  /** Stages manual moves may target (never the bulk job's source stage, see loadTarget). */
  moveTargets: string[];
  opportunityIds: string[];
}
type Sample = { kind: 'read' | 'write'; ms: number; ok: boolean };

async function api(path: string, ws: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-workspace-id': ws, ...(init.headers ?? {}) },
  });
}

async function loadTarget(pool: Pool, name: string, workspaceId: string, excludeStage: string | null): Promise<Target> {
  const stages = await pool.query<{ id: string }>('SELECT id FROM stages WHERE workspace_id = $1 ORDER BY position', [workspaceId]);
  // why: manual moves use opportunities outside the bulk job's stage, so the measured write
  // latency is "same workspace, different rows" (the realistic case) plus some row overlap below.
  const opps = await pool.query<{ id: string }>(
    'SELECT id FROM opportunities WHERE workspace_id = $1 AND stage_id IS DISTINCT FROM $2::uuid ORDER BY random() LIMIT 2000',
    [workspaceId, excludeStage],
  );
  const stageIds = stages.rows.map((r) => r.id);
  // why: never move deals INTO the bulk job's source stage. Otherwise, in the milliseconds
  // between computing the 50k filter and submitting, the load itself could push the match
  // count to 50,001 and the (correct) 422 would abort the benchmark.
  const moveTargets = stageIds.filter((id) => id !== excludeStage);
  return { name, workspaceId, stageIds, moveTargets, opportunityIds: opps.rows.map((r) => r.id) };
}

/** Closed-loop clients: each sends its next request as soon as the previous one returns. */
function startLoad(target: Target, samples: Sample[], stop: AbortSignal): Promise<void>[] {
  const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
  return Array.from({ length: CLIENTS_PER_TARGET }, async (_, client) => {
    while (!stop.aborted) {
      const write = client % 2 === 1; // half the clients write, half read
      const t0 = performance.now();
      let ok = false;
      try {
        const res = write
          ? await api(`/v1/opportunities/${pick(target.opportunityIds)}/stage`, target.workspaceId, {
              method: 'PATCH',
              body: JSON.stringify({ stageId: pick(target.moveTargets) }),
            })
          : await api(`/v1/stages/${pick(target.stageIds)}/opportunities?limit=20`, target.workspaceId);
        await res.arrayBuffer();
        ok = res.ok;
      } catch {
        ok = false;
      }
      samples.push({ kind: write ? 'write' : 'read', ms: performance.now() - t0, ok });
    }
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! * 10) / 10;
}

function summarize(samples: Sample[], seconds: number) {
  const out: Record<string, unknown> = {};
  for (const kind of ['read', 'write'] as const) {
    const ok = samples.filter((s) => s.kind === kind && s.ok).map((s) => s.ms).sort((a, b) => a - b);
    out[kind] = {
      requests: samples.filter((s) => s.kind === kind).length,
      errors: samples.filter((s) => s.kind === kind && !s.ok).length,
      rps: Math.round(ok.length / seconds),
      p50: percentile(ok, 50),
      p95: percentile(ok, 95),
      p99: percentile(ok, 99),
      max: Math.round((ok.at(-1) ?? NaN) * 10) / 10,
    };
  }
  return out;
}

/** Load for `seconds` with no bulk job running: the comparison point. */
async function baseline(targets: Target[], seconds: number) {
  const stop = new AbortController();
  const samples = targets.map(() => [] as Sample[]);
  const runs = targets.flatMap((t, i) => startLoad(t, samples[i]!, stop.signal));
  await sleep(seconds * 1000);
  stop.abort();
  await Promise.all(runs);
  return Object.fromEntries(targets.map((t, i) => [t.name, summarize(samples[i]!, seconds)]));
}

/** Filter matching exactly the 50,000 newest opportunities of the large workspace's biggest stage. */
async function fiftyKFilter(pool: Pool, stageId: string): Promise<{ stageId: string; createdFrom: string }> {
  const { rows } = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM opportunities WHERE workspace_id = $1 AND stage_id = $2
     ORDER BY created_at DESC OFFSET 49999 LIMIT 1`,
    [LARGE_WORKSPACE_ID, stageId],
  );
  return { stageId, createdFrom: rows[0]!.created_at.toISOString() };
}

async function verify(pool: Pool, jobId: string) {
  const { rows } = await pool.query(
    `SELECT j.status, j.total, j.cursor, j.moved, j.skipped_conflict, j.skipped_noop,
       (SELECT count(*) FROM bulk_job_items WHERE job_id = j.id AND outcome IS NULL)::int AS items_without_outcome,
       -- a moved deal must be in the target stage, unless a human moved it again afterwards
       (SELECT count(*) FROM bulk_job_items i JOIN opportunities o ON o.id = i.opportunity_id
          WHERE i.job_id = j.id AND i.outcome = 'moved' AND o.stage_id <> j.target_stage_id
            AND NOT EXISTS (SELECT 1 FROM stage_transitions m JOIN stage_transitions b
                              ON b.opportunity_id = m.opportunity_id AND b.bulk_job_id = j.id
                            WHERE m.opportunity_id = i.opportunity_id AND m.source = 'manual'
                              AND m.created_at > b.created_at))::int AS moved_but_not_in_target,
       (SELECT count(*) FROM bulk_job_items i JOIN opportunities o ON o.id = i.opportunity_id
          WHERE i.job_id = j.id AND i.outcome = 'skipped_conflict'
            AND NOT EXISTS (SELECT 1 FROM stage_transitions m WHERE m.opportunity_id = i.opportunity_id
                              AND m.source = 'manual' AND m.created_at > j.created_at))::int AS conflicts_without_manual_edit,
       (SELECT count(*) FROM stage_transitions WHERE bulk_job_id = j.id)::int AS bulk_transitions,
       (SELECT count(*) FROM (SELECT opportunity_id FROM stage_transitions WHERE bulk_job_id = j.id
          GROUP BY 1 HAVING count(*) > 1) d)::int AS opportunities_moved_twice
     FROM bulk_jobs j WHERE j.id = $1`,
    [jobId],
  );
  const r = rows[0];
  const correct = r.status === 'completed' && r.cursor === r.total && r.items_without_outcome === 0 &&
    r.moved_but_not_in_target === 0 && r.conflicts_without_manual_edit === 0 && r.bulk_transitions === r.moved && r.opportunities_moved_twice === 0;
  return { ...r, correct };
}

async function main(): Promise<void> {
  const pool = createPool(dbConfig().connectionString, 2, 'bench');
  // why: pick the currently biggest stage as source and the smallest as target, so the
  // benchmark can be re-run any number of times on the same data.
  const stages = await pool.query<{ id: string }>(
    `SELECT s.id FROM stages s LEFT JOIN opportunities o ON o.stage_id = s.id
     WHERE s.workspace_id = $1 GROUP BY s.id ORDER BY count(o.id) DESC`,
    [LARGE_WORKSPACE_ID],
  );
  const sourceStage = stages.rows[0]!.id;
  const targetStage = stages.rows.at(-1)!.id;
  const sameWs = await loadTarget(pool, 'same workspace (large, 500k)', LARGE_WORKSPACE_ID, sourceStage);
  const otherWs = await loadTarget(pool, 'other workspace (small)', OTHER_WS, null);
  const targets = [sameWs, otherWs];

  console.log('Baseline load (no bulk job), 15 s...');
  const before = await baseline(targets, 15);

  const filter = await fiftyKFilter(pool, sourceStage);
  const stop = new AbortController();
  const samples = targets.map(() => [] as Sample[]);
  const load = targets.flatMap((t, i) => startLoad(t, samples[i]!, stop.signal));

  const t0 = performance.now();
  const res = await api('/v1/bulk-moves', LARGE_WORKSPACE_ID, {
    method: 'POST',
    headers: { 'idempotency-key': `bench-${Date.now()}` },
    body: JSON.stringify({ targetStageId: targetStage, filter }),
  });
  const submitMs = performance.now() - t0;
  const submitted = (await res.json()) as { jobId?: string; message?: unknown };
  if (res.status !== 202 || !submitted.jobId) {
    stop.abort();
    await Promise.all(load);
    throw new Error(`Submit failed with ${res.status}: ${JSON.stringify(submitted)}`);
  }
  const jobId = submitted.jobId;
  console.log(`Submitted ${jobId} (${res.status}) in ${Math.round(submitMs)} ms`);

  // Deliberate collisions: the same-workspace writers now also move a sample of the job's own
  // deals by hand while it runs, so the manual-edit-wins rule is exercised under load.
  const jobDeals = await pool.query<{ opportunity_id: string }>(
    'SELECT opportunity_id FROM bulk_job_items WHERE job_id = $1 ORDER BY random() LIMIT 200',
    [jobId],
  );
  sameWs.opportunityIds.push(...jobDeals.rows.map((r) => r.opportunity_id));

  let firstProgressAt: number | null = null;
  let killedAt: number | null = null;
  let restartedAt: number | null = null;
  let processed = 0;
  let status = 'queued';
  const timeline: { s: number; processed: number; health: string }[] = [];
  while (status !== 'completed' && status !== 'failed') {
    await sleep(250);
    const p = (await (await api(`/v1/bulk-moves/${jobId}`, LARGE_WORKSPACE_ID)).json()) as { status: string; processed: number; health: string };
    status = p.status;
    processed = p.processed;
    const now = performance.now();
    timeline.push({ s: Math.round((now - t0) / 100) / 10, processed, health: p.health });
    if (firstProgressAt === null && processed > 0) firstProgressAt = now;
    if (KILL && killedAt === null && processed >= KILL_AT) {
      await sh(KILL_CMD);
      killedAt = performance.now();
      console.log(`Killed workers at processed=${processed}`);
      await sleep(1000);
      await sh(START_CMD);
      restartedAt = performance.now();
    }
  }
  const t1 = performance.now();
  stop.abort();
  await Promise.all(load);

  const seconds = (t1 - t0) / 1000;
  const during = Object.fromEntries(targets.map((t, i) => [t.name, summarize(samples[i]!, seconds)]));
  const result = {
    mode: KILL ? 'kill-and-resume' : 'uninterrupted',
    when: new Date().toISOString(),
    hardware: { platform: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30) },
    job: {
      jobId, status, total: processed, submitMs: Math.round(submitMs),
      wallClockSeconds: Math.round(seconds * 10) / 10,
      sustainedRowsPerSecond: firstProgressAt ? Math.round(processed / ((t1 - firstProgressAt) / 1000)) : null,
      killedAtProcessed: killedAt ? KILL_AT : null,
      secondsFromKillToCompletion: killedAt ? Math.round((t1 - killedAt) / 100) / 10 : null,
      secondsWorkersWereDown: killedAt && restartedAt ? Math.round((restartedAt - killedAt) / 100) / 10 : null,
    },
    interactiveBaseline: before,
    interactiveDuringBulk: during,
    verification: await verify(pool, jobId),
    timeline,
  };
  await pool.end();

  mkdirSync('bench/results', { recursive: true });
  const file = `bench/results/${result.mode}-${result.when.replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, timeline: `${timeline.length} samples (see file)` }, null, 2));
  console.log(`\nSaved ${file}`);
}

await main();
