import { describe, expect, it } from 'vitest';
import { catalog, exposedModels } from '../src/lib/catalog/index.ts';
import { migrateLegacySections } from '../src/lib/cookbook/migrate.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { COOKBOOK_SCHEMA } from '../src/lib/cookbook/types.ts';
import {
  parseCookbook,
  parseCookbookText,
} from '../src/lib/cookbook/validate.ts';
import {
  FEATURE_SECTION,
  featureEntries,
  featureNavItems,
  featurePackages,
  filterFeatures,
} from '../src/lib/recipes/features.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const entries = featureEntries(catalog, recipes);
const ORDER = '@happyvertical/smrt-commerce:Order';
const pick = entries.slice(0, 3);

describe('feature entries', () => {
  it('lists every exposed model no recipe covers, and nothing else', () => {
    const covered = new Set(recipes.flatMap((r) => r.models));
    const expected = catalog.packages.flatMap((p) =>
      exposedModels(p).filter((m) => !covered.has(m.id)),
    );
    expect(entries.map((e) => e.id)).toEqual(expected.map((m) => m.id));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => covered.has(e.id))).toBe(false);
    expect(entries.some((e) => e.id === ORDER)).toBe(false);
  });

  it('uses the model description, else a field count', () => {
    const models = new Map(
      catalog.packages.flatMap((p) => p.models).map((m) => [m.id, m]),
    );
    for (const e of entries) {
      const own = models.get(e.id)?.description;
      if (own) {
        expect(e.described).toBe(true);
        expect(own.startsWith(e.description)).toBe(true);
      } else expect(e.description).toMatch(/^\d+ fields?$/);
    }
  });
});

describe('filterFeatures', () => {
  const sample = entries[0];

  it('matches model name, package and field names', () => {
    expect(filterFeatures(entries, sample.name.toUpperCase())).toContain(
      sample,
    );
    expect(filterFeatures(entries, sample.packageId)).toContain(sample);
    const field = sample.fieldNames[0];
    expect(filterFeatures(entries, field)).toContain(sample);
  });

  it('matches the description and requires every term', () => {
    const fake = [{ ...sample, description: 'Tracks widgets' }];
    expect(filterFeatures(fake, 'widgets')).toHaveLength(1);
    expect(filterFeatures(fake, 'widgets zzzz')).toHaveLength(0);
    expect(filterFeatures(entries, 'zzzz-no-such')).toEqual([]);
  });

  it('filters by package, and chips only offer packages with results', () => {
    const only = filterFeatures(entries, '', sample.packageId);
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((e) => e.packageId === sample.packageId)).toBe(true);
    const chips = featurePackages(filterFeatures(entries, sample.name));
    expect(chips).toContain(sample.packageId);
    expect(chips.length).toBeLessThan(featurePackages(entries).length);
  });
});

describe('cookbook features', () => {
  const base = {
    $schema: COOKBOOK_SCHEMA,
    version: 1,
    recipes: [],
    policies: [],
  };

  it('treats an absent field as none (migration)', () => {
    const result = parseCookbook(base);
    expect(result.ok && result.cookbook.features).toEqual([]);
  });

  it('round-trips, sorted', () => {
    const ids = pick.map((e) => e.id);
    const result = parseCookbook({ ...base, features: [...ids].reverse() });
    expect(result.ok && result.cookbook.features).toEqual([...ids].sort());
    if (!result.ok) throw new Error(result.error);
    const again = parseCookbookText(JSON.stringify(result.cookbook));
    expect(again).toEqual(result);
  });

  it.each([
    ['not a list', 'x', /"features"/],
    ['duplicate', [pick[0].id, pick[0].id], /more than once/],
  ])('rejects %s', (_label, features, error) => {
    const result = parseCookbook({ ...base, features });
    expect(!result.ok && result.error).toMatch(error);
  });

  it('keeps a feature this catalog lacks instead of rejecting it', () => {
    const result = parseCookbook({ ...base, features: ['@nope/pkg:Thing'] });
    expect(result.ok && result.cookbook.features).toEqual(['@nope/pkg:Thing']);
  });

  it('survives the store export and import', () => {
    const store = new CookbookStore();
    recipeState.clear();
    recipeState.addFeature(pick[1].id);
    recipeState.addFeature(pick[0].id);
    recipeState.addFeature(pick[0].id);
    const snapshot = store.snapshot();
    expect(snapshot.features).toEqual([pick[0].id, pick[1].id].sort());
    recipeState.clear();
    expect(store.importText(JSON.stringify(snapshot)).ok).toBe(true);
    expect(recipeState.features).toEqual(snapshot.features);
    recipeState.removeFeature(pick[0].id);
    expect(recipeState.hasFeature(pick[0].id)).toBe(false);
    recipeState.clear();
    expect(recipeState.features).toEqual([]);
  });
});

describe('feature nav section', () => {
  it('builds stable items under the More section', () => {
    expect(FEATURE_SECTION).toMatchObject({ id: 'more', label: 'More' });
    const items = featureNavItems(pick.map((e) => e.id));
    expect(items.map((i) => i.id)).toEqual(
      pick.map((e) => `item:${e.packageId}:${e.name}`),
    );
    expect(items[0].label).toBe(pick[0].label);
  });

  it('drops unknown models', () => {
    expect(featureNavItems(['@nope/pkg:Thing'])).toEqual([]);
  });

  it('does not rewrite layout ids of the More section', () => {
    const layout = {
      version: 1 as const,
      sectionOrder: ['section:sales', 'section:more'],
    };
    expect(migrateLegacySections(layout)).toEqual(layout);
  });
});
