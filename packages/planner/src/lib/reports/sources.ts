/**
 * Runtime report sources in the planner (#4100): the browser counterpart of a
 * generated app's `packages.reports.runtime.sources`.
 *
 * A generated app lists its report sources in `smrt.config.ts`; the planner
 * has no config, so it offers the models the app's menu shows (the nav entries
 * of the recipes that are on), each described from the catalog. The in-memory
 * runner (`@happyvertical/smrt-reports/spec`) evaluates specs over their sample
 * rows. Nothing here is an authority boundary: it is sample data.
 */

import {
  describeRuntimeReportMemorySource,
  type RuntimeReportColumnType,
  type RuntimeReportMemoryField,
  type RuntimeReportMemorySource,
} from '@happyvertical/smrt-reports/spec';
import type { CatalogField, CatalogModel } from '../catalog/types.ts';
import { isMoneyField } from '../data/fakes.ts';
import { fieldLabel } from '../data/format.ts';
import { type Recipe, recipeNav } from '../recipes/index.ts';

/** The RuntimeReport model saved reports are rows of. */
export const RUNTIME_REPORT_MODEL = '@happyvertical/smrt-reports:RuntimeReport';

/** The recipe that brings Reports (Shared reports). */
export const REPORTS_RECIPE = 'reports.runtime';

/** A source the planner offers, with what the assistant needs to fill gaps. */
export interface PlannerReportSource extends RuntimeReportMemorySource {
  label: string;
  /** The catalog model the rows come from. */
  model: CatalogModel;
  /** The natural date (smrt-reports' `defaultTimeField`), for ranking. */
  dateField?: string;
  /** The money field a "summary" or "total" sums by default. */
  amountField?: string;
}

function columnType(field: CatalogField): RuntimeReportColumnType | null {
  switch (field.type) {
    case 'text':
      return 'string';
    case 'integer':
      return 'integer';
    case 'decimal':
      return 'decimal';
    case 'boolean':
      return 'boolean';
    case 'datetime':
      return 'datetime';
    case 'foreignKey':
    case 'crossPackageRef':
      return 'id';
    default:
      return null;
  }
}

/** Snake-case plural of a class name: `TaxCode` -> `tax_codes`. */
function sourceId(name: string): string {
  const snake = name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
  if (/(series|species)$/.test(snake)) return snake;
  if (/[^aeiou]y$/.test(snake)) return `${snake.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(snake)) return `${snake}es`;
  return `${snake}s`;
}

const PREFERRED_AMOUNTS = ['totalAmount', 'total', 'amount'];

/** Describe one catalog model as an in-memory report source. */
export function reportSourceFor(
  model: CatalogModel,
  label: string,
  id = sourceId(model.name),
): PlannerReportSource {
  const schema: RuntimeReportMemoryField[] = [{ name: 'id', type: 'string' }];
  for (const field of model.fields) {
    const type = columnType(field);
    // System fields (tenant, snapshots, sync state) are framework plumbing;
    // a person never reports on them.
    if (!type || field.system || schema.some((f) => f.name === field.name)) {
      continue;
    }
    // The catalog's field metadata is what smrt-reports reads its time and
    // grouping hints from: `ui.format` ('money', 'date') and `enum`.
    const format = isMoneyField(field)
      ? 'money'
      : type === 'datetime' && field.ui?.format === 'date'
        ? 'date'
        : undefined;
    schema.push({
      name: field.name,
      type,
      label: fieldLabel(field),
      ...(format ? { format } : {}),
      ...(type === 'string' && field.enum?.length ? { enum: field.enum } : {}),
    });
  }
  const money = schema.filter((field) => field.format === 'money');
  // Only a document's own total is "how much" by default; a customer's credit
  // limit or a product's price is not, so those sources default to a count.
  const amount = PREFERRED_AMOUNTS.map((name) =>
    money.find((f) => f.name === name),
  ).find(Boolean);
  const source: PlannerReportSource = {
    id,
    label,
    ...(model.description ? { description: model.description } : {}),
    schema,
    model,
    ...(amount ? { amountField: amount.name } : {}),
  };
  // The natural date comes from smrt-reports' descriptor, not a guess here.
  const date = describeRuntimeReportMemorySource([source], id).defaultTimeField;
  return date ? { ...source, dateField: date } : source;
}

/**
 * The report sources of an app: one per model its menu lists (recipe nav
 * entries of the recipes that are on), labelled as the menu labels it, in menu
 * order. Saved reports themselves are never a source.
 */
export function plannerReportSources(
  recipeIds: readonly string[],
  recipes: readonly Recipe[],
): PlannerReportSource[] {
  const on = new Set(recipeIds);
  const entries = new Map<string, ReturnType<typeof recipeNav>>();
  for (const recipe of recipes) {
    if (!on.has(recipe.id)) continue;
    for (const entry of recipeNav(recipe)) {
      if (entry.model.id === RUNTIME_REPORT_MODEL) continue;
      entries.set(entry.model.id, [
        ...(entries.get(entry.model.id) ?? []),
        entry,
      ]);
    }
  }
  const seen = new Map<string, PlannerReportSource>();
  const ids = new Set<string>();
  for (const [modelId, list] of entries) {
    // A filtered entry ("Sales orders") shows part of the rows; the source is
    // the whole model, so the unfiltered entry's label names it when there is one.
    const entry = list.find((e) => !e.filter) ?? list[0];
    let id = sourceId(entry.model.name);
    // Two packages with one class name: keep both, told apart by package.
    if (ids.has(id)) id = `${entry.packageId}.${id}`;
    ids.add(id);
    seen.set(modelId, reportSourceFor(entry.model, entry.label, id));
  }
  return [...seen.values()];
}
