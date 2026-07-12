/**
 * Token-streaming conversation endpoint (#1936).
 *
 * The plain/unbound path and the Fetch handler are exercised with a mock AI
 * boundary (only the AI is mocked). The persona-bound path runs the real
 * `runPersonaConversationTurn` against real in-memory SQLite, streaming the
 * model's deltas through the tool loop and asserting the persisted reply is
 * emitted as the final `done` frame.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AIInterface, AIMessage, ChatOptions } from '@happyvertical/ai';
import {
  MembershipCollection,
  RoleCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChatStreamContext,
  type ChatStreamEvent,
  ChatStreamUnauthorizedError,
  createChatStreamHandler,
  encodeChatStreamEvent,
  runChatConversationStream,
} from './chat-stream.js';
import {
  bindPersonaToSession,
  type ConversationPersona,
} from './persona-conversation.js';
import { ChatService } from './services/index.js';

// ---------------------------------------------------------------------------
// Mock AI boundary
// ---------------------------------------------------------------------------

/**
 * A mock AI that streams `chunks`: `stream()` yields them (plain path) and
 * `chat()` forwards them through `onProgress` (persona path), resolving the
 * joined content.
 */
function makeStreamAI(chunks: string[]): AIInterface {
  return {
    async *stream() {
      for (const chunk of chunks) yield chunk;
    },
    async chat(_messages: AIMessage[], options?: ChatOptions) {
      for (const chunk of chunks) options?.onProgress?.(chunk);
      return { content: chunks.join(''), finishReason: 'stop' };
    },
  } as unknown as AIInterface;
}

async function collect(
  events: AsyncGenerator<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Parse an SSE `text/event-stream` body into its decoded events. */
function parseSse(text: string): ChatStreamEvent[] {
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map(
      (frame) => JSON.parse(frame.slice('data: '.length)) as ChatStreamEvent,
    );
}

// ---------------------------------------------------------------------------
// Plain / unbound path
// ---------------------------------------------------------------------------

describe('runChatConversationStream — plain path', () => {
  it('streams token deltas then a synthesized done message', async () => {
    const context: ChatStreamContext = { ai: makeStreamAI(['Hel', 'lo!']) };
    const events = await collect(
      runChatConversationStream({
        context,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens.map((t) => (t as { text: string }).text)).toEqual([
      'Hel',
      'lo!',
    ]);
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect(
      done && (done as { message: { content: string } }).message.content,
    ).toBe('Hello!');
    expect(done && (done as { message: { role: string } }).message.role).toBe(
      'assistant',
    );
  });

  it('emits an error event when no user message is present', async () => {
    const context: ChatStreamContext = { ai: makeStreamAI(['unused']) };
    const events = await collect(
      runChatConversationStream({
        context,
        messages: [{ role: 'assistant', content: 'earlier reply' }],
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  it('surfaces a mid-stream provider failure as an error event', async () => {
    const ai = {
      // biome-ignore lint/correctness/useYield: the stub throws before yielding.
      async *stream() {
        throw new Error('provider exploded');
      },
    } as unknown as AIInterface;
    const events = await collect(
      runChatConversationStream({
        context: { ai },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: 'provider exploded',
    });
  });

  it('threads prior turns as history and answers the latest user message', async () => {
    const seen: AIMessage[][] = [];
    const ai = {
      async *stream(messages: AIMessage[]) {
        seen.push(messages);
        yield 'ok';
      },
    } as unknown as AIInterface;

    await collect(
      runChatConversationStream({
        context: { ai, systemPrompt: 'Be terse.' },
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
        ],
      }),
    );

    const sent = seen[0];
    expect(sent[0]).toEqual({ role: 'system', content: 'Be terse.' });
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'second' });
    // The prior user+assistant turns are carried as history.
    expect(
      sent.some((m) => m.role === 'assistant' && m.content === 'reply'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSE frame encoding
// ---------------------------------------------------------------------------

describe('encodeChatStreamEvent', () => {
  it('serializes an event as a single SSE data frame', () => {
    expect(encodeChatStreamEvent({ type: 'token', text: 'hi' })).toBe(
      'data: {"type":"token","text":"hi"}\n\n',
    );
  });
});

// ---------------------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------------------

describe('createChatStreamHandler', () => {
  const okAuthorize = () => ({ ai: makeStreamAI(['hi ', 'there']) });

  it('streams an end-to-end SSE response for the plain path', async () => {
    const handler = createChatStreamHandler({ authorize: okAuthorize });
    const res = await handler(
      new Request('http://local/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'yo' }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const events = parseSse(await res.text());
    expect(events.filter((e) => e.type === 'token')).toHaveLength(2);
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect((done as { message: { content: string } }).message.content).toBe(
      'hi there',
    );
  });

  it('emits SSE keep-alive heartbeats while a turn is quiet', async () => {
    // Gate the AI stream so the turn goes quiet after the first token; the
    // heartbeat must keep bytes flowing so an idle proxy can't drop the stream.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ai = {
      async *stream() {
        yield 'a';
        await gate;
        yield 'b';
      },
    } as unknown as AIInterface;
    const handler = createChatStreamHandler({
      authorize: () => ({ ai }),
      heartbeatMs: 10,
    });
    const res = await handler(
      new Request('http://local/api/chat/stream', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !text.includes(': heartbeat')) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value);
    }
    expect(text).toContain(': heartbeat');
    release();
    await reader.cancel();
  });

  it('returns 405 for a non-POST method', async () => {
    const handler = createChatStreamHandler({ authorize: okAuthorize });
    const res = await handler(
      new Request('http://local/api/chat/stream', { method: 'GET' }),
    );
    expect(res.status).toBe(405);
  });

  it('returns 400 for a non-JSON body', async () => {
    const handler = createChatStreamHandler({ authorize: okAuthorize });
    const res = await handler(
      new Request('http://local/api/chat/stream', {
        method: 'POST',
        body: 'not json{',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('maps an authorize rejection to its status before streaming', async () => {
    const handler = createChatStreamHandler({
      authorize: () => {
        throw new ChatStreamUnauthorizedError('nope');
      },
    });
    const res = await handler(
      new Request('http://local/api/chat/stream', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('nope');
    expect(body.code).toBe('chat_stream_unauthorized');
  });

  describe('cross-origin CORS (#1861 posture)', () => {
    const corsHandler = () =>
      createChatStreamHandler({
        authorize: okAuthorize,
        allowedOrigins: ['https://widget.example'],
        allowCredentials: true,
      });

    it('answers a credentialed preflight for an allow-listed origin', async () => {
      const res = await corsHandler()(
        new Request('http://local/api/chat/stream', {
          method: 'OPTIONS',
          headers: { origin: 'https://widget.example' },
        }),
      );
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(
        'https://widget.example',
      );
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('rejects a preflight from a non-allow-listed origin', async () => {
      const res = await corsHandler()(
        new Request('http://local/api/chat/stream', {
          method: 'OPTIONS',
          headers: { origin: 'https://evil.example' },
        }),
      );
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('echoes credentials on the streamed response for an allow-listed origin', async () => {
      const res = await corsHandler()(
        new Request('http://local/api/chat/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            origin: 'https://widget.example',
          },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        }),
      );
      expect(res.headers.get('access-control-allow-origin')).toBe(
        'https://widget.example',
      );
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      await res.text();
    });
  });
});

// ---------------------------------------------------------------------------
// Persona-bound path (real harness, mock AI)
// ---------------------------------------------------------------------------

describe('runChatConversationStream — persona-bound path', () => {
  let dbPath: string;
  // A file-backed sqlite CONFIG object (not an instance), so the principal
  // context's re-resolved handle points at the same db — and so the file needs
  // no direct `@happyvertical/sql` import (unavailable in agent worktrees).
  let db: { type: 'sqlite'; url: string };
  let tenantId: string;
  let userId: string;
  let persona: ConversationPersona;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-chat-stream-${Date.now()}-${Math.random()}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    const options = { db };

    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const user = await users.create({ email: 'stream@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'Stream Org' });
    await tenant.save();
    const role = await roles.create({ name: 'Stream Persona' });
    await role.save();
    await (
      await memberships.create({
        userId: user.id,
        tenantId: tenant.id,
        roleId: role.id,
      })
    ).save();

    userId = user.id as string;
    tenantId = tenant.id as string;
    persona = {
      id: 'persona-stream-1',
      tenantId,
      agentClass: '@happyvertical/smrt-agents:Praeco',
      runAsUserId: userId,
      // Empty allow-list keeps the turn a single completion (no tool rows).
      allowedTools: [],
      instructions: 'Answer briefly.',
      memoryScope: `stream:${tenantId}`,
    };
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  it('streams the turn tokens then the persisted assistant message as done', async () => {
    const chatService = await ChatService.create({ tenantId, db });
    await chatService.initialize();
    const { session } = await chatService.createAgentSession({
      tenantId,
      agentId: 'stream-agent',
      actorProfileId: 'human-profile',
    });
    const bound = await bindPersonaToSession({
      chatService,
      session,
      actorProfileId: 'human-profile',
      tenantId,
      persona,
    });

    const context: ChatStreamContext = {
      ai: makeStreamAI(['Sure', ', done.']),
      binding: {
        chatService,
        db,
        persona,
        session: bound,
        tenantId,
        recall: false,
      },
    };

    const events = await collect(
      runChatConversationStream({
        context,
        messages: [{ role: 'user', content: 'help me' }],
      }),
    );

    // Tokens streamed live through the tool loop's onToken sink.
    expect(
      events
        .filter((e) => e.type === 'token')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Sure, done.');

    // The final done frame carries the PERSISTED assistant message.
    const done = events.at(-1) as {
      type: 'done';
      message: { id?: string; content: string };
    };
    expect(done.type).toBe('done');
    expect(done.message.content).toBe('Sure, done.');
    expect(done.message.id).toBeTruthy();

    // It was actually authored into the bound room.
    const roomMessages = await chatService.getRoomMessages({
      roomId: bound.chatRoomId as string,
      actorProfileId: 'human-profile',
      tenantId,
      limit: 50,
    });
    expect(
      roomMessages.some(
        (m) => m.role === 'assistant' && m.content === 'Sure, done.',
      ),
    ).toBe(true);
  });
});
