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
  /** Curation hints keyed by qualified model name; omitted when none. */
  options?: Record<string, RecipeModelOptions>;
}
