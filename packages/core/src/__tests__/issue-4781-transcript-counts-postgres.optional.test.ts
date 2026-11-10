/**
 * PostgreSQL lane for the Usage tab's transcript counts (#4781):
 * `reportAiUsage({ transcripts: true })` looks transcripts up by call id
 * with `$n` placeholders, inside the report's tenant, and the `template`
 * dimension reads the `templateHash` tag.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set; point it at a DISPOSABLE
 * database.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAiTranscript } from '../system/ai-transcripts';
import { reportAiUsage } from '../system/ai-usage-observability';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TENANT = 'pg-4781-tenant';
const OTHER = 'pg-4781-other';

describe.skipIf(!pgUrl)('transcript counts on PostgreSQL (#4781)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: 'smrt-test-4781',
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await getTestDatabase({ db, classes: [] });
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(
      'DELETE FROM _smrt_ai_transcripts WHERE tenant_id IN ($1, $2)',
      TENANT,
      OTHER,
    );
    await db.query("DELETE FROM _smrt_ai_usage WHERE class_name = 'Pg4781'");
  });

  async function usage(id: string, tenant: string, callId: string) {
    await db.query(
      `INSERT INTO _smrt_ai_usage
         (id, provider, model, operation, duration, class_name, tenant_id,
          prompt_key, call_id, tags, created_at)
       VALUES ($1, 'openai', 'gpt-4o', 'chat', 1, 'Pg4781', $2, 'p.pg', $3, $4, $5)`,
      id,
      tenant,
      callId,
      JSON.stringify({ templateHash: 'h-pg' }),
      new Date(),
    );
  }

  it('counts transcribed calls per bucket within the tenant', async () => {
    await usage('pg-4781-u1', TENANT, 'pg-4781-c1');
    await usage('pg-4781-u2', TENANT, 'pg-4781-c1');
    await usage('pg-4781-u3', TENANT, 'pg-4781-c2');
    await usage('pg-4781-u4', OTHER, 'pg-4781-c2');
    for (const [callId, tenantId] of [
      ['pg-4781-c1', TENANT],
      ['pg-4781-c2', OTHER],
    ] as const) {
      await recordAiTranscript(db, {
        callId,
        tenantId,
        operation: 'chat',
        request: '{}',
        response: '{}',
        toolEvents: null,
        truncated: false,
        bytes: 2,
      });
    }
    const report = await reportAiUsage(db, {
      by: ['template'],
      tenantId: TENANT,
      transcripts: true,
    });
    expect(report.buckets).toEqual([
      expect.objectContaining({
        key: { template: 'h-pg' },
        calls: 3,
        transcripts: 1,
      }),
    ]);
    expect(report.totals.transcripts).toBe(1);
  });
});
