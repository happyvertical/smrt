import { getModel } from '../catalog/index.ts';
import type { CatalogModel } from '../catalog/types.ts';
import { featureNavItems } from '../recipes/features.ts';
import { navItemId, navPath, recipeNav } from '../recipes/index.ts';
import { pageScope, type RowScope } from '../recipes/scope.ts';
import { sectionId } from '../recipes/sections.ts';
import type { Recipe } from '../recipes/types.ts';

/** What a navigation entry (a layout item id) points at in the app. */
export interface SectionEntry {
  /** The layout item id, `item:<package>:<Model>[:<key>]`. */
  id: string;
  model: CatalogModel;
  /** In-app path of the entry's page, without the app query. */
  path: string;
  /** The entry's declared noun for New, if the recipe gave one. */
  noun?: string;
  /** The slice of rows the entry lists, if it is a filtered view. */
  scope?: RowScope;
}

/**
 * Every navigation entry the added recipes and features produce, by layout
 * item id. Counting and New use it to turn a menu row back into a model; the
 * scope is the same one the entry's own page lists, so a count matches it.
 */
export function entryIndex(
  added: readonly Recipe[],
  features: readonly string[],
): Map<string, SectionEntry> {
  const nav = added.flatMap((recipe) => recipeNav(recipe));
  const index = new Map<string, SectionEntry>();
  for (const entry of nav) {
    const id = navItemId(entry.packageId, entry.model.name, entry.key);
    if (index.has(id)) continue;
    const scope = pageScope(entry.model.id, entry.key, nav);
    index.set(id, {
      id,
      model: entry.model,
      path: navPath(entry),
      ...(entry.noun ? { noun: entry.noun } : {}),
      ...(scope ? { scope } : {}),
    });
  }
  for (const item of featureNavItems(features)) {
    if (index.has(item.id)) continue;
    const model = getModel(item.packageId, item.modelName);
    if (!model) continue;
    index.set(item.id, {
      id: item.id,
      model,
      path: navPath({ packageId: item.packageId, model }),
    });
  }
  return index;
}

/**
 * The Options and Help groups behind a set of entries: the group (or recipe)
 * of each added recipe that has one of them in its nav, in recipe order. A
 * section can hold several, e.g. Sales: Customers and Sales.
 */
export function optionGroups(
  entryIds: readonly string[],
  added: readonly Recipe[],
): { id: string; label: string }[] {
  const wanted = new Set(entryIds);
  const groups: { id: string; label: string }[] = [];
  for (const recipe of added) {
    const has = recipeNav(recipe).some((entry) =>
      wanted.has(navItemId(entry.packageId, entry.model.name, entry.key)),
    );
    const id = sectionId(recipe);
    if (has && !groups.some((group) => group.id === id)) {
      groups.push({ id, label: recipe.group?.label ?? recipe.label });
    }
  }
  return groups;
}
