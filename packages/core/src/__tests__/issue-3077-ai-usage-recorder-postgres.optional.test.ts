/**
 * PostgreSQL lane for the public AI usage recorder (#3077): a standalone
 * recorder writes `_smrt_ai_usage` with `$n` placeholders, the ambient tenant,
 * the lifted tag columns, and a cost priced from a gateway model id.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAiUsageRecorder,
  setAiUsageTenantResolver,
} from '../adapters/ai-usage-recorder';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TENANT = '7b0b4d1e-3077-4c4a-9d2e-000000003077';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

describe.skipIf(!pgUrl)('AI usage recorder on PostgreSQL (#3077)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: 'smrt-test-3077',
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await getTestDatabase({ db, classes: [] });
  });

  afterAll(async () => {
    setAiUsageTenantResolver(undefined);
    if (!db) return;
    await db.query(
      `DELETE FROM _smrt_ai_usage WHERE class_name = 'Recorder3077'`,
    );
  });

  it('persists an ambient-tenant row with tag columns and a gateway cost', async () => {
    setAiUsageTenantResolver(() => TENANT);
    const record = createAiUsageRecorder({ db, className: 'Recorder3077' });
    await record({
      provider: 'bifrost',
      model: 'openai/gpt-4o-mini',
      operation: 'chat',
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      duration: 42,
      timestamp: new Date(),
      tags: { promptKey: 'recorder.3077', runId: 'run-3077' },
    });

    const rows = rowsOf(
      await db.query(
        `SELECT tenant_id, prompt_key, run_id, estimated_cost, total_tokens
           FROM _smrt_ai_usage WHERE class_name = $1`,
        'Recorder3077',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: TENANT,
      prompt_key: 'recorder.3077',
      run_id: 'run-3077',
    });
    expect(Number(rows[0].total_tokens)).toBe(1500);
    expect(Number(rows[0].estimated_cost)).toBeCloseTo(0.00045, 6);
  });
});
