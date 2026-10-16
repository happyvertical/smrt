// @ts-expect-error untyped internal: `proxy` is what `$state` wraps a value with in a browser build.
import { proxy } from 'svelte/internal/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { saveCookbook } from '../src/lib/cookbook/storage.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { COOKBOOK_SCHEMA } from '../src/lib/cookbook/types.ts';
import { createPlannerController } from '../src/lib/planner/commands/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage;
}

const LAYOUT = {
  version: 1,
  hidden: ['section:purchases'],
  sectionOrder: ['section:sales', 'section:purchases'],
  panels: { right: { visible: false } },
};

const SAVED = {
  $schema: COOKBOOK_SCHEMA,
  version: 1,
  recipes: ['commerce.sales', 'commerce.purchases'],
  policies: [],
  layout: LAYOUT,
};

/**
 * The browser build keeps `$state` fields behind proxies; this suite compiles
 * Svelte for the server, where they are plain values. Wrapping a value with
 * the client runtime's `proxy` is what `$state` does to it in a browser.
 */
const asClientState = <T>(value: T): T => proxy(value as object) as T;

describe('a saved cookbook with a layout survives a reload (#53)', () => {
  beforeEach(() => {
    recipeState.clear();
  });

  it('snapshot() hands the engine plain data, never a $state proxy', () => {
    const storage = fakeStorage();
    expect(saveCookbook(storage, SAVED as never)).toBe(true);

    const store = new CookbookStore();
    expect(store.hydrate('', storage)).toBe(false);
    // `requires` folds the customers and vendors recipes in as well.
    expect(recipeState.ids).toEqual(
      expect.arrayContaining(['commerce.sales', 'commerce.purchases']),
    );
    expect(store.layout).toEqual(LAYOUT);
    store.layout = asClientState(store.layout);
    store.overviews = asClientState(store.overviews);
    recipeState.rows = asClientState(recipeState.rows);

    const snapshot = store.snapshot();
    // What smrt-core's engine does with the document on every sync.
    expect(() => structuredClone(snapshot)).not.toThrow();
    expect(snapshot.layout).toEqual(LAYOUT);
  });

  it('the controller reads the re-hydrated plan, recipes and layout intact', () => {
    const storage = fakeStorage();
    saveCookbook(storage, SAVED as never);
    const store = new CookbookStore();
    store.hydrate('', storage);
    store.layout = asClientState(store.layout);

    const controller = createPlannerController(store);
    const read = controller.snapshot();
    expect(read.recipes.map((r) => r.id)).toEqual(
      expect.arrayContaining(['commerce.purchases', 'commerce.sales']),
    );
    expect(controller.cookbook().layout).toEqual(LAYOUT);

    const result = controller.run({
      name: 'add_recipes',
      input: { ids: ['events.calendar'] },
    });
    expect(result.ok, !result.ok ? result.error.message : '').toBe(true);
    expect(controller.cookbook().layout).toEqual(LAYOUT);
    expect(recipeState.ids).toContain('events.calendar');
  });
});
