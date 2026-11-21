/**
 * The `aiCallId` usage tag is core's tracked-call id
 * (packages/core/agents/ai-usage.md "Call ids"): only an event of a call
 * core minted keeps it as the usage row's id, so a value a caller reuses
 * never makes another call's row vanish, and two pipelines seeing the same
 * tracked call write one row.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiUsageRecorder } from '../adapters/ai-usage-recorder';
import { getAiRun, getRunTrajectory, openAiRun } from '../system/browser';
import { createTrackedAiClient } from '../tracked-ai-client';
import {
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const rawEvent = (tags: Record<string, string>) => ({
  provider: 'openai',
  model: 'gpt-4o',
  operation: 'message',
  usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
  duration: 1,
  tags,
});

describe('usage row identity', () => {
  it('records every call that reuses an aiCallId tag, each under its own id', async () => {
    const db: DatabaseInterface = await newAiRunTestDatabase('sqlite');
    const record = createAiUsageRecorder({ db, tenantId: 'tenant-one' });
    const copied = { aiCallId: 'copied-call-id', promptKey: 'ids.prompt' };
    await record(rawEvent(copied));
    await record(rawEvent(copied));
    await record(rawEvent(copied));
    const rows = rowsOf(
      await db.query(
        "SELECT id, call_id, tags FROM _smrt_ai_usage WHERE prompt_key = 'ids.prompt'",
      ),
    );
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    for (const row of rows) {
      expect(row.id).not.toBe('copied-call-id');
      expect(row.call_id).toBe(row.id);
      expect(JSON.parse(String(row.tags))).not.toHaveProperty('aiCallId');
    }
  });

  it('writes one row when a recorder the host attached to its own client sees a tracked call', async () => {
    const db: DatabaseInterface = await newAiRunTestDatabase('sqlite');
    const hostRecorder = createAiUsageRecorder({ db, tenantId: 'tenant-one' });
    let sentCallId: string | undefined;
    const hostClient = {
      // A client the host built itself (core recognises it by `embed`).
      async embed() {
        return [];
      },
      async message(_text: string, options: Record<string, unknown> = {}) {
        const tags = options.usageTags as Record<string, string>;
        sentCallId = tags.aiCallId;
        await hostRecorder(rawEvent(tags));
        return 'answer';
      },
    };
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-one',
      ai: hostClient as never,
      label: { provider: 'openai', model: 'gpt-4o' },
    });
    const { run, context } = await tracked.openRun({ type: 'turn' });
    const client = await tracked.client(
      { promptKey: 'ids.prompt' },
      { runContext: context },
    );
    await client.message('hello');
    const rows = rowsOf(
      await db.query('SELECT id, run_id, total_tokens FROM _smrt_ai_usage'),
    );
    expect(rows).toEqual([
      { id: sentCallId, run_id: run.id, total_tokens: 12 },
    ]);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1, tokens: 12 });
  });

  it('never lets caller tags place an untracked call in a run or meter it to a user', async () => {
    const db: DatabaseInterface = await newAiRunTestDatabase('sqlite');
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    const record = createAiUsageRecorder({ db, tenantId: 'tenant-one' });
    await record(
      rawEvent({
        promptKey: 'ids.prompt',
        runId: run.id,
        stepInstanceId: 'step-x',
        userId: 'someone-else',
      }),
    );
    const [row] = rowsOf(
      await db.query(
        'SELECT id, run_id, step_instance_id, tags FROM _smrt_ai_usage',
      ),
    );
    expect(row).toMatchObject({ run_id: null, step_instance_id: null });
    const tags = JSON.parse(String(row?.tags));
    expect(tags).not.toHaveProperty('runId');
    expect(tags).not.toHaveProperty('userId');
    expect(tags.promptKey).toBe('ids.prompt');
    const trajectory = await getRunTrajectory(db, { callId: String(row?.id) });
    expect(trajectory?.run).toBeNull();
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 0 });
  });
});
