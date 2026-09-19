/**
 * Browser inference path (`ai.ts`).
 *
 * Two things this suite exists to pin, because both are easy to regress into
 * silently:
 *
 * 1. **Resolution is per call.** A path is held across a session and its
 *    `preference` changes underneath it, so every `chat`/`stream` must resolve
 *    at call time. A cached resolution would keep answering from a backend the
 *    caller has already switched away from — the whole point of the seam.
 * 2. **Truncation never becomes a reply.** The route contract always ends with
 *    `done` or `error`; a stream that closes cleanly without either is an
 *    intermediary cutting the connection, and must surface as a failure rather
 *    than a short (or empty) successful answer.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createInferencePath,
  createRouteInferenceBackend,
  type InferenceBackend,
  type InferenceChatOptions,
  type InferenceMessage,
  InferencePathError,
  type InferenceResponse,
  MAX_INFERENCE_REPLY_UNITS,
  MAX_INFERENCE_STREAM_BYTES,
  MAX_INFERENCE_STREAM_LINE_UNITS,
} from './ai.js';

const USER: InferenceMessage[] = [{ role: 'user', content: 'hi' }];

const OK_RESPONSE: InferenceResponse = { content: 'ok' };

interface BackendDouble extends InferenceBackend {
  calls: string[];
  fire(): void;
}

/** A backend that records every call and optionally emits status changes. */
function makeBackend(
  id: string,
  overrides: Partial<InferenceBackend> = {},
): BackendDouble {
  const calls: string[] = [];
  const subscribers = new Set<() => void>();
  const base: BackendDouble = {
    id,
    kind: 'route',
    status: 'ready',
    calls,
    fire() {
      for (const subscriber of [...subscribers]) subscriber();
    },
    async chat(messages) {
      calls.push(`chat:${(messages[0]?.content as string) ?? ''}`);
      return OK_RESPONSE;
    },
    async *stream(messages, options?: InferenceChatOptions) {
      calls.push(`stream:${(messages[0]?.content as string) ?? ''}`);
      options?.onProgress?.('chunk');
      yield 'chunk';
    },
    subscribe(listener: () => void) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    ...overrides,
  };
  return base;
}

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** An SSE response whose body emits exactly `chunks`, in order. */
function sseResponse(chunks: string[], onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function backendOver(
  response: Response | (() => Promise<Response>),
  overrides: Partial<Parameters<typeof createRouteInferenceBackend>[0]> = {},
) {
  const fetchImpl = vi.fn(
    typeof response === 'function' ? response : async () => response,
  );
  return {
    fetchImpl,
    backend: createRouteInferenceBackend({
      endpoint: '/api/chat',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...overrides,
    }),
  };
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

async function expectPathError(
  run: () => Promise<unknown>,
  code: InferencePathError['code'],
): Promise<InferencePathError> {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(InferencePathError);
  expect((error as InferencePathError).code).toBe(code);
  return error as InferencePathError;
}

describe('createInferencePath', () => {
  it('refuses an empty backend set', () => {
    expect(() => createInferencePath({ backends: [] })).toThrow(
      /requires at least one backend/,
    );
  });

  it('refuses duplicate backend ids before routing anything', () => {
    // A duplicate id makes `preference` ambiguous; picking one would silently
    // ignore the other, so the set is rejected whole.
    const first = makeBackend('route');
    const second = makeBackend('route');
    expect(() =>
      createInferencePath({ backends: [first, second] }),
    ).toThrowError(
      expect.objectContaining({ code: 'duplicate_backend' }) as Error,
    );
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([]);
  });

  it('auto-selects the first usable backend in declared order', async () => {
    const local = makeBackend('local', { kind: 'local' });
    const route = makeBackend('route');
    const path = createInferencePath({ backends: [local, route] });

    expect(path.activeId).toBe('local');
    await path.chat(USER);
    expect(local.calls).toEqual(['chat:hi']);
    expect(route.calls).toEqual([]);
  });

  it('auto-skips a backend that is not ready, and reports which it skipped', () => {
    const local = makeBackend('local', { kind: 'local', status: 'idle' });
    const route = makeBackend('route');
    const path = createInferencePath({ backends: [local, route] });

    // An unloaded local model must not be selected: selecting it would start a
    // model download mid-conversation.
    expect(path.resolve()).toMatchObject({
      reason: 'auto',
      skipped: ['local'],
    });
    expect(path.activeId).toBe('route');
  });

  it('throws rather than fabricating a reply when no backend is usable', async () => {
    const local = makeBackend('local', { status: 'idle' });
    const route = makeBackend('route', { status: 'unavailable' });
    const path = createInferencePath({ backends: [local, route] });

    await expectPathError(() => path.chat(USER), 'no_usable_backend');
    expect(path.activeId).toBeNull();
  });

  it('honors an explicit preference when that backend is usable', async () => {
    const local = makeBackend('local', { kind: 'local' });
    const route = makeBackend('route');
    const path = createInferencePath({
      backends: [local, route],
      preference: 'route',
    });

    expect(path.resolve()).toMatchObject({ reason: 'preferred' });
    await path.chat(USER);
    expect(route.calls).toEqual(['chat:hi']);
  });

  it('falls back from an unusable preference and names what it fell back from', async () => {
    const local = makeBackend('local', { kind: 'local', status: 'idle' });
    const route = makeBackend('route');
    const path = createInferencePath({
      backends: [local, route],
      preference: 'local',
    });

    expect(path.resolve()).toMatchObject({
      reason: 'fallback',
      requested: 'local',
    });
    await path.chat(USER);
    expect(route.calls).toEqual(['chat:hi']);
  });

  it('refuses a preference naming no backend', async () => {
    const path = createInferencePath({
      backends: [makeBackend('route')],
      preference: 'nope',
    });
    await expectPathError(() => path.chat(USER), 'unknown_backend');
  });

  it('re-resolves on every call, so a mid-session switch applies to the next one', async () => {
    const local = makeBackend('local', { kind: 'local' });
    const route = makeBackend('route');
    const path = createInferencePath({ backends: [local, route] });

    await path.chat(USER);
    path.select('route');
    expect(path.activeId).toBe('route');
    await path.chat(USER);
    path.select('auto');
    await path.stream(USER).next();

    expect(local.calls).toEqual(['chat:hi', 'stream:hi']);
    expect(route.calls).toEqual(['chat:hi']);
  });

  it('resolves a stream on pull, not on call', async () => {
    const route = makeBackend('route');
    const path = createInferencePath({ backends: [route] });

    const iterable = path.stream(USER);
    // Nothing has been pulled, so no request should have been started.
    expect(route.calls).toEqual([]);
    await iterable.next();
    expect(route.calls).toEqual(['stream:hi']);
  });

  it('re-broadcasts a backend status change to subscribers', () => {
    const route = makeBackend('route');
    const path = createInferencePath({ backends: [route] });
    const listener = vi.fn();

    const unsubscribe = path.subscribe(listener);
    route.fire();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('dispose detaches backend subscriptions and drops listeners', () => {
    const route = makeBackend('route');
    const path = createInferencePath({ backends: [route] });
    const listener = vi.fn();

    path.subscribe(listener);
    path.dispose();
    route.fire();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createRouteInferenceBackend', () => {
  it('yields token frames in order', async () => {
    const { backend } = backendOver(
      sseResponse([
        frame({ type: 'token', text: 'Hel' }),
        frame({ type: 'token', text: 'lo' }),
        frame({ type: 'done', message: { content: 'Hello' } }),
      ]),
    );

    await expect(collect(backend.stream(USER))).resolves.toEqual(['Hel', 'lo']);
  });

  it('reassembles frames split across chunk boundaries', async () => {
    const whole = frame({ type: 'token', text: 'split' });
    const { backend } = backendOver(
      sseResponse([
        `${whole.slice(0, 12)}`,
        whole.slice(12),
        frame({ type: 'done', message: { content: 'split' } }),
      ]),
    );

    await expect(collect(backend.stream(USER))).resolves.toEqual(['split']);
  });

  it('ignores heartbeats, blank lines, and unrecognized frame types', async () => {
    const { backend } = backendOver(
      sseResponse([
        ': heartbeat\n\n',
        '\n',
        frame({ type: 'emotion', name: 'happy' }),
        frame({ type: 'control', command: { action: 'focus' } }),
        frame({ type: 'token', text: 'a' }),
        frame({ type: 'now-invented-lane', payload: 1 }),
        frame({ type: 'done', message: { content: 'a' } }),
      ]),
    );

    // Forward compatibility: `chat-stream.ts` declares lanes the engine does
    // not emit yet, so an unknown frame must not fail the call.
    await expect(collect(backend.stream(USER))).resolves.toEqual(['a']);
  });

  it('surfaces an error frame as a failure', async () => {
    const { backend } = backendOver(
      sseResponse([frame({ type: 'error', error: 'model exploded' })]),
    );

    await expectPathError(
      () => collect(backend.stream(USER)),
      'route_stream_error',
    );
  });

  it('fails when the stream closes without a done frame', async () => {
    const { backend } = backendOver(
      sseResponse([frame({ type: 'token', text: 'partial' })]),
    );

    // Never fabricate a successful reply out of a truncation.
    const error = await expectPathError(
      () => collect(backend.stream(USER)),
      'route_stream_truncated',
    );
    expect(error.message).toMatch(/without a done frame/);
  });

  it('fails on an unparseable frame, quoting it', async () => {
    const { backend } = backendOver(sseResponse(['data: {not json\n\n']));
    await expectPathError(
      () => collect(backend.stream(USER)),
      'route_stream_error',
    );
  });

  it('carries status and body on a non-ok response', async () => {
    const { backend } = backendOver(
      new Response(JSON.stringify({ error: 'nope' }), { status: 401 }),
    );

    const error = await expectPathError(
      () => collect(backend.stream(USER)),
      'route_request_failed',
    );
    expect(error.message).toContain('401');
    expect(error.message).toContain('nope');
  });

  it('prefers the done frame content over the assembled tokens', async () => {
    const { backend } = backendOver(
      sseResponse([
        frame({ type: 'token', text: 'narrating before acting' }),
        frame({ type: 'done', message: { content: 'the real reply' } }),
      ]),
    );

    // Streamed tokens are a live preview; the `done` message is authoritative.
    await expect(backend.chat(USER)).resolves.toMatchObject({
      content: 'the real reply',
    });
  });

  it('falls back to assembled tokens when done carries no content', async () => {
    const { backend } = backendOver(
      sseResponse([
        frame({ type: 'token', text: 'as' }),
        frame({ type: 'token', text: 'sembled' }),
        frame({ type: 'done', message: {} }),
      ]),
    );

    await expect(backend.chat(USER)).resolves.toMatchObject({
      content: 'assembled',
    });
  });

  it('reports progress per token while streaming, and not from chat', async () => {
    const frames = [
      frame({ type: 'token', text: 'a' }),
      frame({ type: 'done', message: { content: 'a' } }),
    ];

    const onProgress = vi.fn();
    const { backend: streaming } = backendOver(sseResponse([...frames]));
    await collect(streaming.stream(USER, { onProgress }));
    expect(onProgress.mock.calls).toEqual([['a']]);

    const chatProgress = vi.fn();
    const { backend: chatting } = backendOver(sseResponse([...frames]));
    await chatting.chat(USER, { onProgress: chatProgress });
    expect(chatProgress).not.toHaveBeenCalled();
  });

  it('forwards the caller signal to fetch', async () => {
    const controller = new AbortController();
    const { backend, fetchImpl } = backendOver(
      sseResponse([frame({ type: 'done', message: { content: '' } })]),
    );

    await collect(backend.stream(USER, { signal: controller.signal }));
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('releases the connection when a consumer abandons the stream', async () => {
    let cancelled = false;
    const { backend } = backendOver(
      sseResponse(
        [
          frame({ type: 'token', text: 'a' }),
          frame({ type: 'token', text: 'b' }),
        ],
        () => {
          cancelled = true;
        },
      ),
    );

    for await (const _chunk of backend.stream(USER)) break;
    expect(cancelled).toBe(true);
  });

  it('sends messages and session metadata on the request body', async () => {
    const { backend, fetchImpl } = backendOver(
      sseResponse([frame({ type: 'done', message: { content: 'ok' } })]),
      { session: { chatRoomId: 'room-1' } },
    );

    await collect(backend.stream(USER));
    const sent = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(sent.body as string)).toEqual({
      messages: USER,
      session: { chatRoomId: 'room-1' },
    });
  });

  it('fails on a frame whose JSON is not an object', async () => {
    // `null`, `3`, `"x"` and arrays are all valid JSON and none of them is a
    // frame. Accepting one and completing on a later `done` would report a
    // successful answer for a response that was never well formed.
    const { backend } = backendOver(
      sseResponse([
        'data: null\n\n',
        frame({ type: 'token', text: 'a' }),
        frame({ type: 'done', message: { content: 'a' } }),
      ]),
    );

    await expect(collect(backend.stream(USER))).rejects.toMatchObject({
      name: 'InferencePathError',
      code: 'route_stream_error',
    });
  });

  it('fails on an array frame', async () => {
    const { backend } = backendOver(sseResponse(['data: [1,2]\n\n']));

    await expect(collect(backend.stream(USER))).rejects.toMatchObject({
      code: 'route_stream_error',
    });
  });

  it('fails on a valid frame over the line cap before decoding it', async () => {
    // Terminated, so the unterminated-buffer guard never sees it — and valid
    // JSON, so a post-parse check would already have materialized it.
    const oversized = frame({
      type: 'token',
      text: 'x'.repeat(MAX_INFERENCE_STREAM_LINE_UNITS + 10),
    });
    const { backend } = backendOver(sseResponse([oversized]));

    await expect(collect(backend.stream(USER))).rejects.toMatchObject({
      code: 'route_stream_error',
    });
  });

  it('fails on an unterminated frame larger than the line cap', async () => {
    const { backend } = backendOver(
      sseResponse([
        `data: ${'x'.repeat(MAX_INFERENCE_STREAM_LINE_UNITS + 10)}`,
      ]),
    );

    // Without the cap this buffer grows until the tab dies, and the
    // indexOf/slice rescan over it becomes quadratic.
    await expectPathError(
      () => collect(backend.stream(USER)),
      'route_stream_error',
    );
  });

  it('yields the remainder when the authoritative reply extends the preview', async () => {
    const { backend } = backendOver(
      sseResponse([
        frame({ type: 'token', text: 'Hel' }),
        frame({ type: 'done', message: { content: 'Hello' } }),
      ]),
    );

    // A consumer concatenates deltas, so the terminal reply has to arrive as
    // the part it has not seen rather than as a duplicate of it.
    await expect(collect(backend.stream(USER))).resolves.toEqual(['Hel', 'lo']);
  });

  it('yields the authoritative reply when no token was streamed', async () => {
    const { backend } = backendOver(
      sseResponse([frame({ type: 'done', message: { content: 'Reply' } })]),
    );

    // Dropping it would leave an empty delta stream, which a consumer reads as
    // a failed, empty reply.
    await expect(collect(backend.stream(USER))).resolves.toEqual(['Reply']);
  });

  it('surfaces the authoritative reply when it does not extend the preview', async () => {
    const { backend } = backendOver(
      sseResponse([
        frame({ type: 'token', text: 'narration ' }),
        frame({ type: 'done', message: { content: 'The answer.' } }),
      ]),
    );

    // The preview may have narrated past a tool-call round. A delta stream
    // cannot retract it, so the answer is surfaced rather than dropped.
    await expect(collect(backend.stream(USER))).resolves.toEqual([
      'narration ',
      'The answer.',
    ]);
  });

  it('fails when the terminal reply exceeds the reply cap', async () => {
    const { backend } = backendOver(
      sseResponse([
        frame({
          type: 'done',
          message: { content: 'x'.repeat(MAX_INFERENCE_REPLY_UNITS + 1) },
        }),
      ]),
    );

    // The cap is enforced on the authoritative content too, not only on the
    // tokens it replaces.
    await expectPathError(() => backend.chat(USER), 'route_stream_error');
  });

  it('stops reading a failed response body at the excerpt', async () => {
    // A body the reader must stop pulling from: `response.text()` would consume
    // every chunk before any excerpt could bound the result.
    let pulled = 0;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode('e'.repeat(1_000)));
      },
    });
    const { backend } = backendOver(new Response(body, { status: 500 }));

    const error = await backend.chat(USER).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({
      name: 'InferencePathError',
      code: 'route_request_failed',
    });
    // Enough for the 200-character excerpt, nowhere near the whole body.
    expect(pulled).toBeLessThan(5);
  });

  it('fails when the stream exceeds the total byte cap', async () => {
    // Chunked with newlines so each line is legal, but the total is not.
    const chunk = `${'y'.repeat(1_000_000)}\n`;
    const chunks = Array.from(
      { length: Math.ceil(MAX_INFERENCE_STREAM_BYTES / chunk.length) + 1 },
      () => chunk,
    );
    const { backend } = backendOver(sseResponse(chunks));

    await expectPathError(
      () => collect(backend.stream(USER)),
      'route_stream_error',
    );
  });

  it('fails on a read error rather than leaking the raw rejection', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(frame({ type: 'token', text: 'a' })),
        );
        controller.error(new Error('socket reset'));
      },
    });
    const { backend } = backendOver(new Response(body, { status: 200 }));

    const error = await expectPathError(
      () => collect(backend.stream(USER)),
      'route_stream_error',
    );
    expect(error.message).toContain('socket reset');
  });

  it('reports a transport rejection as a route failure', async () => {
    const { backend } = backendOver(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    );

    const error = await expectPathError(
      () => collect(backend.stream(USER)),
      'route_request_failed',
    );
    expect(error.message).toContain('Failed to fetch');
  });

  it('enforces the per-call timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const backend = createRouteInferenceBackend({
      endpoint: '/api/chat',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // A stream that never closes must not hang the caller forever.
    await expectPathError(
      () => collect(backend.stream(USER, { timeout: 20 })),
      'route_request_failed',
    );
  });

  it('refuses tool definitions and tool turns', async () => {
    // The route's own wire contract DROPS these, so forwarding them would
    // answer a different question than the caller asked.
    const { backend, fetchImpl } = backendOver(
      sseResponse([frame({ type: 'done', message: { content: 'ok' } })]),
    );

    await expectPathError(
      () =>
        backend.chat(USER, {
          tools: [{ type: 'function', function: { name: 'product_list' } }],
        }),
      'unsupported_message',
    );
    await expectPathError(
      () => backend.chat([{ role: 'tool', content: '{"rows":[]}' }]),
      'unsupported_message',
    );
    await expectPathError(
      () =>
        backend.chat([
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'x', arguments: '{}' },
              },
            ],
          },
        ]),
      'unsupported_message',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
