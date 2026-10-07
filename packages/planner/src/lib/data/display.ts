/**
 * Which field labels a record in pickers. `model.display` comes from the
 * manifest's `displayLabelField` (happyvertical/smrt#3611); a model that
 * declares none falls back to the first of `name`, `title`, `label`, `code`.
 */
import type { CatalogModel } from '../catalog/types.ts';

export const DEFAULT_LABEL_FIELDS = ['name', 'title', 'label', 'code'] as const;

/** The fields that may label a record of the model, best first. */
export function labelFields(model: CatalogModel): string[] {
  const declared = model.display?.label;
  const names = new Set(model.fields.map((f) => f.name));
  return [...(declared ? [declared] : []), ...DEFAULT_LABEL_FIELDS].filter(
    (name, index, all) => names.has(name) && all.indexOf(name) === index,
  );
}

/** The first non-empty label field of a record, or undefined. */
export function displayLabel(
  model: CatalogModel,
  record: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const name of labelFields(model)) {
    const value = record[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}
