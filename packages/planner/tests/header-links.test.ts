import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import HeaderIconLink from '../src/lib/components/HeaderIconLink.svelte';
import { CHEF_HAT_ICON } from '../src/lib/planner/header-icons.ts';

const layoutSource = readFileSync(
  new URL('../src/routes/+layout.svelte', import.meta.url),
  'utf8',
);

describe('header icon links', () => {
  it('is a labelled icon link that marks its page current', () => {
    const plain = render(HeaderIconLink, {
      props: {
        href: '/planner/',
        label: 'Plan the app',
        path: CHEF_HAT_ICON,
        transitionName: 'planner-customize',
      },
    }).body;
    expect(plain).toContain('aria-label="Plan the app"');
    expect(plain).toContain('title="Plan the app"');
    expect(plain).toContain(CHEF_HAT_ICON);
    expect(plain).not.toContain('aria-current');
    const current = render(HeaderIconLink, {
      props: {
        href: '/planner/',
        label: 'Plan the app',
        path: CHEF_HAT_ICON,
        current: true,
        transitionName: 'planner-customize',
      },
    }).body;
    expect(current).toContain('aria-current="page"');
    expect(current).toContain('--planner-transition-name: planner-customize');
  });

  it("draws the chef's hat as a filled 24x24 path", () => {
    expect(CHEF_HAT_ICON).toMatch(/^M[\d. ,a-zA-Z-]+z$/);
    const numbers = CHEF_HAT_ICON.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    for (const n of numbers) expect(n).toBeGreaterThanOrEqual(-24);
    for (const n of numbers) expect(n).toBeLessThanOrEqual(24);
  });

  // The static app's layout renders inside SvelteKit's runtime, so its header
  // is checked at the source: the same control, with the same name, as the
  // mounted `Planner` (tests/planner-mount.test.ts).
  it("the static app shows the chef's hat at the end of its header too", () => {
    expect(layoutSource).toContain("id: 'planner-customize'");
    expect(layoutSource).toContain("slot: 'header.end'");
    expect(layoutSource).toContain('label="Plan the app"');
    expect(layoutSource).toContain('path={CHEF_HAT_ICON}');
    expect(layoutSource).not.toContain('Customize');
  });
});
