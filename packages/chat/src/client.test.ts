import { describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent, ChatStreamSession } from './chat-stream.js';
import type {
  ChatClientMessage,
  ChatClientStreamFrame,
  SmrtChatSession,
} from './client.js';
import { SmrtChatBackend } from './client.js';

/**
 * Compile-time contract locks (enforced by `pnpm typecheck`): the client must
 * stay a strict consumer of the wire contract `chat-stream.ts` owns.
 */
// Every frame the server can emit parses as a client frame…
const _frameCompat = (event: ChatStreamEvent): ChatClientStreamFrame => event;
void _frameCompat;
// …and the client's session binding is a valid wire session.
const _sessionCompat = (
  session: Required<SmrtChatSession>,
): ChatStreamSession => session;
void _sessionCompat;

let counter = 0;
const msg = (
  role: ChatClientMessage['role'],
  content: string,
): ChatClientMessage => ({
  id: `test-${++counter}`,
  role,
  content,
  createdAt: new Date().toISOString(),
});

/**
 * Build a `text/event-stream` Response. Each entry is either an object
 * (encoded as one `data:` frame) or a raw string chunk (emitted verbatim —
 * lets tests exercise heartbeat comments and frames split across chunks).
 */
function sseResponse(parts: Array<object | string>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const p of parts) {
        controller.enqueue(
          enc.encode(
            typeof p === 'string' ? p : `data: ${JSON.stringify(p)}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const run = (
  fetchImpl: typeof fetch,
): Promise<{
  tokens: string[];
  emotions: string[];
  done: ChatClientMessage;
}> =>
  new Promise((resolve, reject) => {
    const tokens: string[] = [];
    const emotions: string[] = [];
    new SmrtChatBackend({ endpoint: '/api/chat', fetchImpl }).send(
      [msg('user', 'hi')],
      {
        onToken: (t) => tokens.push(t),
        onEmotion: (n) => emotions.push(n),
        onDone: (done) => resolve({ tokens, emotions, done }),
        onError: reject,
      },
    );
  });

describe('SmrtChatBackend', () => {
  it('strips the inline emotion cue from the done message and surfaces it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        { type: 'token', text: 'Hello there' },
        { type: 'token', text: ' [emotion:heart]' },
        {
          type: 'done',
          message: msg('assistant', 'Hello there [emotion:heart]'),
        },
      ]),
    );
    const { tokens, emotions, done } = await run(
      fetchImpl as unknown as typeof fetch,
    );
    // Raw tokens are forwarded as-is (the widget strips them live); the done
    // message the thread/history keeps is cue-free, and the character still
    // emotes.
    expect(tokens.join('')).toBe('Hello there [emotion:heart]');
    expect(done.content).toBe('Hello there');
    expect(emotions).toContain('heart');
  });

  it('preserves the server message identity on done', async () => {
    const server = msg('assistant', 'Hi! [emotion:wink]');
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        { type: 'token', text: 'Hi!' },
        { type: 'done', message: server },
      ]),
    );
    const { done } = await run(fetchImpl as unknown as typeof fetch);
    // Same persisted id/createdAt, cue-free content — reconcilable with
    // server-fetched room history.
    expect(done.id).toBe(server.id);
    expect(done.createdAt).toBe(server.createdAt);
    expect(done.content).toBe('Hi!');
  });

  it('fills id/createdAt when the wire done message omits them', async () => {
    // The wire shape (ChatStreamMessage) has optional id/createdAt; the
    // widget shape does not — the client must fill them, never pass holes.
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        { type: 'token', text: 'Hello' },
        { type: 'done', message: { role: 'assistant', content: 'Hello' } },
      ]),
    );
    const { done } = await run(fetchImpl as unknown as typeof fetch);
    expect(done.content).toBe('Hello');
    expect(done.id).toBeTruthy();
    expect(done.createdAt).toBeTruthy();
  });

  it('ignores heartbeats and reassembles frames split across chunks', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        ': heartbeat\n\n',
        'data: {"type":"tok', // frame split mid-JSON across two chunks
        'en","text":"Hel"}\n\n',
        ': heartbeat\n\n',
        { type: 'token', text: 'lo' },
        { type: 'done' },
      ]),
    );
    const { tokens, done } = await run(fetchImpl as unknown as typeof fetch);
    expect(tokens.join('')).toBe('Hello');
    expect(done.content).toBe('Hello');
  });

  it('surfaces an error frame and stops consuming afterwards', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        { type: 'token', text: 'partial' },
        { type: 'error', error: 'model exploded' },
        { type: 'done', message: msg('assistant', 'too late') },
      ]),
    );
    const onDone = vi.fn();
    const error = await new Promise<Error>((resolve) => {
      new SmrtChatBackend({
        endpoint: '/api/chat',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).send([msg('user', 'hi')], {
        onToken: () => undefined,
        onDone,
        onError: resolve,
      });
    });
    expect(error.message).toMatch(/model exploded/);
    await new Promise((r) => setTimeout(r, 10));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('treats a clean close without done as an error, never an empty reply', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse([{ type: 'token', text: 'cut off' }]));
    await expect(
      run(fetchImpl as unknown as typeof fetch),
    ).rejects.toThrowError(/without a done frame/);
  });

  it('carries the response body detail on HTTP failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Unauthorized',
          code: 'chat_stream_unauthorized',
        }),
        { status: 401 },
      ),
    );
    await expect(
      run(fetchImpl as unknown as typeof fetch),
    ).rejects.toThrowError(/401.*chat_stream_unauthorized/);
  });

  it('cancel aborts silently (no onError, no onDone)', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          capturedSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const onError = vi.fn();
    const onDone = vi.fn();
    const handle = new SmrtChatBackend({
      endpoint: '/api/chat',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).send([msg('user', 'hi')], {
      onToken: () => undefined,
      onDone,
      onError,
    });
    handle.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedSignal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('passes the credentials mode and bearer token through to fetch', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse([{ type: 'done' }]));
    await new Promise<void>((resolve, reject) => {
      new SmrtChatBackend({
        endpoint: '/api/chat',
        credentials: 'include',
        token: 'session-123',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).send([msg('user', 'hi')], {
        onToken: () => undefined,
        onDone: () => resolve(),
        onError: reject,
      });
    });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer session-123',
    );
  });
});
