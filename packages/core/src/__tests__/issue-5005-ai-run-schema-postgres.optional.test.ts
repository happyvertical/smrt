/**
 * PostgreSQL lane for the AI run schema upgrade (#5005).
 *
 * Reshapes a database to the 1.16.0 AI system tables (the fusion-only
 * `_smrt_ai_runs`, `_smrt_ai_usage_outcomes`, the shared `call_id`), runs
 * `ensureSystemTables()` twice, and checks the rebuilt run table, the call id
 * split and the evaluations carried across, with the engine's own types.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set; point it at a DISPOSABLE
 * database (the test drops and recreates the AI system tables).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemTables } from '../system/bootstrap';
import {
  getSystemTableDDLForEngine,
  SMRT_SCHEMA_VERSION,
} from '../system/schema';
import { getTestDatabase } from '../testing/database';
import {
  LEGACY_AI_RUN_DDL,
  seedLegacyAiRunRows,
} from './fixtures/ai-run-legacy-schema';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

describe.skipIf(!pgUrl)('AI run schema upgrade on PostgreSQL (#5005)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: 'smrt-test-5005',
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await getTestDatabase({ db, classes: [] });
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM _smrt_ai_evaluations');
    await db.query('DELETE FROM _smrt_ai_runs');
    await db.query('DELETE FROM _smrt_ai_usage');
  });

  async function columns(table: string): Promise<Record<string, string>> {
    return Object.fromEntries(
      rowsOf(
        await db.query(
          `SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = $1`,
          table,
        ),
      ).map((row) => [String(row.column_name), String(row.data_type)]),
    );
  }

  it('upgrades the 1.16.0 tables in place, idempotently', async () => {
    const fresh = {
      runs: await columns('_smrt_ai_runs'),
      usage: await columns('_smrt_ai_usage'),
      evaluations: await columns('_smrt_ai_evaluations'),
    };
    for (const table of [
      '_smrt_ai_run_checkpoints',
      '_smrt_ai_run_events',
      '_smrt_ai_evaluations',
      '_smrt_ai_runs',
      '_smrt_ai_usage_outcomes',
      '_smrt_ai_usage',
    ]) {
      await db.query(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const statement of LEGACY_AI_RUN_DDL) {
      await db.query(getSystemTableDDLForEngine(statement, 'postgres'));
    }
    await seedLegacyAiRunRows(db);
    await db.query(
      'DELETE FROM _smrt_migrations WHERE version = $1',
      SMRT_SCHEMA_VERSION,
    );

    await ensureSystemTables(db, 'postgres');
    await db.query(
      'DELETE FROM _smrt_migrations WHERE version = $1',
      SMRT_SCHEMA_VERSION,
    );
    await ensureSystemTables(db, 'postgres');

    expect(await columns('_smrt_ai_runs')).toEqual(fresh.runs);
    expect(await columns('_smrt_ai_usage')).toEqual(fresh.usage);
    expect(await columns('_smrt_ai_evaluations')).toEqual(fresh.evaluations);
    expect(await columns('_smrt_ai_usage_outcomes')).toEqual({});
    expect(
      rowsOf(
        await db.query(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = '_smrt_ai_runs'
              AND indexname LIKE '%pkey'`,
        ),
      ),
    ).toEqual([{ indexname: '_smrt_ai_runs_pkey' }]);

    const usage = rowsOf(
      await db.query(
        `SELECT id, call_id, entry_call_id FROM _smrt_ai_usage WHERE id = 'u-seat-2'`,
      ),
    );
    expect(usage).toEqual([
      { id: 'u-seat-2', call_id: 'u-seat-2', entry_call_id: 'fusion-call' },
    ]);
    const runs = rowsOf(
      await db.query(
        'SELECT id, type, status, degraded, stop_reason FROM _smrt_ai_runs ORDER BY id',
      ),
    );
    expect(
      runs.map((row) => [row.id, row.status, Number(row.degraded)]),
    ).toEqual([
      ['run-bad', 'failed', 0],
      ['run-deg', 'done', 1],
      ['run-ok', 'done', 0],
    ]);
    expect(
      rowsOf(
        await db.query(
          `SELECT call_id, run_id FROM _smrt_ai_evaluations WHERE id = 'l-fusion-call'`,
        ),
      ),
    ).toEqual([{ call_id: null, run_id: 'run-f' }]);
  });
});
