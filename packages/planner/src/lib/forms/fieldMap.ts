import type { CatalogField } from '../catalog/types.ts';
import {
  type DataSource,
  isRecordRef,
  type ModelRecord,
  type RecordWrite,
} from '../data/source.ts';
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
  scalar,
  startingValue,
  targetField,
  targetModelId,
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
): { field: RecipeFormField; catalogField: CatalogField; modelId: string }[] {
  const { records, fields } = fieldMapParts(active);
  return fields.map((field) => ({
    field,
    catalogField: targetField(field, records, models),
    modelId: targetModelId(field, records),
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

/**
 * The record the form edits by id: the one of the form's own `model` (a
 * Customer form's Customer, though its Profile is written first), else the
 * first.
 */
export function primaryIndex(active: ActiveForm<FieldMapForm>): number {
  const { records } = fieldMapParts(active);
  const found = records.findIndex((r) => r.model === active.form.model);
  return found < 0 ? 0 : found;
}

/** The rows an existing primary row's records point at, by alias. */
export async function findFieldMapRows(
  source: DataSource,
  active: ActiveForm<FieldMapForm>,
  models: ModelLookup,
  id: string,
): Promise<Record<string, ModelRecord | undefined>> {
  const { records } = fieldMapParts(active);
  const primary = records[primaryIndex(active)];
  if (!primary) return {};
  const row = await source.get(models(primary.model), id);
  return findRows(source, records, { [primary.as]: row }, models);
}

/**
 * Load an existing row's input values, following the records' matches, with
 * the rows found (hand them back to {@link planFieldMapSave}).
 */
export async function loadFieldMapState(
  source: DataSource,
  active: ActiveForm<FieldMapForm>,
  models: ModelLookup,
  id: string,
): Promise<{
  values: Record<string, unknown>;
  rows: Record<string, ModelRecord | undefined>;
}> {
  const { fields } = fieldMapParts(active);
  const rows = await findFieldMapRows(source, active, models, id);
  const blank = blankFieldMap(active, models);
  const values = Object.fromEntries(
    fields.map((field) => {
      const { alias, field: name } = parseTarget(field.to);
      const value = rows[alias]?.[name];
      return [field.id, value === undefined ? blank[field.id] : value];
    }),
  );
  return { values, rows };
}

/** Load an existing row's input values. */
export async function loadFieldMap(
  source: DataSource,
  active: ActiveForm<FieldMapForm>,
  models: ModelLookup,
  id: string,
): Promise<Record<string, unknown>> {
  return (await loadFieldMapState(source, active, models, id)).values;
}

/**
 * The related writes that save a field-map form: each record in order, found
 * or created by its `match` and written with the inputs mapped to it. When
 * editing (`id`), the primary record is updated by `id` and every record
 * `rows` already holds (see {@link findFieldMapRows}) by its own id; the rest
 * are found or created as on a new row. Pure; `apply` runs it.
 */
export function planFieldMapSave(
  active: ActiveForm<FieldMapForm>,
  models: ModelLookup,
  values: Readonly<Record<string, unknown>>,
  id?: string,
  rows: Readonly<Record<string, ModelRecord | undefined>> = {},
  preset: Readonly<Record<string, unknown>> = {},
): RecordWrite[] {
  const { records, fields } = fieldMapParts(active);
  const context = contextFrom(fields, values);
  const primary = primaryIndex(active);
  const written = new Set<string>();
  return records.map((record, index): RecordWrite => {
    const mapped = mappedValues(fields, record.as, values);
    // A page that lists a slice of rows (Ingredients) stamps new primary rows.
    const createValues = {
      ...toWriteValues(record.values, context),
      ...(index === primary
        ? Object.fromEntries(
            Object.entries(preset).map(([key, v]) => [key, scalar(v)]),
          )
        : {}),
    };
    const model = models(record.model);
    const existing = id !== undefined ? rows[record.as] : undefined;
    try {
      if (index === primary && id !== undefined) {
        // Editing also (re)links a record created in this save, e.g. a
        // Customer's Profile.
        const links = Object.fromEntries(
          Object.entries(createValues).filter(([, v]) => isRecordRef(v)),
        );
        return {
          op: 'save',
          as: record.as,
          model,
          id,
          values: { ...mapped, ...links },
        };
      }
      if (existing) {
        return {
          op: 'save',
          as: record.as,
          model,
          id: existing.id,
          values: mapped,
        };
      }
      // A match naming a record that is written later only locates the row
      // being edited; a new row has nothing to find.
      const match = record.match ? toWriteValues(record.match, context) : {};
      const later = Object.values(match).some(
        (v) => isRecordRef(v) && !written.has(v.ref),
      );
      const usable = later ? {} : match;
      const hasMatch = Object.keys(usable).length > 0;
      return {
        op: 'save',
        as: record.as,
        model,
        ...(hasMatch ? { match: usable } : {}),
        onCreate: createValues,
        values: mapped,
      };
    } finally {
      written.add(record.as);
    }
  });
}
