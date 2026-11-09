/**
 * Prompt-version and model comparison (#4782) on SQLite: per-side
 * arithmetic, tenant scoping of every read (usage, labels, runs,
 * transcripts), transcript selection by label, empty sides, selector kinds,
 * and the template history.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtClass } from '../class';
import {
  AiUsageScopeError,
  compareAiPromptRuns,
  listAiPromptTemplateHistory,
} from '../system/ai-prompt-compare';
import { recordAiRun } from '../system/ai-runs';
import { recordAiTranscript } from '../system/ai-transcripts';
import { recordAiUsageOutcome } from '../system/ai-usage-observability';

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

const PROMPT = 'content.summarize';

interface Row {
  id: string;
  tenantId?: string | null;
  promptKey?: string | null;
  hash?: string;
  layer?: string;
  provider?: string;
  model?: string;
  operation?: string;
  tierRequested?: string | null;
  tierResolved?: string | null;
  runId?: string | null;
  callId?: string | null;
  cost?: number | null;
  duration?: number;
  tokens?: number;
  substitutions?: unknown[];
  createdAt?: string;
}

async function usage(row: Row): Promise<void> {
  const tags: Record<string, unknown> = {};
  if (row.hash) tags.templateHash = row.hash;
  if (row.layer) tags.promptLayer = row.layer;
  if (row.substitutions) tags.substitutions = JSON.stringify(row.substitutions);
  await db.query(
    `INSERT INTO _smrt_ai_usage
      (id, provider, model, operation, prompt_tokens, completion_tokens,
       total_tokens, estimated_cost, duration, class_name, tenant_id, tags,
       created_at, prompt_key, tier_requested, tier_resolved, run_id, call_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    row.id,
    row.provider ?? 'openai',
    row.model ?? 'gpt-4o',
    row.operation ?? 'chat',
    row.tokens ?? 10,
    5,
    (row.tokens ?? 10) + 5,
    row.cost === undefined ? 0.01 : row.cost,
    row.duration ?? 100,
    'Doc',
    row.tenantId === undefined ? 't1' : row.tenantId,
    JSON.stringify(tags),
    row.createdAt ?? '2026-11-01T00:00:00.000Z',
    row.promptKey === undefined ? PROMPT : row.promptKey,
    row.tierRequested ?? null,
    row.tierResolved ?? null,
    row.runId ?? null,
    row.callId ?? null,
  );
}

async function transcript(
  callId: string,
  tenantId: string | null,
  createdAt = '2026-11-01T00:00:00.000Z',
): Promise<string> {
  const { id } = await recordAiTranscript(db, {
    callId,
    tenantId,
    promptKey: PROMPT,
    operation: 'chat',
    request: '{"messages":[]}',
    response: '{"messages":[]}',
    toolEvents: null,
    truncated: false,
    bytes: 30,
    createdAt: new Date(createdAt),
  });
  return id;
}

/** The fixture most tests share; see the expectations in the first test. */
async function seed(): Promise<Record<string, string>> {
  // Side A (hash h1), tenant t1.
  await usage({
    id: 'a1',
    hash: 'h1',
    duration: 100,
    cost: 0.01,
    callId: 'c1',
    runId: 'r1',
  });
  await usage({
    id: 'a2',
    hash: 'h1',
    duration: 200,
    cost: 0.02,
    callId: 'c2',
    substitutions: [{ from: 'x' }],
  });
  await usage({
    id: 'a3',
    hash: 'h1',
    duration: 300,
    cost: null,
    callId: 'c3',
  });
  await usage({
    id: 'a4',
    hash: 'h1',
    duration: 400,
    cost: 0.03,
    callId: 'c4',
    runId: 'r9',
  });
  await usage({
    id: 'a5',
    hash: 'h1',
    operation: 'blocked',
    cost: null,
    duration: 0,
  });
  // Side B (hash h2), tenant t1.
  await usage({
    id: 'b1',
    hash: 'h2',
    duration: 50,
    cost: 0.005,
    callId: 'c5',
  });
  await usage({
    id: 'b2',
    hash: 'h2',
    duration: 150,
    cost: 0.005,
    callId: 'c6',
  });
  // Same prompt, neither side: accounted for, not totalled.
  await usage({ id: 'u1', hash: 'h3' });
  await usage({ id: 'u2' });
  // Not this prompt: neither read nor counted.
  await usage({ id: 'o1', hash: 'h1', promptKey: 'other.prompt' });
  // External agent measurement of the prompt: excluded.
  await usage({
    id: 'external-agent:1',
    hash: 'h1',
    operation: 'external-agent',
  });

  await recordAiRun(db, {
    id: 'r1',
    fusionKey: 'f',
    mode: 'm',
    status: 'degraded',
    seats: 2,
    degradedSeats: 1,
    duration: 10,
    tenantId: 't1',
  });
  // r9 degraded in t2 only: t1's a4 (run r9) is not degraded.
  await recordAiRun(db, {
    id: 'r9',
    fusionKey: 'f',
    mode: 'm',
    status: 'failed',
    seats: 2,
    degradedSeats: 2,
    duration: 10,
    tenantId: 't2',
  });

  await recordAiUsageOutcome(db, {
    usageId: 'a1',
    label: 'accepted',
    score: 1,
    actor: 'r',
  });
  await recordAiUsageOutcome(db, {
    callId: 'c2',
    label: 'rejected',
    score: 0,
    actor: 'r',
    tenantId: 't1',
  });
  await recordAiUsageOutcome(db, {
    runId: 'r1',
    label: 'edited',
    score: 0.5,
    actor: 'r',
    tenantId: 't1',
  });
  await recordAiUsageOutcome(db, {
    callId: 'c5',
    label: 'accepted',
    score: 0.8,
    actor: 'r',
  });
  // Tenant t2 reuses call id c1 and run id r1 (after t1's run label, which
  // a run spanning tenants would refuse); its label, run and transcript
  // must never reach t1's numbers.
  await usage({
    id: 't2a',
    tenantId: 't2',
    hash: 'h1',
    duration: 9000,
    cost: 1,
    callId: 'c1',
    runId: 'r1',
  });
  await recordAiUsageOutcome(db, {
    usageId: 't2a',
    label: 'rejected',
    score: -5,
    actor: 'r',
  });

  return {
    c1: await transcript('c1', 't1', '2026-11-01T00:00:01.000Z'),
    c2: await transcript('c2', 't1', '2026-11-01T00:00:02.000Z'),
    c3: await transcript('c3', 't1', '2026-11-01T00:00:03.000Z'),
    c5: await transcript('c5', 't1'),
    t2c1: await transcript('c1', 't2'),
  };
}

describe('compareAiPromptRuns (#4782)', () => {
  it('totals each side and accounts for every row of the prompt', async () => {
    const ids = await seed();
    const result = await compareAiPromptRuns(db, {
      promptKey: PROMPT,
      a: { templateHash: 'h1' },
      b: { templateHash: 'h2' },
      tenantId: 't1',
    });

    expect(result).toMatchObject({
      promptKey: PROMPT,
      tenantId: 't1',
      crossTenant: false,
      rows: 9,
      unmatched: 2,
      inBoth: 0,
      excluded: { externalAgent: 1 },
    });
    expect(result.costBasis).toMatch(/uncosted/);

    const a = result.a;
    expect(a).toMatchObject({
      selector: { templateHash: 'h1' },
      calls: 4,
      blocked: 1,
      totalTokens: 60,
      costedCalls: 3,
      uncostedCalls: 1,
      latencyMs: { p50: 200, p90: 400, p95: 400, p99: 400 },
      fallbackCalls: 1,
      fallbackRate: 0.25,
      degradedCalls: 1,
      degradedRate: 0.25,
      labels: 3,
      scoredLabels: 3,
      callIds: 4,
      transcriptCount: 3,
    });
    expect(a.estimatedCost).toBeCloseTo(0.06);
    expect(a.meanCost).toBeCloseTo(0.02);
    expect(a.meanScore).toBeCloseTo(0.5);
    expect({ ...a.outcomes }).toEqual({ accepted: 1, rejected: 1, edited: 1 });
    // Worst-labelled first: c2 (0), c1 (worst 0.5 of 1 and the run's 0.5),
    // then the unlabelled c3.
    expect(a.transcripts.map((ref) => ref.id)).toEqual([
      ids.c2,
      ids.c1,
      ids.c3,
    ]);
    expect(a.transcripts[0]).toMatchObject({
      callId: 'c2',
      tenantId: 't1',
      labels: ['rejected'],
      worstScore: 0,
    });
    expect(a.transcripts[1]?.labels.sort()).toEqual(['accepted', 'edited']);
    expect(a.transcripts[2]).toMatchObject({ labels: [], worstScore: null });

    const b = result.b;
    expect(b).toMatchObject({
      calls: 2,
      blocked: 0,
      latencyMs: { p50: 50, p90: 150, p95: 150, p99: 150 },
      fallbackRate: 0,
      degradedRate: 0,
      labels: 1,
      transcriptCount: 1,
    });
    expect(b.estimatedCost).toBeCloseTo(0.01);
    expect(b.meanScore).toBeCloseTo(0.8);
    expect(b.transcripts.map((ref) => ref.id)).toEqual([ids.c5]);
  });

  it('reads only the given tenant; cross-tenant needs allowCrossTenant', async () => {
    const ids = await seed();
    const options = {
      promptKey: PROMPT,
      a: { templateHash: 'h1' },
      b: { templateHash: 'h2' },
    };
    await expect(compareAiPromptRuns(db, options)).rejects.toThrow(
      AiUsageScopeError,
    );
    await expect(
      compareAiPromptRuns(db, { ...options, allowCrossTenant: false }),
    ).rejects.toMatchObject({ code: 'AI_USAGE_TENANT_REQUIRED' });

    const t2 = await compareAiPromptRuns(db, { ...options, tenantId: 't2' });
    expect(t2).toMatchObject({ rows: 1, unmatched: 0 });
    // t2's c1 joins t2's run r1 (absent in t2: not degraded) and its own label.
    expect(t2.a).toMatchObject({
      calls: 1,
      degradedCalls: 0,
      labels: 1,
      meanScore: -5,
      latencyMs: { p50: 9000 },
    });
    expect(t2.a.transcripts.map((ref) => ref.id)).toEqual([ids.t2c1]);
    expect(t2.b.calls).toBe(0);

    const global = await compareAiPromptRuns(db, {
      ...options,
      tenantId: null,
    });
    expect(global).toMatchObject({ rows: 0, tenantId: null });

    const all = await compareAiPromptRuns(db, {
      ...options,
      allowCrossTenant: true,
    });
    expect(all.crossTenant).toBe(true);
    expect(all.tenantId).toBeUndefined();
    expect(all.rows).toBe(10);
    expect(all.a.calls).toBe(5);
    // Joins stay per tenant: t1's three labels plus t2's own one; c1 has a
    // transcript in each tenant, t2's run r1 does not exist.
    expect(all.a.labels).toBe(4);
    expect(all.a.degradedCalls).toBe(1);
    expect(all.a.transcriptCount).toBe(4);
    expect(all.a.transcripts[0]?.id).toBe(ids.t2c1);
  });

  it('caps transcript references and handles an empty side', async () => {
    await seed();
    const result = await compareAiPromptRuns(db, {
      promptKey: PROMPT,
      a: { templateHash: 'h1' },
      b: { templateHash: 'never-seen' },
      tenantId: 't1',
      transcriptLimit: 1,
    });
    expect(result.a.transcriptCount).toBe(3);
    expect(result.a.transcripts).toHaveLength(1);
    expect(result.b).toMatchObject({
      calls: 0,
      blocked: 0,
      estimatedCost: 0,
      meanCost: null,
      latencyMs: { p50: null, p90: null, p95: null, p99: null },
      fallbackRate: null,
      degradedRate: null,
      labels: 0,
      meanScore: null,
      callIds: 0,
      transcriptCount: 0,
      transcripts: [],
    });
    expect({ ...result.b.outcomes }).toEqual({});
    expect(result.unmatched).toBe(4);

    const empty = await compareAiPromptRuns(db, {
      promptKey: 'nothing.here',
      a: { model: 'gpt-4o' },
      b: { tier: 'good' },
      tenantId: 't1',
    });
    expect(empty).toMatchObject({ rows: 0, unmatched: 0, inBoth: 0 });
    expect(empty.a.calls).toBe(0);
  });

  it('matches model and tier selectors; overlapping rows count on both', async () => {
    await usage({
      id: 'm1',
      provider: 'openai',
      model: 'gpt-4o',
      tierResolved: 'good',
      tierRequested: 'auto',
    });
    await usage({
      id: 'm2',
      provider: 'anthropic',
      model: 'claude-x',
      tierResolved: 'great',
    });
    await usage({
      id: 'm3',
      provider: 'ollama',
      model: 'llama3:8b',
      tierRequested: 'cheap',
    });

    const byModel = await compareAiPromptRuns(db, {
      promptKey: PROMPT,
      a: { model: 'gpt-4o' },
      b: { model: 'ollama:llama3:8b' },
      tenantId: 't1',
    });
    expect([byModel.a.calls, byModel.b.calls, byModel.unmatched]).toEqual([
      1, 1, 1,
    ]);
    const bare = await compareAiPromptRuns(db, {
      promptKey: PROMPT,
      a: { model: 'anthropic:claude-x' },
      b: { model: 'llama3:8b' },
      tenantId: 't1',
    });
    expect([bare.a.calls, bare.b.calls]).toEqual([1, 1]);

    // tier: resolved tier, else the requested one.
    const byTier = await compareAiPromptRuns(db, {
      promptKey: PROMPT,
      a: { tier: 'good' },
      b: { tier: 'cheap' },
      tenantId: 't1',
    });
    expect([byTier.a.calls, byTier.b.calls, byTier.unmatched]).toEqual([
      1, 1, 1,
    ]);

    const overlap = await compareAiPromptRuns(db, {
      promptKey: PROMPT,
      a: { tier: 'good' },
      b: { model: 'openai:gpt-4o' },
      tenantId: 't1',
    });
    expect(overlap).toMatchObject({ rows: 3, inBoth: 1, unmatched: 2 });
    expect([overlap.a.calls, overlap.b.calls]).toEqual([1, 1]);
  });

  it('counts a call label once per side however many rows the call has', async () => {
    await usage({ id: 's1', hash: 'h1', callId: 'cx', runId: 'rx' });
    await usage({ id: 's2', hash: 'h1', callId: 'cx', runId: 'rx' });
    await recordAiUsageOutcome(db, {
      callId: 'cx',
      label: 'bad',
      score: 2,
      actor: 'r',
    });
    await recordAiUsageOutcome(db, {
      runId: 'rx',
      label: 'bad',
      score: 4,
      actor: 'r',
    });
    // A label naming a usage row and its run judges the row only.
    await recordAiUsageOutcome(db, {
      usageId: 's1',
      runId: 'rx',
      label: 'row',
      actor: 'r',
    });
    const result = await compareAiPromptRuns(db, {
      promptKey: PROMPT,
      a: { templateHash: 'h1' },
      b: { templateHash: 'h1' },
      tenantId: 't1',
    });
    expect(result.inBoth).toBe(2);
    for (const side of [result.a, result.b]) {
      expect(side.calls).toBe(2);
      expect(side.callIds).toBe(1);
      expect({ ...side.outcomes }).toEqual({ bad: 2, row: 1 });
      expect(side.scoredLabels).toBe(2);
      expect(side.meanScore).toBe(3);
    }
  });

  it('honours the window and validates its input', async () => {
    await usage({
      id: 'w1',
      hash: 'h1',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    await usage({
      id: 'w2',
      hash: 'h1',
      createdAt: '2026-11-05T00:00:00.000Z',
    });
    const result = await compareAiPromptRuns(db, {
      promptKey: PROMPT,
      a: { templateHash: 'h1' },
      b: { templateHash: 'h2' },
      tenantId: 't1',
      since: new Date('2026-11-01T00:00:00.000Z'),
      until: new Date('2026-11-30T00:00:00.000Z'),
    });
    expect(result.a.calls).toBe(1);
    expect(result.since?.toISOString()).toBe('2026-11-01T00:00:00.000Z');

    const base = { promptKey: PROMPT, tenantId: 't1' };
    await expect(
      compareAiPromptRuns(db, {
        ...base,
        a: { templateHash: 'h1', model: 'x' } as never,
        b: { tier: 'good' },
      }),
    ).rejects.toThrow(/exactly one/);
    await expect(
      compareAiPromptRuns(db, {
        ...base,
        a: { tier: ' ' },
        b: { tier: 'good' },
      }),
    ).rejects.toThrow(/a.tier/);
    await expect(
      compareAiPromptRuns(db, {
        ...base,
        promptKey: '',
        a: { tier: 'good' },
        b: { tier: 'good' },
      }),
    ).rejects.toThrow(/promptKey/);
    await expect(
      compareAiPromptRuns(db, {
        ...base,
        a: { tier: 'good' },
        b: { tier: 'good' },
        transcriptLimit: -1,
      }),
    ).rejects.toThrow(/transcriptLimit/);
  });

  it('reads labels and transcripts for more calls than one IN chunk', async () => {
    for (let index = 0; index < 520; index++) {
      const id = `k${String(index).padStart(4, '0')}`;
      await usage({ id, hash: 'h1', callId: `call-${id}`, duration: index });
    }
    await recordAiUsageOutcome(db, {
      callId: 'call-k0510',
      label: 'late',
      score: -1,
      actor: 'r',
    });
    await transcript('call-k0510', 't1');
    const result = await compareAiPromptRuns(db, {
      promptKey: PROMPT,
      a: { templateHash: 'h1' },
      b: { templateHash: 'h2' },
      tenantId: 't1',
    });
    expect(result.a.calls).toBe(520);
    expect({ ...result.a.outcomes }).toEqual({ late: 1 });
    expect(result.a.transcripts[0]?.callId).toBe('call-k0510');
    expect(result.a.latencyMs.p50).toBe(259);
  });
});

describe('listAiPromptTemplateHistory (#4782)', () => {
  it('lists hashes with first/last seen and counts, tenant-scoped', async () => {
    await usage({
      id: 'h-1',
      hash: 'old',
      layer: 'global',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    await usage({
      id: 'h-2',
      hash: 'old',
      layer: 'tenant',
      model: 'gpt-4o-mini',
      createdAt: '2026-10-03T00:00:00.000Z',
    });
    await usage({
      id: 'h-3',
      hash: 'new',
      createdAt: '2026-11-02T00:00:00.000Z',
    });
    await usage({
      id: 'h-4',
      hash: 'new',
      operation: 'blocked',
      createdAt: '2026-11-03T00:00:00.000Z',
    });
    await usage({ id: 'h-5', createdAt: '2026-10-15T00:00:00.000Z' });
    await usage({
      id: 'h-6',
      tenantId: 't2',
      hash: 'secret',
      createdAt: '2026-11-04T00:00:00.000Z',
    });
    await usage({ id: 'h-7', hash: 'elsewhere', promptKey: 'other.prompt' });

    await expect(
      listAiPromptTemplateHistory(db, { promptKey: PROMPT }),
    ).rejects.toThrow(AiUsageScopeError);

    const history = await listAiPromptTemplateHistory(db, {
      promptKey: PROMPT,
      tenantId: 't1',
    });
    expect(history.tenantId).toBe('t1');
    expect(history.hashes.map((entry) => entry.templateHash)).toEqual([
      'new',
      null,
      'old',
    ]);
    expect(history.hashes[0]).toMatchObject({ calls: 1, blocked: 1 });
    expect(history.hashes[0]?.firstSeen.toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    );
    expect(history.hashes[0]?.lastSeen.toISOString()).toBe(
      '2026-11-03T00:00:00.000Z',
    );
    expect(history.hashes[2]).toMatchObject({
      calls: 2,
      layers: ['global', 'tenant'],
      models: ['openai:gpt-4o', 'openai:gpt-4o-mini'],
    });

    const windowed = await listAiPromptTemplateHistory(db, {
      promptKey: PROMPT,
      tenantId: 't1',
      since: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(windowed.hashes.map((entry) => entry.templateHash)).toEqual(['new']);

    const all = await listAiPromptTemplateHistory(db, {
      promptKey: PROMPT,
      allowCrossTenant: true,
    });
    expect(all.crossTenant).toBe(true);
    expect(all.hashes.map((entry) => entry.templateHash)).toContain('secret');
  });
});
