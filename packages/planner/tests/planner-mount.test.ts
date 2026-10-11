import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import {
  appHref,
  getBasePath,
  setBasePath,
} from '../src/lib/planner/app.svelte.ts';
import { PLANNER_TAB_IDS } from '../src/lib/planner/commands/index.ts';
import Planner from '../src/lib/planner/Planner.svelte';

describe('Planner component', () => {
  it('renders every tab with no AppShell, router or data source around it', () => {
    const { body } = render(Planner, { props: { basePath: '/planner' } });
    for (const label of [
      'Cookbooks',
      'Recipes',
      'Features',
      'Layout',
      'Settings',
      'Export',
    ]) {
      expect(body, label).toContain(label);
    }
    expect(PLANNER_TAB_IDS).toHaveLength(6);
  });

  it('builds its links from basePath, not from SvelteKit', () => {
    setBasePath('/kitchen/');
    expect(getBasePath()).toBe('/kitchen');
    expect(appHref('/recipes/sales/')).toBe('/kitchen/recipes/sales/');
    setBasePath('');
    expect(appHref('/ai/')).toBe('/ai/');
  });

  it('shows only the tabs it is given', () => {
    const { body } = render(Planner, {
      props: { tabs: ['recipes', 'export'] },
    });
    expect(body).toContain('Recipes');
    expect(body).toContain('Export');
    expect(body).not.toContain('Cookbooks');
  });
});
