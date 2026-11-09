/**
 * PostgreSQL lane for AI call transcripts (#4780).
 *
 * Proves the 1.15.0 replay reaches an existing PostgreSQL database through
 * `ensureSystemTables()`: `_smrt_ai_transcripts` with engine types (TEXT
 * tenant like `_smrt_ai_usage`, BIGINT flag and size, TIMESTAMPTZ), the
 * `call_id` columns added to existing `_smrt_ai_usage` /
 * `_smrt_ai_usage_outcomes` tables, idempotently; and that the writer, the
 * tenant-scoped read with its label join, labels by call id and the prune
 * run with `$n` placeholders.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set; point it at a DISPOSABLE
 * database (the test drops `_smrt_ai_transcripts` and the `call_id` columns).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiUsagePersistenceHandler } from '../adapters/ai-usage';
import {
  listAiTranscripts,
  recordAiTranscript,
} from '../system/ai-transcripts';
import { recordAiUsageOutcome } from '../system/ai-usage-observability';
import { ensureSystemTables } from '../system/bootstrap';
import { pruneAiTranscripts } from '../system/retention';
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

describe.skipIf(!pgUrl)('AI call transcripts on PostgreSQL (#4780)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: 'smrt-test-4780',
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await getTestDatabase({ db, classes: [] });
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM _smrt_ai_transcripts');
    await db.query(
      "DELETE FROM _smrt_ai_usage_outcomes WHERE actor = 'pg-4780'",
    );
    await db.query("DELETE FROM _smrt_ai_usage WHERE class_name = 'Pg4780'");
  });

  async function columns(table: string): Promise<Record<string, string>> {
    const rows = rowsOf(
      await db.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1`,
        table,
      ),
    );
    return Object.fromEntries(
      rows.map((row) => [String(row.column_name), String(row.data_type)]),
    );
  }

  it('adds the table and call_id columns to an existing database, idempotently', async () => {
    // Reshape to a 1.14.0 install: no transcript table, no call_id columns.
    await db.query('DROP TABLE IF EXISTS _smrt_ai_transcripts');
    await db.query('DROP INDEX IF EXISTS idx_smrt_ai_usage_call');
    await db.query('DROP INDEX IF EXISTS idx_smrt_ai_usage_outcomes_call');
    await db.query('ALTER TABLE _smrt_ai_usage DROP COLUMN IF EXISTS call_id');
    await db.query(
      'ALTER TABLE _smrt_ai_usage_outcomes DROP COLUMN IF EXISTS call_id',
    );
    await db.query(
      'DELETE FROM _smrt_migrations WHERE version = $1',
      SMRT_SCHEMA_VERSION,
    );
    expect(await columns('_smrt_ai_transcripts')).toEqual({});

    await ensureSystemTables(db, 'postgres');
    await ensureSystemTables(db, 'postgres');

    expect(await columns('_smrt_ai_transcripts')).toEqual({
      id: 'text',
      call_id: 'text',
      run_id: 'text',
      tenant_id: 'text',
      prompt_key: 'text',
      template_hash: 'text',
      provider: 'text',
      model: 'text',
      operation: 'text',
      class_name: 'text',
      request: 'text',
      response: 'text',
      tool_events: 'text',
      truncated: 'bigint',
      bytes: 'bigint',
      created_at: 'timestamp with time zone',
    });
    expect((await columns('_smrt_ai_usage')).call_id).toBe('text');
    expect((await columns('_smrt_ai_usage_outcomes')).call_id).toBe('text');
    const indexes = rowsOf(
      await db.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname IN ('idx_smrt_ai_transcripts_call',
              'idx_smrt_ai_transcripts_tenant_created', 'idx_smrt_ai_usage_call',
              'idx_smrt_ai_usage_outcomes_call')`,
      ),
    ).map((row) => String(row.indexname));
    expect(indexes.sort()).toEqual([
      'idx_smrt_ai_transcripts_call',
      'idx_smrt_ai_transcripts_tenant_created',
      'idx_smrt_ai_usage_call',
      'idx_smrt_ai_usage_outcomes_call',
    ]);
  });

  it('writes, reads in-tenant with labels, and prunes on PostgreSQL', async () => {
    const callId = `pg-4780-${Date.now()}`;
    await new AiUsagePersistenceHandler(db).handle({
      provider: 'openai',
      model: 'gpt-test',
      operation: 'message',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      duration: 3,
      timestamp: new Date(),
      className: 'Pg4780',
      tenantId: 'pg-tenant',
      tags: { callId },
    });
    const old = new Date(Date.now() - 40 * 86_400_000);
    await recordAiTranscript(db, {
      callId,
      tenantId: 'pg-tenant',
      operation: 'message',
      request: '{"messages":[]}',
      response: '{"messages":[]}',
      toolEvents: null,
      truncated: true,
      bytes: 30,
      createdAt: old,
    });
    await recordAiUsageOutcome(db, {
      callId,
      label: 'rejected',
      score: 0,
      actor: 'pg-4780',
    });
    const [row] = await listAiTranscripts(db, {
      actor: 'pg-4780',
      tenantId: 'pg-tenant',
      callId,
      outcome: 'rejected',
    });
    expect(row).toMatchObject({ callId, truncated: true, bytes: 30 });
    expect(row?.usage.map((usage) => usage.callId)).toEqual([callId]);
    expect(row?.outcomes.map((outcome) => outcome.label)).toEqual(['rejected']);
    expect(
      await listAiTranscripts(db, {
        actor: 'pg-4780',
        tenantId: 'other',
        callId,
      }),
    ).toEqual([]);
    expect(
      await pruneAiTranscripts(db, {
        maxAgeMs: 30 * 86_400_000,
        tenantId: 'pg-tenant',
      }),
    ).toEqual({ pruned: 1 });
  });
});
