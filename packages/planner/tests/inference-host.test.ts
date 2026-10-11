import { beforeEach, describe, expect, it } from 'vitest';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import {
  createHostChat,
  HOST_HISTORY_CHARS,
  HOST_HISTORY_TURNS,
  type HostRequest,
} from '../src/lib/inference/host.ts';
import { createPlannerAssistant } from '../src/lib/planner/assistant.ts';
import { createPlannerController } from '../src/lib/planner/commands/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import { startStub } from './stub-server.ts';

beforeEach(() => recipeState.clear());

const controller = () => createPlannerController(cookbookStore);

async function send(
  assistant: ReturnType<typeof createPlannerAssistant>,
  text: string,
  id = 'r1',
) {
  const result = await assistant.transport.sendMessage({
    threadId: 'planner',
    content: text,
    clientRequestId: id,
  } as never);
  return result.assistantMessage?.content ?? '';
}

describe('host mode wire contract', () => {
  it('POSTs the message, snapshot and bounded history, never the prompt or schema', async () => {
    const plan = controller();
    const stub = await startStub(() => ({
      body: { reply: 'Added.', add: ['commerce.sales'], remove: [] },
    }));
    try {
      const assistant = createPlannerAssistant(plan, {
        mode: 'host',
        host: { endpoint: `${stub.origin}/api/planner/chat` },
      });
      expect(assistant.mode).toBe('host');
      expect(await send(assistant, 'I sell things')).toMatch(/Added/);
      expect(recipeState.ids).toContain('commerce.sales');

      const request = stub.requests[0];
      expect(request?.method).toBe('POST');
      expect(request?.url).toBe('/api/planner/chat');
      expect(request?.headers['content-type']).toBe('application/json');
      expect(request?.headers.authorization).toBeUndefined();
      const body = JSON.parse(request?.body ?? '{}') as HostRequest;
      expect(Object.keys(body).sort()).toEqual([
        'message',
        'snapshot',
        'version',
      ]);
      expect(body.message).toBe('I sell things');
      expect(body.version).toBe(1);
      expect(body.snapshot.version).toBe(plan.snapshot().version);
      // The server owns the prompt: nothing of ours leaks.
      expect(request?.body).not.toMatch(/You help assemble|responseSchema/);

      // The second turn carries the first as history, with no system turn.
      await send(assistant, 'and invoices', 'r2');
      const second = JSON.parse(stub.requests[1]?.body ?? '{}') as HostRequest;
      expect(second.history?.map((h) => h.role)).toEqual(['user', 'assistant']);
      expect(second.history?.[0]?.content).toBe('I sell things');
    } finally {
      await stub.close();
    }
  });

  it('bounds history length and entry size', async () => {
    const stub = await startStub(() => ({ body: { reply: 'ok' } }));
    try {
      const chat = createHostChat({
        endpoint: `${stub.origin}/chat`,
        snapshot: () => controller().snapshot(),
      });
      await chat.message('hi', {
        history: [
          { role: 'system', content: 'secret prompt' },
          ...Array.from({ length: 20 }, (_, i) => ({
            role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
            content: 'x'.repeat(5000) + i,
          })),
        ],
      });
      const body = JSON.parse(stub.requests[0]?.body ?? '{}') as HostRequest;
      expect(body.history).toHaveLength(HOST_HISTORY_TURNS);
      expect(
        body.history?.every((h) => h.content.length <= HOST_HISTORY_CHARS),
      ).toBe(true);
      expect(stub.requests[0]?.body).not.toContain('secret prompt');
    } finally {
      await stub.close();
    }
  });

  it('runs command calls the server returns, through the controller', async () => {
    const plan = controller();
    const stub = await startStub(() => ({
      body: {
        reply: 'Set up.',
        commands: [
          { name: 'add_recipes', input: { ids: ['commerce.sales'] } },
          { name: 'set_settings', input: { currency: 'CAD' } },
          { name: 'not_a_command', input: {} },
        ],
      },
    }));
    try {
      const assistant = createPlannerAssistant(plan, {
        mode: 'host',
        host: { endpoint: `${stub.origin}/chat` },
      });
      const text = await send(assistant, 'go');
      expect(plan.snapshot().recipes.map((r) => r.id)).toContain(
        'commerce.sales',
      );
      expect(plan.snapshot().settings.currency).toBe('CAD');
      // The unknown command is refused and said so, once.
      expect(text).toMatch(/not_a_command was refused/);
    } finally {
      await stub.close();
    }
  });

  it('ignores command calls outside host mode', async () => {
    const plan = controller();
    const assistant = createPlannerAssistant(plan, {
      chat: {
        message: async () =>
          JSON.stringify({
            reply: 'x',
            add: [],
            remove: [],
            commands: [
              { name: 'add_recipes', input: { ids: ['commerce.sales'] } },
            ],
          }),
      },
    });
    await send(assistant, 'go');
    expect(plan.snapshot().recipes).toHaveLength(0);
  });

  it('reads plain text as the reply and shows a server error without crashing', async () => {
    const plain = await startStub(() => ({ raw: true, body: 'Hello there.' }));
    try {
      const assistant = createPlannerAssistant(controller(), {
        mode: 'host',
        host: { endpoint: `${plain.origin}/chat` },
      });
      expect(await send(assistant, 'hi')).toBe('Hello there.');
    } finally {
      await plain.close();
    }
    const broken = await startStub(() => ({ status: 502, body: {} }));
    try {
      const assistant = createPlannerAssistant(controller(), {
        mode: 'host',
        host: { endpoint: `${broken.origin}/chat` },
      });
      expect(await send(assistant, 'hi')).toMatch(/server answered 502/);
    } finally {
      await broken.close();
    }
  });

  it('falls back to browser, with a notice, on a bad prop', () => {
    const assistant = createPlannerAssistant(controller(), {
      mode: 'host',
    } as never);
    expect(assistant.mode).toBe('browser');
    expect(assistant.notice).toBeTruthy();
  });
});
