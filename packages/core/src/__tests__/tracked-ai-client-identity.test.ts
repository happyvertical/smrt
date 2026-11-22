/**
 * A tracked client's run context keeps naming the run it was bound to
 * (docs/content/ai-runs.md sections 3 and 8): once the run is pruned its id
 * is never reopened, so the bound client's next call fails as not found
 * before anything is sent.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { setAiUsageTenantResolver } from '../adapters/ai-usage-recorder.js';
import { config } from '../config.js';
import {
  AiRunIdUsedError,
  AiRunNotFoundError,
  getAiRun,
  openAiRun,
} from '../system/browser';
import { createTrackedAiClient } from '../tracked-ai-client.js';
import { pruneRunNow, rowsOf } from './fixtures/ai-run-test-db';

const ai = { type: 'openai', model: 'gpt-4o' } as const;
const prompt = { promptKey: 'identity.prompt' };

describe('tracked client run identity', () => {
  const sent: Record<string, unknown>[] = [];
  const dbs: DatabaseInterface[] = [];

  async function memoryDb(): Promise<DatabaseInterface> {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    dbs.push(db);
    return db;
  }

  beforeEach(() => {
    config.reset();
    sent.length = 0;
    getAIMock.mockReset();
    getAIMock.mockImplementation(async (aiConfig: Record<string, unknown>) => ({
      async message(_text: string, options: Record<string, unknown> = {}) {
        sent.push(options);
        await (aiConfig.onUsage as (event: unknown) => Promise<void>)({
          provider: 'openai',
          model: 'gpt-4o',
          operation: 'message',
          usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
          duration: 4,
          tags: options.usageTags,
        });
        return 'answer';
      },
    }));
  });

  afterEach(async () => {
    config.reset();
    setAiUsageTenantResolver(undefined);
    for (const db of dbs.splice(0)) {
      await (db as { close?: () => Promise<void> }).close?.();
    }
  });

  it('a bound client fails not found before dispatch once its run is pruned and the id refused', async () => {
    const db = await memoryDb();
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const { run, context } = await one.openRun({ type: 'turn' });
    const client = await one.client(prompt, { runContext: context });
    await pruneRunNow(db, run.id);
    await expect(
      openAiRun(
        { db, usageTracking: true, tenantId: 'tenant-two' },
        { id: run.id, type: 'turn' },
      ),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    await expect(client.message('hello')).rejects.toBeInstanceOf(
      AiRunNotFoundError,
    );
    expect(sent).toHaveLength(0);
    expect(await getAiRun(db, run.id)).toBeNull();
    expect(rowsOf(await db.query('SELECT id FROM _smrt_ai_usage'))).toEqual([]);
  });
});
