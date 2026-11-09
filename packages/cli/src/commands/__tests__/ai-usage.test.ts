/**
 * Tests for `smrt ai:usage` (#4751): flag parsing and the rendered report.
 * The aggregation itself is core's `reportAiUsage()`, exercised here against
 * a real in-memory SQLite database so the rendering sees a real report.
 */

import {
  AiUsagePersistenceHandler,
  ensureSystemTables,
  recordAiRun,
  recordAiUsageOutcome,
  reportAiRuns,
  reportAiUsage,
} from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aiUsageCommand,
  formatAiRunReport,
  formatAiUsageReport,
  parseUsageDimensions,
  parseUsageTime,
} from '../ai-usage.js';

describe('parseUsageDimensions', () => {
  it('defaults to prompt and accepts comma-separated dimensions', () => {
    expect(parseUsageDimensions(undefined)).toEqual(['prompt']);
    expect(parseUsageDimensions('prompt, Model,tier,prompt')).toEqual([
      'prompt',
      'model',
      'tier',
    ]);
    expect(parseUsageDimensions('class,tenant,fusion,source')).toEqual([
      'class',
      'tenant',
      'fusion',
      'source',
    ]);
  });

  it('refuses unknown dimensions by name', () => {
    expect(() => parseUsageDimensions('prompt,provider')).toThrow(
      /Unknown --by dimension: provider/,
    );
  });
});

describe('parseUsageTime', () => {
  const now = new Date('2026-11-07T12:00:00.000Z');

  it('reads relative windows back from now', () => {
    expect(parseUsageTime('24h', '--since', now)?.toISOString()).toBe(
      '2026-11-06T12:00:00.000Z',
    );
    expect(parseUsageTime('7d', '--since', now)?.toISOString()).toBe(
      '2026-10-31T12:00:00.000Z',
    );
    expect(parseUsageTime('30m', '--since', now)?.toISOString()).toBe(
      '2026-11-07T11:30:00.000Z',
    );
    expect(parseUsageTime('2w', '--since', now)?.toISOString()).toBe(
      '2026-10-24T12:00:00.000Z',
    );
  });

  it('reads ISO dates, passes through empty, refuses garbage', () => {
    expect(parseUsageTime('2026-11-01', '--since')?.toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(parseUsageTime(undefined, '--since')).toBeUndefined();
    expect(() => parseUsageTime('yesterday-ish', '--until')).toThrow(
      /Invalid --until/,
    );
  });
});

describe('formatAiUsageReport', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await ensureSystemTables(db, 'sqlite');
    const handler = new AiUsagePersistenceHandler(db);
    const base = {
      provider: 'openai',
      model: 'gpt-4o',
      operation: 'chat',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      timestamp: new Date(),
      tenantId: 'tenant-a',
    };
    await handler.handle({
      ...base,
      duration: 120,
      estimatedCost: 0.002,
      tags: { promptKey: 'content.summarize', runId: 'run-1' },
    });
    await handler.handle({ ...base, duration: 80 });
    await handler.handle({
      ...base,
      tenantId: 'tenant-b',
      duration: 10,
      tags: { promptKey: 'content.summarize' },
    });
    await recordAiUsageOutcome(db, {
      runId: 'run-1',
      label: 'accepted',
      actor: 'test',
    });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('prints unattributed rows, uncosted counts, exclusions and the cost basis', async () => {
    const report = await reportAiUsage(db, {
      by: ['prompt'],
      tenantId: 'tenant-a',
    });
    const text = formatAiUsageReport(report);

    expect(text).toContain('content.summarize');
    expect(text).toContain('(unattributed)');
    expect(text).toContain('accepted=1');
    expect(text).toContain('(+1 uncosted)');
    expect(text).toContain('Unattributed (no prompt key): 1 call(s)');
    expect(text).toContain('Excluded from totals: 1 of other tenants');
    expect(text).toContain(
      'Cost basis: estimated_cost as recorded at call time',
    );
    expect(text).toMatch(/total\s+2\s+0\s+300/);
  });

  it('counts hosted-gate blocks beside calls, by tier (#4760)', async () => {
    const handler = new AiUsagePersistenceHandler(db);
    await handler.handle({
      provider: 'openai',
      model: 'hosted-model',
      operation: 'blocked',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      duration: 0,
      timestamp: new Date(),
      tenantId: 'tenant-a',
      estimatedCost: 0,
      tags: {
        tierRequested: 'good',
        tierResolved: 'good',
        source: 'hosted',
        reason: 'entitlement',
        policy: 'user-cap',
        cap: '1000000',
        spend: '1200000',
      },
    });
    const report = await reportAiUsage(db, { by: ['tier'] });
    const text = formatAiUsageReport(report);
    expect(text).toMatch(/calls\s+blocked/);
    expect(text).toMatch(/good\s+0\s+1\s+0/);
    expect(text).toMatch(/total\s+3\s+1\s+450/);
  });

  it('says so when the window is empty', async () => {
    const report = await reportAiUsage(db, {
      since: new Date('2999-01-01T00:00:00Z'),
    });
    expect(formatAiUsageReport(report)).toContain(
      '(no AI usage recorded in this window)',
    );
  });
});

describe('formatAiRunReport (--by fusion, #4753)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await ensureSystemTables(db, 'sqlite');
    const base = { mode: 'pair', seats: 3, duration: 100 };
    await recordAiRun(db, {
      ...base,
      id: 'r1',
      fusionKey: 'review-pair',
      status: 'ok',
      degradedSeats: 0,
      tenantId: 'tenant-a',
    });
    await recordAiRun(db, {
      ...base,
      id: 'r2',
      fusionKey: 'review-pair',
      status: 'degraded',
      degradedSeats: 1,
      tenantId: 'tenant-a',
    });
    await recordAiRun(db, {
      ...base,
      id: 'r3',
      fusionKey: 'review-pair',
      status: 'failed',
      degradedSeats: 3,
      tenantId: 'tenant-b',
    });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('totals runs per fusion with outcome counts and exclusions', async () => {
    const text = formatAiRunReport(
      await reportAiRuns(db, { tenantId: 'tenant-a' }),
    );
    expect(text).toMatch(/review-pair\s+2\s+1\s+1\s+0\s+6\s+1\s+100ms/);
    expect(text).toMatch(/total\s+2\s+1\s+1\s+0/);
    expect(text).toContain('Excluded from totals: 1 run(s) of other tenants');
  });

  it('says so when no run was recorded', async () => {
    const text = formatAiRunReport(
      await reportAiRuns(db, { since: new Date('2999-01-01T00:00:00Z') }),
    );
    expect(text).toContain('(no fusion runs recorded in this window)');
  });
});

describe('aiUsageCommand', () => {
  it('declares its flags', () => {
    expect(aiUsageCommand.name).toBe('ai:usage');
    expect(Object.keys(aiUsageCommand.options ?? {})).toEqual([
      'by',
      'since',
      'until',
      'tenant',
      'with-transcripts',
      'all-tenants',
      'prompt',
      'actor',
      'json',
    ]);
  });
});
