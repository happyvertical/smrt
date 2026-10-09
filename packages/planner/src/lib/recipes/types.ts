/**
 * The shape of a recipe as `SmrtRecipe` (happyvertical/smrt#3590) emits it into
 * `smrt-knowledge.json` under the top-level `recipes` key, and the only place
 * the planner depends on that shape. Until the generator reads recipes from the
 * published packages. The catalog carries them; `overlay.json` adds the
 * planner-local `forms` and `extends`.
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
  /** The form refuses to save without a value, whatever the catalog says. */
  required?: boolean;
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
  /** LOCAL. A shell icon name (`users`, `calendar`...) drawn on the entry's row. */
  icon: string;
  /** LOCAL. One friendly line for a business owner, shown on the section card. */
  description: string;
  /** Qualified model name, `@scope/pkg:Class`. */
  model: string;
  /**
   * Fixed key making this entry's layout id `item:<pkg>:<Model>:<key>`. Only
   * for a model that appears twice in the nav; never derived from the label.
   */
  key?: string;
  /**
   * What New creates, when the label is not a countable noun ("Stock levels"
   * -> "stock entry"). Without it, the label's singular is used.
   */
  noun?: string;
  /**
   * LOCAL. Narrows the entry to rows whose `field` equals `value` (an
   * Ingredients entry over Products: `productType` = `material`). Needs a
   * `key`, which puts the view at `/m/<pkg>/<Model>/<key>/`. New rows from
   * the view carry the value; the model's plain entry stops listing them
   * while the filtered entry's recipe is added.
   */
  filter?: { field: string; value: string };
}

/**
 * LOCAL (not in `SmrtRecipe` yet): recipes with the same `group.id` share one
 * Planner card. The card's switch is on while any of its recipes is, and each
 * recipe is a sub-switch on the card, in declaration order (the first is what
 * turning the card on adds). `label` and `summary` are the card's.
 */
export interface RecipeGroup {
  id: string;
  label: string;
  summary?: string;
}

/**
 * LOCAL, to upstream to `SmrtRecipe` (PR notes): the navigation section a
 * recipe SUGGESTS its `nav` entries sit under, e.g. `{ id: 'sales', label:
 * 'Sales' }`. Distinct from {@link RecipeGroup}, which is the Planner card and
 * the Options/Help pages. The app owns the sections; the user may rename,
 * add or reorder them in the Layout tab, so `id` must be stable (it keys a
 * saved layout). Recipes naming the same `id` share one section. Absent: the
 * recipe's `group`, else the recipe itself.
 */
export interface RecipeNavSection {
  id: string;
  label: string;
  /**
   * LOCAL: the section's icon, a shell icon name (`shoppingBag`, `receipt`...).
   * The sidebar shows only sections, so every suggested section has one; the
   * user can change it in edit mode.
   */
  icon?: string;
  /** LOCAL: one line for the section's page, under its title. */
  description?: string;
}

/** A value in a form record: a literal, a `{ref}` to another record's id, or a template. */
export type RecipeFormValue =
  | string
  | number
  | boolean
  | null
  | { ref: string; field?: string };

/**
 * LOCAL. One row a form saves. Records are applied in order, so a record can
 * `{ref}` an earlier one. A record with no `match` is created (or, when the
 * form is editing, is the row being edited, for the first record). With a
 * `match` it is found by those values or created from them, so shared rows
 * such as the default location are never duplicated. A `{ref, field}` is that
 * record's value of `field` rather than its id. A `match` that points at a
 * record LATER in the list (a Profile found by its Customer's `profileId`)
 * locates the row when editing and is ignored when creating. `values` apply when the
 * row is created; fields mapped with `to` apply on every save. A string value
 * may use `{alias.field}` and `{alias.field|slug}` over values the form holds.
 */
export interface RecipeFormRecord {
  as: string;
  /** Qualified model name. */
  model: string;
  match?: Record<string, RecipeFormValue>;
  values?: Record<string, RecipeFormValue>;
}

/** An input mapped onto `alias.field` of one of the form's records. */
export interface RecipeFormField {
  id: string;
  label: string;
  /** `alias.field`, e.g. `product.price`. */
  to: string;
  required?: boolean;
  help?: string;
  /** Starting value for a new row. */
  default?: unknown;
}

interface RecipeFormBase {
  /** Unique across recipes; `extends` points at it. */
  id: string;
  /** What New offers and the edit form is titled, e.g. "Simple product". */
  label: string;
  /** The Kind column's text for a row this form edits, e.g. "Simple". */
  kindLabel: string;
  /** Qualified model the form creates and edits; its list is the one shown. */
  model: string;
}

/** Inputs mapped to fields of related objects, saved together. */
export interface FieldMapForm extends RecipeFormBase {
  kind: 'field-map';
  records: RecipeFormRecord[];
  fields: RecipeFormField[];
}

/** One axis of a variant grid. */
export interface VariantAxis {
  /** Written to `ProductVariant.axisName` and the keys of `Sku.attributes`. */
  name: string;
  /** Label of the chip input, e.g. "Sizes". */
  label: string;
  /** Values offered to start with. */
  values: string[];
}

/**
 * A product with axes: name and price, a chip input per axis, then a grid with
 * one cell per combination. Saves the product, a `variants` row per axis and a
 * `skus` row per cell with its `attributes` pinned.
 */
export interface VariantGridForm extends RecipeFormBase {
  kind: 'variant-grid';
  /** The product row, as a record the `fields` map onto. */
  product: RecipeFormRecord;
  fields: RecipeFormField[];
  axes: VariantAxis[];
  /** Qualified model of the axis rows. */
  variants: string;
  /** Qualified model of the cell rows. */
  skus: string;
}

export type RecipeForm = FieldMapForm | VariantGridForm;

/**
 * LOCAL. Adds to another recipe's form from a recipe that is switched on
 * alongside it. On a field-map form the `records` and `fields` join the form.
 * On a variant grid they are evaluated once per cell: `product` and `sku` are
 * the cell's rows, and each `fields` entry is one more input in every cell.
 */
export interface RecipeFormExtension {
  /** Id of the form being extended. */
  form: string;
  records?: RecipeFormRecord[];
  fields?: RecipeFormField[];
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
  /**
   * LOCAL. Alternatives: at least one must be on. Adding the recipe with none
   * on adds the first; the last one on cannot be removed while this is.
   */
  requiresAny?: string[][];
  /** LOCAL. Card this is a sub-switch of; see {@link RecipeGroup}. */
  group?: RecipeGroup;
  /** LOCAL. Suggested navigation section; see {@link RecipeNavSection}. */
  section?: RecipeNavSection;
  /** LOCAL. Forms that replace the generic one-model form for `nav` models. */
  forms?: RecipeForm[];
  /** LOCAL. Additions to other recipes' forms; see {@link RecipeFormExtension}. */
  extends?: RecipeFormExtension[];
  /** Curation hints keyed by qualified model name. */
  options?: Record<string, RecipeModelHints>;
  /** User-facing help (happyvertical/smrt#3591); see `help.ts`. */
  help?: RecipeHelp;
}
