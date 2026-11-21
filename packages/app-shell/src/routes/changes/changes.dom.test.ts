// The changes waiting view, mounted: cards, Remove, Quick edit, Apply (and its
// 409), Discard and Put them back. Runs under vitest.dom.config.ts (jsdom).
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesState } from '../../lib/ui/types.ts';
import { card, changes, noChanges } from '../../test/changes-fixtures.ts';
import { description } from '../../test/draft-fixtures.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({
  goto: vi.fn(async () => {}),
  invalidate: vi.fn(async () => {}),
  invalidateAll: vi.fn(async () => {}),
}));
vi.mock('$app/navigation', () => nav);
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('@happyvertical/smrt-ui', async (orig) => ({
  ...(await orig<object>()),
  toaster: toast,
}));

let component: ReturnType<typeof mount>;
let container: HTMLDivElement;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const button = (label: string | RegExp) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    typeof label === 'string'
      ? (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label
      : label.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  );

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  unmount(component);
  container.remove();
  vi.unstubAllGlobals();
});

async function render(state: ChangesState = changes()) {
  component = mount(Page, {
    target: container,
    props: {
      data: { changes: state, description: description('live') },
    } as never,
  });
  await tick();
}
const calls = () =>
  (fetch as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => {
    const init = call[1] as RequestInit | undefined;
    return [call[0], init?.method, init?.body];
  });

describe('changes waiting view', () => {
  it('lists one card per change in order, with plain words and a count', async () => {
    await render();
    const titles = [...container.querySelectorAll('article h3')].map(
      (h) => h.textContent,
    );
    expect(titles).toEqual([
      'Add field Fulfillment to Orders',
      'New report Orders by fulfillment',
    ]);
    expect(container.querySelector('h1')?.textContent).toMatch(
      /^Changes waiting\s*2$/,
    );
    expect(button('Apply 2 changes')).toBeTruthy();
    expect(container.textContent).not.toMatch(/draft|publish/i);
    expect(container.textContent).toContain('No existing records are replaced');
  });

  const importCards = () =>
    Array.from({ length: 4 }, (_, i) =>
      card({
        id: `t${i}`,
        position: i,
        group: 'import:one',
        source: 'import',
        summary: `Table ${i}: new table with 3 fields and 20 records`,
        commands: [{ type: 'defineModel', name: `T${i}`, fields: {} }],
      }),
    );

  it('shows an import under one collapsed group with its count, expanded on demand', async () => {
    await render(
      changes({
        cards: [card({ id: 'a', position: 9 }), ...importCards()],
      }),
    );
    const group = container.querySelector('[data-testid="change-group"]')!;
    expect(group.textContent).toContain('Imported from your workbook');
    expect(group.textContent).toContain('4 changes');
    // Collapsed: the table cards are not listed, the ordinary card is.
    const titles = () =>
      [...container.querySelectorAll('article h3')].map((h) => h.textContent);
    expect(titles()).toEqual(['Add field Fulfillment to Orders']);
    const head = group.querySelector<HTMLButtonElement>('button')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    head.click();
    await tick();
    expect(titles()).toHaveLength(5);
    expect(titles()).toContain(
      'Table 2: new table with 3 fields and 20 records',
    );
    // Remove and Quick edit still work per card inside the group.
    expect(
      button(
        'Remove this change: Table 2: new table with 3 fields and 20 records',
      ),
    ).toBeTruthy();
    expect(
      button('Quick edit: Table 2: new table with 3 fields and 20 records'),
    ).toBeTruthy();
    // An import's table is not offered a comment.
    expect(
      button('Comment on: Table 2: new table with 3 fields and 20 records'),
    ).toBeUndefined();
  });

  it('opens a group by itself when one of its cards needs a look', async () => {
    const cards = importCards();
    cards[1].checks = [
      { code: 'depends_on_removed', message: 'Needs one you removed.' },
    ];
    await render(changes({ cards }));
    expect(
      container
        .querySelector('[data-testid="change-group"] button')!
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(container.textContent).toContain('needs a look');
  });

  it('says it is rebuilding while a table is removed from an import', async () => {
    const cards = importCards();
    await render(changes({ cards }));
    let finish!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (finish = r))),
    );
    container
      .querySelector<HTMLButtonElement>('[data-testid="change-group"] button')!
      .click();
    await tick();
    button(
      'Remove this change: Table 3: new table with 3 fields and 20 records',
    )!.click();
    await tick();
    expect(container.textContent).toContain('Rebuilding your changes');
    finish(json(changes({ cards: cards.slice(0, 3) })));
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain('Rebuilding your changes'),
    );
  });

  it('has aria labels naming each card for Remove, Quick edit and Comment', async () => {
    await render();
    expect(
      button('Remove this change: Add field Fulfillment to Orders'),
    ).toBeTruthy();
    expect(button('Quick edit: Add field Fulfillment to Orders')).toBeTruthy();
    // The report card has nothing to quick edit.
    expect(
      button('Quick edit: New report Orders by fulfillment'),
    ).toBeUndefined();
    expect(button('Comment on: New report Orders by fulfillment')).toBeTruthy();
  });

  it('removes a card and shows it under Removed with Put back', async () => {
    const after = changes({
      cards: [
        card(),
        card({
          id: 'c2',
          position: 1,
          status: 'removed',
          summary: 'New report Orders by fulfillment',
        }),
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(after)),
    );
    await render();
    button('Remove this change: New report Orders by fulfillment')?.click();
    await vi.waitFor(() =>
      expect(calls()).toContainEqual([
        '/api/shell/changes/cards/c2/remove',
        'POST',
        JSON.stringify({ generation: 3 }),
      ]),
    );
    await vi.waitFor(() =>
      expect(container.querySelectorAll('article')).toHaveLength(1),
    );
    expect(container.textContent).toContain(
      'Removed: New report Orders by fulfillment',
    );
    expect(button('Apply 1 change')).toBeTruthy();
    expect(button('Put back: New report Orders by fulfillment')).toBeTruthy();
  });

  it('keeps a removed card restorable when it was the only one left', async () => {
    const only = changes({
      count: 0,
      cards: [
        card({ id: 'c2', status: 'removed', summary: 'New report Orders' }),
      ],
    });
    const back = changes();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(back)),
    );
    await render(only);
    expect(container.textContent).toContain('Nothing waiting');
    expect(container.textContent).toContain('Removed: New report Orders');
    expect(button('Discard all')).toBeTruthy();
    button('Put back: New report Orders')?.click();
    await vi.waitFor(() =>
      expect(calls()).toContainEqual([
        '/api/shell/changes/cards/c2/restore',
        'POST',
        JSON.stringify({ generation: 3 }),
      ]),
    );
    await vi.waitFor(() =>
      expect(container.querySelectorAll('article').length).toBeGreaterThan(0),
    );
  });

  it('quick edits the name and choices, with no default control', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(changes())),
    );
    await render();
    button('Quick edit: Add field Fulfillment to Orders')?.click();
    await tick();
    expect(container.querySelector('select')).toBeNull();
    expect(container.textContent).not.toMatch(/Starts as|default/i);
    const name =
      container.querySelector<HTMLInputElement>('input[name="name"]')!;
    name.value = 'Delivery method';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const add = container.querySelector<HTMLInputElement>(
      'input[aria-label="Add a choice"]',
    )!;
    add.value = 'Courier';
    add.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[0]).toEqual([
      '/api/shell/changes/cards/c1',
      'PATCH',
      JSON.stringify({ label: 'Delivery method', generation: 3 }),
    ]);
    expect(calls()[1][2]).toBe(
      JSON.stringify({
        choices: ['Pickup', 'Delivery', 'Courier'],
        generation: 3,
      }),
    );
  });

  it('applies with the reviewed digest, thanks the owner and lands on the records', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ id: 'a1', status: 'approved' })),
    );
    await render();
    button('Apply 2 changes')?.click();
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalled());
    expect(calls()[0]).toEqual([
      '/api/shell/changes/apply',
      'POST',
      JSON.stringify({ expect: 'digest-1', generation: 3 }),
    ]);
    expect(toast.success).toHaveBeenCalledWith(
      'Applied. Your app is live',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'See History' }),
      }),
    );
    expect(nav.goto).toHaveBeenCalledWith('/', { invalidateAll: true });
  });

  it('asks to review again on a 409 and refreshes with the new digest', async () => {
    const fresh = changes({ digest: 'digest-2' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'changed' }, 409))
      .mockResolvedValueOnce(json(fresh));
    vi.stubGlobal('fetch', fetchMock);
    await render();
    button('Apply 2 changes')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Review them again',
      ),
    );
    expect(nav.goto).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/shell/changes');
    button('Apply 2 changes')?.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][1].body).toBe(
      JSON.stringify({ expect: 'digest-2', generation: 3 }),
    );
  });

  it("shows a per-app cap refusal on Apply as the owner's own notice, not the stale-digest line", async () => {
    const message =
      'app limit reached (maxModels): this app has 3 of the 3 models allowed; adding 1 would pass the limit';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          json({ error: message, code: 'app_limit', cap: 'maxModels' }, 409),
        )
        .mockResolvedValueOnce(json(changes())),
    );
    await render();
    button('Apply 2 changes')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        message,
      ),
    );
    expect(container.textContent).not.toContain('Review them again');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('discards at once, then Put them back restores', async () => {
    const gone = noChanges({
      discarded: { batchId: 'b1', count: 2, generation: 4 },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(gone))
      .mockResolvedValueOnce(json(changes()));
    vi.stubGlobal('fetch', fetchMock);
    await render();
    button('Discard all')?.click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Nothing waiting'),
    );
    expect(container.querySelector('dialog[open]')).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/shell/changes/discard');
    button('Put them back (2 changes)')?.click();
    await vi.waitFor(() =>
      expect(container.querySelectorAll('article')).toHaveLength(2),
    );
    expect(fetchMock.mock.calls[1][0]).toBe('/api/shell/changes/restore');
    // the discarded batch's own generation, never an omitted or zero one
    expect(fetchMock.mock.calls[1][1].body).toBe(
      JSON.stringify({ generation: 4 }),
    );
  });

  it('shows what a review choice adds next to its button', async () => {
    await render(
      changes({
        cards: [
          card({
            questions: [
              {
                id: 'q1',
                text: 'Track a note?',
                choices: [
                  {
                    label: 'Sure',
                    adds: true,
                    summary: 'Add field Note to Orders',
                  },
                  { label: 'Skip', adds: false },
                ],
                state: 'open',
              },
            ],
          }),
        ],
      }),
    );
    const shown = [
      ...container.querySelectorAll('[data-testid="choice-adds"]'),
    ];
    expect(shown.map((e) => e.textContent)).toEqual([
      'Adds: Add field Note to Orders',
    ]);
  });

  it('keeps Apply off while checking or blocked and says why', async () => {
    await render(changes({ checkState: 'stale', canApply: false }));
    expect((button('Apply 2 changes') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(container.textContent).toContain('Checking…');
    unmount(component);
    container.innerHTML = '';
    await render(
      changes({
        checkState: 'blocked',
        canApply: false,
        blockers: [
          {
            code: 'replay_failed',
            message: 'Needs the Fulfillment field',
            cardId: 'c2',
          },
        ],
      }),
    );
    expect((button('Apply 2 changes') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Can't apply yet",
    );
    expect(
      container.querySelector('[data-card-id="c2"]')?.textContent,
    ).toContain('Needs the Fulfillment field');
  });

  it('shows Put it back and Remove those too on a card that needs a removed change', async () => {
    const state = changes({
      checkState: 'blocked',
      canApply: false,
      cards: [
        card({
          id: 'c2',
          position: 1,
          summary: 'Add field Size to Gadget',
          checks: [
            {
              code: 'depends_on_removed',
              message:
                'This change needs one you removed. Put that one back, or remove this one too.',
              cause: 'c1',
            },
          ],
        }),
        card({
          id: 'c1',
          position: 0,
          status: 'removed',
          summary: 'New table Gadget',
        }),
      ],
      blockers: [
        {
          code: 'depends_on_removed',
          message:
            'This change needs one you removed. Put that one back, or remove this one too.',
          cardId: 'c2',
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(changes())),
    );
    await render(state);
    // the same message from the card and from the blockers shows once
    expect(
      container.querySelectorAll(
        '[data-card-id="c2"] .smrt-change-card__chip-bad',
      ),
    ).toHaveLength(1);
    expect((button(/Apply \d+ change/) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(container.textContent).not.toMatch(/draft|publish/i);
    button('Put it back')?.click();
    await vi.waitFor(() =>
      expect(calls()).toContainEqual([
        '/api/shell/changes/cards/c1/restore',
        'POST',
        JSON.stringify({ generation: 3 }),
      ]),
    );
    unmount(component);
    container.innerHTML = '';
    await render(state);
    button('Remove those too')?.click();
    await vi.waitFor(() =>
      expect(calls()).toContainEqual([
        '/api/shell/changes/cards/c2/remove-dependents',
        'POST',
        JSON.stringify({ generation: 3 }),
      ]),
    );
  });

  it('offers only Remove those too when the removed change is not known, and keeps Apply off while the check runs', async () => {
    await render(
      changes({
        checkState: 'checking',
        canApply: false,
        cards: [
          card({
            checks: [
              { code: 'depends_on_removed', message: 'Needs one you removed.' },
            ],
          }),
        ],
      }),
    );
    expect(button('Put it back')).toBeUndefined();
    expect(button('Remove those too')).toBeTruthy();
    expect((button(/Apply \d+ change/) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows overwrite counts without ever disabling Apply', async () => {
    await render(
      changes({
        overwrites: {
          recordsUpdated: 4,
          recordsMerged: 0,
          archivedValues: 0,
          archivedTables: 0,
        },
      }),
    );
    expect(container.textContent).toContain('4 existing records replaced');
    expect((button(/Apply \d+ change/) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('shows the overwrite count on the summary only', async () => {
    await render(
      changes({
        overwrites: {
          recordsUpdated: 3,
          recordsMerged: 0,
          archivedValues: 0,
          archivedTables: 0,
        },
      }),
    );
    expect(container.querySelector('aside')?.textContent).toContain(
      '3 existing records replaced',
    );
  });

  it('has no Remove or Quick edit on an adopted change', async () => {
    await render(
      changes({
        cards: [card({ opaque: true, editable: false, commands: [] })],
      }),
    );
    expect(button(/Remove this change/)).toBeUndefined();
    expect(button(/Quick edit/)).toBeUndefined();
  });
});

describe('the assistant on a card (comment and questions)', () => {
  const askedCard = () =>
    card({
      questions: [
        {
          id: 'q_1',
          text: 'Mark your 35 orders as Pickup?',
          choices: [
            { label: 'Yes, mark them', adds: true },
            { label: 'Leave them blank', adds: false },
          ],
          state: 'open',
        },
      ],
    });

  it('a comment goes to the assistant for that one card, shows "Changing this…", then the thread; nothing is applied', async () => {
    const answered = changes({
      cards: [
        card({
          revision: 2,
          comments: [
            {
              kind: 'comment',
              role: 'owner',
              text: 'Add Delivery too',
              at: 'now',
              state: 'done',
            },
            {
              kind: 'comment',
              role: 'assistant',
              text: 'Done. I changed this card.',
              at: 'now',
              state: 'done',
            },
          ],
        }),
      ],
    });
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            release = r;
          }),
      ),
    );
    await render(changes({ cards: [card()] }));
    button('Comment on: Add field Fulfillment to Orders')?.click();
    await tick();
    const box = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!box) throw new Error('no comment box');
    box.value = 'Add Delivery too';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    button('Send')?.click();
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-testid="revising"]')?.textContent,
      ).toContain('Changing this'),
    );
    expect(calls()).toEqual([
      [
        '/api/shell/changes/cards/c1/comment',
        'POST',
        JSON.stringify({ text: 'Add Delivery too' }),
      ],
    ]);
    release(json(answered));
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-testid="comment-thread"]')?.textContent,
      ).toContain('Done. I changed this card.'),
    );
    expect(container.querySelector('[data-testid="revising"]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    // never applied: only the comment call was made
    expect(calls().some(([url]) => /apply/.test(String(url)))).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('an adopted (opaque) change cannot be commented on', async () => {
    await render(
      changes({
        cards: [card({ opaque: true, editable: false, commands: [] })],
      }),
    );
    expect(button(/Comment on/)).toBeUndefined();
  });

  it('shows a question with click-to-answer choices (plain text); a click sends only the choice index', async () => {
    const after = changes({
      cards: [
        card({
          questions: [
            { ...askedCard().questions[0], state: 'answered', answered: 0 },
          ],
        }),
        card({
          id: 'c9',
          position: 1,
          summary: 'Set Fulfillment on 35 orders',
        }),
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(after)),
    );
    await render(changes({ cards: [askedCard()] }));
    expect(
      container.querySelector('[data-testid="review-question"]')?.textContent,
    ).toContain('Mark your 35 orders as Pickup?');
    // Apply is not blocked by an open question
    expect(button('Apply 1 change')?.disabled).toBe(false);
    button('Yes, mark them')?.click();
    await vi.waitFor(() =>
      expect(calls()).toEqual([
        [
          '/api/shell/changes/questions/q_1/answer',
          'POST',
          JSON.stringify({ choice: 0, generation: 3 }),
        ],
      ]),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain('You chose: Yes, mark them'),
    );
    expect(container.querySelectorAll('article')).toHaveLength(2);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('question text from the model is shown as text, never as markup', async () => {
    const evil = card({
      questions: [
        {
          id: 'q_2',
          text: '<img src=x onerror=alert(1)> **bold** <script>x()</script>',
          choices: [{ label: '<b>Yes</b>', adds: false }],
          state: 'open',
        },
      ],
    });
    await render(changes({ cards: [evil] }));
    const q = container.querySelector('[data-testid="review-question"]');
    expect(q?.querySelector('img, script, b')).toBeNull();
    expect(q?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
