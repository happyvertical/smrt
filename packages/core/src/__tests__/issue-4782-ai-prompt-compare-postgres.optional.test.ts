/**
 * PostgreSQL lane for prompt comparison (#4782): the keyset pages, `$n` IN
 * lists, tenant predicates and TIMESTAMPTZ window of `compareAiPromptRuns()`
 * and `listAiPromptTemplateHistory()` run on PostgreSQL, joins stay in
 * tenant, and timestamps hydrate as Dates.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set; rows it writes carry the
 * `Pg4782` class / `pg-4782` actor and are removed afterwards.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiUsagePersistenceHandler } from '../adapters/ai-usage';
import {
  compareAiPromptRuns,
  listAiPromptTemplateHistory,
} from '../system/ai-prompt-compare';
import { recordAiRun } from '../system/ai-runs';
import { recordAiTranscript } from '../system/ai-transcripts';
import { recordAiUsageOutcome } from '../system/ai-usage-observability';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)('Prompt comparison on PostgreSQL (#4782)', () => {
  let db: DatabaseInterface;
  const suffix = Date.now().toString(36);
  const prompt = `pg-4782.prompt.${suffix}`;
  const run = `pg-4782-run-${suffix}`;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: 'smrt-test-4782',
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await getTestDatabase({ db, classes: [] });
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(
      'DELETE FROM _smrt_ai_transcripts WHERE prompt_key = $1',
      prompt,
    );
    await db.query(
      "DELETE FROM _smrt_ai_usage_outcomes WHERE actor = 'pg-4782'",
    );
    await db.query('DELETE FROM _smrt_ai_runs WHERE id = $1', run);
    await db.query("DELETE FROM _smrt_ai_usage WHERE class_name = 'Pg4782'");
  });

  async function call(
    tenantId: string,
    templateHash: string,
    callId: string,
    duration: number,
    extra: Record<string, string> = {},
  ): Promise<void> {
    await new AiUsagePersistenceHandler(db).handle({
      provider: 'openai',
      model: 'gpt-test',
      operation: 'message',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      duration,
      timestamp: new Date(),
      className: 'Pg4782',
      tenantId,
      estimatedCost: 0.001,
      tags: { promptKey: prompt, templateHash, callId, ...extra },
    });
  }

  it('compares two template hashes in one tenant', async () => {
    const since = new Date(Date.now() - 60_000);
    await call('pg-a', 'h1', `${suffix}-1`, 10, { runId: run });
    await call('pg-a', 'h1', `${suffix}-2`, 30);
    await call('pg-a', 'h2', `${suffix}-3`, 20);
    await call('pg-b', 'h1', `${suffix}-1`, 999);
    await recordAiRun(db, {
      id: run,
      fusionKey: 'pg',
      mode: 'm',
      status: 'degraded',
      seats: 2,
      degradedSeats: 1,
      duration: 5,
      tenantId: 'pg-a',
      promptKey: prompt,
    });
    await recordAiUsageOutcome(db, {
      callId: `${suffix}-2`,
      label: 'rejected',
      score: 0,
      actor: 'pg-4782',
    });
    const { id } = await recordAiTranscript(db, {
      callId: `${suffix}-2`,
      tenantId: 'pg-a',
      promptKey: prompt,
      operation: 'message',
      request: '{"messages":[]}',
      response: '{"messages":[]}',
      toolEvents: null,
      truncated: false,
      bytes: 30,
    });

    const result = await compareAiPromptRuns(db, {
      promptKey: prompt,
      a: { templateHash: 'h1' },
      b: { templateHash: 'h2' },
      tenantId: 'pg-a',
      since,
    });
    expect(result).toMatchObject({ rows: 3, unmatched: 0, inBoth: 0 });
    expect(result.a).toMatchObject({
      calls: 2,
      degradedCalls: 1,
      latencyMs: { p50: 10, p99: 30 },
      labels: 1,
      meanScore: 0,
      transcriptCount: 1,
    });
    expect(result.a.estimatedCost).toBeCloseTo(0.002);
    expect(result.a.transcripts[0]?.id).toBe(id);
    expect(result.a.transcripts[0]?.createdAt).toBeInstanceOf(Date);
    expect(result.b.calls).toBe(1);

    const other = await compareAiPromptRuns(db, {
      promptKey: prompt,
      a: { templateHash: 'h1' },
      b: { templateHash: 'h2' },
      tenantId: 'pg-b',
    });
    expect(other.a).toMatchObject({
      calls: 1,
      degradedCalls: 0,
      labels: 0,
      transcriptCount: 0,
    });

    const history = await listAiPromptTemplateHistory(db, {
      promptKey: prompt,
      tenantId: 'pg-a',
      since,
    });
    expect(
      history.hashes.map((entry) => [entry.templateHash, entry.calls]).sort(),
    ).toEqual([
      ['h1', 2],
      ['h2', 1],
    ]);
    expect(history.hashes[0]?.firstSeen).toBeInstanceOf(Date);
  });
});
