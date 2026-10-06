/**
 * The shape of a recipe as `SmrtRecipe` (happyvertical/smrt#3590) emits it into
 * `smrt-knowledge.json` under the top-level `recipes` key, and the only place
 * the planner depends on that shape. Until the generator reads recipes from the
 * published packages, `recipes.json` is a local file in this shape; then the
 * file goes away and `index.ts` reads the catalog instead.
 */

import type { RecipeHelp } from './help.ts';

/**
 * Curation hints for one field. The vocabulary is the smrt-fields policy
 * vocabulary (default, visibility, label, help, order, locked), so applying a
 * recipe's options produces smrt-fields policy rows. Hints are never a second
 * schema: they can only name fields the model already declares.
 */
export interface RecipeFieldHint {
  /** A different starting value. Present (even `null`) means "override". */
  default?: unknown;
  /** `hidden` removes the parameter from the options form and the views. */
  visibility?: 'basic' | 'advanced' | 'hidden';
  label?: string;
  help?: string;
  order?: number;
  /** The planner may not change this field's policy. */
  locked?: boolean;
}

/** The `@smrt()` surfaces a recipe may narrow. It can never switch one on. */
export type ExposureSurface = 'api' | 'mcp' | 'cli';

export interface RecipeModelHints {
  /** Keyed by field name. */
  fields?: Record<string, RecipeFieldHint>;
  /** `false` narrows that surface off; `true` is not allowed. */
  exposure?: Partial<Record<ExposureSurface, false>>;
}

export interface RecipeNavEntry {
  label: string;
  /** Qualified model name, `@scope/pkg:Class`. */
  model: string;
}

export interface Recipe {
  /** Unique, e.g. `commerce.sales`. */
  id: string;
  label: string;
  summary: string;
  synonyms: string[];
  /** Qualified model names, all owned by the recipe's package. */
  models: string[];
  nav: RecipeNavEntry[];
  /** Ids of other recipes (possibly in other packages). */
  requires: string[];
  /** Curation hints keyed by qualified model name. */
  options?: Record<string, RecipeModelHints>;
  /** User-facing help (happyvertical/smrt#3591); see `help.ts`. */
  help?: RecipeHelp;
}

/** The slice of `smrt-knowledge.json` the planner reads. */
export interface RecipeFile {
  recipes: Recipe[];
}
