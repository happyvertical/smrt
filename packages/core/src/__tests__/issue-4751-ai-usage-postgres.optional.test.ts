/**
 * PostgreSQL lane for prompt-run observability (#4751).
 *
 * Proves the additive `_smrt_ai_usage` columns reach an existing PostgreSQL
 * database through `ensureSystemTables()` (column-existence-guarded ALTERs,
 * then the 1.13.0 DDL replay creates the indexes and the outcomes table), that
 * a second run is a no-op, and that the handler, outcome API and report run
 * with `$n` placeholders against TIMESTAMPTZ columns.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set; point it at a DISPOSABLE
 * database (the test drops and re-adds columns on `_smrt_ai_usage`).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiUsagePersistenceHandler } from '../adapters/ai-usage';
import {
  listAiUsageOutcomes,
  recordAiUsageOutcome,
  reportAiUsage,
} from '../system/ai-usage-observability';
import { ensureSystemTables } from '../system/bootstrap';
import { SMRT_SCHEMA_VERSION } from '../system/schema';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const NEW_COLUMNS = ['prompt_key', 'tier_requested', 'tier_resolved', 'run_id'];

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

describe.skipIf(!pgUrl)(
  'prompt-run observability on PostgreSQL (#4751)',
  () => {
    let db: DatabaseInterface;

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: 'smrt-test-4751',
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      await getTestDatabase({ db, classes: [] });
    });

    afterAll(async () => {
      if (!db) return;
      await db.query('DELETE FROM _smrt_ai_usage_outcomes');
      await db.query('DELETE FROM _smrt_ai_usage');
    });

    async function liveColumns(): Promise<Record<string, string>> {
      const rows = rowsOf(
        await db.query(
          `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = '_smrt_ai_usage'`,
        ),
      );
      return Object.fromEntries(
        rows.map((row) => [String(row.column_name), String(row.data_type)]),
      );
    }

    async function liveIndexes(table: string): Promise<string[]> {
      return rowsOf(
        await db.query(
          `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = $1`,
          table,
        ),
      ).map((row) => String(row.indexname));
    }

    it('upgrades a pre-1.13 _smrt_ai_usage in place, idempotently', async () => {
      await db.query('DELETE FROM _smrt_ai_usage_outcomes');
      await db.query('DELETE FROM _smrt_ai_usage');
      await db.query(
        `INSERT INTO _smrt_ai_usage (id, provider, model, operation, duration)
       VALUES ('legacy-1', 'openai', 'gpt-4o', 'chat', 5)`,
      );

      // Reshape to the pre-#4751 install: no columns, indexes, outcomes table
      // or 1.13.0 stamp.
      await db.query('DROP INDEX IF EXISTS idx_smrt_ai_usage_prompt_key');
      await db.query('DROP INDEX IF EXISTS idx_smrt_ai_usage_run');
      for (const column of NEW_COLUMNS) {
        await db.query(
          `ALTER TABLE _smrt_ai_usage DROP COLUMN IF EXISTS ${column}`,
        );
      }
      await db.query('DROP TABLE IF EXISTS _smrt_ai_usage_outcomes');
      await db.query(
        'DELETE FROM _smrt_migrations WHERE version = $1',
        SMRT_SCHEMA_VERSION,
      );
      expect(Object.keys(await liveColumns())).not.toContain('prompt_key');

      await ensureSystemTables(db, 'postgres');
      await ensureSystemTables(db, 'postgres');

      const columns = await liveColumns();
      for (const column of NEW_COLUMNS) expect(columns[column]).toBe('text');
      expect(await liveIndexes('_smrt_ai_usage')).toEqual(
        expect.arrayContaining([
          'idx_smrt_ai_usage_prompt_key',
          'idx_smrt_ai_usage_run',
        ]),
      );
      expect(await liveIndexes('_smrt_ai_usage_outcomes')).toEqual(
        expect.arrayContaining([
          'idx_smrt_ai_usage_outcomes_usage',
          'idx_smrt_ai_usage_outcomes_run',
          'idx_smrt_ai_usage_outcomes_tenant_created',
        ]),
      );
      const legacy = rowsOf(
        await db.query(
          "SELECT prompt_key, run_id FROM _smrt_ai_usage WHERE id = 'legacy-1'",
        ),
      );
      expect(legacy).toEqual([{ prompt_key: null, run_id: null }]);
    });

    it('persists lifted tags and reports and labels them', async () => {
      await db.query('DELETE FROM _smrt_ai_usage_outcomes');
      await db.query('DELETE FROM _smrt_ai_usage');
      const handler = new AiUsagePersistenceHandler(db);
      const tenantId = '7d3c1e0a-1a2b-4c5d-8e9f-0a1b2c3d4e5f';
      for (const [promptKey, duration] of [
        ['pg.key', 10],
        ['pg.key', 30],
        [undefined, 20],
      ] as const) {
        await handler.handle({
          provider: 'openai',
          model: 'gpt-4o',
          operation: 'chat',
          usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
          duration,
          timestamp: new Date(),
          tenantId,
          tags: promptKey
            ? { promptKey, runId: 'pg-run', tierResolved: 'good' }
            : undefined,
        });
      }

      const report = await reportAiUsage(db, {
        by: ['prompt', 'tier'],
        tenantId,
        since: new Date(Date.now() - 60_000),
      });
      expect(report.totals.calls).toBe(3);
      expect(report.unattributedCalls).toBe(1);
      expect(report.totals.uncostedCalls).toBe(3);
      const keyed = report.buckets.find((b) => b.key.prompt === 'pg.key');
      expect(keyed).toMatchObject({
        calls: 2,
        p50DurationMs: 10,
        key: { tier: 'good' },
      });

      const outcome = await recordAiUsageOutcome(db, {
        runId: 'pg-run',
        label: 'accepted',
        score: 1,
        actor: 'pg-test',
      });
      expect(outcome.tenantId).toBe(tenantId);
      const [read] = await listAiUsageOutcomes(db, { runId: 'pg-run' });
      expect(read?.usage).toHaveLength(2);
      expect(read?.createdAt).toBeInstanceOf(Date);

      const labelled = await reportAiUsage(db, { by: ['prompt'], tenantId });
      expect(labelled.totals.outcomes).toEqual({ accepted: 1 });
    });
  },
);
