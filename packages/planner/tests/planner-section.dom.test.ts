/**
 * The mounted Planner's section pages are the framework's
 * `CookbookSectionPage` (smrt#3888): drawn `plain` with the planner's heading,
 * the shortcuts carrying record counts from the planner's
 * `loaders.shortcuts`. The overview grid renders after hydration, so this
 * mounts the component in a DOM.
 */
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CookbookStore,
  cookbookStore,
} from '../src/lib/cookbook/store.svelte.ts';
import { COOKBOOK_SCHEMA } from '../src/lib/cookbook/types.ts';
import { setBasePath } from '../src/lib/planner/app.svelte.ts';
import Planner from '../src/lib/planner/Planner.svelte';

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

describe('the mounted Planner section page', () => {
  let target: HTMLElement;
  let app: ReturnType<typeof mount> | undefined;
  const previous = new CookbookStore();

  beforeEach(() => {
    previous.apply(cookbookStore.snapshot());
    cookbookStore.apply({
      $schema: COOKBOOK_SCHEMA,
      version: 1,
      recipes: ['commerce.sales'],
      features: [],
      policies: [],
    });
    cookbookStore.loaded = true;
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (app) unmount(app);
    app = undefined;
    target.remove();
    document.body.innerHTML = '';
    cookbookStore.apply(previous.snapshot());
    cookbookStore.loaded = false;
    setBasePath('');
  });

  it('renders the framework section page plain, with record counts on the shortcuts', async () => {
    app = mount(Planner, { target, props: { basePath: '/planner' } });
    await settle();
    const page = target.querySelector(
      '[data-smrt-component="CookbookSectionPage"]',
    );
    expect(page).not.toBeNull();
    expect(page?.querySelector('header.section-heading h1')?.textContent).toBe(
      'Sales',
    );
    const grid = page?.querySelector('[data-smrt-component="OverviewGrid"]');
    expect(grid?.getAttribute('data-presentation')).toBe('plain');
    const counts = [
      ...(page?.querySelectorAll('.smrt-shortcuts__count') ?? []),
    ].map((node) => node.textContent?.trim() ?? '');
    expect(counts.length).toBeGreaterThan(0);
    for (const count of counts) expect(count).toMatch(/^\d+ records?$/);
  });
});
