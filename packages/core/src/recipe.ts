/**
 * `SmrtRecipe` — a declared, user-facing unit of app functionality (#3590).
 *
 * A recipe is smaller than a package: "Sales" or "Customers", not all of
 * smrt-commerce. It names the models that make up the unit, the navigation
 * entries it contributes, the recipes it needs first, and curation hints for
 * how its models' forms present. It is declaration only: not persisted and not
 * `@smrt()`-decorated.
 *
 * Declare a recipe as a subclass with static properties, in the package that
 * owns the models. The scanner reads the statics at build time and emits them
 * as the top-level `recipes` array of `manifest.json` and
 * `smrt-knowledge.json`; nothing here runs at that point, so every static must
 * be spelled literally (model entries are class references).
 *
 * @example
 * ```typescript
 * export class SalesRecipe extends SmrtRecipe {
 *   static id = 'commerce.sales';
 *   static label = 'Sales';
 *   static summary = 'Take customer orders and track them.';
 *   static synonyms = ['sales orders', 'orders'];
 *   static models = [Order];
 *   static nav = [{ label: 'Sales Orders', model: Order }];
 *   static requires = ['commerce.customers'];
 *   static section = { id: 'sales', label: 'Sales', icon: 'shoppingBag' };
 *   static options = {
 *     Order: { fields: { status: { default: 'draft', locked: true } } },
 *   };
 *   static help = './sales.recipe.md';
 * }
 * ```
 */

import type {
  RecipeDemoSeed,
  RecipeExposureNarrowing,
  RecipeFieldOptions,
  RecipeProvider,
  RecipeRuntime,
  RecipeSurface,
} from '@happyvertical/smrt-types';

/**
 * A model class as a recipe references it. Any constructor qualifies; the
 * parameter list is `never[]` so models with required constructor options
 * remain assignable.
 */
export type SmrtRecipeModel = abstract new (...args: never[]) => object;

/** One navigation entry a recipe contributes. */
export interface SmrtRecipeNavEntry {
  label: string;
  model: SmrtRecipeModel;
  /** A shell icon name (`users`, `calendar`...) drawn on the entry's row. */
  icon?: string;
  /** One friendly line for a business owner, shown on the section card. */
  description?: string;
  /**
   * Fixed key making the entry's layout id `item:<pkg>:<Model>:<key>`. Needed
   * for a second entry over the same model, and for a `filter`.
   */
  key?: string;
  /** What "New" creates when the label is not a countable noun. */
  noun?: string;
  /**
   * Narrow the entry to rows whose `field` equals `value`; new rows from the
   * view carry the value. Needs a `key`.
   */
  filter?: { field: string; value: string };
}

/** Recipes sharing a `group.id` share one card in a host. */
export interface SmrtRecipeGroup {
  id: string;
  label: string;
  summary?: string;
}

/** The navigation section a recipe suggests; same `id` shares a section. */
export interface SmrtRecipeSection {
  id: string;
  label: string;
  icon?: string;
  description?: string;
}

/**
 * Curation hints for one model, keyed in `static options` by the model's class
 * name. Hints only ever refine what the model already declares: they name its
 * existing fields and can narrow, never widen, its API/MCP/CLI exposure.
 */
export interface SmrtRecipeModelOptions {
  fields?: Record<string, RecipeFieldOptions>;
  exposure?: {
    api?: RecipeExposureNarrowing;
    mcp?: RecipeExposureNarrowing;
    cli?: RecipeExposureNarrowing;
  };
}

export abstract class SmrtRecipe {
  /** Stable dotted id, e.g. `commerce.sales`. Unique across all recipes. */
  static id: string;
  /** Display name, e.g. `Sales`. */
  static label: string;
  /** One sentence on what the unit gives the user. */
  static summary: string;
  /** Other words someone might use to ask for it. */
  static synonyms: readonly string[] = [];
  /** Models the unit brings. They must belong to the declaring package. */
  static models: readonly SmrtRecipeModel[];
  /** Navigation entries; each model must also be listed in `models`. */
  static nav: readonly SmrtRecipeNavEntry[] = [];
  /** Ids of recipes needed first; they may live in other packages. */
  static requires: readonly string[] = [];
  /**
   * Alternatives: at least one id of each inner list must be on. Adding the
   * recipe with none on adds the first of the list.
   */
  static requiresAny: readonly (readonly string[])[] = [];
  /**
   * Card the recipe is a sub-switch of in a host such as an app shell. Recipes
   * with the same `group.id` share it; the first declaration supplies the
   * card's `label` and `summary`.
   */
  static group?: SmrtRecipeGroup;
  /**
   * Navigation section the recipe suggests its `nav` entries sit under. The
   * host owns sections and the user may rename them, so keep `id` stable.
   */
  static section?: SmrtRecipeSection;
  /** Curation hints keyed by model class name. */
  static options: Readonly<Record<string, SmrtRecipeModelOptions>> = {};
  /**
   * Optional user-facing help (#3591): a path to a Markdown file beside the
   * recipe, such as `./sales.recipe.md`. The scanner reads it at build time and
   * embeds `{ markdown, fieldRefs }` in the recipe's manifest entry. See
   * `renderHelp` for how a host follows the app's options.
   */
  static help?: string;
  /**
   * Non-model surfaces (#3708): shell widgets, routes, settings panels and
   * playground entries. Components are referenced by
   * `'<module specifier>#<ExportName>'`, never imported by the manifest.
   */
  static surfaces?: readonly RecipeSurface[];
  /** Providers and secrets the recipe needs or can use (#3708). */
  static providers?: readonly RecipeProvider[];
  /** Where the recipe's runtime pieces can run; omitted means `both`. */
  static runtime?: RecipeRuntime;
  /** Demo fixture data: a fixture export or small inline JSON (#3708). */
  static demoSeed?: RecipeDemoSeed;
}
