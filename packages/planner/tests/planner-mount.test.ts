import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PackagePage from '../src/lib/components/PackagePage.svelte';
import {
  CookbookStore,
  cookbookStore,
} from '../src/lib/cookbook/store.svelte.ts';
import { COOKBOOK_SCHEMA } from '../src/lib/cookbook/types.ts';
import { plannerLoaders } from '../src/lib/overviews/registry.ts';
import {
  appHref,
  getBasePath,
  setBasePath,
} from '../src/lib/planner/app.svelte.ts';
import { PLANNER_TAB_IDS } from '../src/lib/planner/commands/index.ts';
import { CHEF_HAT_ICON } from '../src/lib/planner/header-icons.ts';
import Planner from '../src/lib/planner/Planner.svelte';
import PlannerControls from '../src/lib/planner/PlannerControls.svelte';
import { selection } from '../src/lib/planner/selection.svelte.ts';
import { plannerTab } from '../src/lib/planner/tab.svelte.ts';

describe('Planner component', () => {
  it('renders the app shell and its customization controls without a host router', () => {
    const { body } = render(Planner, { props: { basePath: '/planner' } });
    expect(body).toContain('smrt-admin-shell');
    for (const label of [
      'Cookbooks',
      'Recipes',
      'Theme',
      'Settings',
      'Export',
    ]) {
      expect(body, label).toContain(label);
    }
    expect(PLANNER_TAB_IDS).toHaveLength(7);
  });

  it('shows a host back link at the start of its header only when given one', () => {
    const plain = render(Planner, { props: { basePath: '/planner' } }).body;
    expect(plain).not.toContain('data-planner-back');
    const { body } = render(Planner, {
      props: {
        basePath: '/planner',
        backLink: { href: '/docs', label: 'Back to documentation' },
      },
    });
    expect(body).toContain('data-planner-back');
    expect(body).toContain('href="/docs"');
    expect(body).toContain('Back to documentation');
  });

  it("puts the chef's hat, not a second pencil, at the end of its header", () => {
    const { body } = render(Planner, { props: { basePath: '/planner' } });
    // The shell's pencil edits the layout; the planner's own pages are behind
    // the chef's hat (`#/configure/`), so the header never shows two pencils.
    const hat = body.match(
      /<a class="header-link[^>]*aria-label="Plan the app"[^>]*>/,
    );
    expect(hat, 'Plan the app link').toBeTruthy();
    expect(hat?.[0]).toContain('href="#/configure/"');
    expect(hat?.[0]).toContain('title="Plan the app"');
    expect(body).not.toContain('aria-label="Customize"');
    expect(body).toContain(CHEF_HAT_ICON);
    expect(body).toContain('aria-label="Edit layout"');
  });

  it('has an assistant toggle and dock only when the host gives it a model', () => {
    const plain = render(Planner, { props: { basePath: '/planner' } }).body;
    expect(plain).not.toContain('data-dock-tool="assistant"');
    const { body } = render(Planner, {
      props: { basePath: '/planner', inference: { mode: 'byo' } },
    });
    // The shell's own `dock:assistant` control; there is no planner-side
    // toggle.
    expect(body).toContain('data-dock-tool="assistant"');
    expect(body).not.toContain('data-assistant-setup');
  });

  it('makes the assistant control a link to the AI setup page until the assistant is ready', () => {
    try {
      // Nothing is loaded on the server, so the assistant is not ready: the
      // shell renders its control as a real link to the mount's AI page, not
      // a dock toggle.
      const { body } = render(Planner, {
        props: { basePath: '/planner', inference: { mode: 'byo' } },
      });
      const control = body.match(
        /<a[^>]*data-dock-tool="assistant"[^>]*>/,
      )?.[0];
      expect(control).toBeDefined();
      expect(control).toContain('href="#/ai/"');
      expect(control).toContain('aria-label="Set up the assistant"');
      expect(control).not.toContain('aria-pressed');
      expect(body).not.toMatch(/<button[^>]*data-dock-tool="assistant"/);
    } finally {
      setBasePath('');
    }
  });

  it('renders the shell account item for the visitor', () => {
    const { body } = render(Planner, { props: { basePath: '/planner' } });
    expect(body).not.toContain('User menu');
    expect(body).toContain('>You<');
  });

  it('builds its links from basePath, not from SvelteKit', () => {
    setBasePath('/kitchen/');
    expect(getBasePath()).toBe('/kitchen');
    expect(appHref('/recipes/sales/')).toBe('/kitchen/recipes/sales/');
    setBasePath('');
    expect(appHref('/ai/')).toBe('/ai/');
  });

  it('adds the package selection to a path that has its own query', () => {
    setBasePath('/planner');
    selection.ids = ['commerce'];
    try {
      expect(appHref('/m/commerce/Order/')).toBe(
        '/planner/m/commerce/Order/?p=commerce',
      );
      const href = appHref('/m/commerce/Order/?customerId=c%201');
      expect(href).toBe(
        '/planner/m/commerce/Order/?customerId=c%201&p=commerce',
      );
      const search = new URL(href, 'https://x.test').searchParams;
      expect(search.get('customerId')).toBe('c 1');
      expect(search.get('p')).toBe('commerce');
    } finally {
      selection.ids = [];
      setBasePath('');
    }
  });

  it('writes fragment links in the mount, so a feature or package link stays inside it', () => {
    // The complete Planner routes by URL fragment and serves nothing from the
    // host's paths: `/planner/packages/reports/` would be the host's 404.
    setBasePath('/planner', 'hash');
    expect(appHref('/packages/reports/')).toBe('#/packages/reports/');
    expect(appHref('/m/commerce/Order/')).toBe('#/m/commerce/Order/');
    setBasePath('/planner');
    expect(appHref('/packages/reports/')).toBe('/planner/packages/reports/');
    const { body } = render(Planner, { props: { basePath: '/planner' } });
    expect(body).not.toContain('href="/planner/');
    setBasePath('');
  });

  it('serves the package page at #/packages/<id>/ with fragment links', () => {
    // The mount routes by `location.hash`, absent on the server, so the page
    // is rendered directly: the same component the static route renders.
    setBasePath('/planner', 'hash');
    try {
      const { body } = render(PackagePage, { props: { id: 'commerce' } });
      expect(body).toContain('href="#/m/commerce/Order/"');
      expect(body).not.toContain('href="/planner/');
      const unknown = render(PackagePage, {
        props: { id: 'nope', backHref: '#/configure/' },
      }).body;
      expect(unknown).toContain('Unknown package');
      expect(unknown).toContain('href="#/configure/"');
    } finally {
      setBasePath('');
    }
  });

  it('mounts the editable overviews over the sample data: the pencil, plain sections, every loader', () => {
    const previous = new CookbookStore();
    previous.apply(cookbookStore.snapshot());
    try {
      cookbookStore.apply({
        $schema: COOKBOOK_SCHEMA,
        version: 1,
        recipes: ['commerce.sales'],
        features: [],
        policies: [],
      });
      cookbookStore.loaded = true;
      const { body } = render(Planner, { props: { basePath: '/planner' } });
      // The shell's layout pencil (`layoutEditing`, start of the header).
      expect(body).toContain('Edit layout');
      // The first section page is the default route: the framework's own
      // section page, with the planner's heading. Its overview grid renders
      // after hydration (tests/planner-section.dom.test.ts).
      expect(body).toContain('data-smrt-component="CookbookSectionPage"');
      expect(body).not.toContain('class="section-view');
      expect(body).toMatch(/<header class="section-heading[^"]*">/);
      expect(body).toMatch(/<h1[^>]*>Sales<\/h1>/);
      // The loaders the mount hands `CookbookApp`: every data widget, and the
      // shortcuts' record counts.
      expect(Object.keys(plannerLoaders).sort()).toEqual([
        'chart',
        'metric',
        'records',
        'shortcuts',
      ]);
    } finally {
      cookbookStore.apply(previous.snapshot());
      cookbookStore.loaded = false;
      setBasePath('');
    }
  });

  it('keeps Features and Layout reachable after they left the tab strip', () => {
    try {
      plannerTab.active = 'features';
      const { body } = render(PlannerControls, { props: {} });
      expect(body).toContain('Show all');
      expect(body).not.toMatch(/role="tab"[^>]*>\s*Features/);
    } finally {
      plannerTab.active = 'cookbooks';
    }
  });

  it('offers the controls separately for hosts with their own shell', () => {
    const { body } = render(PlannerControls, {
      props: { tabs: ['recipes', 'export'] },
    });
    expect(body).not.toContain('smrt-admin-shell');
    expect(body).toContain('Recipes');
    expect(body).toContain('Export');
    expect(body).not.toContain('Cookbooks');
  });
});
