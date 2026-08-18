/**
 * Tests for system-table retention (issue #2375, assessment finding F2).
 *
 * Covers the three halves the framework was missing:
 *   1. `pruneAiUsage()` — the retention API `_smrt_ai_usage` never had, by age,
 *      by row count, and scoped to one tenant (including the global rows).
 *   2. `pruneExpiredContexts()` — enforcement for `_smrt_contexts.expires_at`,
 *      which `remember()` stored and nothing ever acted on.
 *   3. `runRetentionSweep()` — the opt-out sweep that drives every
 *      framework-owned table plus registered tasks, its dry-run preview, its
 *      per-task opt-outs, and its "one failing task never aborts the rest"
 *      contract.
 *
 * Plus the predicate indexes: a prune that ships without its index is the gap
 * this issue is about, so bootstrap is asserted to create them.
 *
 * Runs against real in-memory SQLite — `SmrtClass.initialize()` creates the
 * system tables exactly as production bootstrap does. No mocking.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneChangeFeed } from '../change-feed';
import { SmrtClass } from '../class';
import {
  clearRetentionTasks,
  DEFAULT_RETENTION_POLICY,
  getRetentionTasks,
  pruneAiUsage,
  pruneExpiredContexts,
  registerRetentionTask,
  runRetentionSweep,
  unregisterRetentionTask,
} from '../system/retention';

let instance: SmrtClass;
let db: DatabaseInterface;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function inDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

async function insertUsage(options: {
  id: string;
  createdAt: string;
  tenantId?: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO _smrt_ai_usage
       (id, provider, model, operation, prompt_tokens, completion_tokens,
        total_tokens, estimated_cost, duration, class_name, tenant_id, tags, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    options.id,
    'openai',
    'gpt-4',
    'chat',
    10,
    5,
    15,
    0.01,
    120,
    'Widget',
    options.tenantId ?? null,
    null,
    options.createdAt,
  );
}

async function insertContext(options: {
  id: string;
  key: string;
  expiresAt: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO _smrt_contexts
       (id, owner_class, owner_id, scope, key, value, version, confidence, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    options.id,
    'Widget',
    'owner-1',
    'scope',
    options.key,
    JSON.stringify({ ok: true }),
    1,
    1.0,
    options.expiresAt,
  );
}

async function insertChange(seq: number, createdAt: string): Promise<void> {
  await db.query(
    `INSERT INTO _smrt_changes (seq, table_name, row_id, operation, tenant_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    seq,
    'widgets',
    `row-${seq}`,
    'update',
    null,
    createdAt,
  );
}

async function insertDispatch(options: {
  id: string;
  status: string;
  processedAt: string | null;
  updatedAt: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO _smrt_dispatch
       (id, type, source, status, attempts, processed_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    options.id,
    'widget.changed',
    'tests',
    options.status,
    0,
    options.processedAt,
    options.updatedAt,
    options.updatedAt,
  );
}

async function countRows(table: string): Promise<number> {
  const result = await db.query(`SELECT COUNT(*) AS total FROM ${table}`);
  return Number(result.rows[0]?.total ?? 0);
}

async function idsIn(table: string): Promise<string[]> {
  const result = await db.query(`SELECT id FROM ${table} ORDER BY id ASC`);
  return result.rows.map((row) => String(row.id));
}

beforeEach(async () => {
  clearRetentionTasks();
  instance = new SmrtClass({ db: ':memory:' });
  // initialize() is protected on the bare base class — no public factory
  // exists for SmrtClass itself — so it stays cast. Everything else below
  // goes through public APIs.
  await (instance as unknown as { initialize(): Promise<void> }).initialize();
  db = instance.db as DatabaseInterface;
});

afterEach(async () => {
  clearRetentionTasks();
  instance?.destroy();
});

describe('pruneAiUsage (#2375)', () => {
  it('deletes records older than maxAgeMs and keeps newer ones', async () => {
    await insertUsage({ id: 'old', createdAt: daysAgo(120) });
    await insertUsage({ id: 'recent', createdAt: daysAgo(3) });

    const { pruned } = await pruneAiUsage(db, { maxAgeMs: 90 * DAY_MS });

    expect(pruned).toBe(1);
    expect(await idsIn('_smrt_ai_usage')).toEqual(['recent']);
  });

  it('keeps only the newest maxRows records', async () => {
    await insertUsage({ id: 'a-oldest', createdAt: daysAgo(5) });
    await insertUsage({ id: 'b-middle', createdAt: daysAgo(3) });
    await insertUsage({ id: 'c-newest', createdAt: daysAgo(1) });

    const { pruned } = await pruneAiUsage(db, { maxRows: 2 });

    expect(pruned).toBe(1);
    expect(await idsIn('_smrt_ai_usage')).toEqual(['b-middle', 'c-newest']);
  });

  it('empties the table when maxRows is 0', async () => {
    await insertUsage({ id: 'a', createdAt: daysAgo(1) });
    await insertUsage({ id: 'b', createdAt: daysAgo(2) });

    const { pruned } = await pruneAiUsage(db, { maxRows: 0 });

    expect(pruned).toBe(2);
    expect(await countRows('_smrt_ai_usage')).toBe(0);
  });

  it('scopes the prune to one tenant and leaves other tenants intact', async () => {
    await insertUsage({ id: 'a-old', createdAt: daysAgo(120), tenantId: 'a' });
    await insertUsage({ id: 'b-old', createdAt: daysAgo(120), tenantId: 'b' });
    await insertUsage({ id: 'g-old', createdAt: daysAgo(120), tenantId: null });

    const { pruned } = await pruneAiUsage(db, {
      maxAgeMs: 30 * DAY_MS,
      tenantId: 'a',
    });

    expect(pruned).toBe(1);
    expect(await idsIn('_smrt_ai_usage')).toEqual(['b-old', 'g-old']);
  });

  it('treats a null tenantId as the global (tenant-less) records', async () => {
    await insertUsage({ id: 'a-old', createdAt: daysAgo(120), tenantId: 'a' });
    await insertUsage({ id: 'g-old', createdAt: daysAgo(120), tenantId: null });

    const { pruned } = await pruneAiUsage(db, {
      maxAgeMs: 30 * DAY_MS,
      tenantId: null,
    });

    expect(pruned).toBe(1);
    expect(await idsIn('_smrt_ai_usage')).toEqual(['a-old']);
  });

  it('counts without deleting under dryRun', async () => {
    await insertUsage({ id: 'old', createdAt: daysAgo(120) });
    await insertUsage({ id: 'recent', createdAt: daysAgo(1) });

    const { pruned } = await pruneAiUsage(db, {
      maxAgeMs: 90 * DAY_MS,
      dryRun: true,
    });

    expect(pruned).toBe(1);
    expect(await countRows('_smrt_ai_usage')).toBe(2);
  });

  it('does not double-count records selected by both bounds under dryRun', async () => {
    await insertUsage({ id: 'a-ancient', createdAt: daysAgo(200) });
    await insertUsage({ id: 'b-ancient', createdAt: daysAgo(150) });
    await insertUsage({ id: 'c-recent', createdAt: daysAgo(2) });
    await insertUsage({ id: 'd-recent', createdAt: daysAgo(1) });

    // maxAgeMs selects the two ancient rows; maxRows=1 additionally selects
    // 'c-recent'. The union is three, not the four a naive sum would report.
    const preview = await pruneAiUsage(db, {
      maxAgeMs: 90 * DAY_MS,
      maxRows: 1,
      dryRun: true,
    });
    expect(preview.pruned).toBe(3);
    expect(await countRows('_smrt_ai_usage')).toBe(4);

    const applied = await pruneAiUsage(db, {
      maxAgeMs: 90 * DAY_MS,
      maxRows: 1,
    });
    expect(applied.pruned).toBe(3);
    expect(await idsIn('_smrt_ai_usage')).toEqual(['d-recent']);
  });

  it('rejects a call with no bounds and negative bounds', async () => {
    await expect(pruneAiUsage(db, {})).rejects.toThrow(
      /requires maxAgeMs and\/or maxRows/,
    );
    await expect(pruneAiUsage(db, { maxAgeMs: -1 })).rejects.toThrow(
      /maxAgeMs must be >= 0/,
    );
    await expect(pruneAiUsage(db, { maxRows: -1 })).rejects.toThrow(
      /maxRows must be >= 0/,
    );
  });
});

describe('pruneExpiredContexts (#2375)', () => {
  it('deletes expired entries and keeps unexpired and never-expiring ones', async () => {
    await insertContext({ id: 'c1', key: 'expired', expiresAt: daysAgo(1) });
    await insertContext({ id: 'c2', key: 'future', expiresAt: inDays(1) });
    await insertContext({ id: 'c3', key: 'forever', expiresAt: null });

    const { pruned } = await pruneExpiredContexts(db);

    expect(pruned).toBe(1);
    expect(await idsIn('_smrt_contexts')).toEqual(['c2', 'c3']);
  });

  it('honours an injected clock', async () => {
    await insertContext({ id: 'c1', key: 'soon', expiresAt: inDays(1) });

    const { pruned } = await pruneExpiredContexts(db, {
      now: new Date(Date.now() + 2 * DAY_MS),
    });

    expect(pruned).toBe(1);
    expect(await countRows('_smrt_contexts')).toBe(0);
  });

  it('counts without deleting under dryRun', async () => {
    await insertContext({ id: 'c1', key: 'expired', expiresAt: daysAgo(1) });

    const { pruned } = await pruneExpiredContexts(db, { dryRun: true });

    expect(pruned).toBe(1);
    expect(await countRows('_smrt_contexts')).toBe(1);
  });
});

describe('pruneChangeFeed dryRun (#2375)', () => {
  it('reports the same count it would delete, without deleting', async () => {
    await insertChange(1, daysAgo(90));
    await insertChange(2, daysAgo(60));
    await insertChange(3, daysAgo(1));

    const preview = await pruneChangeFeed(db, {
      maxAgeMs: 30 * DAY_MS,
      dryRun: true,
    });
    expect(preview.pruned).toBe(2);
    expect(await countRows('_smrt_changes')).toBe(3);

    const applied = await pruneChangeFeed(db, { maxAgeMs: 30 * DAY_MS });
    expect(applied.pruned).toBe(2);
    expect(await countRows('_smrt_changes')).toBe(1);
  });

  it('does not double-count entries selected by both bounds', async () => {
    await insertChange(1, daysAgo(90));
    await insertChange(2, daysAgo(90));
    await insertChange(3, daysAgo(1));

    // maxRows selects seq 1; maxAgeMs selects seq 1 and 2. The union is two.
    const preview = await pruneChangeFeed(db, {
      maxRows: 2,
      maxAgeMs: 30 * DAY_MS,
      dryRun: true,
    });

    expect(preview.pruned).toBe(2);
    expect(await countRows('_smrt_changes')).toBe(3);
  });
});

describe('runRetentionSweep (#2375)', () => {
  it('prunes every framework-owned table with the documented defaults', async () => {
    await insertChange(1, daysAgo(90));
    await insertChange(2, daysAgo(1));
    await insertUsage({ id: 'usage-old', createdAt: daysAgo(120) });
    await insertUsage({ id: 'usage-new', createdAt: daysAgo(1) });
    await insertContext({ id: 'ctx-old', key: 'k1', expiresAt: daysAgo(1) });
    await insertContext({ id: 'ctx-live', key: 'k2', expiresAt: null });
    await insertDispatch({
      id: 'd-old',
      status: 'completed',
      processedAt: daysAgo(60),
      updatedAt: daysAgo(60),
    });
    await insertDispatch({
      id: 'd-new',
      status: 'completed',
      processedAt: daysAgo(1),
      updatedAt: daysAgo(1),
    });

    const result = await runRetentionSweep(db);

    expect(result.failed).toBe(false);
    expect(result.pruned).toBe(4);
    expect(result.tasks.map((task) => task.task)).toEqual([
      'changes',
      'ai-usage',
      'contexts',
      'dispatch',
    ]);
    expect(await countRows('_smrt_changes')).toBe(1);
    expect(await countRows('_smrt_ai_usage')).toBe(1);
    expect(await countRows('_smrt_contexts')).toBe(1);
    expect(await countRows('_smrt_dispatch')).toBe(1);
  });

  it('breaks the dispatch count down by bucket', async () => {
    await insertDispatch({
      id: 'd-completed',
      status: 'completed',
      processedAt: daysAgo(60),
      updatedAt: daysAgo(60),
    });
    await insertDispatch({
      id: 'd-failed',
      status: 'failed',
      processedAt: null,
      updatedAt: daysAgo(120),
    });

    const result = await runRetentionSweep(db);
    const dispatch = result.tasks.find((task) => task.task === 'dispatch');

    expect(dispatch?.details).toEqual({ completed: 1, failed: 1 });
    expect(dispatch?.pruned).toBe(2);
    expect(await countRows('_smrt_dispatch')).toBe(0);
  });

  it('previews dispatch cleanup without deleting', async () => {
    await insertDispatch({
      id: 'd-completed',
      status: 'completed',
      processedAt: daysAgo(60),
      updatedAt: daysAgo(60),
    });

    const result = await runRetentionSweep(db, { dryRun: true });
    const dispatch = result.tasks.find((task) => task.task === 'dispatch');

    expect(dispatch?.details).toEqual({ completed: 1, failed: 0 });
    expect(await countRows('_smrt_dispatch')).toBe(1);
  });

  it('deletes nothing under dryRun but reports what it would delete', async () => {
    await insertUsage({ id: 'usage-old', createdAt: daysAgo(120) });
    await insertContext({ id: 'ctx-old', key: 'k1', expiresAt: daysAgo(1) });

    const result = await runRetentionSweep(db, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.pruned).toBe(2);
    expect(await countRows('_smrt_ai_usage')).toBe(1);
    expect(await countRows('_smrt_contexts')).toBe(1);
  });

  it('opts a single table out with `false` and reports it as disabled', async () => {
    await insertUsage({ id: 'usage-old', createdAt: daysAgo(120) });
    await insertContext({ id: 'ctx-old', key: 'k1', expiresAt: daysAgo(1) });

    const result = await runRetentionSweep(db, { aiUsage: false });

    expect(result.tasks.find((task) => task.task === 'ai-usage')?.skipped).toBe(
      'disabled',
    );
    expect(await countRows('_smrt_ai_usage')).toBe(1);
    expect(await countRows('_smrt_contexts')).toBe(0);
  });

  it('opts the whole sweep out with enabled: false', async () => {
    await insertUsage({ id: 'usage-old', createdAt: daysAgo(120) });

    const result = await runRetentionSweep(db, { enabled: false });

    expect(result.tasks).toEqual([]);
    expect(result.pruned).toBe(0);
    expect(await countRows('_smrt_ai_usage')).toBe(1);
  });

  it('honours per-table overrides of the default window', async () => {
    await insertUsage({ id: 'usage-45d', createdAt: daysAgo(45) });

    const result = await runRetentionSweep(db, {
      aiUsage: { maxAgeDays: 30 },
    });

    expect(result.pruned).toBe(1);
    expect(await countRows('_smrt_ai_usage')).toBe(0);
  });

  it('runs registered tasks and lets policy disable them by name', async () => {
    let runs = 0;
    registerRetentionTask({
      name: 'test-task',
      run: async () => {
        runs += 1;
        return 7;
      },
    });

    const included = await runRetentionSweep(db);
    expect(runs).toBe(1);
    expect(
      included.tasks.find((task) => task.task === 'test-task')?.pruned,
    ).toBe(7);

    const excluded = await runRetentionSweep(db, {
      tasks: { 'test-task': false },
    });
    expect(runs).toBe(1);
    expect(
      excluded.tasks.find((task) => task.task === 'test-task')?.skipped,
    ).toBe('disabled');
  });

  it('records a failing task and still runs the rest', async () => {
    await insertContext({ id: 'ctx-old', key: 'k1', expiresAt: daysAgo(1) });
    registerRetentionTask({
      name: 'exploding-task',
      run: async () => {
        throw new Error('boom');
      },
    });

    const result = await runRetentionSweep(db);

    expect(result.failed).toBe(true);
    expect(
      result.tasks.find((task) => task.task === 'exploding-task')?.error,
    ).toBe('boom');
    // The contexts task ran despite the failure.
    expect(await countRows('_smrt_contexts')).toBe(0);
  });

  it('reports a missing system table as unavailable rather than failing', async () => {
    await db.query('DROP TABLE _smrt_ai_usage');

    const result = await runRetentionSweep(db);

    expect(result.failed).toBe(false);
    expect(result.tasks.find((task) => task.task === 'ai-usage')?.skipped).toBe(
      'unavailable',
    );
  });

  it('replaces a re-registered task and supports unregistering', () => {
    registerRetentionTask({ name: 'dupe', run: async () => 1 });
    registerRetentionTask({ name: 'dupe', run: async () => 2 });
    expect(getRetentionTasks()).toHaveLength(1);

    expect(unregisterRetentionTask('dupe')).toBe(true);
    expect(unregisterRetentionTask('dupe')).toBe(false);
    expect(getRetentionTasks()).toEqual([]);
  });

  it('rejects a task registered without a name', () => {
    expect(() =>
      registerRetentionTask({ name: '', run: async () => 0 }),
    ).toThrow(/non-empty task name/);
  });
});

describe('retention predicate indexes (#2375)', () => {
  it('bootstrap creates an index for every retention predicate', async () => {
    const result = await db.query(
      `SELECT name FROM sqlite_master WHERE type = 'index'`,
    );
    const names = result.rows.map((row) => String(row.name));

    expect(names).toContain('idx_smrt_contexts_expires_at');
    expect(names).toContain('idx_smrt_ai_usage_tenant_created');
    expect(names).toContain('idx_smrt_dispatch_status_processed');
    expect(names).toContain('idx_smrt_dispatch_status_updated');
  });
});

describe('DEFAULT_RETENTION_POLICY (#2375)', () => {
  it('documents a window for every unbounded table', () => {
    expect(DEFAULT_RETENTION_POLICY.changes.maxAgeDays).toBe(30);
    expect(DEFAULT_RETENTION_POLICY.aiUsage.maxAgeDays).toBe(90);
    expect(DEFAULT_RETENTION_POLICY.dispatch.completedOlderThanDays).toBe(30);
    expect(DEFAULT_RETENTION_POLICY.dispatch.failedOlderThanDays).toBe(90);
  });
});
