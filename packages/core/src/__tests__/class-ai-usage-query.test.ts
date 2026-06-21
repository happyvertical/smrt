/**
 * Coverage tests for SmrtClass AI-usage query/reporting paths in class.ts:
 *   - listAiUsage: WHERE-clause builder (every filter branch), LIMIT/OFFSET,
 *     orderBy ASC/DESC, and row → record mapping (null/undefined coalescing,
 *     tag parsing, token hydration, timestamp normalization)
 *   - summarizeAiUsage: every `groupBy` bucket expression + stat aggregation
 *   - error paths when no database is configured
 *   - getAiUsageSnapshot / resetAiUsage / signalBus / destroy on a no-AI instance
 *
 * Uses a real in-memory SQLite database (SmrtClass.initialize() creates the
 * `_smrt_ai_usage` system table) and inserts rows directly, then drives the
 * public query methods. No mocking — these are pure SQL/data-shaping paths.
 *
 * @see src/class.ts (issue #1500 coverage, ORM group)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtClass } from '../class';

/** A row matching the `_smrt_ai_usage` schema (id TEXT PK, ...). */
interface UsageRow {
  id: string;
  provider: string;
  model: string;
  operation: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  duration: number;
  className: string | null;
  tenantId: string | null;
  tags: string | null;
  createdAt: string;
}

async function insertUsage(db: any, row: UsageRow): Promise<void> {
  await db.query(
    `INSERT INTO _smrt_ai_usage
       (id, provider, model, operation, prompt_tokens, completion_tokens,
        total_tokens, estimated_cost, duration, class_name, tenant_id, tags, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    row.id,
    row.provider,
    row.model,
    row.operation,
    row.promptTokens,
    row.completionTokens,
    row.totalTokens,
    row.estimatedCost,
    row.duration,
    row.className,
    row.tenantId,
    row.tags,
    row.createdAt,
  );
}

let instance: SmrtClass;
let db: any;

beforeEach(async () => {
  instance = new SmrtClass({ db: ':memory:' });
  // initialize() is protected on the bare base class (no public factory exists
  // for SmrtClass itself), so it stays cast; the db handle and AI-usage methods
  // below are read through their public API (db getter / public methods).
  await (instance as any).initialize();
  db = instance.db;

  // Seed a representative spread of rows.
  await insertUsage(db, {
    id: 'u1',
    provider: 'openai',
    model: 'gpt-4',
    operation: 'chat',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    estimatedCost: 0.01,
    duration: 1200,
    className: 'Widget',
    tenantId: 'tenant-a',
    tags: JSON.stringify({ env: 'prod', team: 'core' }),
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  await insertUsage(db, {
    id: 'u2',
    provider: 'anthropic',
    model: 'claude-3',
    operation: 'embed',
    promptTokens: null, // exercise null coalescing in hydration/mapping
    completionTokens: null,
    totalTokens: null,
    estimatedCost: null, // estimated_cost null → undefined in record
    duration: 800,
    className: null, // class_name null → undefined
    tenantId: null, // tenant_id null
    tags: 'not-valid-json{', // exercise parseAiUsageTags catch → undefined
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  await insertUsage(db, {
    id: 'u3',
    provider: 'openai',
    model: 'gpt-4',
    operation: 'chat',
    promptTokens: 200,
    completionTokens: 100,
    totalTokens: 300,
    estimatedCost: 0.02,
    duration: 1500,
    className: 'Widget',
    tenantId: 'tenant-b',
    tags: null, // tags null → undefined
    createdAt: '2026-01-03T00:00:00.000Z',
  });
});

afterEach(() => {
  instance?.destroy?.();
});

describe('SmrtClass.listAiUsage', () => {
  it('lists all rows newest-first by default and maps fields', async () => {
    const rows = await instance.listAiUsage();
    expect(rows).toHaveLength(3);
    // DESC by created_at → u3 first
    expect(rows[0].id).toBe('u3');
    expect(rows[2].id).toBe('u1');

    const u1 = rows.find((r: any) => r.id === 'u1');
    expect(u1.provider).toBe('openai');
    expect(u1.estimatedCost).toBe(0.01);
    expect(u1.className).toBe('Widget');
    expect(u1.tags).toEqual({ env: 'prod', team: 'core' });
    expect(u1.timestamp).toBeInstanceOf(Date);

    const u2 = rows.find((r: any) => r.id === 'u2');
    // null DB columns coalesce to undefined in the record
    expect(u2.estimatedCost).toBeUndefined();
    expect(u2.className).toBeUndefined();
    // invalid-JSON tags → undefined
    expect(u2.tags).toBeUndefined();
  });

  it('orders ascending when orderBy is "timestamp ASC"', async () => {
    const rows = await instance.listAiUsage({
      orderBy: 'timestamp ASC',
    });
    expect(rows[0].id).toBe('u1');
    expect(rows[2].id).toBe('u3');
  });

  it('applies LIMIT and OFFSET', async () => {
    const limited = await instance.listAiUsage({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].id).toBe('u3'); // newest

    const offset = await instance.listAiUsage({
      limit: 1,
      offset: 1,
    });
    expect(offset[0].id).toBe('u2');
  });

  it('filters by provider, model, and operation', async () => {
    const byProvider = await instance.listAiUsage({
      provider: 'openai',
    });
    expect(byProvider.map((r: any) => r.id).sort()).toEqual(['u1', 'u3']);

    const byModel = await instance.listAiUsage({ model: 'claude-3' });
    expect(byModel.map((r: any) => r.id)).toEqual(['u2']);

    const byOp = await instance.listAiUsage({ operation: 'embed' });
    expect(byOp.map((r: any) => r.id)).toEqual(['u2']);
  });

  it('filters by className and by date window (since/until)', async () => {
    const byClass = await instance.listAiUsage({
      className: 'Widget',
    });
    expect(byClass.map((r: any) => r.id).sort()).toEqual(['u1', 'u3']);

    const window = await instance.listAiUsage({
      since: new Date('2026-01-02T00:00:00.000Z'),
      until: new Date('2026-01-02T23:59:59.000Z'),
    });
    expect(window.map((r: any) => r.id)).toEqual(['u2']);
  });

  it('filters by tenantId value and by tenantId === null', async () => {
    const byTenant = await instance.listAiUsage({
      tenantId: 'tenant-a',
    });
    expect(byTenant.map((r: any) => r.id)).toEqual(['u1']);

    const nullTenant = await instance.listAiUsage({
      tenantId: null,
    });
    expect(nullTenant.map((r: any) => r.id)).toEqual(['u2']);
  });
});

describe('SmrtClass.summarizeAiUsage', () => {
  it('groups by model by default and aggregates stats', async () => {
    const summary = await instance.summarizeAiUsage();
    // model bucket = provider:model
    const gpt = summary['openai:gpt-4'];
    expect(gpt).toBeDefined();
    expect(gpt.callCount).toBe(2);
    expect(gpt.promptTokens).toBe(300); // 100 + 200
    expect(gpt.totalTokens).toBe(450);
    expect(gpt.estimatedCost).toBeCloseTo(0.03, 5);
    expect(gpt.lastUsed).toBeGreaterThan(0);
  });

  it('groups by provider', async () => {
    const summary = await instance.summarizeAiUsage({
      groupBy: 'provider',
    });
    expect(summary.openai.callCount).toBe(2);
    expect(summary.anthropic.callCount).toBe(1);
  });

  it('groups by operation', async () => {
    const summary = await instance.summarizeAiUsage({
      groupBy: 'operation',
    });
    expect(summary.chat.callCount).toBe(2);
    expect(summary.embed.callCount).toBe(1);
  });

  it('groups by class, bucketing nulls as "unknown"', async () => {
    const summary = await instance.summarizeAiUsage({
      groupBy: 'class',
    });
    expect(summary.Widget.callCount).toBe(2);
    expect(summary.unknown.callCount).toBe(1); // u2 has null class_name
  });

  it('groups by tenant, bucketing nulls as "global"', async () => {
    const summary = await instance.summarizeAiUsage({
      groupBy: 'tenant',
    });
    expect(summary['tenant-a'].callCount).toBe(1);
    expect(summary['tenant-b'].callCount).toBe(1);
    expect(summary.global.callCount).toBe(1); // u2 null tenant
  });

  it('groups by day (date bucket via created_at prefix)', async () => {
    const summary = await instance.summarizeAiUsage({
      groupBy: 'day',
    });
    // three distinct dates → three buckets
    expect(Object.keys(summary)).toHaveLength(3);
    expect(summary['2026-01-01'].callCount).toBe(1);
  });

  it('honors filter options alongside grouping', async () => {
    const summary = await instance.summarizeAiUsage({
      groupBy: 'provider',
      provider: 'openai',
    });
    expect(Object.keys(summary)).toEqual(['openai']);
    expect(summary.openai.callCount).toBe(2);
  });
});

describe('SmrtClass AI-usage without a database', () => {
  it('listAiUsage throws a clear error when no db is configured', async () => {
    const noDb = new SmrtClass({});
    await (noDb as any).initialize();
    await expect(noDb.listAiUsage()).rejects.toThrow(
      /AI usage requires a database configuration/,
    );
  });

  it('summarizeAiUsage throws a clear error when no db is configured', async () => {
    const noDb = new SmrtClass({});
    await (noDb as any).initialize();
    await expect(noDb.summarizeAiUsage()).rejects.toThrow(
      /AI usage requires a database configuration/,
    );
  });
});

describe('SmrtClass misc accessors', () => {
  it('getAiUsageSnapshot returns undefined when no collector is active', () => {
    const base = new SmrtClass({});
    expect(base.getAiUsageSnapshot()).toBeUndefined();
  });

  it('resetAiUsage is a no-op (does not throw) with no collector', () => {
    const base = new SmrtClass({});
    expect(() => base.resetAiUsage()).not.toThrow();
  });

  it('signalBus is undefined when signals are not enabled', () => {
    const base = new SmrtClass({});
    expect(base.signalBus).toBeUndefined();
  });

  it('destroy is safe to call when nothing was registered', () => {
    const base = new SmrtClass({});
    expect(() => base.destroy()).not.toThrow();
  });
});
