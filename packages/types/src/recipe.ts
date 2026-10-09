/**
 * Recipe types (#3590).
 *
 * A recipe is a declared, user-facing unit of app functionality ("Sales",
 * "Customers") smaller than a package. These are the shapes the scanner emits
 * under the top-level `recipes` key of `manifest.json` and
 * `smrt-knowledge.json`; `SmrtRecipe` in smrt-core is the authoring base class.
 */

/** Same visibility vocabulary as the smrt-fields policy rail. */
export type RecipeFieldVisibility = 'basic' | 'advanced' | 'hidden';

/**
 * Curation hints for one field of one recipe model.
 *
 * The vocabulary is the smrt-fields policy one (default, label, help, order,
 * visibility, locked), so applying a recipe's options yields field-policy
 * rows. It is never a second schema: it can only name a field the model
 * already declares, and every key refines how that field is presented.
 */
export interface RecipeFieldOptions {
  /** A different starting value for the field. */
  default?: unknown;
  label?: string;
  help?: string;
  order?: number;
  visibility?: RecipeFieldVisibility;
  locked?: boolean;
  /** The form refuses to save without a value, whatever the model says. */
  required?: boolean;
}

/**
 * Exposure narrowing for one transport. Narrow only: `false` withdraws the
 * transport, `{ exclude }` withdraws named operations. `true` and `include`
 * are rejected because they can widen what the model already declares.
 */
export type RecipeExposureNarrowing = false | { exclude: string[] };

/** Curation hints for one recipe model. */
export interface RecipeModelOptions {
  fields?: Record<string, RecipeFieldOptions>;
  exposure?: {
    api?: RecipeExposureNarrowing;
    mcp?: RecipeExposureNarrowing;
    cli?: RecipeExposureNarrowing;
  };
}

/** One navigation entry of a recipe. `model` is a qualified class name. */
export interface RecipeNavEntry {
  label: string;
  model: string;
  /** A shell icon name (`users`, `calendar`...) drawn on the entry's row. */
  icon?: string;
  /** One friendly line for a business owner, shown on the section card. */
  description?: string;
  /**
   * Fixed key making the entry's layout id `item:<pkg>:<Model>:<key>`. Needed
   * for a second entry over the same model, and for a `filter`. Never derived
   * from the label.
   */
  key?: string;
  /**
   * What "New" creates when the label is not a countable noun ("Stock levels"
   * -> "stock entry"). Without it a host singularises the label.
   */
  noun?: string;
  /**
   * Narrows the entry to rows whose `field` equals `value` (an Ingredients
   * entry over Products: `productType` = `material`). Needs a `key`. New rows
   * made from the view carry the value.
   */
  filter?: { field: string; value: string };
}

/**
 * Recipes with the same `group.id` share one card in a host such as an app
 * shell: the card is on while any of its recipes is, each recipe being a
 * sub-switch in declaration order. `label` and `summary` are the card's, and
 * the first declaration of an id supplies them.
 */
export interface RecipeGroup {
  id: string;
  label: string;
  summary?: string;
}

/**
 * The navigation section a recipe suggests its `nav` entries sit under. The
 * host owns sections and the user may rename or reorder them, so `id` must be
 * stable. Recipes naming the same `id` share a section.
 */
export interface RecipeSection {
  id: string;
  label: string;
  /** A shell icon name (`shoppingBag`, `receipt`...). */
  icon?: string;
  /** One line for the section's page, under its title. */
  description?: string;
}

/**
 * User-facing help for a recipe (#3591), embedded so a static host needs no
 * extra request. `markdown` is the authored prose; a step may name a field as
 * `{field:name}` or `{field:Model.name}`. `fieldRefs` is derived from the
 * Markdown at build time (distinct references as written, sorted) and is never
 * authored by hand.
 */
export interface RecipeHelp {
  markdown: string;
  fieldRefs: string[];
}

/** A recipe as emitted into the manifest and the knowledge artifact. */
export interface RecipeDefinition {
  /** Stable, dotted, lowercase id, e.g. `commerce.sales`. */
  id: string;
  /** The recipe's class name, for traceability. */
  className: string;
  label: string;
  summary: string;
  synonyms: string[];
  /** Qualified class names (`@scope/pkg:Class`) of the models it brings. */
  models: string[];
  nav: RecipeNavEntry[];
  /** Ids of recipes this one needs; they may live in other packages. */
  requires: string[];
  /**
   * Alternatives: at least one id of each inner list must be on. Adding the
   * recipe with none on adds the first. Omitted when none.
   */
  requiresAny?: string[][];
  /** Shared card in a host; omitted when the recipe stands alone. */
  group?: RecipeGroup;
  /** Suggested navigation section; omitted when the host chooses. */
  section?: RecipeSection;
  /** Curation hints keyed by qualified model name; omitted when none. */
  options?: Record<string, RecipeModelOptions>;
  /** User-facing help read from the recipe's `static help` file; omitted when none. */
  help?: RecipeHelp;
}
