import type { Recipe } from './types.ts';

/**
 * A navigation section: one recipe, or the recipes of one `group` (Products
 * from Simple and Clothing). A section owns one Options page and one Help
 * page, at `/recipes/<id>/` and `/recipes/<id>/help/`. For a recipe with no
 * group the id is the recipe id, so those URLs are the recipe's own.
 */
export interface RecipeSection {
  /** The group id, or the recipe id for a recipe with no group. */
  id: string;
  label: string;
  /** In declaration order. */
  recipes: Recipe[];
}

/** The id of the section a recipe belongs to. */
export function sectionId(recipe: Recipe): string {
  return recipe.group?.id ?? recipe.id;
}

/** Sections in the order their first recipe is declared. */
export function buildSections(recipes: readonly Recipe[]): RecipeSection[] {
  const sections = new Map<string, RecipeSection>();
  for (const recipe of recipes) {
    const id = sectionId(recipe);
    const existing = sections.get(id);
    if (existing) existing.recipes.push(recipe);
    else
      sections.set(id, {
        id,
        label: recipe.group?.label ?? recipe.label,
        recipes: [recipe],
      });
  }
  return [...sections.values()];
}
