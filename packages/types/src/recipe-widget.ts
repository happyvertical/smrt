/**
 * Recipe `widget` surface types (#3727, phase 2).
 *
 * A package contributes an overview widget by declaring a `widget` surface on a
 * recipe. The shapes are JSON so they travel in `manifest.json` and
 * `smrt-knowledge.json`; smrt-svelte's `registerRecipeWidgets` turns them into
 * widget-registry registrations, resolving the export references itself. The
 * option vocabulary is a literal copy of smrt-svelte's overview option schema
 * (types cannot depend on it); a smrt-svelte test keeps the two in step.
 */

import type { RecipeExportRef } from './recipe.js';

/** The option field types an overview widget supports. No free-form query type exists. */
export type RecipeWidgetOptionType =
  | 'text'
  | 'markdown'
  | 'identifier'
  | 'model'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum';

/** One choice of a closed `enum` option. */
export interface RecipeWidgetOptionChoice {
  value: string;
  /** Label text or an i18n key. */
  label: string;
}

/** One option of a widget: plain JSON, mirrors smrt-svelte's `WidgetOptionField`. */
export interface RecipeWidgetOption {
  /** Camel-case key, `[A-Za-z][A-Za-z0-9]{0,31}`, unique within the widget. */
  key: string;
  type: RecipeWidgetOptionType;
  /** Label text or an i18n key. */
  label: string;
  /** Help text or an i18n key. */
  help?: string;
  required?: boolean;
  /** A JSON primitive that passes the field's own type. */
  default?: string | number | boolean;
  /** `integer` and `number` bounds. */
  min?: number;
  max?: number;
  /** `text`, `markdown`: maximum length. */
  maxLength?: number;
  /** `enum`: the closed set of values (required, non-empty, distinct). */
  choices?: readonly RecipeWidgetOptionChoice[];
}

/** What a widget reads: its server loader and the models it queries. */
export interface RecipeWidgetData {
  /**
   * Export of the widget's server `load(options, ctx)` function. The host runs
   * it inside the page load with the user's permissions; absent for a widget
   * that renders from its options alone.
   */
  load?: RecipeExportRef;
  /** Qualified class names (`@scope/pkg:Class`) the widget reads. */
  models?: readonly string[];
}

/**
 * A widget the recipe contributes to customizable overviews. `export` names the
 * Svelte component (`'<module specifier>#<ExportName>'`), never imported at scan
 * time.
 */
export interface RecipeWidgetSurface {
  kind: 'widget';
  /** Widget type id, unique per recipe: lowercase kebab, `[a-z][a-z0-9-]{0,31}`. */
  type: string;
  export: RecipeExportRef;
  /** Title text or an i18n key. */
  label: string;
  /** Short description or an i18n key, shown in the add list. */
  description?: string;
  /** A shell icon name drawn in the add list. */
  icon?: string;
  /** Option-schema version, a positive integer; omitted means 1. */
  version?: number;
  /** Export of the `migrate(options, fromVersion)` function; needs `version` above 1. */
  migrate?: RecipeExportRef;
  /** The widget's options; omitted means none. */
  options?: readonly RecipeWidgetOption[];
  /** Data needs; omitted for a widget that renders from its options alone. */
  data?: RecipeWidgetData;
  /** Overview ids the widget may appear in; omitted means any. */
  allowedIn?: readonly string[];
  /** Column spans, 1 to 4 (`minSpan <= defaultSpan <= maxSpan`). */
  defaultSpan?: number;
  minSpan?: number;
  maxSpan?: number;
}
