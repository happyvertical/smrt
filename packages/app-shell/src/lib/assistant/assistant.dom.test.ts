import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { card, changes, noChanges } from '../../test/changes-fixtures.ts';
import { result } from '../../test/report-fixtures.ts';
import AssistantPanel from './AssistantPanel.svelte';

let component: ReturnType<typeof mount>;
let container: HTMLDivElement;
afterEach(() => {
  if (component) unmount(component);
  container?.remove();
  vi.unstubAllGlobals();
});
function stubTurn(events: object[], thread: object[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const path = String(input);
      if (path.includes('/turn'))
        return new Response(
          events
            .map((e) => `event: turn\ndata: ${JSON.stringify(e)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      if (/\/threads\/[^/?]+/.test(path))
        return new Response(JSON.stringify({ messages: thread }));
      return new Response(
        JSON.stringify(
          path.includes('/status')
            ? { configured: true }
            : /\/threads(\?|$)/.test(path)
              ? {
                  threads: thread.length
                    ? [{ id: 't1', title: 'x', updatedAt: '' }]
                    : [],
                }
              : { approvals: [] },
        ),
      );
    }),
  );
}

async function open(
  props: Record<string, unknown> = {},
  ready = /Tell me what you want|waiting/,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  component = mount(AssistantPanel, {
    target: container,
    props: { open: true, ...props },
  });
  await vi.waitFor(() => expect(container.textContent).toMatch(ready));
}

async function say(text: string) {
  const field = container.querySelector('textarea');
  if (!field) throw new Error('Missing assistant input');
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  container
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

const TOOL = [
  { type: 'tool_call', id: 'tool', name: 'app_addfield', args: '{}' },
  {
    type: 'tool_result',
    id: 'tool',
    name: 'app_addfield',
    ok: true,
    summary: 'Added a field',
  },
];
const block = () =>
  container.querySelector<HTMLElement>('[data-testid="changes-block"]');
const buttons = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('a.smrt-app-shell__btn, button')].map(
    (b) => ({
      text: b.textContent?.trim(),
      primary: b.classList.contains('smrt-app-shell__btn-primary'),
      href: b.getAttribute('href'),
    }),
  );

describe('the reply block', () => {
  it('a reply that made changes ends in "N changes waiting"; Review leads while questions are open, and says nothing about drafts', async () => {
    stubTurn([
      ...TOOL,
      { type: 'changes_block' },
      { type: 'done', stop: 'complete' },
    ]);
    const withQuestion = changes({
      cards: [
        card({
          questions: [
            {
              id: 'q1',
              text: 'Mark them?',
              choices: [{ label: 'Yes', adds: true }],
              state: 'open',
            },
          ],
        }),
        card({ id: 'c2', summary: 'New report Orders by fulfillment' }),
      ],
    });
    await open({ changes: withQuestion, onapply: vi.fn() });
    await say('Add a field');
    await vi.waitFor(() => expect(block()).not.toBeNull());
    const el = block() as HTMLElement;
    expect(el.getAttribute('aria-label')).toBe('2 changes waiting');
    expect(el.textContent).toContain('1 question');
    expect(el.textContent).toContain('Add field Fulfillment to Orders');
    expect(buttons(el).slice(1)).toEqual([
      { text: 'Review', primary: true, href: '/changes' },
      { text: 'Apply', primary: false, href: null },
    ]);
    // the pill is the one place the question shows; it is answered in Review
    const pill = el.querySelector<HTMLButtonElement>(
      '.smrt-assistant-panel__q',
    );
    expect(pill?.getAttribute('aria-expanded')).toBe('false');
    expect(el.textContent).not.toContain('Mark them?');
    pill?.click();
    await vi.waitFor(() => expect(el.textContent).toContain('Mark them?'));
    expect(pill?.getAttribute('aria-expanded')).toBe('true');
    expect(
      el.querySelector('a[href="/changes"]:not(.smrt-app-shell__btn)')
        ?.textContent,
    ).toBe('Answer in Review');
    expect(el.querySelector('input, [role="radio"]')).toBeNull();
    expect(container.textContent).not.toMatch(
      /draft|Tried in|Changed in your live/i,
    );
  });

  it('Review leads even for a small addition while a question is open', async () => {
    stubTurn([
      ...TOOL,
      { type: 'changes_block' },
      { type: 'done', stop: 'complete' },
    ]);
    await open({
      changes: changes({
        applyNow: true,
        cards: [
          card({
            questions: [
              { id: 'q1', text: 'Which?', choices: [], state: 'open' },
            ],
          }),
        ],
      }),
      onapply: vi.fn(),
    });
    await say('Add a field');
    await vi.waitFor(() => expect(block()).not.toBeNull());
    expect(buttons(block() as HTMLElement).map((b) => b.text)).not.toContain(
      'Apply now',
    );
    expect(buttons(block() as HTMLElement).find((b) => b.primary)?.text).toBe(
      'Review',
    );
  });

  it("Apply leads once no question is open, and is the owner's click (calls the layout's apply, not Apply now)", async () => {
    stubTurn([
      ...TOOL,
      { type: 'changes_block' },
      { type: 'done', stop: 'complete' },
    ]);
    const onapply = vi.fn(async () => {});
    await open({ changes: changes(), onapply });
    await say('Add a field');
    await vi.waitFor(() => expect(block()).not.toBeNull());
    expect(buttons(block() as HTMLElement)).toEqual([
      { text: 'Apply', primary: true, href: null },
      { text: 'Review', primary: false, href: '/changes' },
    ]);
    (block()?.querySelector('button') as HTMLButtonElement | null)?.click();
    await vi.waitFor(() => expect(onapply).toHaveBeenCalledWith(false));
  });

  it('a small addition the server says qualifies gets "Apply now"; a failed apply shows why', async () => {
    stubTurn([
      ...TOOL,
      { type: 'changes_block' },
      { type: 'done', stop: 'complete' },
    ]);
    const onapply = vi.fn(async () => {
      throw new Error('This one needs a closer look. Review it, then Apply.');
    });
    await open({
      changes: changes({ cards: [card()], applyNow: true }),
      onapply,
    });
    await say('Add a phone field');
    await vi.waitFor(() => expect(block()).not.toBeNull());
    expect(block()?.getAttribute('aria-label')).toBe('1 change waiting');
    expect(buttons(block() as HTMLElement)[0]).toEqual({
      text: 'Apply now',
      primary: true,
      href: null,
    });
    (block()?.querySelector('button') as HTMLButtonElement | null)?.click();
    await vi.waitFor(() => expect(onapply).toHaveBeenCalledWith(true));
    await vi.waitFor(() =>
      expect(block()?.querySelector('[role="alert"]')?.textContent).toContain(
        'closer look',
      ),
    );
  });

  it('Apply is not offered while the changes cannot be applied; nothing shows once nothing waits', async () => {
    stubTurn([
      ...TOOL,
      { type: 'changes_block' },
      { type: 'done', stop: 'complete' },
    ]);
    await open({
      changes: changes({ canApply: false, checkState: 'checking' }),
      onapply: vi.fn(),
    });
    await say('Add a field');
    await vi.waitFor(() => expect(block()).not.toBeNull());
    const apply = [...(block() as HTMLElement).querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Apply',
    );
    expect(apply?.disabled).toBe(true);
    unmount(component);
    container.remove();
    stubTurn([
      ...TOOL,
      { type: 'changes_block' },
      { type: 'done', stop: 'complete' },
    ]);
    await open({ changes: noChanges() });
    await say('Add a field');
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Added a field'),
    );
    expect(block()).toBeNull();
  });

  it('a reopened thread shows only the newest block, from the live state', async () => {
    stubTurn(
      [],
      [
        { id: '1', seq: 1, role: 'user', content: 'one' },
        { id: '2', seq: 2, role: 'assistant', content: '', block: 'changes' },
        { id: '3', seq: 3, role: 'user', content: 'two' },
        { id: '4', seq: 4, role: 'assistant', content: '', block: 'changes' },
      ],
    );
    await open({ changes: changes(), onapply: vi.fn() });
    await vi.waitFor(() => expect(block()).not.toBeNull());
    expect(
      container.querySelectorAll('[data-testid="changes-block"]'),
    ).toHaveLength(1);
  });
});

it('reopens old tool chips as human lines without JSON, SQL or snapshot paths', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const path = String(input);
      return new Response(
        JSON.stringify(
          path.includes('/status')
            ? { configured: true }
            : path.endsWith('/old?target=live')
              ? {
                  messages: [
                    {
                      id: '1',
                      seq: 1,
                      role: 'tool',
                      content: '',
                      tool: {
                        id: '1',
                        name: 'app_addfield',
                        ok: true,
                        summary:
                          '{"data":{"summary":"add Product.notes","statements":["ALTER TABLE products"],"snapshot":"/private/tmp/app.db"}}',
                      },
                    },
                    {
                      id: '2',
                      seq: 2,
                      role: 'tool',
                      content: '',
                      tool: {
                        id: '2',
                        name: 'app_describe',
                        ok: true,
                        summary: '{"data":{"mode":"live"',
                      },
                    },
                  ],
                }
              : { threads: [{ id: 'old' }], approvals: [] },
        ),
      );
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  component = mount(AssistantPanel, {
    target: container,
    props: { open: true },
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Added a Notes field to product'),
  );
  expect(container.textContent).toContain('checked the app structure');
  for (const chip of container.querySelectorAll('.chip')) {
    expect(chip.textContent).not.toMatch(/[{}]|ALTER TABLE|\/private/);
    expect(chip.getAttribute('title')).not.toMatch(
      /[{}]|ALTER TABLE|\/private/,
    );
  }
});

it('renders an assistant-run report with the shared result component and record links', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const path = String(input);
      if (path.includes('/turn'))
        return new Response(
          [
            { type: 'tool_call', id: 'r', name: 'app_runreport', args: '{}' },
            {
              type: 'tool_result',
              id: 'r',
              name: 'app_runreport',
              ok: true,
              summary: 'Ran Sales: 1 rows',
              report: {
                result: { ...result, chart: { type: 'table' } },
                href: '/reports/sales',
              },
            },
            { type: 'done', stop: 'complete' },
          ]
            .map((e) => `event: turn\ndata: ${JSON.stringify(e)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      return new Response(
        JSON.stringify(
          path.includes('/status')
            ? { configured: true }
            : { threads: [], approvals: [] },
        ),
      );
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  component = mount(AssistantPanel, {
    target: container,
    props: { open: true },
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Tell me what you want'),
  );
  const field = container.querySelector('textarea');
  if (!field) throw new Error('Missing composer');
  field.value = 'Run sales';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  container
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(
      container.querySelector('[data-smrt-component="ReportResult"]'),
    ).toBeTruthy(),
  );
  expect(container.querySelector('td a')?.textContent).toBe('Acme Ltd');
  expect(container.querySelector('a[href="/reports/sales"]')?.textContent).toBe(
    'Open report',
  );
});

it('shows a working indicator with the current step while a turn runs', async () => {
  const sse = (e: unknown) =>
    new TextEncoder().encode(`event: turn\ndata: ${JSON.stringify(e)}\n\n`);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const path = String(input);
      if (path.includes('/turn'))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                sse({
                  type: 'tool_call',
                  id: 't',
                  name: 'app_describe',
                  args: '{}',
                }),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      return new Response(
        JSON.stringify(
          path.includes('/status')
            ? { configured: true }
            : { threads: [], approvals: [] },
        ),
      );
    }),
  );
  const target = document.createElement('div');
  document.body.appendChild(target);
  const mounted = mount(AssistantPanel, { target, props: { open: true } });
  await vi.waitFor(() =>
    expect(target.textContent).toContain('Tell me what you want'),
  );
  const field = target.querySelector('textarea');
  if (!field) throw new Error('Missing assistant input');
  field.value = 'Look around';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  target
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(
      target.querySelector('[data-testid="assistant-working"]')?.textContent,
    ).toContain('Looking at your app'),
  );
  expect(target.textContent).not.toContain('Describe');
  unmount(mounted);
  target.remove();
});

it('renders a markdown table in a reply and the plain reason on a failed card', async () => {
  const table = '| Dog | Walks |\n| --- | --- |\n| Rex | 3 |';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const path = String(input);
      if (path.includes('/turn'))
        return new Response(
          [
            { type: 'tool_call', id: 't', name: 'dog_list', args: '{}' },
            {
              type: 'tool_result',
              id: 't',
              name: 'dog_list',
              ok: false,
              summary:
                "Invalid WHERE clause operator: 'ne'. Valid operators: =, !=",
            },
            { type: 'text', delta: `Here you go:\n\n${table}` },
            { type: 'done', stop: 'complete' },
          ]
            .map((e) => `event: turn\ndata: ${JSON.stringify(e)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      return new Response(
        JSON.stringify(
          path.includes('/status')
            ? { configured: true }
            : { threads: [], approvals: [] },
        ),
      );
    }),
  );
  const target = document.createElement('div');
  document.body.appendChild(target);
  const mounted = mount(AssistantPanel, { target, props: { open: true } });
  await vi.waitFor(() =>
    expect(target.textContent).toContain('Tell me what you want'),
  );
  const field = target.querySelector('textarea');
  if (!field) throw new Error('Missing assistant input');
  field.value = 'List dogs';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  target
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(target.querySelector('table')).not.toBeNull());
  expect(target.querySelectorAll('td')[1]?.textContent).toBe('3');
  expect(target.textContent).not.toContain('| Dog |');
  const chip = target.querySelector('li.smrt-assistant-panel__err');
  expect(chip?.getAttribute('title')).toBe(
    'That search used a comparison the app cannot do, so nothing was looked up.',
  );
  expect(target.textContent).not.toMatch(/WHERE|Valid operators/);
  unmount(mounted);
  target.remove();
});

describe('one scroller (#5395)', () => {
  const longReply = Array.from({ length: 12 }, (_, i) => `Point ${i}.`).join(
    '\n\n',
  );
  const thread = [
    { id: '1', seq: 1, role: 'user', content: 'one' },
    { id: '2', seq: 2, role: 'assistant', content: longReply },
    { id: '3', seq: 3, role: 'user', content: 'two' },
    { id: '4', seq: 4, role: 'assistant', content: longReply },
  ];
  it('replies are plain text; only an older long reply folds, and Show more opens it', async () => {
    stubTurn([], thread);
    await open({}, /Point 11/);
    await vi.waitFor(() =>
      expect(
        container.querySelectorAll('.smrt-assistant-panel__reply'),
      ).toHaveLength(2),
    );
    const replies = [
      ...container.querySelectorAll('.smrt-assistant-panel__reply'),
    ];
    expect(container.querySelector('.smrt-assistant-panel__bot')).toBeNull();
    expect(replies[0]?.classList.contains('smrt-assistant-panel__folded')).toBe(
      true,
    );
    expect((replies[0] as HTMLElement).inert).toBe(true);
    expect((replies[1] as HTMLElement).inert).toBeFalsy();
    expect(replies[1]?.classList.contains('smrt-assistant-panel__folded')).toBe(
      false,
    );
    const more = container.querySelectorAll<HTMLButtonElement>(
      '.smrt-assistant-panel__more',
    );
    expect(more).toHaveLength(1);
    expect(more[0]?.textContent).toBe('Show more');
    expect(more[0]?.getAttribute('aria-expanded')).toBe('false');
    more[0]?.click();
    await vi.waitFor(() =>
      expect(
        replies[0]?.classList.contains('smrt-assistant-panel__folded'),
      ).toBe(false),
    );
    expect(
      container.querySelector('.smrt-assistant-panel__more')?.textContent,
    ).toBe('Show less');
  });
});

describe('quieter steps (#5395)', () => {
  const results = (ok2: boolean) => [
    { type: 'tool_call', id: 'a', name: 'app_describe', args: '{}' },
    {
      type: 'tool_result',
      id: 'a',
      name: 'app_describe',
      ok: true,
      summary: 'Checked the app structure',
    },
    { type: 'tool_call', id: 'b', name: 'app_zzz_secret', args: '{}' },
    ok2
      ? {
          type: 'tool_result',
          id: 'b',
          name: 'app_zzz_secret',
          ok: true,
          summary: 'Looked up 40 orders',
        }
      : {
          type: 'tool_result',
          id: 'b',
          name: 'app_zzz_secret',
          ok: false,
          summary: 'Invalid WHERE clause operator',
        },
  ];
  const stepsButton = () =>
    container.querySelector<HTMLButtonElement>('.smrt-assistant-panel__steps');

  it("a reply's steps fold into one plain line that opens to the list; no tool name shows", async () => {
    stubTurn([
      ...results(true),
      { type: 'text', delta: 'Done.' },
      { type: 'done', stop: 'complete' },
    ]);
    await open();
    await say('Look around');
    await vi.waitFor(() => expect(container.textContent).toContain('Done.'));
    expect(
      container.querySelectorAll('.smrt-assistant-panel__steps'),
    ).toHaveLength(1);
    expect(stepsButton()?.textContent).toContain(
      'Checked the app structure · looked up 40 orders',
    );
    expect(stepsButton()?.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector('.smrt-assistant-panel__steplist'),
    ).toBeNull();
    stepsButton()?.click();
    await vi.waitFor(() =>
      expect(
        container.querySelectorAll('.smrt-assistant-panel__steplist li'),
      ).toHaveLength(2),
    );
    expect(container.textContent).not.toMatch(/app_|zzz|Zzz/);
  });

  it('a turn of several text chunks shows ONE reply; the earlier chunks sit in the steps list', async () => {
    stubTurn([
      { type: 'text', delta: "I'll look at the current app first." },
      ...results(true),
      { type: 'text', delta: 'All done, your app is ready.' },
      { type: 'done', stop: 'complete' },
    ]);
    await open();
    await say('Look around');
    await vi.waitFor(() => expect(container.textContent).toContain('All done'));
    const replies = container.querySelectorAll('.smrt-assistant-panel__reply');
    expect(replies).toHaveLength(1);
    expect(replies[0].textContent).toContain('All done');
    expect(
      container.querySelector('.smrt-assistant-panel__steplist'),
    ).toBeNull();
    stepsButton()?.click();
    await vi.waitFor(() =>
      expect(
        container.querySelector('.smrt-assistant-panel__steplist')?.textContent,
      ).toContain("I'll look at the current app first."),
    );
  });

  it('record steps read as plain grouped words with the model label and no per-row done', async () => {
    const write = (id: string, name: string) => [
      { type: 'tool_call', id, name, args: '{}' },
      {
        type: 'tool_result',
        id,
        name,
        ok: true,
        summary: 'Completed this action',
      },
    ];
    stubTurn([
      ...[1, 2, 3, 4].flatMap((n) => write(`c${n}`, 'customer_create')),
      ...[1, 2, 3].flatMap((n) => write(`o${n}`, 'order_create')),
      { type: 'text', delta: 'Added them.' },
      { type: 'done', stop: 'complete' },
    ]);
    await open({
      definition: {
        models: {
          customer: { label: 'Profile', fields: {} },
          order: { label: 'Orders', fields: {} },
        },
      },
    });
    await say('Add data');
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Added them.'),
    );
    expect(stepsButton()?.textContent).toContain(
      'Added 4 profiles · added 3 orders',
    );
    stepsButton()?.click();
    await vi.waitFor(() =>
      expect(
        container.querySelectorAll('.smrt-assistant-panel__steplist li'),
      ).toHaveLength(2),
    );
    expect(container.textContent).not.toMatch(/Completed this action|done/);
  });

  it('a failed step opens itself in red and Try again sends the same question', async () => {
    stubTurn([...results(false), { type: 'done', stop: 'complete' }]);
    await open();
    await say('Look around');
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"] button')).not.toBeNull(),
    );
    expect(stepsButton()?.classList.contains('smrt-assistant-panel__err')).toBe(
      true,
    );
    expect(stepsButton()?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('comparison the app cannot do');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'comparison the app cannot do',
    );
    const fetchMock = vi.mocked(fetch);
    const first = fetchMock.getMockImplementation();
    // The second turn is a plain reply (the stubbed tool ids would repeat).
    fetchMock.mockImplementation(async (input, init) =>
      String(input).includes('/turn')
        ? new Response(
            `event: turn\ndata: ${JSON.stringify({ type: 'done', stop: 'complete' })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          )
        : (first as typeof fetch)(input, init),
    );
    const turnsBefore = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/turn'),
    ).length;
    container
      .querySelector<HTMLButtonElement>('[role="alert"] button')
      ?.click();
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes('/turn'))
          .length,
      ).toBe(turnsBefore + 1),
    );
    const last = fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/turn'))
      .at(-1);
    expect(String((last?.[1] as RequestInit | undefined)?.body)).toContain(
      'Look around',
    );
  });
});

it('a wide report shows its key columns in a table that fits, with the rest counted and Open report', async () => {
  const col = (id: string, label: string, role: 'dimension' | 'measure') => ({
    id,
    label,
    role,
    type: role === 'measure' ? 'integer' : 'string',
  });
  const wide = {
    ...result,
    columns: [
      col('customer', 'Customer', 'dimension'),
      col('town', 'Town', 'dimension'),
      col('spent', 'Money spent', 'measure'),
      col('orders', 'Order count', 'measure'),
      col('avg', 'Average order', 'measure'),
    ],
    rows: [
      { customer: 'Maple', town: 'Eastport', spent: 5, orders: 2, avg: 3 },
    ],
    chart: { type: 'bar', x: 'customer', y: ['spent', 'orders'] },
  };
  stubTurn([
    { type: 'tool_call', id: 'r', name: 'app_runreport', args: '{}' },
    {
      type: 'tool_result',
      id: 'r',
      name: 'app_runreport',
      ok: true,
      summary: 'Ran Sales',
      report: { result: wide, href: '/reports/sales' },
    },
    { type: 'text', delta: 'Maple leads.' },
    { type: 'done', stop: 'complete' },
  ]);
  await open();
  await say('Top customers');
  await vi.waitFor(() =>
    expect(container.querySelector('table')).not.toBeNull(),
  );
  expect(
    [...container.querySelectorAll('th')].map((h) => h.textContent),
  ).toEqual(['Customer', 'Money spent', 'Order count']);
  const group = container.querySelector('.smrt-assistant-panel__result');
  expect(group?.textContent).toContain('2 more columns');
  expect(group?.querySelector('a[href="/reports/sales"]')?.textContent).toBe(
    'Open report',
  );
  expect(container.querySelector('[data-fit]')).not.toBeNull();
  // the reply text comes before the table
  const html = container.innerHTML;
  expect(html.indexOf('Maple leads.')).toBeLessThan(html.indexOf('<table'));
});

it('New chat forgets which replies were unfolded and which steps were opened', async () => {
  stubTurn(
    [],
    [
      { id: '1', seq: 1, role: 'user', content: 'one' },
      {
        id: '2',
        seq: 2,
        role: 'assistant',
        content: Array.from({ length: 12 }, (_, i) => `Point ${i}.`).join(
          '\n\n',
        ),
      },
      { id: '3', seq: 3, role: 'user', content: 'two' },
      { id: '4', seq: 4, role: 'assistant', content: 'Short.' },
    ],
  );
  await open({}, /Short\./);
  container
    .querySelector<HTMLButtonElement>('.smrt-assistant-panel__more')
    ?.click();
  await vi.waitFor(() =>
    expect(
      container.querySelector('.smrt-assistant-panel__more')?.textContent,
    ).toBe('Show less'),
  );
  [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.trim() === 'New chat')
    ?.click();
  await vi.waitFor(() =>
    expect(container.querySelector('.smrt-assistant-panel__more')).toBeNull(),
  );
});

it('reopens the most recent thread with its history on load, even before the chat is opened (#5608)', async () => {
  const fetchMock = vi.fn(async (input: unknown) => {
    const path = String(input);
    if (path.includes('/threads/t2'))
      return new Response(
        JSON.stringify({
          messages: [
            { id: '1', seq: 1, role: 'user', content: 'Earlier question' },
            { id: '2', seq: 2, role: 'assistant', content: 'Earlier answer' },
          ],
        }),
      );
    if (/\/threads(\?|$)/.test(path))
      return new Response(
        JSON.stringify({
          threads: [
            { id: 't1', title: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
            { id: 't2', title: 'new', updatedAt: '2026-02-01T00:00:00.000Z' },
          ],
        }),
      );
    return new Response(
      JSON.stringify(
        path.includes('/status') ? { configured: true } : { approvals: [] },
      ),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  await open({ open: false }, /Earlier answer/);
  expect(container.textContent).toContain('Earlier question');
  const threadCalls = fetchMock.mock.calls
    .map(([u]) => String(u))
    .filter((u) => /\/threads\/t/.test(u));
  expect(threadCalls).toEqual([expect.stringContaining('/threads/t2')]);
});
