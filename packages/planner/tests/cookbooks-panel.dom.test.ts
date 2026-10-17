/**
 * The Cookbooks tab mounted in a DOM: a card opens that cookbook's detail in
 * place of the grid, the back control (or Escape) returns to the grid with
 * focus on the card, and the swap is a view transition except under reduced
 * motion, where it is instant.
 */
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_SOURCE_KEY } from '../src/lib/data/context.ts';
import {
  cookbookFromSearch,
  cookbookView,
  withCookbook,
} from '../src/lib/library/view.svelte.ts';
import CookbooksPanel from './cookbooks-panel.fixture.svelte';

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

/** The document's view-transition slot, writable for the stub. */
const slot = document as unknown as { startViewTransition?: unknown };

/** A stand-in for `document.startViewTransition` that runs the update at once. */
function stubViewTransitions() {
  const start = vi.fn((update: () => unknown) => {
    const done = Promise.resolve(update());
    return { updateCallbackDone: done, ready: done, finished: done };
  });
  slot.startViewTransition = start;
  return start;
}

function reducedMotion(reduce: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion: reduce'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
}

describe('the cookbooks panel', () => {
  let target: HTMLElement;
  let app: ReturnType<typeof mount> | undefined;
  const context = new Map<unknown, unknown>([[DATA_SOURCE_KEY, {}]]);

  const grid = () => target.querySelector('ul[aria-label="Cookbooks"]');
  const detail = () => target.querySelector('[data-cookbook-detail]');
  const card = (id: string) =>
    target.querySelector<HTMLButtonElement>(`[data-cookbook="${id}"]`);
  const backButton = () =>
    [...target.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Back to cookbooks'),
    );

  beforeEach(() => {
    cookbookView.open = null;
    cookbookView.returnTo = null;
    cookbookView.navigator = null;
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (app) unmount(app);
    app = undefined;
    target.remove();
    delete slot.startViewTransition;
    vi.restoreAllMocks();
    cookbookView.open = null;
  });

  it('opens a cookbook in place of the grid, focused at its heading', async () => {
    reducedMotion(false);
    app = mount(CookbooksPanel, { target, context });
    await settle();
    expect(grid()).not.toBeNull();
    expect(detail()).toBeNull();

    card('mechanic')?.click();
    await settle();
    expect(grid()).toBeNull();
    expect(detail()?.getAttribute('data-cookbook-detail')).toBe('mechanic');
    expect(detail()?.querySelector('h2')?.textContent).toBe('Mechanic');
    expect(document.activeElement).toBe(detail()?.querySelector('h2'));
    // The form is the detail's own: Use this cookbook sits in it.
    expect(detail()?.textContent).toContain('Use this cookbook');
  });

  it('goes back to the grid, focused on the card it came from', async () => {
    reducedMotion(false);
    app = mount(CookbooksPanel, { target, context });
    await settle();
    card('roaster')?.click();
    await settle();
    const back = backButton();
    expect(back?.textContent?.trim()).toMatch(/Back to cookbooks$/);
    back?.click();
    await settle();
    expect(detail()).toBeNull();
    expect(grid()).not.toBeNull();
    expect(document.activeElement).toBe(card('roaster'));
  });

  it('goes back on Escape', async () => {
    reducedMotion(false);
    app = mount(CookbooksPanel, { target, context });
    await settle();
    card('bakery')?.click();
    await settle();
    detail()?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();
    expect(detail()).toBeNull();
    expect(document.activeElement).toBe(card('bakery'));
  });

  it('crossfades through a view transition', async () => {
    reducedMotion(false);
    const start = stubViewTransitions();
    app = mount(CookbooksPanel, { target, context });
    await settle();
    card('mechanic')?.click();
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
    expect(detail()).not.toBeNull();
  });

  it('swaps instantly under reduced motion', async () => {
    reducedMotion(true);
    const start = stubViewTransitions();
    app = mount(CookbooksPanel, { target, context });
    await settle();
    card('mechanic')?.click();
    await settle();
    expect(detail()).not.toBeNull();
    backButton()?.click();
    await settle();
    expect(grid()).not.toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('hands the address to a host navigator', async () => {
    reducedMotion(false);
    const calls: string[] = [];
    cookbookView.navigator = {
      open: (id) => {
        calls.push(`open ${id}`);
        void cookbookView.set(id, false);
      },
      close: () => {
        calls.push('close');
        void cookbookView.set(null, false);
      },
    };
    app = mount(CookbooksPanel, { target, context });
    await settle();
    card('agency')?.click();
    await settle();
    backButton()?.click();
    await settle();
    expect(calls).toEqual(['open agency', 'close']);
    expect(grid()).not.toBeNull();
  });
});

describe('the cookbook query', () => {
  it('reads and writes ?cookbook= beside the other parameters', () => {
    const ids = ['mechanic', 'bakery'];
    expect(cookbookFromSearch('?tab=cookbooks&cookbook=mechanic', ids)).toBe(
      'mechanic',
    );
    expect(cookbookFromSearch('?cookbook=nope', ids)).toBeNull();
    expect(withCookbook('?tab=cookbooks', 'mechanic')).toBe(
      '?tab=cookbooks&cookbook=mechanic',
    );
    expect(withCookbook('?tab=cookbooks&cookbook=mechanic', null)).toBe(
      '?tab=cookbooks',
    );
    expect(withCookbook('?p=a,b', null)).toBe('?p=a,b');
  });
});
