import type { CatalogField } from '../catalog/types.ts';
import type { DataSource, RecordWrite } from '../data/source.ts';
import type {
  FieldMapForm,
  RecipeFormField,
  RecipeFormRecord,
} from '../recipes/types.ts';
import type { ActiveForm } from './active.ts';
import {
  contextFrom,
  findRows,
  type ModelLookup,
  mappedValues,
  parseTarget,
  startingValue,
  targetField,
  toWriteValues,
} from './shared.ts';

/** The records and inputs of a field-map form once extensions are merged in. */
export function fieldMapParts(active: ActiveForm<FieldMapForm>): {
  records: RecipeFormRecord[];
  fields: RecipeFormField[];
} {
  return {
    records: [
      ...active.form.records,
      ...active.extensions.flatMap((ext) => ext.records ?? []),
    ],
    fields: [
      ...active.form.fields,
      ...active.extensions.flatMap((ext) => ext.fields ?? []),
    ],
  };
}

/** Each input with the catalog field it maps onto, for rendering. */
export function fieldMapInputs(
  active: ActiveForm<FieldMapForm>,
  models: ModelLookup,
): { field: RecipeFormField; catalogField: CatalogField }[] {
  const { records, fields } = fieldMapParts(active);
  return fields.map((field) => ({
    field,
    catalogField: targetField(field, records, models),
  }));
}

/** Input values for a new row. */
export function blankFieldMap(
  active: ActiveForm<FieldMapForm>,
  models: ModelLookup,
): Record<string, unknown> {
  return Object.fromEntries(
    fieldMapInputs(active, models).map(({ field, catalogField }) => [
      field.id,
      startingValue(field, catalogField),
    ]),
  );
}

/** Load an existing row's input values, following the records' matches. */
export async function loadFieldMap(
  source: DataSource,
  active: ActiveForm<FieldMapForm>,
  models: ModelLookup,
  id: string,
): Promise<Record<string, unknown>> {
  const { records, fields } = fieldMapParts(active);
  const primary = records[0];
  if (!primary) return {};
  const row = await source.get(models(primary.model), id);
  const rows = await findRows(source, records, { [primary.as]: row }, models);
  const blank = blankFieldMap(active, models);
  return Object.fromEntries(
    fields.map((field) => {
      const { alias, field: name } = parseTarget(field.to);
      const value = rows[alias]?.[name];
      return [field.id, value === undefined ? blank[field.id] : value];
    }),
  );
}

/**
 * The related writes that save a field-map form: the primary record (updated
 * when `id` is given), then each further record found-or-created by its
 * `match` and written with the inputs mapped to it. Pure; `apply` runs it.
 */
export function planFieldMapSave(
  active: ActiveForm<FieldMapForm>,
  models: ModelLookup,
  values: Readonly<Record<string, unknown>>,
  id?: string,
): RecordWrite[] {
  const { records, fields } = fieldMapParts(active);
  const context = contextFrom(fields, values);
  return records.map((record, index): RecordWrite => {
    const mapped = mappedValues(fields, record.as, values);
    const createValues = toWriteValues(record.values, context);
    const model = models(record.model);
    if (index === 0 && id !== undefined) {
      return { op: 'save', as: record.as, model, id, values: mapped };
    }
    return {
      op: 'save',
      as: record.as,
      model,
      ...(record.match ? { match: toWriteValues(record.match, context) } : {}),
      onCreate: createValues,
      values: mapped,
    };
  });
}
