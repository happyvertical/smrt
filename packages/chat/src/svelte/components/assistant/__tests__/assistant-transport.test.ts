// @vitest-environment jsdom
/**
 * Coverage for assistant-transport.ts's implementations directly (not
 * through the controller) — #2904 review, Copilot PR #2919.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryAssistantTransport } from '../assistant-transport.js';

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
