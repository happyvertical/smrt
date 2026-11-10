import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserAssistantTransport,
  type PlannerHostTurn,
} from '../src/lib/assistant/transport.ts';

const input = (content: string, clientRequestId = content) => ({
  threadId: 'planner',
  content,
  clientRequestId,
});
const store = () => ({ ids: [] as string[], add: vi.fn(), remove: vi.fn() });
const memory = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
  };
};
describe('trusted host current-turn contract', () => {
  it('handles actual user sends once, excludes seed and programmatic handoff and never interprets model tools', async () => {
    const hook = vi.fn(async (_turn: PlannerHostTurn) => ({
      content: 'Acknowledged by host.',
    }));
    const model = {
      message: vi.fn(async () => '{"reply":"build it","add":[],"remove":[]}'),
    };
    const native = createBrowserAssistantTransport({
      recipes: [],
      store: store(),
      model: () => model,
      hostTurn: hook,
    });
    native.seed({
      id: 'seed',
      messages: [{ role: 'user', content: 'build it' }],
    });
    expect(hook).not.toHaveBeenCalled();
    await native.sendHostMessage(input('make a bakery'));
    expect(hook).not.toHaveBeenCalled();
    await native.sendMessage(input('build it', 'actual'));
    await native.sendMessage(input('build it', 'actual'));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toMatchObject({
      userMessage: { role: 'user', content: 'build it' },
      conversation: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'build it' }),
      ]),
    });
    expect(model.message).toHaveBeenCalledTimes(1);
  });
  it('restores transcript without executing hook and reset suppresses late host completion', async () => {
    const storage = memory();
    const hook = vi.fn(async () => ({ content: 'done' }));
    const native = createBrowserAssistantTransport({
      recipes: [],
      store: store(),
      model: () => null,
      hostTurn: hook,
      conversationStorage: storage,
    });
    await native.sendMessage(input('first'));
    const restored = createBrowserAssistantTransport({
      recipes: [],
      store: store(),
      model: () => null,
      hostTurn: hook,
      conversationStorage: storage,
    });
    expect(restored.conversation().some((m) => m.content === 'first')).toBe(
      true,
    );
    expect(hook).toHaveBeenCalledTimes(1);
    let finish!: (value: { content: string }) => void;
    const pending = createBrowserAssistantTransport({
      recipes: [],
      store: store(),
      model: () => null,
      hostTurn: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const sending = pending.sendMessage(input('submit'));
    pending.reset();
    finish({ content: 'late success' });
    await sending;
    expect(pending.conversation().map((m) => m.content)).toEqual([
      'What would you like to build?',
    ]);
    expect(pending.busy).toBe(false);
  });
  it('does not infer after a host action fails', async () => {
    const model = { message: vi.fn() };
    const native = createBrowserAssistantTransport({
      recipes: [],
      store: store(),
      model: () => model,
      hostTurn: async () => {
        throw Error('failed');
      },
    });
    const reply = await native.sendMessage(input('submit'));
    expect(reply.assistantMessage?.content).toContain('could not be confirmed');
    expect(model.message).not.toHaveBeenCalled();
  });
});
