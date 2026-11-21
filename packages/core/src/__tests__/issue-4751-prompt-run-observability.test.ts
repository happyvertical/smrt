/**
 * Prompt-run observability (#4751), against real in-memory SQLite.
 *
 * - The persistence handler lifts `promptKey` / `tierRequested` /
 *   `tierResolved` / `runId` tags into indexed columns and keeps `tags` whole.
 * - `listAiUsage()` / `summarizeAiUsage()` filter and group on them.
 * - `recordAiEvaluation()` labels existing usage only, inside its tenant.
 * - `reportAiUsage()` follows "a filter selects what is totalled, never what
 *   is accounted for": unattributed and uncosted rows are counted, filtered
 *   rows are reported as excluded.
 */

import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AiUsagePersistenceHandler,
  insertAiUsageRow,
} from '../adapters/ai-usage';
import { SmrtClass } from '../class';
import {
  AI_USAGE_COST_BASIS,
  AiEvaluationTargetError,
  listAiEvaluations,
  recordAiEvaluation,
  reportAiUsage,
} from '../system/ai-usage-observability';
import { ensureSystemTables } from '../system/bootstrap';
import { ensureAiUsageSystemTableCompatibility } from '../system/compatibility';

let instance: SmrtClass;
let db: DatabaseInterface;

beforeEach(async () => {
  instance = new SmrtClass({ db: ':memory:' });
  await (instance as unknown as { initialize(): Promise<void> }).initialize();
  db = instance.db as DatabaseInterface;
});

afterEach(async () => {
  instance.destroy();
  await (db as { close?: () => Promise<void> }).close?.();
});

interface UsageSeed {
  id: string;
  model?: string;
  provider?: string;
  className?: string | null;
  tenantId?: string | null;
  tags?: Record<string, unknown> | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  estimatedCost?: number | null;
  duration?: number;
  operation?: string;
  createdAt?: string;
}

/**
 * Insert one row the way a tracked call's settlement does
 * (`insertAiUsageRow` with the run named explicitly: a `runId` tag on an
 * untracked event no longer places a row in a run).
 */
async function persist(seed: UsageSeed): Promise<void> {
  const runId =
    typeof seed.tags?.runId === 'string' ? (seed.tags.runId as string) : null;
  await insertAiUsageRow(
    db,
    {
      provider: seed.provider ?? 'openai',
      model: seed.model ?? 'gpt-4o',
      operation: seed.operation ?? 'chat',
      usage:
        seed.promptTokens === null
          ? undefined
          : {
              promptTokens: seed.promptTokens ?? 10,
              completionTokens: seed.completionTokens ?? 5,
              totalTokens:
                (seed.promptTokens ?? 10) + (seed.completionTokens ?? 5),
            },
      duration: seed.duration ?? 100,
      timestamp: new Date(seed.createdAt ?? '2026-11-01T00:00:00.000Z'),
      tags: (seed.tags ?? undefined) as Record<string, string> | undefined,
      className: seed.className ?? 'Doc',
      tenantId: seed.tenantId ?? null,
      estimatedCost:
        seed.estimatedCost === null ? undefined : (seed.estimatedCost ?? 0.01),
    },
    { runId },
  );
  // The row gets its own UUID; rename it so tests can target rows.
  const rows = (
    await db.query(
      'SELECT id FROM _smrt_ai_usage WHERE id NOT LIKE $1 ORDER BY created_at DESC',
      'seed-%',
    )
  ).rows as { id: string }[];
  const fresh = rows.find((row) => !row.id.startsWith('seed-'));
  if (fresh) {
    await db.query(
      'UPDATE _smrt_ai_usage SET id = $1 WHERE id = $2',
      seed.id,
      fresh.id,
    );
  }
}

describe('AiUsagePersistenceHandler tag lift (#4751)', () => {
  it('copies the tags into their columns and keeps the full tag map', async () => {
    await persist({
      id: 'seed-1',
      tags: {
        promptKey: 'content.summarize.headline',
        promptLayer: 'tenant',
        templateHash: 'abcdefabcdef',
        tierRequested: 'auto',
        tierResolved: 'good',
        runId: 'run-1',
      },
    });

    const [row] = (
      await db.query(
        'SELECT prompt_key, tier_requested, tier_resolved, run_id, tags FROM _smrt_ai_usage',
      )
    ).rows as Record<string, unknown>[];

    expect(row).toMatchObject({
      prompt_key: 'content.summarize.headline',
      tier_requested: 'auto',
      tier_resolved: 'good',
      run_id: 'run-1',
    });
    expect(JSON.parse(String(row?.tags))).toEqual({
      promptKey: 'content.summarize.headline',
      promptLayer: 'tenant',
      templateHash: 'abcdefabcdef',
      tierRequested: 'auto',
      tierResolved: 'good',
      runId: 'run-1',
    });
  });

  it('stores NULL columns when the tags are absent or empty', async () => {
    await persist({ id: 'seed-1', tags: null });
    await persist({ id: 'seed-2', tags: { promptKey: '' } });

    const rows = (
      await db.query(
        'SELECT prompt_key, tier_requested, tier_resolved, run_id FROM _smrt_ai_usage',
      )
    ).rows;
    expect(rows).toEqual([
      {
        prompt_key: null,
        tier_requested: null,
        tier_resolved: null,
        run_id: null,
      },
      {
        prompt_key: null,
        tier_requested: null,
        tier_resolved: null,
        run_id: null,
      },
    ]);
  });

  it('reaches the columns through the SmrtClass usage pipeline', async () => {
    await (
      instance as unknown as {
        recordAiUsageEvent(
          event: unknown,
          config: Record<string, unknown>,
        ): Promise<void>;
      }
    ).recordAiUsageEvent(
      {
        provider: 'openai',
        model: 'gpt-4o',
        operation: 'chat',
        usage: { promptTokens: 3, completionTokens: 2 },
        duration: 7,
        tags: { promptKey: 'pipeline.key', runId: 'run-p' },
      },
      {},
    );

    const records = await instance.listAiUsage({ promptKey: 'pipeline.key' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      promptKey: 'pipeline.key',
      tags: { promptKey: 'pipeline.key' },
    });
    // A caller's runId tag does not make an untracked call a call of a run.
    expect(records[0]?.runId ?? null).toBeNull();
    expect(records[0]?.tags).not.toHaveProperty('runId');
    expect(records[0]?.tierRequested).toBeUndefined();
  });
});

describe('existing DuckDB install (#4751)', () => {
  it('adds the columns through the guarded ALTERs, idempotently, and records into them', async () => {
    const duck = await getDatabase({ type: 'duckdb', url: ':memory:' });
    try {
      await duck.query(`CREATE TABLE _smrt_ai_usage (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
        operation TEXT NOT NULL, prompt_tokens BIGINT, completion_tokens BIGINT,
        total_tokens BIGINT, estimated_cost REAL, duration BIGINT NOT NULL,
        class_name TEXT, tenant_id TEXT, tags TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);

      await ensureSystemTables(duck, 'duckdb');
      await ensureAiUsageSystemTableCompatibility(duck, 'duckdb');

      const columns = (
        (await duck.query('PRAGMA table_info(_smrt_ai_usage)')).rows as {
          name: string;
        }[]
      ).map((column) => column.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          'prompt_key',
          'tier_requested',
          'tier_resolved',
          'run_id',
        ]),
      );

      await insertAiUsageRow(
        duck,
        {
          provider: 'openai',
          model: 'gpt-4o',
          operation: 'chat',
          duration: 4,
          timestamp: new Date(),
          tags: { promptKey: 'duck.key', runId: 'duck-run' },
        },
        { runId: 'duck-run' },
      );
      const report = await reportAiUsage(duck, {
        allowCrossTenant: true,
        by: ['prompt'],
      });
      expect(report.buckets.map((b) => b.key.prompt)).toEqual(['duck.key']);
      await recordAiEvaluation(duck, {
        runId: 'duck-run',
        label: 'ok',
        evaluator: 'human',
      });
      expect(
        (await listAiEvaluations(duck, { allowCrossTenant: true }))[0]?.usage,
      ).toHaveLength(1);
    } finally {
      await duck.close?.();
    }
  });
});

describe('listAiUsage / summarizeAiUsage on the new columns', () => {
  beforeEach(async () => {
    await persist({
      id: 'seed-a',
      tags: {
        promptKey: 'k.one',
        runId: 'r1',
        tierRequested: 'good',
        tierResolved: 'good',
      },
    });
    await persist({
      id: 'seed-b',
      tags: {
        promptKey: 'k.one',
        runId: 'r2',
        tierRequested: 'great',
        tierResolved: 'good',
      },
    });
    await persist({ id: 'seed-c', tags: { promptKey: 'k.two' } });
    await persist({ id: 'seed-d', tags: null });
  });

  it('filters by prompt key, NULL prompt key, run and tiers', async () => {
    const ids = async (options: Parameters<SmrtClass['listAiUsage']>[0]) =>
      (await instance.listAiUsage(options)).map((r) => r.id).sort();

    expect(await ids({ promptKey: 'k.one' })).toEqual(['seed-a', 'seed-b']);
    expect(await ids({ promptKey: null })).toEqual(['seed-d']);
    expect(await ids({ runId: 'r2' })).toEqual(['seed-b']);
    expect(await ids({ tierRequested: 'great' })).toEqual(['seed-b']);
    expect(await ids({ tierResolved: 'good' })).toEqual(['seed-a', 'seed-b']);
  });

  it('groups by prompt (unattributed kept) and by tier', async () => {
    const byPrompt = await instance.summarizeAiUsage({ groupBy: 'prompt' });
    expect(
      Object.fromEntries(
        Object.entries(byPrompt).map(([k, v]) => [k, v.callCount]),
      ),
    ).toEqual({ 'k.one': 2, 'k.two': 1, unattributed: 1 });

    const byTier = await instance.summarizeAiUsage({ groupBy: 'tier' });
    expect(
      Object.fromEntries(
        Object.entries(byTier).map(([k, v]) => [k, v.callCount]),
      ),
    ).toEqual({ good: 2, untiered: 2 });
  });
});

describe('recordAiEvaluation / listAiEvaluations', () => {
  beforeEach(async () => {
    await persist({
      id: 'seed-t1',
      tenantId: 'tenant-a',
      tags: { promptKey: 'k', runId: 'run-a' },
    });
    await persist({
      id: 'seed-t2',
      tenantId: 'tenant-a',
      tags: { promptKey: 'k', runId: 'run-a' },
    });
    await persist({
      id: 'seed-t3',
      tenantId: 'tenant-b',
      tags: { promptKey: 'k', runId: 'run-mixed' },
    });
    await persist({
      id: 'seed-t4',
      tenantId: 'tenant-a',
      tags: { promptKey: 'k', runId: 'run-mixed' },
    });
  });

  it('records a usage label inheriting the row tenant, with JSON evidence', async () => {
    const record = await recordAiEvaluation(db, {
      callId: 'seed-t1',
      label: ' accepted ',
      value: 0.9,
      evidence: { editDistance: 0 },
      evaluator: 'human',
    });

    expect(record).toMatchObject({
      callId: 'seed-t1',
      runId: null,
      label: 'accepted',
      metric: 'outcome',
      value: 0.9,
      valueType: 'number',
      evidence: '{"editDistance":0}',
      evaluator: 'human',
      tenantId: 'tenant-a',
    });

    const [read] = await listAiEvaluations(db, {
      allowCrossTenant: true,
      callId: 'seed-t1',
    });
    expect(read).toMatchObject({
      id: record.id,
      label: 'accepted',
      value: 0.9,
    });
    expect(read?.usage.map((u) => u.id)).toEqual(['seed-t1']);
    expect(read?.usage[0]).toMatchObject({ promptKey: 'k', runId: 'run-a' });
  });

  it('joins a run label to every row of the run', async () => {
    await recordAiEvaluation(db, {
      runId: 'run-a',
      label: 'rejected',
      evaluator: 'human',
    });
    const [read] = await listAiEvaluations(db, {
      allowCrossTenant: true,
      runId: 'run-a',
    });
    expect(read?.tenantId).toBe('tenant-a');
    expect(read?.usage.map((u) => u.id).sort()).toEqual(['seed-t1', 'seed-t2']);
  });

  it('refuses unknown targets, tenant mismatches and runs spanning tenants', async () => {
    await expect(
      recordAiEvaluation(db, {
        callId: 'nope',
        label: 'x',
        evaluator: 'human',
      }),
    ).rejects.toMatchObject({ code: 'AI_EVALUATION_UNKNOWN_TARGET' });
    await expect(
      recordAiEvaluation(db, { runId: 'nope', label: 'x', evaluator: 'human' }),
    ).rejects.toBeInstanceOf(AiEvaluationTargetError);
    await expect(
      recordAiEvaluation(db, {
        callId: 'seed-t1',
        tenantId: 'tenant-b',
        label: 'x',
        evaluator: 'human',
      }),
    ).rejects.toMatchObject({ code: 'AI_EVALUATION_TENANT_MISMATCH' });
    await expect(
      recordAiEvaluation(db, {
        runId: 'run-mixed',
        label: 'x',
        evaluator: 'human',
      }),
    ).rejects.toMatchObject({ code: 'AI_EVALUATION_TENANT_MISMATCH' });
    await expect(
      recordAiEvaluation(db, {
        runId: 'run-mixed',
        tenantId: 'tenant-a',
        label: 'x',
        evaluator: 'human',
      }),
    ).rejects.toMatchObject({ code: 'AI_EVALUATION_TENANT_MISMATCH' });
  });

  it('validates its input', async () => {
    await expect(
      recordAiEvaluation(db, { label: 'x', evaluator: 'human' }),
    ).rejects.toThrow(/exactly one of callId or runId/);
    await expect(
      recordAiEvaluation(db, {
        callId: 'seed-t1',
        label: '  ',
        evaluator: 'human',
      }),
    ).rejects.toThrow(/label/);
    await expect(
      recordAiEvaluation(db, { callId: 'seed-t1', label: 'x', evaluator: '' }),
    ).rejects.toThrow(/evaluator/);
    await expect(
      recordAiEvaluation(db, {
        callId: 'seed-t1',
        label: 'x',
        evaluator: 'human',
        value: Number.NaN,
      }),
    ).rejects.toThrow(/finite/);
  });

  it('treats an empty tenant filter as a tenant, never as no filter', async () => {
    await recordAiEvaluation(db, {
      callId: 'seed-t1',
      label: 'a',
      evaluator: 'human',
    });
    await recordAiEvaluation(db, {
      callId: 'seed-t3',
      label: 'b',
      evaluator: 'human',
    });
    expect(await listAiEvaluations(db, { tenantId: '' })).toEqual([]);
    const report = await reportAiUsage(db, { tenantId: '' });
    expect(report.totals.calls).toBe(0);
    expect(report.totals.evaluations).toEqual({});
  });

  it('keeps the label after retention prunes its usage row', async () => {
    await recordAiEvaluation(db, {
      callId: 'seed-t2',
      label: 'ok',
      evaluator: 'human',
    });
    await db.query('DELETE FROM _smrt_ai_usage WHERE id = $1', 'seed-t2');
    const [read] = await listAiEvaluations(db, {
      allowCrossTenant: true,
      callId: 'seed-t2',
    });
    expect(read?.label).toBe('ok');
    expect(read?.usage).toEqual([]);
  });

  it('filters by tenant, label and limit, newest first', async () => {
    await recordAiEvaluation(db, {
      callId: 'seed-t1',
      label: 'a',
      evaluator: 'human',
      createdAt: new Date('2026-11-02T00:00:00Z'),
    });
    await recordAiEvaluation(db, {
      callId: 'seed-t3',
      label: 'b',
      evaluator: 'human',
      createdAt: new Date('2026-11-03T00:00:00Z'),
    });
    expect(
      (await listAiEvaluations(db, { allowCrossTenant: true })).map(
        (o) => o.label,
      ),
    ).toEqual(['b', 'a']);
    expect(
      (await listAiEvaluations(db, { tenantId: 'tenant-a' })).map(
        (o) => o.label,
      ),
    ).toEqual(['a']);
    expect(
      (await listAiEvaluations(db, { allowCrossTenant: true, label: 'b' })).map(
        (o) => o.tenantId,
      ),
    ).toEqual(['tenant-b']);
    expect(
      await listAiEvaluations(db, { allowCrossTenant: true, limit: 1 }),
    ).toHaveLength(1);
    expect(await listAiEvaluations(db, { tenantId: null })).toEqual([]);
  });
});

describe('reportAiUsage', () => {
  beforeEach(async () => {
    await persist({
      id: 'seed-1',
      tenantId: 'tenant-a',
      duration: 100,
      estimatedCost: 0.02,
      tags: {
        promptKey: 'k.one',
        tierRequested: 'good',
        tierResolved: 'good',
        runId: 'run-1',
      },
    });
    await persist({
      id: 'seed-2',
      tenantId: 'tenant-a',
      duration: 300,
      estimatedCost: null,
      model: 'local-llm',
      tags: {
        promptKey: 'k.one',
        tierRequested: 'great',
        tierResolved: 'good',
        runId: 'run-1',
        substitutions: '[{"from":"a","to":"b","reason":"quota"}]',
        fusionKey: 'pair.review',
        source: 'byo',
      },
    });
    await persist({
      id: 'seed-3',
      tenantId: 'tenant-a',
      duration: 200,
      estimatedCost: 0.01,
      tags: null,
    });
    await persist({
      id: 'seed-4',
      tenantId: 'tenant-b',
      duration: 50,
      estimatedCost: 0.5,
      tags: { promptKey: 'k.one' },
    });
    await persist({
      id: 'seed-5',
      tenantId: 'tenant-a',
      duration: 10,
      createdAt: '2026-10-01T00:00:00.000Z',
      tags: { promptKey: 'k.old' },
    });
    // An external-agent measurement: its own summary contract, never totalled.
    await persist({
      id: 'seed-ext',
      operation: 'external-agent',
      tenantId: 'tenant-a',
      tags: null,
    });
    await db.query(
      "UPDATE _smrt_ai_usage SET id = 'external-agent:abc' WHERE id = 'seed-ext'",
    );

    await recordAiEvaluation(db, {
      callId: 'seed-1',
      label: 'accepted',
      evaluator: 'human',
    });
    await recordAiEvaluation(db, {
      runId: 'run-1',
      label: 'edited',
      evaluator: 'human',
    });
    await recordAiEvaluation(db, {
      callId: 'seed-4',
      label: 'rejected',
      evaluator: 'human',
    });
  });

  it('groups by prompt with unattributed rows kept, cost basis stated and uncosted counted', async () => {
    const report = await reportAiUsage(db, {
      allowCrossTenant: true,
      by: ['prompt'],
      since: new Date('2026-10-15T00:00:00Z'),
    });

    expect(report.costBasis).toBe(AI_USAGE_COST_BASIS);
    expect(report.totals).toMatchObject({
      calls: 4,
      costedCalls: 3,
      uncostedCalls: 1,
      substitutions: 1,
      evaluations: { accepted: 1, edited: 1, rejected: 1 },
    });
    expect(report.totals.estimatedCost).toBeCloseTo(0.53);
    expect(report.unattributedCalls).toBe(1);
    expect(report.excluded).toEqual({ otherTenants: 0, externalAgent: 1 });

    const byKey = Object.fromEntries(
      report.buckets.map((b) => [String(b.key.prompt), b]),
    );
    expect(Object.keys(byKey).sort()).toEqual(['k.one', 'null']);
    expect(byKey['k.one']).toMatchObject({
      calls: 3,
      costedCalls: 2,
      uncostedCalls: 1,
      p50DurationMs: 100,
      evaluations: { accepted: 1, edited: 1, rejected: 1 },
    });
    expect(byKey.null).toMatchObject({ calls: 1, p50DurationMs: 200 });
  });

  it('totals one tenant and never reads or counts the other tenants', async () => {
    const report = await reportAiUsage(db, {
      by: ['model', 'tier'],
      tenantId: 'tenant-a',
      since: new Date('2026-10-15T00:00:00Z'),
    });

    expect(report.tenantId).toBe('tenant-a');
    expect(report.totals.calls).toBe(3);
    expect(report.excluded).toEqual({ otherTenants: 0, externalAgent: 1 });
    // A run label counts once in the totals even though the run has two rows.
    expect(report.totals.evaluations).toEqual({ accepted: 1, edited: 1 });

    const keys = report.buckets
      .map((b) => `${b.key.model}|${b.key.tier}`)
      .sort();
    expect(keys).toEqual([
      'openai:gpt-4o|good',
      'openai:gpt-4o|null',
      'openai:local-llm|great->good',
    ]);
  });

  it('groups by fusion and class, and rejects unknown dimensions', async () => {
    // The whole history, the 2026-10-01 row included.
    const report = await reportAiUsage(db, {
      allowCrossTenant: true,
      by: ['fusion', 'class'],
      since: new Date(0),
    });
    const fusion = report.buckets.find((b) => b.key.fusion === 'pair.review');
    expect(fusion).toMatchObject({ calls: 1, key: { class: 'Doc' } });
    expect(report.totals.calls).toBe(5);

    await expect(
      reportAiUsage(db, { allowCrossTenant: true, by: ['nope' as never] }),
    ).rejects.toThrow(/unknown dimension/);
  });

  it('groups by binding source from the source tag (#4756)', async () => {
    const report = await reportAiUsage(db, {
      allowCrossTenant: true,
      by: ['source'],
      since: new Date(0),
    });
    expect(report.buckets.find((b) => b.key.source === 'byo')).toMatchObject({
      calls: 1,
    });
    expect(report.buckets.find((b) => b.key.source === null)?.calls).toBe(4);
  });

  it('never counts a run label on another tenant reusing the run id later', async () => {
    // run-1 is labelled while it belongs only to tenant-a; tenant-b then
    // records usage under the same free-form run id.
    await persist({
      id: 'seed-b-run',
      tenantId: 'tenant-b',
      tags: { promptKey: 'k.b', runId: 'run-1' },
    });

    const report = await reportAiUsage(db, {
      allowCrossTenant: true,
      by: ['tenant'],
      since: new Date('2026-10-15T00:00:00Z'),
    });
    const byTenant = Object.fromEntries(
      report.buckets.map((b) => [String(b.key.tenant), b.evaluations]),
    );
    expect(byTenant['tenant-a']).toEqual({ accepted: 1, edited: 1 });
    expect(byTenant['tenant-b']).toEqual({ rejected: 1 });
    expect(report.totals.evaluations).toEqual({
      accepted: 1,
      edited: 1,
      rejected: 1,
    });
  });

  it('counts labels named like Object.prototype members as plain labels', async () => {
    for (const label of ['constructor', 'toString', '__proto__']) {
      await recordAiEvaluation(db, {
        callId: 'seed-3',
        label,
        evaluator: 'human',
      });
      await recordAiEvaluation(db, {
        callId: 'seed-3',
        label,
        evaluator: 'human',
      });
    }
    const report = await reportAiUsage(db, {
      allowCrossTenant: true,
      since: new Date('2026-10-15T00:00:00Z'),
    });
    const parsed = JSON.parse(JSON.stringify(report.totals.evaluations));
    expect(parsed).toMatchObject({ constructor: 2, toString: 2 });
    expect(
      Object.getOwnPropertyDescriptor(report.totals.evaluations, '__proto__')
        ?.value,
    ).toBe(2);
  });

  it('pages through more rows than one keyset page', async () => {
    for (let i = 0; i < 1005; i++) {
      await db.query(
        `INSERT INTO _smrt_ai_usage (id, provider, model, operation, duration, created_at)
         VALUES ($1, 'p', 'm', 'chat', 1, '2026-11-05T00:00:00.000Z')`,
        `bulk-${String(i).padStart(5, '0')}`,
      );
    }
    const report = await reportAiUsage(db, {
      allowCrossTenant: true,
      since: new Date('2026-11-04T00:00:00Z'),
    });
    expect(report.totals.calls).toBe(1005);
    expect(report.totals.uncostedCalls).toBe(1005);
    expect(report.unattributedCalls).toBe(1005);
  });
});
