import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import { TenantUsageMeter } from '../services/usage-meter.js';

const AI_USAGE_DDL = `
  CREATE TABLE IF NOT EXISTS _smrt_ai_usage (
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
    created_at TIMESTAMP NOT NULL
  )
`;

interface SeedRow {
  tenantId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  createdAt: string;
}

async function seedAiUsage(
  metrics: TenantUsageMetricCollection,
  rows: SeedRow[],
): Promise<void> {
  let counter = 0;
  for (const row of rows) {
    counter += 1;
    await metrics.db.query(
      `INSERT INTO _smrt_ai_usage
        (id, provider, model, operation, prompt_tokens, completion_tokens,
         total_tokens, estimated_cost, duration, class_name, tenant_id, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `usage-${counter}`,
      'openai',
      'gpt-test',
      'do',
      row.promptTokens,
      row.completionTokens,
      row.totalTokens,
      row.estimatedCost,
      0,
      'TestClass',
      row.tenantId,
      null,
      row.createdAt,
    );
  }
}

describe('TenantUsageMeter AI usage summaries', () => {
  let metrics: TenantUsageMetricCollection;

  beforeEach(async () => {
    metrics = await TenantUsageMetricCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    await metrics.db.query(AI_USAGE_DDL);
  });

  afterEach(async () => {
    await metrics.db.close?.();
  });

  it('sums persisted _smrt_ai_usage rows within the window for the tenant', async () => {
    await seedAiUsage(metrics, [
      {
        tenantId: 'tenant-1',
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        estimatedCost: 0.5,
        createdAt: '2026-06-10T12:00:00.000Z',
      },
      {
        tenantId: 'tenant-1',
        promptTokens: 60,
        completionTokens: 20,
        totalTokens: 80,
        estimatedCost: 0.25,
        createdAt: '2026-06-20T12:00:00.000Z',
      },
      // Outside the window — must be excluded.
      {
        tenantId: 'tenant-1',
        promptTokens: 999,
        completionTokens: 999,
        totalTokens: 999,
        estimatedCost: 9.99,
        createdAt: '2026-07-05T12:00:00.000Z',
      },
      // Different tenant — must be excluded.
      {
        tenantId: 'tenant-2',
        promptTokens: 500,
        completionTokens: 500,
        totalTokens: 500,
        estimatedCost: 5,
        createdAt: '2026-06-15T12:00:00.000Z',
      },
    ]);

    const meter = new TenantUsageMeter(metrics);
    const summary = await meter.summarizeAiUsage({
      tenantId: 'tenant-1',
      window: {
        start: new Date('2026-06-01T00:00:00.000Z'),
        end: new Date('2026-07-01T00:00:00.000Z'),
      },
    });

    expect(summary).toMatchObject({
      tenantId: 'tenant-1',
      promptTokens: 160,
      completionTokens: 60,
      totalTokens: 220,
      requestCount: 2,
    });
    expect(summary.estimatedCost).toBeCloseTo(0.75, 5);
  });

  it('maps ai.* metric keys onto the matching usage quantity', async () => {
    await seedAiUsage(metrics, [
      {
        tenantId: 'tenant-1',
        promptTokens: 30,
        completionTokens: 10,
        totalTokens: 40,
        estimatedCost: 0.2,
        createdAt: '2026-06-10T12:00:00.000Z',
      },
    ]);

    const meter = new TenantUsageMeter(metrics);
    const window = {
      start: new Date('2026-06-01T00:00:00.000Z'),
      end: new Date('2026-07-01T00:00:00.000Z'),
    };

    const totalTokens = await meter.summarize({
      tenantId: 'tenant-1',
      metricKey: 'ai.tokens.total',
      window,
    });
    expect(totalTokens.quantity).toBe(40);

    const requests = await meter.summarize({
      tenantId: 'tenant-1',
      metricKey: 'ai.requests',
      window,
    });
    expect(requests.quantity).toBe(1);
  });

  it('summarizes mixed AI and persisted metrics in one batch call', async () => {
    await seedAiUsage(metrics, [
      {
        tenantId: 'tenant-1',
        promptTokens: 30,
        completionTokens: 10,
        totalTokens: 40,
        estimatedCost: 0.2,
        createdAt: '2026-06-10T12:00:00.000Z',
      },
    ]);

    const meter = new TenantUsageMeter(metrics);
    const window = {
      start: new Date('2026-06-01T00:00:00.000Z'),
      end: new Date('2026-07-01T00:00:00.000Z'),
    };

    await meter.record({
      tenantId: 'tenant-1',
      metricKey: 'storage.bytes',
      quantity: 1024,
      windowStart: new Date('2026-06-12T00:00:00.000Z'),
      windowEnd: new Date('2026-06-12T01:00:00.000Z'),
    });
    await meter.record({
      tenantId: 'tenant-1',
      metricKey: 'storage.bytes',
      quantity: 2048,
      windowStart: new Date('2026-06-13T00:00:00.000Z'),
      windowEnd: new Date('2026-06-13T01:00:00.000Z'),
    });

    const summaries = await meter.summarizeBatch({
      tenantId: 'tenant-1',
      metricKeys: ['ai.tokens.total', 'ai.requests', 'storage.bytes'],
      window,
    });
    const quantityByMetric = new Map(
      summaries.map((summary) => [summary.metricKey, summary.quantity]),
    );

    expect(quantityByMetric.get('ai.tokens.total')).toBe(40);
    expect(quantityByMetric.get('ai.requests')).toBe(1);
    expect(quantityByMetric.get('storage.bytes')).toBe(3072);
  });

  it('returns zeroed totals when no usage matches', async () => {
    const meter = new TenantUsageMeter(metrics);
    const summary = await meter.summarizeAiUsage({
      tenantId: 'tenant-unknown',
      window: {
        start: new Date('2026-06-01T00:00:00.000Z'),
        end: new Date('2026-07-01T00:00:00.000Z'),
      },
    });

    expect(summary).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      requestCount: 0,
    });
  });
});
