import type { Recipe, RecipeForm, RecipeFormExtension } from './types.ts';

/**
 * What the planner keeps locally because no smrt package declares it: the
 * save-together `forms` and the `extends` that add to another recipe's form.
 * Everything else about a recipe comes from the package that owns it.
 */
export interface RecipeOverlayEntry {
  forms?: RecipeForm[];
  extends?: RecipeFormExtension[];
}

export interface RecipeOverlay {
  /**
   * Card and sub-switch order. Package declaration order is alphabetical by
   * package, so the planner pins the order it shows; recipes not listed
   * follow, in catalog order.
   */
  order: string[];
  /** Keyed by recipe id; every key must be a recipe a package declares. */
  recipes: Record<string, RecipeOverlayEntry>;
}

/**
 * The recipe list: every recipe the catalog's packages declare, with the
 * overlay's local parts merged in. An overlay entry or `order` id naming no
 * upstream recipe is an error: a recipe must exist in its package first.
 */
export function mergeRecipes(
  upstream: readonly Recipe[],
  overlay: RecipeOverlay,
): Recipe[] {
  const byId = new Map(upstream.map((recipe) => [recipe.id, recipe]));
  const orphans = [...Object.keys(overlay.recipes), ...overlay.order].filter(
    (id) => !byId.has(id),
  );
  if (orphans.length > 0) {
    throw new Error(
      `Recipes only declared locally, not in a smrt package: ${[...new Set(orphans)].join(', ')}`,
    );
  }
  const ordered = [
    ...overlay.order,
    ...upstream.map((r) => r.id).filter((id) => !overlay.order.includes(id)),
  ];
  return [...new Set(ordered)].map((id) => {
    const recipe = byId.get(id) as Recipe;
    const local = overlay.recipes[id];
    return local ? { ...recipe, ...local } : recipe;
  });
}
