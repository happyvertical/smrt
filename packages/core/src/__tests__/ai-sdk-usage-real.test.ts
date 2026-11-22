/**
 * Parts mode against the real `@happyvertical/ai` (sdk#1585, #5516): a
 * client built by the SDK's own `getAI()` declares `usageFeatures.parts`, its
 * usage events carry a `part`, and its responses carry `usageParts`. The SDK
 * talks to a local OpenAI-compatible endpoint; nothing is mocked in core or
 * in the SDK. A reply continued on the output limit is billed the sum of its
 * parts.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../config';
import { createTrackedAiClient } from '../tracked-ai-client';
import { readOnlyCall, runTotals } from './fixtures/ai-call-ledger-harness';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
} from './fixtures/ai-run-test-db';

/** Replies the endpoint gives, in order, then repeats the last. */
let replies: Array<{
  content: string;
  finish: string;
  usage?: { prompt: number; completion: number };
}> = [];
let requests = 0;
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const reply = replies[Math.min(requests, replies.length - 1)];
      requests++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: `chatcmpl-${requests}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: reply?.content ?? '' },
              finish_reason: reply?.finish ?? 'stop',
            },
          ],
          ...(reply?.usage
            ? {
                usage: {
                  prompt_tokens: reply.usage.prompt,
                  completion_tokens: reply.usage.completion,
                  total_tokens: reply.usage.prompt + reply.usage.completion,
                },
              }
            : {}),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  config.reset();
  requests = 0;
  await closeAiRunTestDatabases();
});

async function trackedClient(engine: (typeof aiRunTestEngines)[number]) {
  const db = await newAiRunTestDatabase(engine);
  const tracked = createTrackedAiClient({
    db,
    tenantId: 'tenant-a',
    ai: {
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl,
      model: 'gpt-4o',
      maxRetries: 0,
    } as never,
    usage: { costRates: { 'openai:gpt-4o': { input: 1, output: 2 } } } as never,
  });
  const { run, context } = await tracked.openRun({ type: 'turn' });
  const client = (await tracked.client(
    { promptKey: 'real.sdk' },
    { runContext: context },
  )) as unknown as {
    chat(messages: unknown, options?: unknown): Promise<unknown>;
  };
  return { db, run, client };
}

describe.each(
  aiRunTestEngines,
)('parts mode on the real SDK on %s', (engine) => {
  it('a one-request reply is complete and billed its counts', async () => {
    replies = [
      { content: 'hi', finish: 'stop', usage: { prompt: 6, completion: 4 } },
    ];
    const { db, run, client } = await trackedClient(engine);
    const response = (await client.chat([
      { role: 'user', content: 'hello' },
    ])) as {
      usageParts?: { complete: boolean };
    };
    expect(response.usageParts?.complete).toBe(true);
    const call = await readOnlyCall(db, run.id);
    expect(call.callUsage?.mode).toBe('parts');
    expect(call).toMatchObject({ usageSource: 'complete', chargedTokens: 10 });
    expect(call.chargedCost).toBeCloseTo((6 * 1 + 4 * 2) / 1000, 12);
    expect((await runTotals(db, run.id)).tokens).toBe(10);
  });

  it('a reply continued on the output limit is billed the sum of its parts', async () => {
    replies = [
      {
        content: 'part one ',
        finish: 'length',
        usage: { prompt: 6, completion: 4 },
      },
      {
        content: 'part two',
        finish: 'stop',
        usage: { prompt: 9, completion: 3 },
      },
    ];
    const { db, run, client } = await trackedClient(engine);
    const response = (await client.chat([{ role: 'user', content: 'hello' }], {
      continueOnLength: true,
    })) as {
      content: string;
      usageParts?: { complete: boolean; parts: unknown[] };
    };
    expect(requests).toBe(2);
    expect(response.usageParts?.parts).toHaveLength(2);
    const call = await readOnlyCall(db, run.id);
    expect(call).toMatchObject({ usageSource: 'complete', chargedTokens: 22 });
    const rows = rowsOf(
      await db.query(
        'SELECT total_tokens FROM _smrt_ai_usage WHERE run_id = $1',
        run.id,
      ),
    );
    expect(rows.map((row) => Number(row.total_tokens))).toEqual([22]);
  });

  it('a request whose provider reported no counts is charged provisionally', async () => {
    replies = [{ content: 'hi', finish: 'stop' }];
    const { db, run, client } = await trackedClient(engine);
    await client.chat([{ role: 'user', content: 'hello' }]);
    const call = await readOnlyCall(db, run.id);
    expect(call.callUsage?.mode).toBe('parts');
    expect(call.usageSource).toBe('provisional');
  });
});
