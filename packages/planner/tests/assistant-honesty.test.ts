/**
 * #4086 item 15: the assistant says what ran, never what the model claims.
 * Will asked for "a summary of all sales last month", heard "Added sales
 * report for last month. Added Reports." and saw nothing (the model had picked
 * reports.materialized, which has no menu entry), then "take me to it" was
 * answered "Viewing sales report for last month." with no navigation at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeChange } from '../src/lib/assistant/change.ts';
import {
  type ChatModel,
  createBrowserAssistantTransport,
  NOTHING_CHANGED,
  REPORTS_PENDING,
} from '../src/lib/assistant/transport.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { createPlannerController } from '../src/lib/planner/commands/index.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

beforeEach(() => recipeState.clear());

function setup(...replies: object[]) {
  const queue = replies.map((r) => JSON.stringify(r));
  const message = vi.fn<ChatModel['message']>(
    async () => queue.shift() ?? '{}',
  );
  const setSection = vi.fn();
  const controller = createPlannerController(new CookbookStore(), {
    navigation: { getTab: () => 'recipes', setTab: () => {}, setSection },
  });
  let menu: () => { id: string; label: string }[] = () =>
    controller
      .snapshot()
      .sections.filter((s) => !s.hidden)
      .map(({ id, label }) => ({ id, label }));
  const transport = createBrowserAssistantTransport({
    model: () => ({ message }),
    store: recipeState,
    recipes,
    controller,
    menu: () => menu(),
  });
  let n = 0;
  const say = async (content: string) =>
    (
      await transport.sendMessage({
        threadId: 'planner',
        content,
        clientRequestId: `r${++n}`,
      })
    ).assistantMessage?.content ?? '';
  return {
    controller,
    setSection,
    message,
    say,
    setMenu: (next: typeof menu) => {
      menu = next;
    },
  };
}

describe('assistant honesty', () => {
  it('says nothing changed when the model claims an action that did not run', async () => {
    const { say } = setup(
      { reply: 'Viewing sales report for last month.', add: [], remove: [] },
      { reply: '', add: [], remove: [] },
      { reply: 'Which month do you mean?', add: [], remove: [] },
    );
    expect(await say('take me to it')).toBe(
      `Viewing sales report for last month. ${NOTHING_CHANGED}`,
    );
    expect(await say('hm')).toBe(NOTHING_CHANGED);
    // A question asks; it claims nothing.
    expect(await say('which period?')).toBe('Which month do you mean?');
  });

  it('reports what ran from the results, not the model sentence', async () => {
    const { say, controller } = setup({
      reply: 'Added sales report for last month.',
      add: ['reports.runtime'],
      remove: [],
    });
    const reply = await say(
      'can you give me a summary of all sales last month?',
    );
    expect(reply).toMatch(/^Added /);
    expect(reply).toContain('Reports');
    expect(reply).not.toContain('last month');
    // What was added is in the menu the app renders.
    const items = controller
      .snapshot()
      .sections.flatMap((s) => s.items.map((i) => i.label));
    expect(items).toContain('Shared reports');
  });

  it('says when an added recipe puts nothing in the menu', () => {
    expect(
      describeChange(
        { added: ['reports.materialized'], removed: [], kept: [] },
        recipes,
      ),
    ).toBe(
      'Added Scheduled reports. Scheduled reports adds nothing to the menu.',
    );
  });

  it('"take me to it" opens the section, through the app navigation', async () => {
    const { say, controller, setSection, message } = setup(
      { reply: 'Added it.', add: ['reports.runtime'], remove: [] },
      { reply: 'Viewing sales report.', add: [], remove: [] },
    );
    await say('a summary of sales');
    const section = controller
      .snapshot()
      .sections.find((s) => s.items.some((i) => i.label === 'Shared reports'));
    if (!section) throw new Error('no reports section');
    message.mockImplementationOnce(async () =>
      JSON.stringify({
        reply: 'Viewing sales report.',
        add: [],
        remove: [],
        open: section.id,
      }),
    );
    expect(await say('take me to it')).toBe(`Opened ${section.label}.`);
    expect(setSection).toHaveBeenCalledWith(section.id);
    // The schema offered exactly the menu's sections.
    const schema = message.mock.calls[1][1]?.responseSchema as {
      properties: { open?: { enum: unknown[] } };
    };
    expect(schema.properties.open?.enum).toContain(section.id);
  });

  it('says so when a section cannot be opened', async () => {
    const { say, setMenu, setSection, message } = setup();
    setMenu(() => [{ id: 'section:ghost', label: 'Ghost' }]);
    message.mockImplementationOnce(async () =>
      JSON.stringify({
        reply: 'Opening Ghost.',
        add: [],
        remove: [],
        open: 'section:ghost',
      }),
    );
    expect(await say('open ghost')).toMatch(/^Could not open Ghost: /);
    expect(setSection).not.toHaveBeenCalled();
  });

  it('cannot navigate where the app offers no menu', async () => {
    const { say, setMenu, message, setSection } = setup();
    setMenu(() => []);
    message.mockImplementationOnce(async () =>
      JSON.stringify({
        reply: 'Opening Reports.',
        add: [],
        remove: [],
        open: 'section:reports',
      }),
    );
    expect(await say('take me to the invoices')).toBe(
      `Opening Reports. ${NOTHING_CHANGED}`,
    );
    expect(setSection).not.toHaveBeenCalled();
    const schema = message.mock.calls[0][1]?.responseSchema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.open).toBeUndefined();
  });
});

describe('report requests (the runtime report flow is smrt#4100)', () => {
  it('a sales-report request never opens the catalogue, and says the report itself is not built', async () => {
    const { say, controller, setSection, message } = setup();
    recipeState.add('commerce.sales', 'products.simple');
    const catalog = controller
      .snapshot()
      .sections.find((s) =>
        s.items.some((i) => i.id.startsWith('item:products:')),
      );
    if (!catalog) throw new Error('no catalogue section');
    message.mockImplementationOnce(async () =>
      JSON.stringify({
        reply: 'Here is your sales report.',
        add: [],
        remove: [],
        open: catalog.id,
      }),
    );
    const reply = await say('can you give me a sales report?');
    expect(setSection).not.toHaveBeenCalled();
    expect(reply).not.toContain('Opened');
    expect(reply).toContain(REPORTS_PENDING);
    // The model was told where reports live.
    expect(message.mock.calls[0][1]?.history?.[0].content).toContain(
      'reports.runtime (Reports)',
    );
  });

  it('a summary request adds Reports and may open it, honestly', async () => {
    const { say, controller, setSection, message } = setup({
      reply: 'Summary ready.',
      add: ['reports.runtime'],
      remove: [],
    });
    const first = await say('give me a summary of all sales last month');
    expect(first).toMatch(/^Added /);
    expect(first).toContain(REPORTS_PENDING);
    expect(first).not.toContain('Summary ready');
    const reports = controller
      .snapshot()
      .sections.find((s) =>
        s.items.some((i) => i.id === 'item:reports:RuntimeReport'),
      );
    if (!reports) throw new Error('no Reports section');
    message.mockImplementationOnce(async () =>
      JSON.stringify({ reply: 'Here.', add: [], remove: [], open: reports.id }),
    );
    expect(await say('take me to the sales report')).toBe(
      `Opened ${reports.label}. ${REPORTS_PENDING}`,
    );
    expect(setSection).toHaveBeenCalledWith(reports.id);
  });
});
