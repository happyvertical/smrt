import type { Recipe } from './types.ts';

/** Sorted and de-duplicated, so the same selection is always the same URL. */
export function normalizeRecipes(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/** `ids` plus every recipe they transitively `require`, as a sorted set. */
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
  return normalizeRecipes(result);
}

/** Ids of the selected recipes that require `id` directly. */
export function recipesRequiring(
  id: string,
  selected: readonly string[],
  recipes: ReadonlyMap<string, Recipe>,
): string[] {
  return selected.filter(
    (other) => other !== id && recipes.get(other)?.requires.includes(id),
  );
}

/** Keep only ids that name a known recipe. */
export function knownRecipes(
  ids: Iterable<string>,
  recipes: ReadonlyMap<string, Recipe>,
): string[] {
  return normalizeRecipes([...ids].filter((id) => recipes.has(id)));
}
