import { beforeEach, describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { serializeCookbook } from '../src/lib/cookbook/file.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { COOKBOOK_SCHEMA } from '../src/lib/cookbook/types.ts';
import {
  parseCookbook,
  parseCookbookText,
} from '../src/lib/cookbook/validate.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import {
  isOverviewId,
  sectionOverview,
} from '../src/lib/overviews/definitions.ts';
import {
  createSectionOverview,
  loadSectionWidget,
} from '../src/lib/overviews/page.ts';
import { overviewRegistry } from '../src/lib/overviews/registry.ts';
import { checkStoredOverride } from '../src/lib/overviews/validate.ts';
import {
  buildNavSections,
  recipeNav,
  recipes,
  recipesById,
} from '../src/lib/recipes/index.ts';
import { navSectionOf } from '../src/lib/recipes/sections.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const sales = recipesById.get('commerce.sales');
if (!sales) throw new Error('commerce.sales recipe missing');
/** The overview id of the section commerce.sales suggests. */
const SALES = `section:${navSectionOf(sales).id}`;

const base = {
  $schema: COOKBOOK_SCHEMA,
  version: 1,
  recipes: ['commerce.sales'],
  policies: [],
};

const note = (id: string, body = 'Hello') => ({
  id,
  type: 'note',
  span: 2,
  options: { body },
});

function definition(id = SALES) {
  const found = sectionOverview(id);
  if (!found) throw new Error(`no overview for ${id}`);
  return found;
}

function parse(overviews: unknown, extra: Record<string, unknown> = {}) {
  const result = parseCookbook({ ...base, ...extra, overviews });
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe('section overview definitions', () => {
  it('every recipe section and More is an overview with the shortcuts first', () => {
    for (const section of buildNavSections(recipes)) {
      const id = `section:${section.id}`;
      expect(isOverviewId(id)).toBe(true);
      const def = definition(id);
      expect(def.defaults[0]).toMatchObject({ id: 'shortcuts', span: 4 });
      // Every default passes the page's own validation.
      const check = checkStoredOverride(id, null);
      expect(check.issues).toEqual([]);
    }
    expect(isOverviewId('section:more')).toBe(true);
  });

  it('the sales overview counts and lists its lead model after the shortcuts', () => {
    // The first menu entry of the first recipe suggesting the section.
    const section = buildNavSections(recipes).find(
      (s) => `section:${s.id}` === SALES,
    );
    const lead = section?.recipes
      .map((recipe) => recipeNav(recipe)[0])
      .find(Boolean)?.model.id;
    expect(lead).toBeTruthy();
    expect(definition().defaults.map((w) => [w.id, w.type])).toEqual([
      ['shortcuts', 'shortcuts'],
      ['count', 'metric'],
      ['latest', 'records'],
    ]);
    expect(definition().defaults[1]?.options.model).toBe(lead);
  });

  it('custom sections are overviews only when the layout has them', () => {
    const layout = {
      version: 1 as const,
      customSections: [{ id: 'custom:shop', label: 'Shop' }],
    };
    expect(isOverviewId('custom:shop', layout)).toBe(true);
    expect(isOverviewId('custom:other', layout)).toBe(false);
    expect(isOverviewId('custom:shop')).toBe(false);
    expect(isOverviewId('package:commerce')).toBe(false);
  });
});

describe('cookbook overviews: validation', () => {
  it('keeps a valid override, canonical, and reports nothing', () => {
    const result = parse({
      [SALES]: {
        version: 1,
        added: [note('w1')],
        changed: { shortcuts: { span: 3 } },
        // A removed id the page never had is noise, not a change.
        removed: ['nope'],
      },
    });
    expect(result.dropped).toBeUndefined();
    expect(result.cookbook.overviews?.[SALES]).toEqual({
      version: 1,
      added: [{ ...note('w1'), version: 1 }],
      changed: { shortcuts: { span: 3 } },
    });
  });

  it('drops and reports a widget of an unknown or disallowed type, keeping the rest', () => {
    const result = parse({
      [SALES]: {
        version: 1,
        added: [
          note('w1'),
          { id: 'w2', type: 'iframe', span: 2, options: { src: 'x' } },
          { id: 'w3', type: 'chart', span: 2, options: {} },
        ],
      },
    });
    expect(result.cookbook.overviews?.[SALES]?.added?.map((w) => w.id)).toEqual(
      ['w1'],
    );
    expect(result.dropped?.join(' ')).toMatch(/w2 \(iframe\).*unknown_type/);
    expect(result.dropped?.join(' ')).toMatch(/w3 \(chart\)/);
  });

  it('drops and reports invalid options; a bad change keeps the default widget', () => {
    const result = parse({
      [SALES]: {
        version: 1,
        added: [
          {
            id: 'w1',
            type: 'metric',
            span: 1,
            options: { model: 'drop table', measure: 'count' },
          },
          { id: 'w2', type: 'note', span: 1, options: { body: 'ok', js: 1 } },
          note('w3'),
        ],
        changed: { count: { options: { measure: 'median' } } },
      },
    });
    const kept = result.cookbook.overviews?.[SALES];
    expect(kept?.added?.map((w) => w.id)).toEqual(['w3']);
    // The default `count` metric is not removed by its bad change.
    expect(kept?.removed).toBeUndefined();
    expect(kept?.changed).toBeUndefined();
    const text = result.dropped?.join(' ') ?? '';
    expect(text).toMatch(/w1 \(metric\).*invalid_options/);
    expect(text).toMatch(/w2 \(note\).*unknown_option/);
    expect(text).toMatch(/count \(metric\).*not_in_choices/);
  });

  it('a model outside the catalog is refused like any invalid option', () => {
    const check = checkStoredOverride(SALES, {
      version: 1,
      added: [
        {
          id: 'w1',
          type: 'records',
          span: 2,
          options: { model: '@evil/pkg:Secrets' },
        },
      ],
    });
    expect(check.override).toBeNull();
    expect(check.issues[0]?.options).toEqual([
      { key: 'model', code: 'not_allowed' },
    ]);
  });

  it('drops and reports an unknown overview id', () => {
    const result = parse({
      'section:nowhere': { version: 1, added: [note('w1')] },
      'custom:gone': { version: 1, added: [note('w1')] },
      [SALES]: { version: 1, added: [note('w1')] },
    });
    expect(Object.keys(result.cookbook.overviews ?? {})).toEqual([SALES]);
    expect(result.dropped).toEqual([
      'Overview custom:gone is not a page in this app and was dropped.',
      'Overview section:nowhere is not a page in this app and was dropped.',
    ]);
  });

  it('keeps a custom section override when the layout has that section', () => {
    const result = parse(
      { 'custom:shop': { version: 1, added: [note('w1')] } },
      {
        layout: {
          version: 1,
          customSections: [{ id: 'custom:shop', label: 'Shop' }],
        },
      },
    );
    expect(result.cookbook.overviews?.['custom:shop']?.added).toHaveLength(1);
  });

  it('rejects a malformed overviews field and drops malformed entries', () => {
    for (const bad of [[], 'x', 3, null]) {
      const result = parseCookbook({ ...base, overviews: bad });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/"overviews"/);
    }
    const result = parse({
      [SALES]: { version: 2, added: [note('w1')] },
      'section:more': 'hello',
    });
    expect(result.cookbook.overviews).toBeUndefined();
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped?.every((s) => s.includes('malformed'))).toBe(true);
  });

  it('omits empty overrides and a field that ends up empty', () => {
    const result = parse({
      [SALES]: { version: 1 },
      'section:more': { version: 1, changed: {} },
    });
    expect(result.cookbook).not.toHaveProperty('overviews');
    expect(result.dropped).toBeUndefined();
  });
});

describe('cookbook overviews: version 1 compatibility', () => {
  it('a version 1 file from before overviews still reads, with no overviews', () => {
    const result = parseCookbook(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cookbook.version).toBe(1);
      expect(result.cookbook).not.toHaveProperty('overviews');
    }
  });

  it('a file with overviews is still version 1 under the v1 schema', () => {
    const result = parse({ [SALES]: { version: 1, added: [note('w1')] } });
    expect(result.cookbook.version).toBe(1);
    expect(result.cookbook.$schema).toBe(COOKBOOK_SCHEMA);
  });
});

describe('cookbook overviews: store, export and import', () => {
  beforeEach(() => recipeState.clear());

  it('round-trips overrides through export and import unchanged', () => {
    const store = new CookbookStore();
    store.apply(parse({}).cookbook);
    const controller = createSectionOverview(definition(), store);
    expect(controller.add('note', { body: 'Hello **there**' }).ok).toBe(true);
    expect(controller.resize('latest', 4).ok).toBe(true);
    expect(controller.remove('count').ok).toBe(true);
    const exported = store.snapshot();
    expect(Object.keys(exported.overviews ?? {})).toEqual([SALES]);

    const text = serializeCookbook(exported);
    const imported = parseCookbookText(text);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.dropped).toBeUndefined();
    expect(imported.cookbook.overviews).toEqual(exported.overviews);

    const other = new CookbookStore();
    expect(other.importText(text).ok).toBe(true);
    expect(other.snapshot()).toEqual(exported);
    // The import renders what was exported.
    const again = createSectionOverview(definition(), other);
    expect(again.document).toEqual(controller.document);
  });

  it('reset clears the overviews with the rest', () => {
    const store = new CookbookStore();
    store.setOverview(SALES, { version: 1, removed: ['count'] });
    store.reset();
    expect(store.snapshot()).not.toHaveProperty('overviews');
  });
});

describe('section page overview', () => {
  beforeEach(() => recipeState.clear());

  it('an edit lands in the cookbook, and reset returns to the defaults', () => {
    const store = new CookbookStore();
    const controller = createSectionOverview(definition(), store);
    expect(controller.customized).toBe(false);

    const added = controller.add('note', { title: 'Team', body: 'Hi' });
    expect(added.ok).toBe(true);
    const saved = store.snapshot().overviews?.[SALES];
    expect(saved?.added).toEqual([
      {
        id: 'w1',
        type: 'note',
        span: 2,
        options: { title: 'Team', body: 'Hi' },
        version: 1,
      },
    ]);
    // The page renders from the cookbook: the controller reads it back.
    expect(controller.document.widgets.map((w) => w.id)).toEqual([
      'shortcuts',
      'count',
      'latest',
      'w1',
    ]);

    expect(controller.move('w1', 0).ok).toBe(true);
    expect(store.snapshot().overviews?.[SALES]?.order?.[0]).toBe('w1');

    expect(controller.reset().ok).toBe(true);
    expect(store.snapshot()).not.toHaveProperty('overviews');
    expect(controller.document.widgets.map((w) => w.id)).toEqual([
      'shortcuts',
      'count',
      'latest',
    ]);
  });

  it('refuses an edit the definition does not allow, leaving the cookbook alone', () => {
    const store = new CookbookStore();
    const controller = createSectionOverview(definition(), store);
    expect(controller.add('chart').ok).toBe(false);
    expect(
      controller.add('metric', { model: '@evil/pkg:Secrets' }),
    ).toMatchObject({ ok: false, reason: 'invalid_options' });
    expect(store.snapshot()).not.toHaveProperty('overviews');
  });

  it('loads widget data from the in-browser sample source', async () => {
    const source = createMemoryDataSource();
    const def = definition();
    const model = def.defaults[1]?.options.model;
    const lead =
      typeof model === 'string' ? getModelByQualifiedName(model) : undefined;
    if (!lead) throw new Error('no lead model');
    const context = {
      source,
      sections: [
        {
          id: SALES,
          items: [
            {
              id: 'item:x',
              label: 'Orders',
              item: { href: '/m/commerce/Order/' },
            },
            {
              id: 'item:hidden',
              label: 'Hidden',
              hidden: true,
              item: { href: '/m/commerce/Hidden/' },
            },
          ],
        },
      ],
      entries: new Map(),
      href: (path: string) => path,
    };
    const rows = await source.list(lead.model);
    const [shortcuts, count, latest] = def.defaults;
    if (!shortcuts || !count || !latest) throw new Error('defaults');
    await expect(loadSectionWidget(def, context, shortcuts)).resolves.toEqual({
      items: [{ id: 'item:x', label: 'Orders', href: '/m/commerce/Order/' }],
    });
    await expect(loadSectionWidget(def, context, count)).resolves.toMatchObject(
      { value: rows.length, format: 'integer' },
    );
    const list = (await loadSectionWidget(def, context, latest)) as {
      rows: { title: string }[];
    };
    expect(list.rows.length).toBe(Math.min(5, rows.length));
    expect(list.rows.every((row) => row.title.length > 0)).toBe(true);
    // A named filter the sample data does not have is an error, not a guess.
    await expect(
      loadSectionWidget(def, context, {
        ...count,
        options: { ...count.options, filter: 'overdue' },
      }),
    ).rejects.toThrow();
  });

  it('the registry offers exactly the core widgets the planner can load', () => {
    expect(
      overviewRegistry
        .list()
        .map((w) => w.type)
        .sort(),
    ).toEqual(['metric', 'note', 'records', 'shortcuts']);
  });
});
