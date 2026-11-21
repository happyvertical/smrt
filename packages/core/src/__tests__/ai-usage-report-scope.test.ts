/**
 * `reportAiUsage()` and `reportAiRuns()` read only what they report: the
 * tenant filter is a predicate of every query (other tenants' rows are never
 * read or counted), and a usage report without `since` covers the last 30
 * days. Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { insertAiUsageRow } from '../adapters/ai-usage';
import {
  openAiRun,
  recordAiEvaluation,
  reportAiRuns,
  reportAiUsage,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  usageEvent,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const DAY = 86_400_000;

async function usage(
  db: DatabaseInterface,
  id: string,
  tenantId: string | null,
  at: Date,
  tags: Record<string, string> = {},
): Promise<void> {
  await insertAiUsageRow(
    db,
    {
      ...usageEvent(10, 0.01, { promptKey: 'scope.prompt', ...tags }),
      tenantId,
      timestamp: at,
    },
    { id },
  );
}

/** Every SQL text and parameter list the database is asked to run. */
function recordQueries(db: DatabaseInterface): {
  queries: Array<{ sql: string; params: unknown[] }>;
  stop(): void;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const original = db.query.bind(db);
  (db as { query: unknown }).query = (sql: string, ...params: unknown[]) => {
    queries.push({ sql, params });
    return original(sql, ...params);
  };
  return {
    queries,
    stop: () => {
      (db as { query: unknown }).query = original;
    },
  };
}

describe.each(aiRunTestEngines)('usage report scope on %s', (engine) => {
  it('totals one tenant from that tenant rows only, with no count of the others', async () => {
    const db = await newAiRunTestDatabase(engine);
    const now = new Date();
    await usage(db, 'scope-own-1', 'tenant-one', now);
    await usage(db, 'scope-own-2', 'tenant-one', now);
    await usage(db, 'scope-other-1', 'tenant-two', now);
    await usage(db, 'scope-other-2', 'tenant-two', now);
    await usage(db, 'scope-global', null, now);
    await recordAiEvaluation(db, {
      callId: 'scope-own-1',
      label: 'accepted',
      evaluator: 'human',
    });
    await recordAiEvaluation(db, {
      callId: 'scope-other-1',
      label: 'rejected',
      evaluator: 'human',
    });

    const recorder = recordQueries(db);
    const report = await reportAiUsage(db, {
      by: ['prompt'],
      tenantId: 'tenant-one',
      transcripts: true,
    });
    recorder.stop();

    expect(report.totals.calls).toBe(2);
    expect(report.totals.evaluations).toEqual({ accepted: 1 });
    expect(report.excluded).toEqual({ otherTenants: 0, externalAgent: 0 });
    // Every query that reads usage, evaluations or transcripts carries the
    // tenant as a predicate.
    const reads = recorder.queries.filter((query) =>
      /FROM _smrt_ai_(usage|evaluations|transcripts)/.test(query.sql),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const query of reads) {
      expect(query.sql).toMatch(/tenant_id = \$\d+/);
      expect(query.params).toContain('tenant-one');
    }

    // The global scope reads global rows only.
    const global = await reportAiUsage(db, { tenantId: null });
    expect(global.totals.calls).toBe(1);
    expect(global.excluded.otherTenants).toBe(0);

    // Without a tenant (an operator report) every tenant is totalled.
    const all = await reportAiUsage(db, {
      allowCrossTenant: true,
      by: ['tenant'],
    });
    expect(all.totals.calls).toBe(5);
    expect(all.totals.evaluations).toEqual({ accepted: 1, rejected: 1 });
  });

  it('counts a run label once per tenant even when another tenant reuses the run id', async () => {
    const db = await newAiRunTestDatabase(engine);
    const now = new Date();
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    await usage(db, 'scope-run-1', 'tenant-one', now, { runId: run.id });
    await usage(db, 'scope-run-2', 'tenant-one', now, { runId: run.id });
    await usage(db, 'scope-run-3', 'tenant-two', now, { runId: run.id });
    await recordAiEvaluation(db, {
      runId: run.id,
      label: 'accepted',
      evaluator: 'human',
    });
    const one = await reportAiUsage(db, { tenantId: 'tenant-one' });
    expect(one.totals.calls).toBe(2);
    expect(one.totals.evaluations).toEqual({ accepted: 1 });
    const two = await reportAiUsage(db, { tenantId: 'tenant-two' });
    expect(two.totals.calls).toBe(1);
    expect(two.totals.evaluations).toEqual({});
  });

  it('classifies an external-agent id prefix the same way with and without a tenant filter', async () => {
    const db = await newAiRunTestDatabase(engine);
    const now = new Date();
    await usage(db, 'external-agent:canonical', 'tenant-one', now);
    await usage(db, 'EXTERNAL-AGENT:mixed', 'tenant-one', now);
    await db.query(
      "UPDATE _smrt_ai_usage SET operation = 'external-agent' WHERE id IN ('external-agent:canonical', 'EXTERNAL-AGENT:mixed')",
    );
    const all = await reportAiUsage(db, { allowCrossTenant: true });
    const one = await reportAiUsage(db, { tenantId: 'tenant-one' });
    expect(all.totals.calls).toBe(1);
    expect(all.excluded.externalAgent).toBe(1);
    expect(one.totals.calls).toBe(all.totals.calls);
    expect(one.excluded.externalAgent).toBe(all.excluded.externalAgent);
  });

  it('covers the last 30 days without since, and the whole history when asked', async () => {
    const db = await newAiRunTestDatabase(engine);
    const now = new Date();
    await usage(
      db,
      'scope-recent',
      'tenant-one',
      new Date(now.getTime() - DAY),
    );
    await usage(
      db,
      'scope-old',
      'tenant-one',
      new Date(now.getTime() - 45 * DAY),
    );

    const report = await reportAiUsage(db, { tenantId: 'tenant-one' });
    expect(report.totals.calls).toBe(1);
    expect(report.since).toBeInstanceOf(Date);
    const start = (report.since as Date).getTime();
    expect(start).toBeGreaterThan(now.getTime() - 30 * DAY - 60_000);
    expect(start).toBeLessThanOrEqual(Date.now() - 30 * DAY + 60_000);

    // The default window ends at `until` when one is given.
    const until = new Date(now.getTime() - 40 * DAY);
    const earlier = await reportAiUsage(db, { tenantId: 'tenant-one', until });
    expect(earlier.totals.calls).toBe(1);
    expect(earlier.since?.getTime()).toBe(until.getTime() - 30 * DAY);

    const whole = await reportAiUsage(db, {
      tenantId: 'tenant-one',
      since: new Date(0),
    });
    expect(whole.totals.calls).toBe(2);
    expect(whole.since?.getTime()).toBe(0);
  });

  it('reads one tenant runs only in the run report', async () => {
    const db = await newAiRunTestDatabase(engine);
    for (const tenantId of ['tenant-one', 'tenant-two', 'tenant-two', null]) {
      await openAiRun({ db, usageTracking: true, tenantId }, { type: 'turn' });
    }
    const recorder = recordQueries(db);
    const one = await reportAiRuns(db, { tenantId: 'tenant-one' });
    recorder.stop();
    expect(one.totals.runs).toBe(1);
    expect(one.excluded).toEqual({ otherTenants: 0 });
    const runReads = recorder.queries.filter((query) =>
      /FROM _smrt_ai_runs/.test(query.sql),
    );
    expect(runReads.length).toBeGreaterThan(0);
    for (const query of runReads) {
      expect(query.sql).toMatch(/tenant_id = \$\d+/);
    }
    expect((await reportAiRuns(db, { tenantId: null })).totals.runs).toBe(1);
    expect(
      (await reportAiRuns(db, { allowCrossTenant: true })).totals.runs,
    ).toBe(4);
  });
});
