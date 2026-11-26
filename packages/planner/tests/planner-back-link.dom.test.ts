/**
 * #5208: with `backLink` set, the header row overflowed a 390px viewport (the
 * brand, the link's label and the layout toggle left the actions 11px short).
 * At the shell's phone width the link shows its arrow only; the label stays in
 * the DOM as the link's accessible name, so it is clipped, never `display:none`.
 * Measured in Chromium at 390px and 360px: every header control ends inside
 * the viewport.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import Planner from '../src/lib/planner/Planner.svelte';

let app: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
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
});

it('keeps the back link label in the DOM as its accessible name', async () => {
  app = mount(Planner, {
    target,
    props: {
      persistence: 'host',
      backLink: { href: '/docs', label: 'Back to documentation' },
    },
  });
  for (let n = 0; n < 12; n++) await tick();
  const link = target.querySelector<HTMLAnchorElement>('[data-planner-back]');
  expect(link?.getAttribute('href')).toBe('/docs');
  expect(link?.querySelector('.smrt-planner__back-label')?.textContent).toBe(
    'Back to documentation',
  );
  expect(link?.querySelector('[aria-hidden="true"]')?.textContent).toBe('←');
});

it('clips the label at phone width instead of removing it', () => {
  const source = readFileSync(
    join(
      process.cwd().endsWith('packages/planner')
        ? process.cwd()
        : join(process.cwd(), 'packages/planner'),
      'src/lib/planner/Planner.svelte',
    ),
    'utf8',
  );
  const media = source.indexOf('@media (max-width: 48rem)');
  expect(media).toBeGreaterThan(-1);
  const label = source.indexOf('.smrt-planner__back-label {', media);
  expect(label).toBeGreaterThan(media);
  const rule = source.slice(label, source.indexOf('}', label));
  expect(rule).toMatch(/clip-path:\s*inset\(50%\)/);
  expect(rule).not.toMatch(/display:\s*none/);
});
