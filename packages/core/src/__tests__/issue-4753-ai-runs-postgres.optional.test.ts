/**
 * PostgreSQL lane for fusion run records (#4753).
 *
 * Proves `_smrt_ai_runs` reaches an existing PostgreSQL database through
 * `ensureSystemTables()` (the 1.14.0 DDL replay creates the table and its
 * indexes; a second run is a no-op), materializes with the engine's types
 * (TIMESTAMPTZ, BIGINT counts, TEXT tenant like `_smrt_ai_usage`), and that
 * the writer, list, report and prune run with `$n` placeholders.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set; point it at a DISPOSABLE
 * database (the test drops `_smrt_ai_runs`).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAiRuns, recordAiRun, reportAiRuns } from '../system/ai-runs';
import { ensureSystemTables } from '../system/bootstrap';
import { pruneAiRuns } from '../system/retention';
import { SMRT_SCHEMA_VERSION } from '../system/schema';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

describe.skipIf(!pgUrl)('fusion run records on PostgreSQL (#4753)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: 'smrt-test-4753',
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await getTestDatabase({ db, classes: [] });
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM _smrt_ai_runs');
  });

  async function liveColumns(): Promise<Record<string, string>> {
    const rows = rowsOf(
      await db.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = '_smrt_ai_runs'`,
      ),
    );
    return Object.fromEntries(
      rows.map((row) => [String(row.column_name), String(row.data_type)]),
    );
  }

  it('adds _smrt_ai_runs to an existing database, idempotently, with engine types', async () => {
    // Reshape to the pre-#4753 install: no run table, no 1.14.0 stamp.
    await db.query('DROP TABLE IF EXISTS _smrt_ai_runs');
    await db.query(
      'DELETE FROM _smrt_migrations WHERE version = $1',
      SMRT_SCHEMA_VERSION,
    );
    expect(await liveColumns()).toEqual({});

    await ensureSystemTables(db, 'postgres');
    await ensureSystemTables(db, 'postgres');

    expect(await liveColumns()).toEqual({
      id: 'text',
      fusion_key: 'text',
      mode: 'text',
      tenant_id: 'text',
      class_name: 'text',
      prompt_key: 'text',
      seats: 'bigint',
      degraded_seats: 'bigint',
      status: 'text',
      duration: 'bigint',
      details: 'text',
      created_at: 'timestamp with time zone',
    });
    const indexes = rowsOf(
      await db.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = '_smrt_ai_runs'`,
      ),
    ).map((row) => String(row.indexname));
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_smrt_ai_runs_created',
        'idx_smrt_ai_runs_fusion_created',
        'idx_smrt_ai_runs_tenant_created',
      ]),
    );
  });

  it('records, lists, reports and prunes runs', async () => {
    await db.query('DELETE FROM _smrt_ai_runs');
    const tenantId = '7d3c1e0a-1a2b-4c5d-8e9f-0a1b2c3d4e5f';
    await recordAiRun(db, {
      id: 'pg-run-1',
      fusionKey: 'review-pair',
      mode: 'pair',
      status: 'degraded',
      seats: 3,
      degradedSeats: 1,
      duration: 120,
      promptKey: 'notes.review',
      className: 'Note',
      tenantId,
      details: { seats: [{ persona: 'skeptic', status: 'failed' }] },
    });
    await recordAiRun(db, {
      id: 'pg-run-2',
      fusionKey: 'review-pair',
      mode: 'pair',
      status: 'ok',
      seats: 3,
      degradedSeats: 0,
      duration: 80,
      createdAt: new Date(Date.now() - 10 * 86_400_000),
    });

    const [run] = await listAiRuns(db, { tenantId });
    expect(run).toMatchObject({
      id: 'pg-run-1',
      seats: 3,
      degradedSeats: 1,
      duration: 120,
      details: { seats: [{ persona: 'skeptic', status: 'failed' }] },
    });
    expect(typeof run?.seats).toBe('number');
    expect(run?.createdAt).toBeInstanceOf(Date);

    const report = await reportAiRuns(db, {
      since: new Date(Date.now() - 30 * 86_400_000),
    });
    expect(report.buckets).toEqual([
      expect.objectContaining({
        fusionKey: 'review-pair',
        runs: 2,
        ok: 1,
        degraded: 1,
        seats: 6,
        degradedSeats: 1,
      }),
    ]);

    expect(await pruneAiRuns(db, { maxAgeMs: 86_400_000 })).toEqual({
      pruned: 1,
    });
    expect((await listAiRuns(db)).map((r) => r.id)).toEqual(['pg-run-1']);
  });
});
