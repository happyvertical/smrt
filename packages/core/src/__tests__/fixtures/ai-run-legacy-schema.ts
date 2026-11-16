/**
 * The 1.16.0 shape of the AI system tables (`_smrt_ai_usage`,
 * `_smrt_ai_usage_outcomes`, `_smrt_ai_runs`) and rows to carry across the
 * #5005 upgrade, for the schema-evolution tests of every engine.
 */

import type { DatabaseInterface } from '@happyvertical/sql';

/** 1.16.0 `_smrt_ai_usage`, `_smrt_ai_usage_outcomes` and `_smrt_ai_runs`. */
export const LEGACY_AI_RUN_DDL = [
  `CREATE TABLE _smrt_ai_usage (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    operation TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    estimated_cost REAL,
    duration INTEGER NOT NULL,
    class_name TEXT,
    tenant_id TEXT,
    tags TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    prompt_key TEXT,
    tier_requested TEXT,
    tier_resolved TEXT,
    run_id TEXT,
    call_id TEXT
  )`,
  'CREATE INDEX idx_smrt_ai_usage_created ON _smrt_ai_usage(created_at)',
  'CREATE INDEX idx_smrt_ai_usage_class ON _smrt_ai_usage(class_name)',
  'CREATE INDEX idx_smrt_ai_usage_tenant ON _smrt_ai_usage(tenant_id)',
  'CREATE INDEX idx_smrt_ai_usage_provider_model ON _smrt_ai_usage(provider, model)',
  'CREATE INDEX idx_smrt_ai_usage_tenant_created ON _smrt_ai_usage(tenant_id, created_at)',
  'CREATE INDEX idx_smrt_ai_usage_prompt_key ON _smrt_ai_usage(prompt_key, created_at)',
  'CREATE INDEX idx_smrt_ai_usage_run ON _smrt_ai_usage(run_id)',
  'CREATE INDEX idx_smrt_ai_usage_call ON _smrt_ai_usage(call_id)',
  `CREATE TABLE _smrt_ai_usage_outcomes (
    id TEXT PRIMARY KEY,
    usage_id TEXT,
    run_id TEXT,
    call_id TEXT,
    label TEXT NOT NULL,
    score REAL,
    evidence TEXT,
    actor TEXT NOT NULL,
    tenant_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX idx_smrt_ai_usage_outcomes_usage ON _smrt_ai_usage_outcomes(usage_id)',
  'CREATE INDEX idx_smrt_ai_usage_outcomes_run ON _smrt_ai_usage_outcomes(run_id)',
  'CREATE INDEX idx_smrt_ai_usage_outcomes_tenant_created ON _smrt_ai_usage_outcomes(tenant_id, created_at)',
  'CREATE INDEX idx_smrt_ai_usage_outcomes_call ON _smrt_ai_usage_outcomes(call_id)',
  `CREATE TABLE _smrt_ai_runs (
    id TEXT PRIMARY KEY,
    fusion_key TEXT NOT NULL,
    mode TEXT NOT NULL,
    tenant_id TEXT,
    class_name TEXT,
    prompt_key TEXT,
    seats INTEGER NOT NULL,
    degraded_seats INTEGER NOT NULL,
    status TEXT NOT NULL,
    duration INTEGER NOT NULL,
    details TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX idx_smrt_ai_runs_created ON _smrt_ai_runs(created_at)',
  'CREATE INDEX idx_smrt_ai_runs_fusion_created ON _smrt_ai_runs(fusion_key, created_at)',
  'CREATE INDEX idx_smrt_ai_runs_tenant_created ON _smrt_ai_runs(tenant_id, created_at)',
];

export async function seedLegacyAiRunRows(
  db: DatabaseInterface,
): Promise<void> {
  // A fusion's three seats share one transcript call id; a lone call has its
  // own; a very old row has none.
  const usage = (
    id: string,
    callId: string | null,
    runId: string | null,
    tenant: string | null = 't1',
  ) =>
    db.query(
      `INSERT INTO _smrt_ai_usage
        (id, provider, model, operation, duration, tenant_id, run_id, call_id, prompt_key)
       VALUES ($1, 'openai', 'gpt-4o', 'chat', 5, $2, $3, $4, 'k')`,
      id,
      tenant,
      runId,
      callId,
    );
  await usage('u-seat-1', 'fusion-call', 'run-f', 't1');
  await usage('u-seat-2', 'fusion-call', 'run-f', 't1');
  await usage('u-seat-3', 'fusion-call', 'run-f', 't1');
  await usage('u-solo', 'solo-call', null);
  await usage('u-none', null, null);
  await usage('u-chain-1', 'chain-call', null);
  await usage('u-chain-2', 'chain-call', null);

  const run = (
    id: string,
    status: string,
    createdAt: string,
    duration: number,
  ) =>
    db.query(
      `INSERT INTO _smrt_ai_runs
        (id, fusion_key, mode, tenant_id, seats, degraded_seats, status,
         duration, details, created_at)
       VALUES ($1, 'review', 'pair', 't1', 3, 1, $2, $3, '{"seats":[]}', $4)`,
      id,
      status,
      duration,
      createdAt,
    );
  await run('run-ok', 'ok', '2026-01-02T00:00:10.000Z', 4000);
  await run('run-deg', 'degraded', '2026-01-02T00:00:20.000Z', 500);
  await run('run-bad', 'failed', '2026-01-02T00:00:30.000Z', 0);

  const label = (
    id: string,
    target: { usage?: string; run?: string; call?: string },
    score: number | null,
  ) =>
    db.query(
      `INSERT INTO _smrt_ai_usage_outcomes
        (id, usage_id, run_id, call_id, label, score, evidence, actor, tenant_id)
       VALUES ($1, $2, $3, $4, 'accepted', $5, '{"why":"x"}', 'reviewer', 't1')`,
      id,
      target.usage ?? null,
      target.run ?? null,
      target.call ?? null,
      score,
    );
  await label('l-usage', { usage: 'u-solo' }, 0.5);
  await label('l-usage-and-run', { usage: 'u-seat-1', run: 'run-f' }, null);
  await label('l-run', { run: 'run-f' }, 1);
  await label('l-solo-call', { call: 'solo-call' }, 0.25);
  await label('l-fusion-call', { call: 'fusion-call' }, 0);
  await label('l-chain-call', { call: 'chain-call' }, 1);
  await label('l-pruned-call', { call: 'gone-call' }, 1);
}
