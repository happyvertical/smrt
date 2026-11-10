import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantSession } from '../src/lib/assistant/session.svelte.ts';
import {
  type ChatModel,
  createBrowserAssistantTransport,
} from '../src/lib/assistant/transport.ts';
import { serializeCookbook } from '../src/lib/cookbook/file.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { createPlannerController } from '../src/lib/planner/commands/index.ts';
import { capturePlannerExport } from '../src/lib/planner/export-context.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

beforeEach(() => recipeState.clear());

function setup(
  message: ChatModel['message'] = async () => '{"reply":"What next?"}',
) {
  const store = new CookbookStore();
  const controller = createPlannerController(store);
  const transport = createBrowserAssistantTransport({
    store: { ids: [], add() {}, remove() {} },
    recipes,
    controller,
    model: () => ({ message }),
    acceptCommands: true,
  });
  return { store, controller, transport };
}
const input = (content: string, clientRequestId = content) => ({
  threadId: 'planner',
  content,
  clientRequestId,
});

describe('native conversation handoff', () => {
  it('seeds complete earlier history once, atomically, with no commands or truncation', async () => {
    const message = vi.fn<ChatModel['message']>(
      async () => '{"reply":"What next?"}',
    );
    const { transport, controller } = setup(message);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `${i}: ${'business context '.repeat(100)}`,
    }));
    const before = controller.snapshot();
    const updates: number[] = [];
    transport.subscribeConversation((turns) => updates.push(turns.length));
    expect(transport.seed({ id: 'studio', messages })).toBe(true);
    expect(updates).toEqual([1, 21]);
    expect(transport.seed({ id: 'studio', messages })).toBe(false);
    expect(
      transport.seed({
        id: 'invalid',
        messages: [{ role: 'system', content: 'bad' }],
      } as never),
    ).toBe(false);
    expect(
      transport
        .conversation()
        .slice(1)
        .map(({ role, content }) => ({ role, content })),
    ).toEqual(messages);
    expect(controller.snapshot()).toEqual(before);
    expect(message).not.toHaveBeenCalled();
    await transport.sendMessage(input('continue'));
    expect(transport.seed({ id: 'late', messages })).toBe(false);
    expect(transport.conversation()).toHaveLength(23);
    const copy = transport.conversation();
    copy[1].content = 'changed';
    expect(transport.conversation()[1].content).toBe(messages[0].content);
  });

  it('captures exact manual app edits and full native history as detached context', () => {
    const { store, controller, transport } = setup();
    transport.seed({
      id: 'intent',
      messages: [
        { role: 'user', content: 'A workshop for handmade instruments' },
      ],
    });
    controller.run({ name: 'add_recipes', input: { ids: [recipes[0].id] } });
    store.name = 'Manual name';
    const context = capturePlannerExport(controller, transport);
    expect(context.export.cookbook).toEqual(store.snapshot());
    expect(context.export.text).toBe(
      serializeCookbook(context.export.cookbook),
    );
    expect(context.export.fileName).toBe('manual-name.cookbook.json');
    expect(context.revision).toBe(controller.snapshot().revision);
    expect(context.conversation).toEqual(transport.conversation());
    store.name = 'Later name';
    expect(context.export.cookbook.name).toBe('Manual name');
    context.conversation[0].content = 'edited capture';
    expect(transport.conversation()[0].content).not.toBe('edited capture');
  });

  it('refuses partial exports and overlapping sends; cancelled late replies never edit the app', async () => {
    let resolve!: (text: string) => void;
    const { controller, transport } = setup(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const states: boolean[] = [];
    const unsubscribe = transport.subscribeConversation(() =>
      states.push(transport.busy),
    );
    const turn = transport.sendMessage(input('add something'));
    expect(transport.busy).toBe(true);
    expect(() => capturePlannerExport(controller, transport)).toThrow(
      'Wait for the assistant',
    );
    await expect(transport.sendMessage(input('overlap'))).rejects.toThrow(
      'still answering',
    );
    expect(transport.seed({ id: 'inflight', messages: [] })).toBe(false);
    transport.abort();
    resolve(
      JSON.stringify({
        reply: 'Added',
        commands: [{ name: 'add_recipes', input: { ids: [recipes[0].id] } }],
      }),
    );
    await turn;
    expect(controller.snapshot().recipes).toEqual([]);
    expect(transport.conversation().at(-1)?.content).toBe('Stopped.');
    expect(states).toContain(true);
    expect(states.at(-1)).toBe(false);
    expect(transport.busy).toBe(false);
    expect(
      capturePlannerExport(controller, transport).conversation,
    ).toHaveLength(3);
    unsubscribe();
    expect(await transport.sendMessage(input('add something'))).toMatchObject({
      assistantMessage: { content: 'Stopped.' },
    });
    expect(transport.conversation()).toHaveLength(3);
  });

  it('can disable cookbook offers while retaining generic recipe composition', async () => {
    const message = vi.fn<ChatModel['message']>(async () =>
      JSON.stringify({
        reply: 'What next?',
        add: [recipes[0].id],
        cookbook: 'bakery',
      }),
    );
    const store = {
      ids: [] as string[],
      add(id: string) {
        this.ids.push(id);
      },
      remove() {},
    };
    const session = new AssistantSession({ store, recipes, storage: null });
    session.cookbookOffers = false;
    session.setMode('host');
    session.useRemote({ message }, 'Test');
    await session.transport.sendMessage(
      input('A business outside the library'),
    );
    expect(store.ids).toContain(recipes[0].id);
    expect(Object.keys(session.offers.offers)).toHaveLength(0);
    expect(
      JSON.stringify(message.mock.calls[0][1]?.responseSchema),
    ).not.toContain('bakery');
  });
});
