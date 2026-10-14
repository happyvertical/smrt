import { afterEach, describe, expect, it } from 'vitest';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { applyLibraryCookbook } from '../src/lib/library/apply.ts';
import { libraryCookbooks } from '../src/lib/library/index.ts';
import {
  DEFAULT_PLANNER_TITLE,
  plannerTitle,
} from '../src/lib/planner/title.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

afterEach(() => recipeState.clear());

const bakery = libraryCookbooks.find((c) => c.id === 'bakery');
if (!bakery) throw new Error('library has no bakery');

describe('plannerTitle', () => {
  it('falls back to Planner for an empty cookbook', () => {
    expect(plannerTitle({ recipes: [], features: [] }, null)).toBe(
      DEFAULT_PLANNER_TITLE,
    );
  });

  it('shows the applied library cookbook by its friendly name, not its id', () => {
    const store = new CookbookStore();
    expect(applyLibraryCookbook(bakery, store).ok).toBe(true);
    expect(plannerTitle(store.snapshot(), 'bakery')).toBe('Bakery');
    for (const entry of libraryCookbooks) {
      expect(plannerTitle(entry.document, entry.id)).toBe(entry.name);
      expect(entry.name).not.toBe(entry.id);
    }
  });

  it('lets an explicit app name win over the applied cookbook', () => {
    const store = new CookbookStore();
    applyLibraryCookbook(bakery, store);
    store.name = 'Rose & Rye';
    expect(plannerTitle(store.snapshot(), 'bakery')).toBe('Rose & Rye');
    store.name = '   ';
    expect(plannerTitle(store.snapshot(), 'bakery')).toBe('Bakery');
  });

  it('drops the library name once the cookbook is reset or no longer held', () => {
    const store = new CookbookStore();
    applyLibraryCookbook(bakery, store);
    store.reset();
    expect(plannerTitle(store.snapshot(), 'bakery')).toBe(
      DEFAULT_PLANNER_TITLE,
    );
    expect(
      plannerTitle({ recipes: [], features: [] }, 'no-such-cookbook'),
    ).toBe(DEFAULT_PLANNER_TITLE);
  });
});
