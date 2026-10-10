/**
 * Navigation sections and entry ids (#3749), ported from smrt-planner's
 * `recipes/sections.ts` so a generated app and the planner derive the same
 * ids: a saved layout names them, so they must stay stable.
 */
import type { RecipeSection } from '@happyvertical/smrt-types';
import type { CookbookRecipe } from './types.js';

/** The section that holds feature models no recipe covers. */
export const FEATURE_SECTION: RecipeSection = {
  id: 'more',
  label: 'More',
  icon: 'layers',
  description: 'Extra records you added one at a time.',
};

/** Icon of an entry whose recipe names none, and of feature entries. */
export const DEFAULT_ENTRY_ICON = 'fileText';

/** The icon of a section the user made, or one the host knows nothing of. */
export const DEFAULT_SECTION_ICON = 'folder';

/** The id of the group (or recipe) a recipe belongs to. */
export function groupId(recipe: Pick<CookbookRecipe, 'id' | 'group'>): string {
  return recipe.group?.id ?? recipe.id;
}

/**
 * The nav section a recipe's entries sit under by default: the section it
 * suggests, else its group, else the recipe itself.
 */
export function navSectionOf(recipe: CookbookRecipe): RecipeSection {
  return (
    recipe.section ?? {
      id: groupId(recipe),
      label: recipe.group?.label ?? recipe.label,
    }
  );
}

export type NavSectionGroup = RecipeSection & { recipes: CookbookRecipe[] };

/** Nav sections of the given recipes, in the order their first recipe comes. */
export function buildNavSections(
  recipes: readonly CookbookRecipe[],
): NavSectionGroup[] {
  const out = new Map<string, NavSectionGroup>();
  for (const recipe of recipes) {
    const nav = navSectionOf(recipe);
    const existing = out.get(nav.id);
    if (existing) {
      existing.recipes.push(recipe);
      // The first recipe supplies the label; a later one may add what is missing.
      existing.icon ??= nav.icon;
      existing.description ??= nav.description;
    } else out.set(nav.id, { ...nav, recipes: [recipe] });
  }
  return [...out.values()];
}

/**
 * The stable layout id of a navigation item: `item:<package>:<Model>`, or
 * `item:<package>:<Model>:<key>` when a model appears twice in the nav and the
 * extra entry declares a fixed `key`. It never names the section, the label or
 * the href, so renaming an entry or moving a recipe's section leaves a saved
 * layout valid.
 */
export function navItemId(
  packageId: string,
  modelName: string,
  key?: string,
): string {
  return `item:${packageId}:${modelName}${key ? `:${key}` : ''}`;
}

/** `section:<id>` for a recipe-suggested section. */
export function sectionLayoutId(id: string): string {
  return `section:${id}`;
}

/**
 * A section page lives at `/s/<slug>/`. The slug is the layout id with its
 * `kind:` prefix turned into `kind-` (`section:sales` -> `section-sales`), so
 * no path segment holds a colon. Only the first colon is the prefix.
 */
export function sectionSlug(id: string): string {
  return id.replace(':', '-');
}

/** The layout id a slug names; the inverse of {@link sectionSlug}. */
export function sectionIdFromSlug(slug: string): string {
  return slug.replace('-', ':');
}

/** Default in-app path of a section page. */
export function defaultSectionPath(id: string): string {
  return `/s/${sectionSlug(id)}/`;
}

/** Default in-app path of a model entry: `/m/<pkg>/<Model>/[<key>/]`. */
export function defaultEntryPath(entry: {
  packageId: string;
  modelName: string;
  key?: string;
}): string {
  return `/m/${entry.packageId}/${entry.modelName}/${entry.key ? `${entry.key}/` : ''}`;
}

function humanizeName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * The line under an entry on its section card: the recipe's own text first,
 * then the model's description, then a plain fallback.
 */
export function entryDescription(
  own: string | undefined,
  model: { description?: string; name: string },
): string {
  return (
    own?.trim() ||
    model.description?.trim() ||
    `Your ${humanizeName(model.name)} records, all in one place.`
  );
}
