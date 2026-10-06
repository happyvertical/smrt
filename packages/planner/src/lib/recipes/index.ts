import { getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogModel, CatalogPackage } from '../catalog/types.ts';
import raw from './recipes.json';
import type { Recipe, RecipeFile } from './types.ts';

export type * from './types.ts';

/**
 * The recipes the planner offers, sorted by id. This is the one seam to swap:
 * once recipes ship in the published packages' `smrt-knowledge.json`, read
 * them from the catalog here and delete `recipes.json`.
 */
export const recipes: readonly Recipe[] = [
  ...(raw as unknown as RecipeFile).recipes,
].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

export function getRecipe(id: string): Recipe | undefined {
  return byId.get(id);
}

export const recipesById: ReadonlyMap<string, Recipe> = byId;

/** The package that owns a recipe: the one its first model belongs to. */
export function recipePackage(recipe: Recipe): CatalogPackage | undefined {
  const first = recipe.models[0];
  return first ? getModelByQualifiedName(first)?.pkg : undefined;
}

export interface RecipeNavTarget {
  label: string;
  model: CatalogModel;
  /** Catalog package id, for the `/m/<package>/<model>/` route. */
  packageId: string;
}

/** A recipe's `nav` entries resolved to catalog models; unknown ones are dropped. */
export function recipeNav(recipe: Recipe): RecipeNavTarget[] {
  return recipe.nav.flatMap((entry) => {
    const found = getModelByQualifiedName(entry.model);
    return found
      ? [{ label: entry.label, model: found.model, packageId: found.pkg.id }]
      : [];
  });
}

/** A recipe's models resolved to catalog models, in declared order. */
export function recipeModels(
  recipe: Recipe,
): { model: CatalogModel; packageId: string }[] {
  return recipe.models.flatMap((qualified) => {
    const found = getModelByQualifiedName(qualified);
    return found ? [{ model: found.model, packageId: found.pkg.id }] : [];
  });
}
