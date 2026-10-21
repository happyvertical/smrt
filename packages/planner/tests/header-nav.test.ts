import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { PLANNER_TAB_IDS } from '../src/lib/planner/commands/index.ts';
import {
  NAV_GROUP_TABS,
  navEntryTab,
  navGroupOf,
} from '../src/lib/planner/header-nav.ts';
import Planner from '../src/lib/planner/Planner.svelte';

const headerLinks = (body: string) =>
  [...body.matchAll(/<a\b[^>]*class="[^"]*header-link[^"]*"[^>]*>/g)].map(
    (m) => m[0],
  );

describe('labelled header navigation', () => {
  it('lists specs as a tab and groups every tab once at most', () => {
    expect(PLANNER_TAB_IDS).toContain('specs');
    const grouped = Object.values(NAV_GROUP_TABS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(navGroupOf('cookbooks')).toBe('features');
    expect(navGroupOf('features')).toBe('features');
    expect(navGroupOf('layout')).toBe('features');
    expect(navGroupOf('settings')).toBe('styles');
    expect(navGroupOf('specs')).toBe('specs');
    expect(navGroupOf('export')).toBe('build');
    expect(navEntryTab('features', 'cookbooks')).toBe('cookbooks');
    expect(navEntryTab('features', 'export')).toBe('recipes');
    expect(navEntryTab('styles', 'recipes')).toBe('theme');
  });

  it('keeps the icon header by default', () => {
    const { body } = render(Planner, {});
    const links = headerLinks(body);
    expect(links.some((l) => l.includes('data-tone'))).toBe(false);
    expect(body).toContain('aria-label="Plan the app"');
    expect(body).toContain('aria-label="Export the app"');
    expect(body).not.toContain('href="#/configure/specs/"');
  });

  it('renders Specs, Features, Styles, Build in order with their targets', () => {
    const { body } = render(Planner, { props: { headerNav: 'labelled' } });
    const links = headerLinks(body).filter((l) => l.includes('data-tone'));
    expect(links.map((l) => /data-tone="(\w+)"/.exec(l)?.[1])).toEqual([
      'specs',
      'features',
      'styles',
      'build',
    ]);
    const hrefs = links.map((l) => /href="([^"]+)"/.exec(l)?.[1]);
    expect(hrefs).toEqual([
      '#/configure/specs/',
      '#/configure/recipes/',
      '#/configure/theme/',
      '#/configure/export/',
    ]);
    expect(body).not.toContain('aria-label="Plan the app"');
    expect(body).not.toContain('aria-label="Export the app"');
    for (const text of ['Specs', 'Features', 'Styles', 'Build']) {
      expect(body).toMatch(new RegExp(`<span[^>]*>${text}</span>`));
    }
    for (const name of [
      'planner-specs',
      'planner-customize',
      'planner-styles',
      'planner-export',
    ]) {
      expect(body).toContain(
        `--smrt-header-icon-link-transition-name: ${name}`,
      );
    }
  });

  it('labels Build with exportLabel when the host sets one', () => {
    const { body } = render(Planner, {
      props: { headerNav: 'labelled', exportLabel: 'Ship it' },
    });
    expect(body).toMatch(/<span[^>]*>Ship it<\/span>/);
    expect(body).not.toMatch(/<span[^>]*>Build<\/span>/);
  });
});
