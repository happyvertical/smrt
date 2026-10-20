import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ChatModel,
  createBrowserAssistantTransport,
} from '../src/lib/assistant/transport.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import {
  clearSampleContext,
  getSampleContext,
} from '../src/lib/data/sample-context.ts';
import { createPlannerController } from '../src/lib/planner/commands/index.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

beforeEach(() => {
  recipeState.clear();
  clearSampleContext();
});
const sample = {
  provenance: 'fictional',
  products: [
    { name: 'Stale product', description: 'Should not appear', price: 100 },
  ],
  customers: ['Stale customer'],
  vendors: ['Stale vendor'],
};
const reply = {
  reply: 'Added',
  commands: [{ name: 'add_recipes', input: { ids: ['commerce.customers'] } }],
  sampleContext: sample,
};
function setup() {
  const store = new CookbookStore();
  const controller = createPlannerController(store);
  let resolve!: (reply: string) => void;
  const model: ChatModel = {
    message: () =>
      new Promise((done) => {
        resolve = done;
      }),
  };
  const transport = createBrowserAssistantTransport({
    store: recipeState,
    recipes,
    controller,
    model: () => model,
    acceptCommands: true,
  });
  const send = () =>
    transport.sendMessage({
      threadId: 'planner',
      clientRequestId: 'native-hosted',
      content: 'Build a relevant app',
    });
  return {
    store,
    controller,
    transport,
    send,
    resolve: (value: unknown) => resolve(JSON.stringify(value)),
  };
}

describe('hosted native structured reply revision', () => {
  it('keeps the new turn active when an aborted earlier provider resolves after reset', async () => {
    const store = new CookbookStore();
    const controller = createPlannerController(store);
    const replies: ((value: string) => void)[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const transport = createBrowserAssistantTransport({
      store: recipeState,
      recipes,
      controller,
      acceptCommands: false,
      model: () => ({
        message: (_text, options) => {
          signals.push(options?.signal);
          return new Promise((resolve) => replies.push(resolve));
        },
      }),
    });
    const send = (id: string) =>
      transport.sendMessage({
        threadId: 'planner',
        clientRequestId: id,
        content: id,
      });
    const old = send('old');
    transport.reset();
    const fresh = send('fresh');
    replies[0](
      JSON.stringify({ reply: 'Old answer', add: ['commerce.customers'] }),
    );
    await old;
    expect(controller.snapshot().recipes).toHaveLength(0);
    expect(transport.busy).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    replies[1](
      JSON.stringify({ reply: 'Fresh answer', add: ['commerce.customers'] }),
    );
    const result = await fresh;
    expect(result.assistantMessage?.content).not.toContain('could not answer');
    expect(controller.snapshot().recipes.map((item) => item.id)).toContain(
      'commerce.customers',
    );
    expect(
      transport
        .conversation()
        .some((message) => message.content.includes('Old answer')),
    ).toBe(false);
    expect(transport.busy).toBe(false);
  });
  for (const actor of ['manual', 'external-assistant'] as const) {
    it(`preserves ${actor} edits made while hosted inference is pending`, async () => {
      const test = setup();
      const pending = test.send();
      if (actor === 'manual') test.store.name = 'Manually named app';
      else
        expect(
          test.controller.batch({
            id: 'overlay',
            expectedRevision: test.controller.snapshot().revision,
            commands: [
              { name: 'set_name', input: { name: 'Overlay named app' } },
            ],
          }).ok,
        ).toBe(true);
      const expected = test.store.snapshot();
      test.resolve(reply);
      const result = await pending;
      expect(test.store.snapshot()).toEqual(expected);
      expect(test.controller.snapshot().recipes).toHaveLength(0);
      expect(getSampleContext()).toBeUndefined();
      expect(result.assistantMessage?.content).toContain('app changed');
      expect(result.assistantMessage?.content).toContain('Please try again');
      expect(
        test.transport.conversation().map((message) => message.role),
      ).toEqual(['assistant', 'user', 'assistant']);
      expect(test.transport.busy).toBe(false);
    });
  }
  it('applies a reply and samples when the observed revision remains current', async () => {
    const test = setup();
    const pending = test.send();
    test.resolve(reply);
    const result = await pending;
    expect(test.controller.snapshot().recipes.map((item) => item.id)).toContain(
      'commerce.customers',
    );
    expect(getSampleContext()?.products[0].name).toBe('Stale product');
    expect(result.assistantMessage?.content).toContain('Added');
  });
  it('does not reject supported local-provider work performed inside message()', async () => {
    const store = new CookbookStore();
    const controller = createPlannerController(store);
    const transport = createBrowserAssistantTransport({
      store: recipeState,
      recipes,
      controller,
      acceptCommands: false,
      model: () => ({
        message: async () => {
          controller.run({
            name: 'set_name',
            input: { name: 'Provider-owned work' },
          });
          return JSON.stringify({
            reply: 'What next?',
            add: ['commerce.customers'],
          });
        },
      }),
    });
    const result = await transport.sendMessage({
      threadId: 'planner',
      clientRequestId: 'local',
      content: 'Build',
    });
    expect(store.name).toBe('Provider-owned work');
    expect(controller.snapshot().recipes.map((item) => item.id)).toContain(
      'commerce.customers',
    );
    expect(result.assistantMessage?.content).not.toContain('app changed');
  });
});
