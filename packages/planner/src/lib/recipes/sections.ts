import type { Recipe, RecipeNavSection } from './types.ts';

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

/**
 * The NAV section a recipe's entries sit under by default: the section it
 * suggests, else its group, else the recipe. Not to be confused with
 * {@link RecipeSection} (Options and Help pages), which follows `group`.
 */
export function navSectionOf(recipe: Recipe): RecipeNavSection {
  return (
    recipe.section ?? {
      id: sectionId(recipe),
      label: recipe.group?.label ?? recipe.label,
    }
  );
}

/** Nav sections of the given recipes, in the order their first recipe comes. */
export function buildNavSections(
  recipes: readonly Recipe[],
): (RecipeNavSection & { recipes: Recipe[] })[] {
  const out = new Map<string, RecipeNavSection & { recipes: Recipe[] }>();
  for (const recipe of recipes) {
    const nav = navSectionOf(recipe);
    const existing = out.get(nav.id);
    if (existing) existing.recipes.push(recipe);
    else out.set(nav.id, { ...nav, recipes: [recipe] });
  }
  return [...out.values()];
}

/**
 * Old nav section key (the `group` id or recipe id that used to name a nav
 * section) to its key now. Only keys that changed appear.
 */
export function legacyNavSectionKeys(
  recipes: readonly Recipe[],
): Record<string, string> {
  // A key that is still a nav section today (`billing`: the invoicing group id
  // AND its section) is not legacy, whatever another recipe's old key meant.
  const current = new Set(recipes.map((recipe) => navSectionOf(recipe).id));
  const map: Record<string, string> = {};
  for (const recipe of recipes) {
    const old = sectionId(recipe);
    const now = navSectionOf(recipe).id;
    if (old !== now && !current.has(old)) map[old] = now;
  }
  return map;
}

/**
 * The stable layout id of a navigation item: `item:<package>:<Model>`, or
 * `item:<package>:<Model>:<key>` when a model appears twice in the nav and the
 * extra entry declares a fixed `key`. It never names the section, the label or
 * the href, so renaming an entry, moving a recipe's suggested section or
 * changing the selection query leaves saved layouts and cookbooks valid.
 */
export function navItemId(
  packageId: string,
  modelName: string,
  key?: string,
): string {
  return `item:${packageId}:${modelName}${key ? `:${key}` : ''}`;
}

/**
 * The line under an entry on its section card: the recipe's own text first,
 * then the catalog model's description, then a plain fallback.
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

function humanizeName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}
