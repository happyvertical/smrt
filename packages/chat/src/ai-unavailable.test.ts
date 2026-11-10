/**
 * Chat answers a structured `unavailable` message instead of a 500 when AI
 * is off or not set up (#4757): the stream handler (503 before streaming,
 * an in-band `error` event with `code: 'ai_unavailable'` mid-turn), the
 * browser client (typed `ChatUnavailableError`), and the dev text route.
 */
import type { AIInterface } from '@happyvertical/ai';
import {
  InferenceUnavailableError,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatUnavailableBody } from './ai-unavailable.js';
import { createChatStreamHandler } from './chat-stream.js';
import {
  type ChatClientMessage,
  ChatUnavailableError,
  readChatUnavailableStatus,
  SmrtChatBackend,
} from './client.js';
import { POST as devChatPost } from './routes/api/dev-chat/+server.js';

const offError = () =>
  new InferenceUnavailableError({ reason: 'off', tier: 'good' });

function streamRequest(): Request {
  return new Request('http://local/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)));
}

function sendWith(fetchImpl: typeof fetch): Promise<Error> {
  return new Promise((resolve, reject) => {
    new SmrtChatBackend({ endpoint: '/api/chat', fetchImpl }).send(
      [{ id: '1', role: 'user', content: 'hi' } as ChatClientMessage],
      {
        onToken: () => {},
        onDone: () => reject(new Error('expected an error')),
        onError: resolve,
      },
    );
  });
}

afterEach(() => {
  setInferenceResolver(undefined);
});

describe('#4757 chat unavailable answers', () => {
  it('builds the body from the typed error only, with no stack or detail', () => {
    expect(chatUnavailableBody(offError())).toEqual({
      type: 'unavailable',
      code: 'ai_unavailable',
      error: 'AI is turned off.',
      unavailable: {
        available: false,
        mode: 'off',
        reason: 'off',
        tier: 'good',
      },
    });
    expect(chatUnavailableBody(new Error('boom'))).toBeUndefined();
    // Another core copy's error is recognised by code and reason.
    expect(
      chatUnavailableBody({ code: 'AI_UNAVAILABLE', reason: 'unconfigured' }),
    ).toMatchObject({ unavailable: { reason: 'unconfigured' } });
  });

  it('the stream handler answers 503 when authorize finds AI unavailable', async () => {
    const handler = createChatStreamHandler({
      authorize: () => {
        throw offError();
      },
    });
    const response = await handler(streamRequest());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      type: 'unavailable',
      code: 'ai_unavailable',
      unavailable: { reason: 'off' },
    });
    expect(JSON.stringify(body)).not.toContain('stack');
  });

  it('a mid-turn unavailable error is an in-band event with the status', async () => {
    const ai = {
      // biome-ignore lint/correctness/useYield: throws before yielding
      async *stream() {
        throw offError();
      },
    } as unknown as AIInterface;
    const handler = createChatStreamHandler({ authorize: () => ({ ai }) });
    const events = parseSse(await (await handler(streamRequest())).text());
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: 'AI is turned off.',
      code: 'ai_unavailable',
      unavailable: {
        available: false,
        mode: 'off',
        reason: 'off',
        tier: 'good',
      },
    });
  });

  it('the browser client raises ChatUnavailableError for both shapes', async () => {
    const body = chatUnavailableBody(offError());
    const refused = await sendWith(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    expect(refused).toBeInstanceOf(ChatUnavailableError);
    expect((refused as ChatUnavailableError).unavailable.reason).toBe('off');

    const frame = {
      type: 'error',
      error: body?.error,
      code: body?.code,
      unavailable: body?.unavailable,
    };
    const inBand = await sendWith(
      vi.fn().mockResolvedValue(
        new Response(`data: ${JSON.stringify(frame)}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    expect(inBand).toBeInstanceOf(ChatUnavailableError);

    expect(readChatUnavailableStatus({ code: 'other' })).toBeUndefined();
    expect(
      readChatUnavailableStatus({
        code: 'ai_unavailable',
        unavailable: { reason: 'entitlement', mode: 'hosted', tier: 'x' },
      }),
    ).toEqual({ available: false, mode: 'hosted', reason: 'entitlement' });
  });

  it('the dev text route answers the structured message when AI is off', async () => {
    const saved = process.env.SMRT_CHAT_DEV_PROVIDER;
    process.env.SMRT_CHAT_DEV_PROVIDER = 'ollama';
    setInferenceResolver({
      resolve: (request) => ({
        tierResolved: request.tier === 'auto' ? 'good' : request.tier,
        target: {},
        via: 'resolver',
        mode: 'off',
        unavailable: 'off',
      }),
    });
    try {
      const response = await devChatPost({
        request: new Request('http://local/api/dev-chat', {
          method: 'POST',
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        }),
      } as never);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        type: 'unavailable',
        unavailable: { reason: 'off' },
      });
    } finally {
      if (saved === undefined) delete process.env.SMRT_CHAT_DEV_PROVIDER;
      else process.env.SMRT_CHAT_DEV_PROVIDER = saved;
    }
  });
});
