/**
 * A tracked call that answers without reporting tokens (#5489): a priced
 * call is charged the cost it reserved, its usage row records that cost and
 * says it is the reservation, and `maxCost` sees it. Usage that reports only
 * a total is priced at the higher of the model's two rates, never at zero.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { estimateAiUsageCost } from '../adapters/cost-rates.js';
import { config } from '../config.js';
import { AiRunStoppedError, getAiRun } from '../system/browser';
import { createTrackedAiClient } from '../tracked-ai-client.js';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** gpt-4o reservation of "hello" (2 input tokens) with maxTokens 100. */
const RESERVED_COST = (2 * 0.0025 + 100 * 0.01) / 1000;

type Usage = Record<string, number> | undefined;

/** The tracked client's methods these tests send through. */
interface StreamingClient {
  message(text: string, options?: unknown): Promise<unknown>;
  stream(text: string, options?: unknown): AsyncIterable<unknown>;
}

describe('tracked calls that report no tokens (#5489)', () => {
  const dbs: DatabaseInterface[] = [];
  let reported: Usage;

  async function memoryDb(): Promise<DatabaseInterface> {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    dbs.push(db);
    return db;
  }

  beforeEach(() => {
    config.reset();
    clearRuntimeConfig();
    reported = undefined;
    getAIMock.mockReset();
    getAIMock.mockImplementation(async (aiConfig: Record<string, unknown>) => {
      const emit = (operation: string, options: Record<string, unknown>) =>
        (aiConfig.onUsage as (event: unknown) => Promise<void>)({
          provider: 'openai',
          model: aiConfig.model,
          operation,
          // As the SDK's OpenAI-compatible stream: an event, no usage.
          usage: reported,
          duration: 2,
          tags: options.usageTags,
        });
      return {
        async message(_text: string, options: Record<string, unknown> = {}) {
          await emit('message', options);
          return 'answer';
        },
        async *stream(_text: string, options: Record<string, unknown> = {}) {
          yield 'part one ';
          yield 'part two';
          await emit('stream', options);
        },
      };
    });
  });

  afterEach(async () => {
    config.reset();
    clearRuntimeConfig();
    for (const db of dbs.splice(0)) {
      await (db as { close?: () => Promise<void> }).close?.();
    }
  });

  async function trackedRun(model: string, budget?: Record<string, number>) {
    const db = await memoryDb();
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-a',
      ai: { provider: 'openai', apiKey: 'sk-test', model } as never,
    });
    const run = await tracked.openRun({
      type: 'turn',
      ...(budget ? { budget } : {}),
    });
    const client = (await tracked.client(
      { promptKey: 'test.unreported' },
      { runContext: run.context },
    )) as unknown as StreamingClient;
    return { db, run, client };
  }

  async function drain(iterable: AsyncIterable<unknown>): Promise<string> {
    let text = '';
    for await (const chunk of iterable) text += String(chunk);
    return text;
  }

  it('charges a streamed call with no reported usage its reserved cost', async () => {
    const { db, run, client } = await trackedRun('gpt-4o');
    expect(
      await drain(client.stream('hello', { maxTokens: 100 } as never)),
    ).toBe('part one part two');
    const [row] = rowsOf(
      await db.query(
        'SELECT estimated_cost, total_tokens, tags FROM _smrt_ai_usage',
      ),
    );
    expect(Number(row?.estimated_cost)).toBeCloseTo(RESERVED_COST, 12);
    expect(row?.total_tokens ?? null).toBeNull();
    expect(JSON.parse(String(row?.tags))).toMatchObject({
      usageEstimate: 'reservation',
    });
    const totals = await getAiRun(db, run.run.id, { tenantId: 'tenant-a' });
    expect(totals?.costUsed).toBeCloseTo(RESERVED_COST, 12);
    expect(totals?.reservedCost).toBe(0);
    expect(totals?.uncostedCalls).toBe(0);
    expect(totals?.tokens).toBe(102);
  });

  it('stops a run at maxCost when its calls report no usage', async () => {
    const { client } = await trackedRun('gpt-4o', {
      maxCost: RESERVED_COST * 1.5,
    });
    await drain(client.stream('hello', { maxTokens: 100 } as never));
    await expect(
      drain(client.stream('hello', { maxTokens: 100 } as never)),
    ).rejects.toBeInstanceOf(AiRunStoppedError);
  });

  it('charges a message with no reported usage its reserved cost', async () => {
    const { db, client } = await trackedRun('gpt-4o');
    await client.message('hello', { maxTokens: 100 } as never);
    const [row] = rowsOf(
      await db.query('SELECT estimated_cost FROM _smrt_ai_usage'),
    );
    expect(Number(row?.estimated_cost)).toBeCloseTo(RESERVED_COST, 12);
  });

  it('records reported usage at its own cost, without the estimate tag', async () => {
    reported = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
    const { db, client } = await trackedRun('gpt-4o');
    await drain(client.stream('hello', { maxTokens: 100 } as never));
    const [row] = rowsOf(
      await db.query('SELECT estimated_cost, tags FROM _smrt_ai_usage'),
    );
    expect(Number(row?.estimated_cost)).toBeCloseTo(
      (10 * 0.0025 + 20 * 0.01) / 1000,
      12,
    );
    expect(JSON.parse(String(row?.tags))).not.toHaveProperty('usageEstimate');
  });

  it('keeps a call on an unpriced model uncosted', async () => {
    const { db, run, client } = await trackedRun('unpriced-model');
    await drain(client.stream('hello', { maxTokens: 100 } as never));
    const [row] = rowsOf(
      await db.query('SELECT estimated_cost FROM _smrt_ai_usage'),
    );
    expect(row?.estimated_cost ?? null).toBeNull();
    const totals = await getAiRun(db, run.run.id, { tenantId: 'tenant-a' });
    expect(totals?.uncostedCalls).toBe(1);
  });

  it('prices usage that reports only a total at the higher rate', async () => {
    expect(
      estimateAiUsageCost('openai', 'gpt-4o', { totalTokens: 1000 }),
    ).toBeCloseTo(0.01, 12);
    reported = { totalTokens: 1000 };
    const { db, client } = await trackedRun('gpt-4o');
    await client.message('hello', { maxTokens: 100 } as never);
    const [row] = rowsOf(
      await db.query('SELECT estimated_cost FROM _smrt_ai_usage'),
    );
    expect(Number(row?.estimated_cost)).toBeCloseTo(0.01, 12);
  });
});
