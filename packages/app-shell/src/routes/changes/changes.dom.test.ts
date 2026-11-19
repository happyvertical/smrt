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

  it('has aria labels naming each card for Remove and Quick edit, and no Comment yet', async () => {
    await render();
    expect(
      button('Remove this change: Add field Fulfillment to Orders'),
    ).toBeTruthy();
    expect(button('Quick edit: Add field Fulfillment to Orders')).toBeTruthy();
    // The report card has nothing to quick edit.
    expect(
      button('Quick edit: New report Orders by fulfillment'),
    ).toBeUndefined();
    expect(button(/Comment/)).toBeUndefined();
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

  it('discards at once, then Put them back restores', async () => {
    const gone = noChanges({ discarded: { batchId: 'b1', count: 2 } });
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
