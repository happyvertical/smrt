import { beforeEach, describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import type { CatalogField, CatalogModel } from '../src/lib/catalog/types.ts';
import { appQuery } from '../src/lib/planner/app.svelte.ts';
import {
  composeQuery,
  hasAppState,
  withTab,
} from '../src/lib/planner/query.ts';
import { selection } from '../src/lib/planner/selection.svelte.ts';
import {
  getRecipe,
  recipeModels,
  recipeNav,
  recipePackage,
  recipes,
  recipesById,
} from '../src/lib/recipes/index.ts';
import {
  backgroundDefaults,
  draftFrom,
  type FieldPolicyRow,
  formFields,
  narrowedFromDraft,
  narrowModel,
  resolveExposure,
  resolveFields,
  rowsFromDraft,
  viewFields,
} from '../src/lib/recipes/policy.ts';
import {
  knownRecipes,
  recipesRequiring,
  withRequirements,
} from '../src/lib/recipes/resolve.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import type { RecipeModelHints } from '../src/lib/recipes/types.ts';

const ORDER = '@happyvertical/smrt-commerce:Order';
const PURCHASE_ORDER = '@happyvertical/smrt-commerce:PurchaseOrder';
const CUSTOMER = '@happyvertical/smrt-commerce:Customer';

function modelOf(qualified: string): CatalogModel {
  const found = getModelByQualifiedName(qualified);
  if (!found) throw new Error(`catalog is missing ${qualified}`);
  return found.model;
}

const field = (name: string, extra: Partial<CatalogField> = {}) =>
  ({ name, type: 'text', required: false, ...extra }) as CatalogField;

/** A small model with ui hints, enum values and all three surfaces. */
const widget: CatalogModel = {
  id: '@x/y:Widget',
  name: 'Widget',
  collection: 'widgets',
  fields: [
    field('tenantId', { system: true }),
    field('name', { required: true, ui: { basic: true, order: 2 } }),
    field('size', { type: 'integer', default: 3, ui: { basic: true } }),
    field('colour', { enum: ['red', 'blue'], default: 'red' }),
    field('notes'),
    field('code', { required: true }),
  ],
  rest: [{ method: 'GET', path: '/widgets' }],
  mcp: [{ operation: 'list', name: 'widget_list' }],
  cli: [{ operation: 'list', name: 'widget_list' }],
  methods: [
    {
      name: 'ping',
      async: true,
      parameters: [],
      returnType: 'void',
      aiCallable: true,
    },
  ],
  references: [],
  exposed: true,
};

describe('recipes.json', () => {
  it('has the recipes in declaration order, each resolving to catalog models', () => {
    // The overlay pins these first; recipes it does not list (feature recipes
    // such as tags.taxonomy) follow in catalog order.
    const pinned = [
      'commerce.customers',
      'commerce.purchases',
      'commerce.sales',
      'commerce.vendors',
      'inventory.stock',
      'products.simple',
      'products.clothing',
      'products.ingredients',
      'commerce.estimates',
      'commerce.wholesale',
      'commerce.invoicing',
      'commerce.fulfillment',
      'commerce.agreements',
      'commerce.leases',
      'commerce.licenses',
      'ledgers.bookkeeping',
      'projects.tracker',
      'events.calendar',
      'sales.pipeline',
    ];
    expect(recipes.map((r) => r.id).slice(0, pinned.length)).toEqual(pinned);
    expect(new Set(recipes.map((r) => r.id)).size).toBe(recipes.length);
    for (const recipe of recipes) {
      expect(recipeModels(recipe)).toHaveLength(recipe.models.length);
      expect(recipePackage(recipe)?.id).toBe(recipe.id.split('.')[0]);
      // Every nav model is one of the recipe's models.
      for (const entry of recipe.nav) {
        expect(recipe.models).toContain(entry.model);
      }
      // Hints only name fields the model declares.
      for (const [ref, hints] of Object.entries(recipe.options ?? {})) {
        const names = modelOf(ref).fields.map((f) => f.name);
        for (const name of Object.keys(hints.fields ?? {})) {
          expect(names).toContain(name);
        }
      }
    }
  });

  it('shares one table between Order and PurchaseOrder, split by contractType', () => {
    expect(modelOf(ORDER).collection).toBe(modelOf(PURCHASE_ORDER).collection);
    expect(
      recipeNav(getRecipe('commerce.sales') ?? recipes[0]).map((n) => n.label),
    ).toEqual(['Sales orders']);
  });
});

describe('recipe resolution', () => {
  it('pulls in requires, transitively and once', () => {
    expect(withRequirements(['commerce.sales'], recipesById)).toEqual([
      'commerce.customers',
      'commerce.sales',
    ]);
    expect(
      withRequirements(['commerce.purchases', 'commerce.vendors'], recipesById),
    ).toEqual(['commerce.purchases', 'commerce.vendors']);
    expect(withRequirements(['nope'], recipesById)).toEqual([]);
  });

  it('follows requires across a chain', () => {
    const chain = new Map(
      [
        { id: 'a', requires: ['b'] },
        { id: 'b', requires: ['c'] },
        { id: 'c', requires: [] },
      ].map((r) => [
        r.id,
        { ...r, label: r.id, summary: '', synonyms: [], models: [], nav: [] },
      ]),
    );
    expect(withRequirements(['a'], chain)).toEqual(['a', 'b', 'c']);
  });

  it('reports which added recipes need one, and drops unknown ids', () => {
    expect(
      recipesRequiring(
        'commerce.customers',
        ['commerce.sales', 'commerce.customers'],
        recipesById,
      ),
    ).toEqual(['commerce.sales']);
    expect(
      knownRecipes(['commerce.sales', 'x', 'commerce.sales'], recipesById),
    ).toEqual(['commerce.sales']);
  });
});

describe('policy application', () => {
  it('applies the cold-start rule: no basic markers means every field is basic', () => {
    const resolved = resolveFields(modelOf(CUSTOMER), undefined);
    expect(resolved.every((r) => r.visibility === 'basic')).toBe(true);
    expect(resolved.some((r) => r.field.system)).toBe(false);
  });

  it('seeds basic from ui hints once any field is marked', () => {
    const byName = Object.fromEntries(
      resolveFields(widget, undefined).map((r) => [r.field.name, r]),
    );
    expect(byName.name.visibility).toBe('basic');
    expect(byName.notes.visibility).toBe('advanced');
    // Required fields cannot leave basic without a usable default.
    expect(byName.code.visibility).toBe('basic');
    expect(byName.code.visibilityForced).toBe(true);
  });

  it('orders by ui.order, then declaration', () => {
    expect(resolveFields(widget, undefined).map((r) => r.field.name)[0]).toBe(
      'size',
    );
  });

  it('layers recipe hints, then rows, on the catalog defaults', () => {
    const hints: RecipeModelHints = {
      fields: {
        colour: { default: 'blue', label: 'Colour', help: 'Pick one' },
      },
    };
    const [colour] = resolveFields(widget, hints).filter(
      (r) => r.field.name === 'colour',
    );
    expect(colour).toMatchObject({
      default: 'blue',
      label: 'Colour',
      help: 'Pick one',
    });

    const rows: FieldPolicyRow[] = [
      {
        objectRef: widget.id,
        fieldName: 'colour',
        scopeType: 'app',
        defaultValue: JSON.stringify('red'),
        visibility: 'basic',
      },
    ];
    const next = resolveFields(widget, hints, rows).find(
      (r) => r.field.name === 'colour',
    );
    expect(next).toMatchObject({ default: 'red', visibility: 'basic' });
  });

  it('ignores rows on a locked field unless the row unlocks it', () => {
    const hints: RecipeModelHints = {
      fields: { notes: { locked: true, default: 'x' } },
    };
    const row = (extra: Partial<FieldPolicyRow>): FieldPolicyRow => ({
      objectRef: widget.id,
      fieldName: 'notes',
      scopeType: 'app',
      defaultValue: '"y"',
      ...extra,
    });
    const value = (rows: FieldPolicyRow[]) =>
      resolveFields(widget, hints, rows).find((r) => r.field.name === 'notes')
        ?.default;
    expect(value([row({})])).toBe('x');
    expect(value([row({ locked: false })])).toBe('y');
  });

  it('hides a field the form switches off, from the views, with its default kept', () => {
    const rows: FieldPolicyRow[] = [
      {
        objectRef: widget.id,
        fieldName: 'size',
        scopeType: 'app',
        visibility: 'hidden',
      },
    ];
    const resolved = resolveFields(widget, undefined, rows);
    expect(viewFields(resolved).map((f) => f.name)).not.toContain('size');
    expect(backgroundDefaults(resolved)).toMatchObject({ size: 3 });
  });

  it('turns the recipe hints for Order into a hidden, locked discriminator', () => {
    const hints = getRecipe('commerce.sales')?.options?.[ORDER];
    const resolved = resolveFields(modelOf(ORDER), hints);
    const view = viewFields(resolved).map((f) => f.name);
    expect(view).not.toContain('contractType');
    expect(view).not.toContain('vendorId');
    expect(view).toContain('customerId');
    expect(backgroundDefaults(resolved)).toMatchObject({
      contractType: 'order',
    });
    // The hidden parameters are not offered in the options form either.
    expect(
      formFields(modelOf(ORDER), hints).map((r) => r.field.name),
    ).not.toContain('contractType');
  });

  it('carries label, help and a primitive default into view fields', () => {
    const rows: FieldPolicyRow[] = [
      {
        objectRef: widget.id,
        fieldName: 'name',
        scopeType: 'app',
        label: 'Widget name',
        help: 'What it is called',
        defaultValue: '"Untitled"',
      },
    ];
    const view = viewFields(resolveFields(widget, undefined, rows)).find(
      (f) => f.name === 'name',
    );
    expect(view).toMatchObject({
      label: 'Widget name',
      help: 'What it is called',
      default: 'Untitled',
    });
  });
});

describe('exposure', () => {
  it('can only be narrowed', () => {
    const wide = resolveExposure(widget, undefined);
    expect(wide.api.on && wide.mcp.on && wide.cli.on).toBe(true);

    const narrow = resolveExposure(widget, { exposure: { mcp: false } }, [
      'cli',
    ]);
    expect(narrow.mcp).toMatchObject({ on: false, locked: true });
    expect(narrow.cli).toMatchObject({ on: false, locked: false });

    // A surface the class never declared stays off and locked.
    const none = resolveExposure({ ...widget, cli: [] }, undefined);
    expect(none.cli).toMatchObject({
      available: false,
      on: false,
      locked: true,
    });
  });

  it('empties narrowed surfaces and stops AI-callable methods without MCP', () => {
    const model = narrowModel(
      widget,
      resolveExposure(widget, undefined, ['mcp', 'api']),
    );
    expect(model.rest).toEqual([]);
    expect(model.mcp).toEqual([]);
    expect(model.cli).toHaveLength(1);
    expect(model.methods[0].aiCallable).toBe(false);
  });
});

describe('options form generation', () => {
  it('starts from the policy: basic on, required locked, hidden params absent', () => {
    const draft = draftFrom(widget, undefined, [], []);
    expect(draft.fields.name.use).toBe(true);
    expect(draft.fields.notes.use).toBe(false);
    expect(draft.fields.size.default).toBe(3);
    expect(draft.exposure).toEqual({ api: true, mcp: true, cli: true });
  });

  it('writes nothing for an untouched form', () => {
    expect(
      rowsFromDraft(widget, undefined, draftFrom(widget, undefined, [], [])),
    ).toEqual([]);
  });

  it('writes smrt-fields policy rows for what changed, and round-trips them', () => {
    const draft = draftFrom(widget, undefined, [], []);
    draft.fields.size.use = false;
    draft.fields.notes.use = true;
    draft.fields.colour.label = 'Colourway';
    draft.fields.colour.help = 'Shown on labels';
    draft.fields.colour.default = 'blue';
    draft.fields.name.order = 9;
    // Required fields stay on even if the draft says otherwise.
    draft.fields.name.use = false;
    draft.exposure.cli = false;

    const rows = rowsFromDraft(widget, undefined, draft);
    const byField = Object.fromEntries(rows.map((r) => [r.fieldName, r]));
    expect(byField.size).toEqual({
      objectRef: widget.id,
      fieldName: 'size',
      scopeType: 'app',
      visibility: 'hidden',
    });
    expect(byField.notes.visibility).toBe('basic');
    expect(byField.colour).toMatchObject({
      label: 'Colourway',
      help: 'Shown on labels',
      defaultValue: '"blue"',
    });
    expect(byField.name).toEqual({
      objectRef: widget.id,
      fieldName: 'name',
      scopeType: 'app',
      displayOrder: 9,
    });
    expect(narrowedFromDraft(widget, undefined, draft)).toEqual(['cli']);

    const again = draftFrom(widget, undefined, rows, ['cli']);
    expect(again.fields.size.use).toBe(false);
    expect(again.fields.colour).toMatchObject({
      label: 'Colourway',
      default: 'blue',
    });
    expect(again.exposure.cli).toBe(false);
    expect(rowsFromDraft(widget, undefined, again)).toEqual(rows);
  });

  it('does not offer fields the recipe locked', () => {
    const hints: RecipeModelHints = { fields: { notes: { locked: true } } };
    const draft = draftFrom(widget, hints, [], []);
    draft.fields.notes.label = 'Changed';
    expect(
      rowsFromDraft(widget, hints, draft).some((r) => r.fieldName === 'notes'),
    ).toBe(false);
  });
});

describe('url query', () => {
  it('carries only the package selection', () => {
    expect(composeQuery({ packages: [] })).toBe('');
    expect(composeQuery({ packages: ['b', 'a'] })).toBe('?p=a,b');
    expect(withTab('?p=a,b', 'layout')).toBe('?p=a,b&tab=layout');
    expect(withTab('?p=a&tab=export', 'recipes')).toBe('?p=a');
    expect(withTab('', 'export')).toBe('?tab=export');
    expect(hasAppState('?p=a')).toBe(true);
    expect(hasAppState('?r=commerce.sales')).toBe(false);
  });
});

describe('recipe state', () => {
  beforeEach(() => {
    recipeState.clear();
    selection.clear();
  });

  it('adding Sales adds Customers, and Customers cannot then be removed', () => {
    recipeState.add('commerce.sales');
    expect(recipeState.ids).toEqual(['commerce.customers', 'commerce.sales']);
    expect(recipeState.requiredBy('commerce.customers')).toEqual([
      'commerce.sales',
    ]);
    recipeState.remove('commerce.customers');
    expect(recipeState.has('commerce.customers')).toBe(true);
    recipeState.remove('commerce.sales');
    recipeState.remove('commerce.customers');
    expect(recipeState.ids).toEqual([]);
  });

  it('applies saved options to the views, and survives a snapshot and load', () => {
    recipeState.add('commerce.sales');
    const order = modelOf(ORDER);
    const hints = recipeState.hintsFor(ORDER);
    const draft = draftFrom(order, hints, recipeState.rows, []);
    draft.fields.notes.use = false;
    draft.exposure.cli = false;
    recipeState.save(
      ORDER,
      rowsFromDraft(order, hints, draft),
      narrowedFromDraft(order, hints, draft),
    );

    const applied = recipeState.apply(order);
    expect(applied.fields.map((f) => f.name)).not.toContain('notes');
    expect(applied.model.cli).toEqual([]);
    expect(applied.model.rest.length).toBeGreaterThan(0);

    // The URL carries only the package selection now; the cookbook keeps the rest.
    expect(appQuery()).toBe('');
    const saved = JSON.parse(JSON.stringify(recipeState.snapshot()));

    recipeState.clear();
    recipeState.load(saved);
    const restored = recipeState.apply(order);
    expect(restored.fields.map((f) => f.name)).not.toContain('notes');
    expect(restored.model.cli).toEqual([]);
    expect(restored.background).toMatchObject({ contractType: 'order' });
  });

  it('keeps Order and PurchaseOrder separate despite the shared table', () => {
    recipeState.add('commerce.sales', 'commerce.purchases');
    expect(recipeState.apply(modelOf(ORDER)).background.contractType).toBe(
      'order',
    );
    expect(
      recipeState.apply(modelOf(PURCHASE_ORDER)).background.contractType,
    ).toBe('purchase_order');
  });

  it('drops options for models no added recipe covers', () => {
    recipeState.add('commerce.sales');
    recipeState.save(
      ORDER,
      [
        {
          objectRef: ORDER,
          fieldName: 'notes',
          scopeType: 'app',
          visibility: 'hidden',
        },
      ],
      ['mcp'],
    );
    recipeState.remove('commerce.sales');
    expect(recipeState.rows).toEqual([]);
    expect(recipeState.narrowed).toEqual({});
  });
});
