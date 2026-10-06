import { getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogModel, CatalogPackage } from '../catalog/types.ts';
import descriptionsFile from './help/descriptions.json';
import { createRecipeHelp, type HelpModel } from './help.ts';
import { type FieldPolicyRow, resolveFields } from './policy.ts';
import raw from './recipes.json';
import type { Recipe, RecipeFile } from './types.ts';

export type * from './types.ts';

// Local stand-ins for what happyvertical/smrt#3591 puts in the catalog: the
// `help/<recipe id>.md` next to each recipe, and the `@field({ description })`
// of the fields it shows. Both go away with `recipes.json`.
const helpMarkdown = import.meta.glob<string>('./help/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const descriptions = descriptionsFile as Record<string, Record<string, string>>;

/**
 * The recipes the planner offers, in declaration order (which is the order of
 * sub-switches on a card). This is the one seam to swap:
 * once recipes ship in the published packages' `smrt-knowledge.json`, read
 * them from the catalog here (help included) and delete `recipes.json` and
 * `help/`.
 */
export const recipes: readonly Recipe[] = (
  raw as unknown as RecipeFile
).recipes.map((recipe): Recipe => {
  const markdown = helpMarkdown[`./help/${recipe.id}.md`];
  return markdown ? { ...recipe, help: createRecipeHelp(markdown) } : recipe;
});

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

/**
 * A recipe's models as the help renderer takes them: the effective field
 * policies (the recipe's own hints plus the app's saved `rows`, whether or not
 * the recipe is added yet) and the descriptions.
 */
export function helpModels(
  recipe: Recipe,
  rows: readonly FieldPolicyRow[] = [],
): HelpModel[] {
  return recipeModels(recipe).map(({ model }) => ({
    id: model.id,
    name: model.name,
    descriptions: descriptions[model.id] ?? {},
    fields: resolveFields(model, recipe.options?.[model.id], rows).map((r) => ({
      name: r.field.name,
      label: r.label,
      help: r.help,
      visibility: r.visibility,
    })),
  }));
}
