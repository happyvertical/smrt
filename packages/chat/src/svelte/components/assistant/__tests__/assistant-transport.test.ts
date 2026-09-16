// @vitest-environment jsdom
/**
 * Coverage for assistant-transport.ts's implementations directly (not
 * through the controller) — #2904 review, Copilot PR #2919.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryAssistantTransport,
  createSmrtAssistantTransport,
  normalizeAssistantMessage,
  normalizeAssistantThreadSummary,
  sortAssistantMessagesChronologically,
} from '../assistant-transport.js';

describe('createInMemoryAssistantTransport', () => {
  // jAwu8: simulateInProgressOnce alone left the turn pending forever;
  // resolveInProgressAfterLoads makes the resolution point configurable.
  it('resolveInProgressAfterLoads appends the assistant reply on the Nth loadMessages() call', async () => {
    const transport = createInMemoryAssistantTransport({
      simulateInProgressOnce: true,
      resolveInProgressAfterLoads: 2,
      respond: (threadId, userMessage) => ({
        id: 'reply-1',
        threadId,
        content: `reply to: ${userMessage.content}`,
        role: 'assistant',
        createdAt: new Date(),
      }),
    });
    const thread = await transport.createThread('t1');
    const result = await transport.sendMessage({
      threadId: thread.id,
      content: 'hello',
      clientRequestId: 'req-1',
    });
    expect(result.inProgress).toBe(true);

    // First load: still 1 load remaining, no reply yet.
    let messages = await transport.loadMessages(thread.id);
    expect(messages.some((m) => m.role === 'assistant')).toBe(false);

    // Second load: resolves.
    messages = await transport.loadMessages(thread.id);
    const reply = messages.find((m) => m.role === 'assistant');
    expect(reply?.content).toBe('reply to: hello');
  });

  it('without resolveInProgressAfterLoads, the turn never resolves on its own', async () => {
    const transport = createInMemoryAssistantTransport({
      simulateInProgressOnce: true,
    });
    const thread = await transport.createThread('t1');
    await transport.sendMessage({
      threadId: thread.id,
      content: 'hello',
      clientRequestId: 'req-1',
    });

    for (let i = 0; i < 5; i += 1) {
      const messages = await transport.loadMessages(thread.id);
      expect(messages.some((m) => m.role === 'assistant')).toBe(false);
    }
  });
});

// Copilot PR #2919 jAwvV: the normalizers tolerate a raw generated-model
// snake_case row (created_at/thread_id), a JSON-string `attachments` column
// with `filename` fields, and newest-first pagination — none of which the
// controller's camelCase/chronological/`{name}` expectations understand
// directly.
describe('normalizeAssistantThreadSummary', () => {
  it('accepts the documented camelCase wire shape unchanged', () => {
    const result = normalizeAssistantThreadSummary({
      id: 't1',
      title: 'Order question',
      isResolved: true,
      messageCount: 3,
      lastMessageAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result).toEqual({
      id: 't1',
      title: 'Order question',
      isResolved: true,
      messageCount: 3,
      lastMessageAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('falls back to snake_case fields from a raw generated-model row', () => {
    const result = normalizeAssistantThreadSummary({
      id: 't1',
      title: 'Order question',
      is_resolved: true,
      message_count: 5,
      last_message_at: '2026-01-01T00:00:00.000Z',
    });
    expect(result.isResolved).toBe(true);
    expect(result.messageCount).toBe(5);
    expect(result.lastMessageAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('normalizeAssistantMessage', () => {
  it('accepts the documented camelCase wire shape with an attachments array', () => {
    const result = normalizeAssistantMessage({
      id: 'm1',
      threadId: 't1',
      content: 'hello',
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      attachments: [{ name: 'report.pdf', url: 'https://example.com/r.pdf' }],
    });
    expect(result.threadId).toBe('t1');
    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.attachments).toEqual([
      { id: 'att-0', name: 'report.pdf', url: 'https://example.com/r.pdf' },
    ]);
  });

  it('falls back to snake_case created_at/thread_id from a raw generated-model row', () => {
    const result = normalizeAssistantMessage({
      id: 'm1',
      thread_id: 't1',
      content: 'hello',
      role: 'user',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(result.threadId).toBe('t1');
    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('parses a JSON-STRING attachments column with filename fields', () => {
    const result = normalizeAssistantMessage({
      id: 'm1',
      threadId: 't1',
      content: 'hello',
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      attachments: JSON.stringify([{ filename: 'contract.docx', size: 2048 }]),
    });
    expect(result.attachments).toEqual([
      { id: 'att-0', name: 'contract.docx', size: 2048 },
    ]);
  });

  it('returns undefined attachments for a malformed JSON string', () => {
    const result = normalizeAssistantMessage({
      id: 'm1',
      threadId: 't1',
      content: 'hello',
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
      attachments: 'not json',
    });
    expect(result.attachments).toBeUndefined();
  });
});

describe('sortAssistantMessagesChronologically', () => {
  it('reorders a newest-first (generated-model pagination) list to oldest-first', () => {
    const newestFirst = [
      {
        id: 'm3',
        threadId: 't1',
        content: 'third',
        role: 'user' as const,
        createdAt: '2026-01-03T00:00:00.000Z',
      },
      {
        id: 'm1',
        threadId: 't1',
        content: 'first',
        role: 'user' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'm2',
        threadId: 't1',
        content: 'second',
        role: 'assistant' as const,
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ];
    const chronological = sortAssistantMessagesChronologically(newestFirst);
    expect(chronological.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });
});

// Copilot PR #2919 jAwqo/jAwrQ: createSmrtAssistantTransport must call the
// host-supplied readEndpoint, never a raw baseUrl-derived generated list
// route.
describe('createSmrtAssistantTransport reads', () => {
  function fakeFetch(responsesByUrl: Record<string, unknown>) {
    const calledUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calledUrls.push(url);
      const body = responsesByUrl[url];
      if (body === undefined) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calledUrls };
  }

  it('listThreads() calls GET {readEndpoint}/threads and normalizes the rows', async () => {
    const { fetchImpl, calledUrls } = fakeFetch({
      'https://api.example.com/assistant/threads': {
        items: [
          {
            id: 't1',
            title: 'Order question',
            is_resolved: false,
            message_count: 2,
          },
        ],
      },
    });
    const transport = createSmrtAssistantTransport({
      readEndpoint: 'https://api.example.com/assistant',
      token: 'test-token',
      fetchImpl,
    });

    const threads = await transport.listThreads();

    expect(calledUrls).toEqual(['https://api.example.com/assistant/threads']);
    expect(threads).toEqual([
      {
        id: 't1',
        title: 'Order question',
        isResolved: false,
        messageCount: 2,
        lastMessageAt: null,
      },
    ]);
  });

  it('loadMessages() calls GET {readEndpoint}/threads/{id}/messages, never a raw list route, and sorts chronologically', async () => {
    const { fetchImpl, calledUrls } = fakeFetch({
      'https://api.example.com/assistant/threads/t1/messages': {
        items: [
          {
            id: 'm2',
            thread_id: 't1',
            content: 'second',
            role: 'assistant',
            created_at: '2026-01-02T00:00:00.000Z',
          },
          {
            id: 'm1',
            thread_id: 't1',
            content: 'first',
            role: 'user',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });
    const transport = createSmrtAssistantTransport({
      readEndpoint: 'https://api.example.com/assistant',
      token: 'test-token',
      fetchImpl,
    });

    const messages = await transport.loadMessages('t1');

    expect(calledUrls).toEqual([
      'https://api.example.com/assistant/threads/t1/messages',
    ]);
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(messages[0]?.threadId).toBe('t1');
  });
});
