import type { Recipe } from './types.ts';

/** Sorted and de-duplicated, so the same selection is always the same URL. */
export function normalizeRecipes(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * `ids` plus every recipe they transitively `require`, as a sorted set. A
 * `requiresAny` list with none of its alternatives present adds the first
 * known one.
 */
export function withRequirements(
  ids: Iterable<string>,
  recipes: ReadonlyMap<string, Recipe>,
): string[] {
  const result = new Set<string>();
  const visit = (id: string) => {
    const recipe = recipes.get(id);
    if (!recipe || result.has(id)) return;
    result.add(id);
    for (const required of recipe.requires) visit(required);
  };
  for (const id of ids) visit(id);

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...result]) {
      for (const alternatives of recipes.get(id)?.requiresAny ?? []) {
        if (alternatives.some((alt) => result.has(alt))) continue;
        const first = alternatives.find((alt) => recipes.has(alt));
        if (first) {
          visit(first);
          changed = true;
        }
      }
    }
  }
  return normalizeRecipes(result);
}

/**
 * Selected recipes that would force any of `ids` back on if they were all
 * removed: they require one directly, or `ids` hold the last alternative of
 * one of their `requiresAny` lists.
 */
export function removalBlockers(
  ids: readonly string[],
  selected: readonly string[],
  recipes: ReadonlyMap<string, Recipe>,
): string[] {
  const removing = new Set(ids);
  const remaining = selected.filter((id) => !removing.has(id));
  const keep = new Set(remaining);
  return remaining.filter((other) => {
    const recipe = recipes.get(other);
    if (!recipe) return false;
    if (recipe.requires.some((id) => removing.has(id))) return true;
    return (recipe.requiresAny ?? []).some(
      (alternatives) =>
        alternatives.some((alt) => removing.has(alt)) &&
        !alternatives.some((alt) => keep.has(alt)),
    );
  });
}

/** Ids of the selected recipes that require `id` and so keep it on. */
export function recipesRequiring(
  id: string,
  selected: readonly string[],
  recipes: ReadonlyMap<string, Recipe>,
): string[] {
  return removalBlockers([id], selected, recipes);
}

/** Keep only ids that name a known recipe. */
export function knownRecipes(
  ids: Iterable<string>,
  recipes: ReadonlyMap<string, Recipe>,
): string[] {
  return normalizeRecipes([...ids].filter((id) => recipes.has(id)));
}
