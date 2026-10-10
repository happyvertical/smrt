import { catalog, getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogModel, CatalogPackage } from '../catalog/types.ts';
import { FEATURE_ENTRY_ICON } from './features.ts';
import descriptionsFile from './help/descriptions.json';
import type { HelpModel } from './help.ts';
import { mergeRecipes, type RecipeOverlay } from './merge.ts';
import overlay from './overlay.json';
import { type FieldPolicyRow, resolveFields } from './policy.ts';
import {
  buildSections,
  entryDescription,
  type RecipeSection,
} from './sections.ts';
import type { Recipe } from './types.ts';

export type { RecipeSection } from './sections.ts';
export {
  buildNavSections,
  legacyNavSectionKeys,
  navItemId,
  navSectionOf,
  sectionId,
} from './sections.ts';
export type * from './types.ts';

const descriptions = descriptionsFile as Record<string, Record<string, string>>;

/**
 * The recipes the planner offers, in the overlay's order (which is the order
 * of sub-switches on a card). They are the ones the smrt packages declare
 * (carried in the catalog), plus the planner-local `forms` and `extends` of
 * `overlay.json`; see `merge.ts`.
 */
export const recipes: readonly Recipe[] = mergeRecipes(
  catalog.packages.flatMap((pkg) => pkg.recipes ?? []),
  overlay as unknown as RecipeOverlay,
);

const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

export function getRecipe(id: string): Recipe | undefined {
  return byId.get(id);
}

export const recipesById: ReadonlyMap<string, Recipe> = byId;

/** The navigation sections (see `sections.ts`), one Options and Help page each. */
export const sections: readonly RecipeSection[] = buildSections(recipes);

export function getSection(id: string): RecipeSection | undefined {
  return sections.find((section) => section.id === id);
}

/** The package that owns a recipe: the one its first model belongs to. */
export function recipePackage(recipe: Recipe): CatalogPackage | undefined {
  const first = recipe.models[0];
  return first ? getModelByQualifiedName(first)?.pkg : undefined;
}

export interface RecipeNavTarget {
  label: string;
  /** Shell icon name; see `RecipeNavEntry.icon`. */
  icon: string;
  /** The recipe's own line; see `RecipeNavEntry.description`. */
  description: string;
  /** The entry's fixed id key, if the model appears twice in the nav. */
  key?: string;
  /** Explicit noun for the New button; see `RecipeNavEntry.noun`. */
  noun?: string;
  /** Row filter of a keyed entry; see `RecipeNavEntry.filter`. */
  filter?: { field: string; value: string };
  model: CatalogModel;
  /** Catalog package id, for the `/m/<package>/<model>/` route. */
  packageId: string;
}

/** A recipe's `nav` entries resolved to catalog models; unknown ones are dropped. */
export function recipeNav(recipe: Recipe): RecipeNavTarget[] {
  return recipe.nav.flatMap((entry) => {
    const found = getModelByQualifiedName(entry.model);
    return found
      ? [
          {
            label: entry.label,
            icon: entry.icon ?? FEATURE_ENTRY_ICON,
            description: entryDescription(entry.description, found.model),
            ...(entry.key ? { key: entry.key } : {}),
            ...(entry.noun ? { noun: entry.noun } : {}),
            ...(entry.filter ? { filter: entry.filter } : {}),
            model: found.model,
            packageId: found.pkg.id,
          },
        ]
      : [];
  });
}

/**
 * In-app path of a nav entry, without the app query: `/m/<pkg>/<Model>/`, and
 * `/m/<pkg>/<Model>/<key>/` for a keyed entry (the same model shown twice).
 */
export function navPath(entry: {
  packageId: string;
  model: { name: string };
  key?: string;
}): string {
  return `/m/${entry.packageId}/${entry.model.name}/${entry.key ? `${entry.key}/` : ''}`;
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
  // A recipe with no menu entry has no list or form, so no field is shown to
  // describe (the assistant's session records, a policy table). Its prose can
  // still name fields (Form customization's steps), so they resolve; they just
  // get no glossary entry.
  const listed = recipe.nav.length > 0;
  return recipeModels(recipe).map(({ model }) => ({
    id: model.id,
    name: model.name,
    ...(listed ? {} : { glossary: false }),
    // The curated local text first (it is plain language, checked by tests);
    // a field it does not cover falls back to the description its package
    // declares, which is how feature recipes' models get a glossary.
    descriptions: {
      ...Object.fromEntries(
        model.fields.flatMap((f) =>
          f.description ? [[f.name, f.description]] : [],
        ),
      ),
      ...descriptions[model.id],
    },
    fields: resolveFields(model, recipe.options?.[model.id], rows).map((r) => ({
      name: r.field.name,
      label: r.label,
      help: r.help,
      visibility: r.visibility,
    })),
  }));
}
