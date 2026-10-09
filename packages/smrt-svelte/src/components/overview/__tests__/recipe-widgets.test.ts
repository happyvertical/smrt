import type {
  RecipeDefinition,
  RecipeWidgetOptionType,
  RecipeWidgetSurface,
} from '@happyvertical/smrt-types';
import { describe, expect, it, vi } from 'vitest';
import { loadOverview } from '../load.js';
import { sanitizeOverview } from '../model.js';
import {
  parseRecipeExportRef,
  type RecipeExportResolver,
  registerRecipeWidgets,
} from '../recipe-widgets.js';
import { createWidgetRegistry, resolveWidgetComponents } from '../registry.js';
import type { OverviewDefinition, WidgetOptionType } from '../types.js';
import { w } from './fixtures.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Fails typecheck when the recipe option vocabulary and the overview one diverge.
const sameOptionTypes: Equal<RecipeWidgetOptionType, WidgetOptionType> = true;

const FakeComponent = () => {};

const surface: RecipeWidgetSurface = {
  kind: 'widget',
  type: 'sales-total',
  export: '@acme/shop/svelte#SalesTotal',
  label: 'Sales total',
  description: 'Order totals.',
  icon: 'chart',
  options: [
    { key: 'model', type: 'model', label: 'Model', required: true },
    {
      key: 'style',
      type: 'enum',
      label: 'Style',
      default: 'bar',
      choices: [
        { value: 'bar', label: 'Bar' },
        { value: 'line', label: 'Line' },
      ],
    },
  ],
  data: { load: '@acme/shop/server#loadSalesTotal' },
  allowedIn: ['shop.home'],
  maxSpan: 2,
};

function recipe(
  id: string,
  ...surfaces: RecipeWidgetSurface[]
): Pick<RecipeDefinition, 'id' | 'surfaces'> {
  return { id, surfaces };
}

function resolver(exports: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const resolveExport: RecipeExportResolver = (specifier, name) => {
    calls.push(`${specifier}#${name}`);
    return exports[`${specifier}#${name}`];
  };
  return { resolveExport, calls };
}

const page = (id: string): OverviewDefinition => ({ id, defaults: [] });

describe('registerRecipeWidgets (#3727)', () => {
  it('keeps the option vocabularies in step', () => {
    expect(sameOptionTypes).toBe(true);
  });

  it('registers a widget definition from the manifest without importing anything', async () => {
    const registry = createWidgetRegistry();
    const { resolveExport, calls } = resolver();
    const result = await registerRecipeWidgets(
      registry,
      [recipe('shop.sales', surface)],
      resolveExport,
    );
    expect(result).toMatchObject({ registered: ['sales-total'], skipped: [] });
    expect(calls).toEqual([]);

    const def = registry.get('sales-total');
    expect(def).toMatchObject({
      type: 'sales-total',
      title: 'Sales total',
      description: 'Order totals.',
      icon: 'chart',
      version: 1,
      allowedIn: ['shop.home'],
      minSpan: 1,
      maxSpan: 2,
      defaultSpan: 1,
    });
    expect(def?.options.map((option) => option.key)).toEqual([
      'model',
      'style',
    ]);
    expect(typeof def?.load).toBe('function');
    expect(typeof def?.loadComponent).toBe('function');
    expect(def?.component).toBeUndefined();
  });

  it('resolves the component lazily, once, as a module or a bare export', async () => {
    const registry = createWidgetRegistry();
    const { resolveExport, calls } = resolver({
      '@acme/shop/svelte#SalesTotal': FakeComponent,
      '@acme/shop/svelte#Wrapped': { default: FakeComponent },
    });
    await registerRecipeWidgets(
      registry,
      [
        recipe('shop.sales', surface, {
          ...surface,
          type: 'wrapped',
          export: '@acme/shop/svelte#Wrapped',
          data: undefined,
        }),
      ],
      resolveExport,
    );
    const components = await resolveWidgetComponents(
      ['sales-total', 'wrapped', 'sales-total'],
      registry,
    );
    expect(components.get('sales-total')).toBe(FakeComponent);
    expect(components.get('wrapped')).toBe(FakeComponent);
    await resolveWidgetComponents(['sales-total'], registry);
    expect(
      calls.filter((call) => call === '@acme/shop/svelte#SalesTotal'),
    ).toHaveLength(1);
  });

  it('leaves a component that cannot resolve out, to render as unavailable', async () => {
    const registry = createWidgetRegistry();
    await registerRecipeWidgets(
      registry,
      [recipe('shop.sales', surface)],
      resolver().resolveExport,
    );
    const components = await resolveWidgetComponents(['sales-total'], registry);
    expect(components.has('sales-total')).toBe(false);
  });

  it('runs the server loader with validated options and the request context', async () => {
    const registry = createWidgetRegistry();
    const loader = vi.fn((_options, ctx) => ({ total: 42, user: ctx.userId }));
    const { resolveExport, calls } = resolver({
      '@acme/shop/server#loadSalesTotal': loader,
    });
    await registerRecipeWidgets(
      registry,
      [recipe('shop.sales', surface)],
      resolveExport,
    );
    const loaded = await loadOverview(
      {
        widgets: [
          w('a', 'sales-total', 1, { model: 'shop:Order' }),
          w('b', 'sales-total', 1, { model: 'drop table' }),
        ],
      },
      page('shop.home'),
      registry,
      { userId: 'u1' },
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0][0]).toEqual({
      model: 'shop:Order',
      style: 'bar',
    });
    expect(loaded.widgets).toHaveLength(1);
    expect(loaded.widgets[0]).toMatchObject({
      id: 'a',
      status: 'ready',
      data: { total: 42, user: 'u1' },
    });
    expect(loaded.issues[0].code).toBe('invalid_options');
    expect(calls).toEqual(['@acme/shop/server#loadSalesTotal']);
  });

  it('turns a missing or non-function loader into a per-widget error tile', async () => {
    const registry = createWidgetRegistry();
    const onError = vi.fn();
    await registerRecipeWidgets(
      registry,
      [recipe('shop.sales', surface)],
      resolver({ '@acme/shop/server#loadSalesTotal': 'nope' }).resolveExport,
    );
    const loaded = await loadOverview(
      { widgets: [w('a', 'sales-total', 1, { model: 'shop:Order' })] },
      page('shop.home'),
      registry,
      {},
      { onError },
    );
    expect(loaded.widgets[0]).toMatchObject({
      status: 'error',
      error: { code: 'load_failed' },
    });
    expect(onError).toHaveBeenCalled();
  });

  it('confines the widget to its allowed overview ids', async () => {
    const registry = createWidgetRegistry();
    await registerRecipeWidgets(
      registry,
      [recipe('shop.sales', surface)],
      resolver().resolveExport,
    );
    const document = {
      widgets: [w('a', 'sales-total', 1, { model: 'shop:Order' })],
    };
    const inside = sanitizeOverview(document, {
      registry,
      definition: page('shop.home'),
    });
    expect(inside.document.widgets).toHaveLength(1);
    const outside = sanitizeOverview(document, {
      registry,
      definition: page('shop.admin'),
    });
    expect(outside.document.widgets).toHaveLength(0);
    expect(outside.issues[0].code).toBe('type_not_allowed');
  });

  it('upgrades stored options through the resolved migrate export', async () => {
    const registry = createWidgetRegistry();
    const migrate = vi.fn((options: Record<string, unknown>) => ({
      model: options.source,
    }));
    const { resolveExport, calls } = resolver({
      '@acme/shop/server#migrate': migrate,
    });
    await registerRecipeWidgets(
      registry,
      [
        recipe('shop.sales', {
          ...surface,
          version: 2,
          migrate: '@acme/shop/server#migrate',
          allowedIn: undefined,
        }),
      ],
      resolveExport,
    );
    // migrate is synchronous in the registry, so it resolves at registration.
    expect(calls).toEqual(['@acme/shop/server#migrate']);
    const out = sanitizeOverview(
      {
        widgets: [
          { ...w('a', 'sales-total', 1, { source: 'shop:Order' }), version: 1 },
        ],
      },
      { registry, definition: page('shop.home') },
    );
    expect(out.issues).toEqual([]);
    expect(out.document.widgets[0]).toMatchObject({
      version: 2,
      options: { model: 'shop:Order', style: 'bar' },
    });
  });

  it('skips a widget whose migrate export is missing', async () => {
    const registry = createWidgetRegistry();
    const result = await registerRecipeWidgets(
      registry,
      [
        recipe('shop.sales', {
          ...surface,
          version: 2,
          migrate: '@acme/shop/server#migrate',
        }),
      ],
      resolver().resolveExport,
    );
    expect(result.registered).toEqual([]);
    expect(result.skipped).toMatchObject([
      { recipeId: 'shop.sales', type: 'sales-total', reason: 'unresolved' },
    ]);
    expect(registry.has('sales-total')).toBe(false);
  });

  it('skips a type that is already registered, and replaces it on request', async () => {
    const registry = createWidgetRegistry();
    registry.register({ type: 'sales-total', title: 'Core', options: [] });
    const { resolveExport } = resolver();
    const skipped = await registerRecipeWidgets(
      registry,
      [recipe('shop.sales', surface)],
      resolveExport,
    );
    expect(skipped.skipped).toMatchObject([{ reason: 'duplicate_type' }]);
    expect(registry.get('sales-total')?.title).toBe('Core');

    const replaced = await registerRecipeWidgets(
      registry,
      [recipe('shop.sales', surface)],
      resolveExport,
      { replace: true },
    );
    expect(replaced.registered).toEqual(['sales-total']);
    expect(registry.get('sales-total')?.title).toBe('Sales total');
  });

  it('reports an invalid definition instead of throwing, and keeps going', async () => {
    const registry = createWidgetRegistry();
    const result = await registerRecipeWidgets(
      registry,
      [
        recipe(
          'shop.sales',
          { ...surface, type: 'bad-span', minSpan: 3, maxSpan: 2 },
          { ...surface, type: 'good' },
        ),
      ],
      resolver().resolveExport,
    );
    expect(result.registered).toEqual(['good']);
    expect(result.skipped).toMatchObject([
      { type: 'bad-span', reason: 'invalid' },
    ]);
  });

  it('honours enabled(), ignores other surface kinds, and disposes its own registrations', async () => {
    const registry = createWidgetRegistry();
    registry.register({ type: 'metric', title: 'Metric', options: [] });
    const recipes = [
      recipe('shop.sales', surface),
      recipe('shop.off', { ...surface, type: 'off-widget' }),
      {
        id: 'shop.panel',
        surfaces: [
          {
            kind: 'settings-panel' as const,
            export: '@acme/shop/svelte#Settings' as const,
            label: 'Settings',
          },
        ],
      },
      { id: 'shop.bare' },
    ];
    const result = await registerRecipeWidgets(
      registry,
      recipes,
      resolver().resolveExport,
      { enabled: (id) => id !== 'shop.off' },
    );
    expect(registry.types()).toEqual(['metric', 'sales-total']);
    result.dispose();
    expect(registry.types()).toEqual(['metric']);
  });
});

describe('parseRecipeExportRef', () => {
  it.each([
    ['@acme/shop/svelte#Total', '@acme/shop/svelte', 'Total'],
    ['pkg#default', 'pkg', 'default'],
  ])('splits %s', (ref, specifier, exportName) => {
    expect(parseRecipeExportRef(ref)).toEqual({ specifier, exportName });
  });

  it.each([
    './Local.svelte#Total',
    '/abs/Total#Total',
    '../up#Total',
    'pkg',
    'pkg#',
    '#Name',
    'pkg#not a name',
    'pk g#Name',
  ])('refuses %s', (ref) => {
    expect(parseRecipeExportRef(ref)).toBeNull();
  });
});
