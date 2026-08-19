/**
 * PostgreSQL lane for system-table retention (issue #2375, finding F2).
 *
 * SQLite masks two things this suite exists to catch:
 *   - **Placeholder dialect.** Retention SQL is written with `?` and rewritten
 *     to `$n` for PostgreSQL. A mismatch is a syntax error on PG and invisible
 *     on SQLite.
 *   - **Timestamp typing.** `created_at`/`expires_at` are `TIMESTAMPTZ` on
 *     PostgreSQL and text-affinity on SQLite, so an ISO-string cutoff that
 *     compares fine on SQLite can be rejected — or, worse, silently mis-order
 *     — on PostgreSQL.
 *
 * Also asserts the retention-predicate indexes really materialize in
 * `pg_indexes`, not just in the DDL string.
 *
 * Runs in the dedicated PostgreSQL CI shard and only when
 * `SMRT_TEST_POSTGRES_URL` is set — point local runs at a DISPOSABLE database
 * (the test deletes rows from `_smrt_ai_usage`, `_smrt_contexts`,
 * `_smrt_dispatch` and `_smrt_changes`).
 *
 * @example
 * ```bash
 * SMRT_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/smrt_test \
 *   npx vitest run src/__tests__/retention-postgres.optional.test.ts
 * ```
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRetentionTasks,
  pruneAiUsage,
  pruneExpiredContexts,
  runRetentionSweep,
} from '../system/retention';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

describe.skipIf(!pgUrl)('system-table retention on PostgreSQL (#2375)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    clearRetentionTasks();
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: 'smrt-test-retention',
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

    await getTestDatabase({ db, classes: [] });

    await db.query('DELETE FROM _smrt_ai_usage');
    await db.query('DELETE FROM _smrt_contexts');
    await db.query('DELETE FROM _smrt_dispatch');
    await db.query('DELETE FROM _smrt_changes');
  });

  afterAll(async () => {
    clearRetentionTasks();
    if (!db) return;
    await db.query('DELETE FROM _smrt_ai_usage');
    await db.query('DELETE FROM _smrt_contexts');
    await db.query('DELETE FROM _smrt_dispatch');
    await db.query('DELETE FROM _smrt_changes');
  });

  async function insertUsage(options: {
    id: string;
    createdAt: Date;
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
      options.createdAt.toISOString(),
    );
  }

  async function countRows(table: string): Promise<number> {
    return Number(
      rowsOf(await db.query(`SELECT COUNT(*) AS total FROM ${table}`))[0]
        ?.total ?? 0,
    );
  }

  it('prunes AI usage by age against TIMESTAMPTZ columns', async () => {
    await insertUsage({
      id: 'pg-old',
      createdAt: new Date(Date.now() - 120 * DAY_MS),
    });
    await insertUsage({
      id: 'pg-new',
      createdAt: new Date(Date.now() - DAY_MS),
    });

    const { pruned } = await pruneAiUsage(db, { maxAgeMs: 90 * DAY_MS });

    expect(pruned).toBe(1);
    const remaining = rowsOf(
      await db.query('SELECT id FROM _smrt_ai_usage ORDER BY id'),
    );
    expect(remaining.map((row) => String(row.id))).toEqual(['pg-new']);
  });

  it('prunes AI usage by row count using a portable OFFSET boundary', async () => {
    await insertUsage({
      id: 'pg-a',
      createdAt: new Date(Date.now() - 3 * DAY_MS),
    });
    await insertUsage({
      id: 'pg-b',
      createdAt: new Date(Date.now() - 2 * DAY_MS),
    });
    await insertUsage({
      id: 'pg-c',
      createdAt: new Date(Date.now() - DAY_MS),
    });

    const { pruned } = await pruneAiUsage(db, { maxRows: 2 });

    expect(pruned).toBe(1);
    const remaining = rowsOf(
      await db.query('SELECT id FROM _smrt_ai_usage ORDER BY id'),
    );
    expect(remaining.map((row) => String(row.id))).toEqual(['pg-b', 'pg-c']);
  });

  it('binds the tenant scope through $n placeholders', async () => {
    await insertUsage({
      id: 'pg-tenant-a',
      createdAt: new Date(Date.now() - 120 * DAY_MS),
      tenantId: 'tenant-a',
    });
    await insertUsage({
      id: 'pg-tenant-b',
      createdAt: new Date(Date.now() - 120 * DAY_MS),
      tenantId: 'tenant-b',
    });
    await insertUsage({
      id: 'pg-global',
      createdAt: new Date(Date.now() - 120 * DAY_MS),
      tenantId: null,
    });

    expect(
      (await pruneAiUsage(db, { maxAgeMs: DAY_MS, tenantId: 'tenant-a' }))
        .pruned,
    ).toBe(1);
    expect(
      (await pruneAiUsage(db, { maxAgeMs: DAY_MS, tenantId: null })).pruned,
    ).toBe(1);

    const remaining = rowsOf(
      await db.query('SELECT id FROM _smrt_ai_usage ORDER BY id'),
    );
    expect(remaining.map((row) => String(row.id))).toEqual(['pg-tenant-b']);
  });

  it('enforces _smrt_contexts.expires_at against TIMESTAMPTZ', async () => {
    await db.query(
      `INSERT INTO _smrt_contexts
         (id, owner_class, owner_id, scope, key, value, version, confidence, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      'pg-ctx-expired',
      'Widget',
      'owner-1',
      'scope',
      'expired',
      JSON.stringify({ ok: true }),
      1,
      1.0,
      new Date(Date.now() - DAY_MS).toISOString(),
    );
    await db.query(
      `INSERT INTO _smrt_contexts
         (id, owner_class, owner_id, scope, key, value, version, confidence, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      'pg-ctx-forever',
      'Widget',
      'owner-1',
      'scope',
      'forever',
      JSON.stringify({ ok: true }),
      1,
      1.0,
      null,
    );

    const { pruned } = await pruneExpiredContexts(db);

    expect(pruned).toBe(1);
    const remaining = rowsOf(
      await db.query('SELECT id FROM _smrt_contexts ORDER BY id'),
    );
    expect(remaining.map((row) => String(row.id))).toEqual(['pg-ctx-forever']);
  });

  it('runs a full sweep, and a dry run deletes nothing', async () => {
    await insertUsage({
      id: 'pg-sweep-old',
      createdAt: new Date(Date.now() - 120 * DAY_MS),
    });

    const preview = await runRetentionSweep(db, { dryRun: true });
    expect(preview.failed).toBe(false);
    expect(preview.pruned).toBe(1);
    expect(await countRows('_smrt_ai_usage')).toBe(1);

    const applied = await runRetentionSweep(db);
    expect(applied.failed).toBe(false);
    expect(applied.pruned).toBe(1);
    expect(await countRows('_smrt_ai_usage')).toBe(0);
  });

  it('materializes every retention-predicate index in pg_indexes', async () => {
    const rows = rowsOf(
      await db.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
      ),
    );
    const names = rows.map((row) => String(row.indexname));

    expect(names).toContain('idx_smrt_contexts_expires_at');
    expect(names).toContain('idx_smrt_ai_usage_tenant_created');
    expect(names).toContain('idx_smrt_dispatch_status_processed');
    expect(names).toContain('idx_smrt_dispatch_status_updated');
  });
});
