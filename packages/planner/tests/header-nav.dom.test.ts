import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import Planner from '../src/lib/planner/Planner.svelte';

let app: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
const settle = async () => {
  for (let n = 0; n < 12; n++) await tick();
};
beforeEach(() => {
  cookbookStore.reset();
  location.hash = '';
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  target.remove();
  vi.unstubAllGlobals();
  cookbookStore.reset();
  location.hash = '';
});

const nav = () =>
  [...target.querySelectorAll<HTMLAnchorElement>('a[data-tone]')].map((a) => ({
    tone: a.dataset.tone,
    href: a.getAttribute('href'),
    text: a.textContent?.trim(),
    current: a.getAttribute('aria-current'),
  }));

it('marks only the button whose group is open as current', async () => {
  location.hash = '#/configure/recipes/';
  app = mount(Planner, {
    target,
    props: { headerNav: 'labelled', persistence: 'host' },
  });
  await settle();
  expect(nav()).toEqual([
    { tone: 'specs', href: '#/configure/specs/', text: 'Specs', current: null },
    {
      tone: 'features',
      href: '#/configure/recipes/',
      text: 'Features',
      current: 'page',
    },
    {
      tone: 'styles',
      href: '#/configure/theme/',
      text: 'Styles',
      current: null,
    },
    {
      tone: 'build',
      href: '#/configure/export/',
      text: 'Build',
      current: null,
    },
  ]);
  const tabs = [...target.querySelectorAll('[role="tab"]')].map((t) =>
    t.textContent?.trim(),
  );
  expect(tabs).toEqual(['Cookbooks', 'Recipes', 'Features']);
});

it('follows the route to Specs and shows its panel', async () => {
  location.hash = '#/configure/specs/';
  app = mount(Planner, {
    target,
    props: { headerNav: 'labelled', persistence: 'host' },
  });
  await settle();
  expect(nav().find((n) => n.tone === 'specs')?.current).toBe('page');
  expect(nav().filter((n) => n.current).length).toBe(1);
  expect(target.querySelector('#planner-specs-input')).not.toBeNull();
});
