/**
 * Hosted spend from real calls (#5489): calls core sends on a hosted tier
 * binding through the tracked client are read back by the default spend
 * reader.
 */
import {
  createTrackedAiClient,
  type InferenceResolver,
  SmrtClass,
  setInferenceGate,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHostedAiSpendReader } from '../services/hosted-ai-spend.js';
import { getWindowForThreshold } from '../utils.js';

const TENANT = '7d9b9a8e-6a0b-4f33-9c55-2f4f0a3f9e02';

/** Every tier bound to `gpt-4o` (priced) as a binding of `source`. */
function binding(source: 'hosted' | 'byo'): InferenceResolver {
  return {
    resolve(request) {
      return {
        tierResolved:
          request.tier === 'auto' ? 'good' : (request.tier as 'good'),
        via: 'resolver',
        target: { model: 'gpt-4o', source },
      };
    },
  };
}

/**
 * A provider client that answers with its usage on the response (as a
 * `chat()` answer does): 100 prompt and 50 completion tokens, $0.00075 on
 * the default `openai:gpt-4o` rate.
 */
function answeringModel() {
  return {
    async embed() {
      return [];
    },
    async message(_text: string, _options: Record<string, unknown> = {}) {
      return {
        content: 'ok',
        model: 'gpt-4o',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    },
  };
}

describe('hosted spend meters tracked calls (#5489)', () => {
  let host: SmrtClass;
  let db: DatabaseInterface;

  beforeEach(async () => {
    host = new SmrtClass({ db: { type: 'sqlite', url: ':memory:' } });
    await (host as unknown as { initialize(): Promise<void> }).initialize();
    db = host.db as DatabaseInterface;
  });

  afterEach(async () => {
    setInferenceGate(undefined);
    setInferenceResolver(undefined);
    host.destroy();
    await db.close?.();
  });

  async function spend(): Promise<number> {
    const reader = createHostedAiSpendReader(db);
    const { spend } = await reader.summarize({
      tenantId: TENANT,
      window: getWindowForThreshold('month', new Date()),
    });
    return spend;
  }

  async function trackedCall(): Promise<void> {
    const tracked = createTrackedAiClient({
      db,
      tenantId: TENANT,
      ai: answeringModel() as never,
      label: { provider: 'openai', model: 'gpt-4o' },
    });
    const run = await tracked.openRun({ type: 'turn' });
    const client = await tracked.client(
      { promptKey: 'test.hosted.metered', tier: 'good' },
      { runContext: run.context },
    );
    await client.message('hello', { maxTokens: 64 } as never);
  }

  it('counts a tracked call on a hosted binding at its recorded cost', async () => {
    setInferenceResolver(binding('hosted'));
    await trackedCall();
    expect(await spend()).toBe(750);
  });

  it('does not count a tracked call on a byo binding', async () => {
    setInferenceResolver(binding('byo'));
    await trackedCall();
    expect(await spend()).toBe(0);
  });
});
