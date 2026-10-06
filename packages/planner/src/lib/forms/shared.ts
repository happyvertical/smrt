import { getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogField, CatalogModel } from '../catalog/types.ts';
import type { DataSource, ModelRecord, WriteValue } from '../data/source.ts';
import type {
  RecipeFormField,
  RecipeFormRecord,
  RecipeFormValue,
} from '../recipes/types.ts';

/** A catalog model by qualified name; a form naming a missing one is a bug. */
export type ModelLookup = (qualified: string) => CatalogModel;

export const catalogModels: ModelLookup = (qualified) => {
  const found = getModelByQualifiedName(qualified);
  if (!found) throw new Error(`The catalog has no model ${qualified}`);
  return found.model;
};

/** What a template reads: `alias.field` to the value the form holds. */
export type TemplateContext = Readonly<Record<string, unknown>>;

/** `Blue Tee` to `BLUE-TEE`: upper-case letters and digits, joined by dashes. */
export function slug(value: unknown): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const PLACEHOLDER = /\{([A-Za-z_][\w]*\.[A-Za-z_][\w]*)(?:\|(slug))?\}/g;

/** Fill `{alias.field}` and `{alias.field|slug}` in a string from the context. */
export function fillTemplate(text: string, context: TemplateContext): string {
  return text.replace(PLACEHOLDER, (_, key: string, filter?: string) => {
    const value = context[key];
    const plain = value === null || value === undefined ? '' : String(value);
    return filter === 'slug' ? slug(plain) : plain;
  });
}

/** A recipe value as a write value: templates filled, `{ref}` kept. */
export function toWriteValue(
  value: RecipeFormValue,
  context: TemplateContext,
  renameRef: (alias: string) => string = (alias) => alias,
): WriteValue {
  if (typeof value === 'string') return fillTemplate(value, context);
  if (value !== null && typeof value === 'object') {
    return { ref: renameRef(value.ref) };
  }
  return value;
}

export function toWriteValues(
  values: Record<string, RecipeFormValue> | undefined,
  context: TemplateContext,
  renameRef?: (alias: string) => string,
): Record<string, WriteValue> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [
      key,
      toWriteValue(value, context, renameRef),
    ]),
  );
}

/** An input's value as a write value: scalars as they are, anything else null. */
export function scalar(value: unknown): WriteValue {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? value
    : null;
}

/** The inputs mapped to one record, as that record's field values. */
export function mappedValues(
  fields: readonly RecipeFormField[],
  alias: string,
  values: Readonly<Record<string, unknown>>,
): Record<string, WriteValue> {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const target = parseTarget(field.to);
      return target.alias === alias
        ? [[target.field, scalar(values[field.id])]]
        : [];
    }),
  );
}

/** `product.price` to `{ alias: 'product', field: 'price' }`. */
export function parseTarget(to: string): { alias: string; field: string } {
  const dot = to.indexOf('.');
  if (dot < 1 || dot === to.length - 1) {
    throw new Error(`A form field maps to "alias.field", got "${to}"`);
  }
  return { alias: to.slice(0, dot), field: to.slice(dot + 1) };
}

/** The catalog field a form field maps onto. */
export function targetField(
  field: RecipeFormField,
  records: readonly RecipeFormRecord[],
  models: ModelLookup,
): CatalogField {
  const { alias, field: name } = parseTarget(field.to);
  const record = records.find((r) => r.as === alias);
  if (!record)
    throw new Error(`Form field ${field.id} maps to unknown ${alias}`);
  const found = models(record.model).fields.find((f) => f.name === name);
  if (!found) {
    throw new Error(
      `${record.model} has no field ${name} (form field ${field.id})`,
    );
  }
  return found;
}

/** The starting value of a field on a new row. */
export function startingValue(
  field: RecipeFormField,
  catalogField: CatalogField,
): unknown {
  if (field.default !== undefined) return field.default;
  if (catalogField.default !== undefined) return catalogField.default;
  return catalogField.type === 'text' ? '' : null;
}

/** Context values (`alias.field`) from the form's field values. */
export function contextFrom(
  fields: readonly RecipeFormField[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f.to, values[f.id]]));
}

const sameValue = (a: unknown, b: unknown) => a === b;

/**
 * Rows a form's records currently point at: walk them in order, finding each
 * by its (literal or `{ref}`) `match`. `seeded` rows (the one being edited)
 * are taken as given. A record whose match cannot be resolved has no row.
 */
export async function findRows(
  source: DataSource,
  records: readonly RecipeFormRecord[],
  seeded: Record<string, ModelRecord | undefined>,
  models: ModelLookup,
): Promise<Record<string, ModelRecord | undefined>> {
  const rows: Record<string, ModelRecord | undefined> = { ...seeded };
  for (const record of records) {
    if (record.as in rows) continue;
    if (!record.match) {
      rows[record.as] = undefined;
      continue;
    }
    const wanted: Record<string, unknown> = {};
    let resolvable = true;
    for (const [key, value] of Object.entries(record.match)) {
      if (value !== null && typeof value === 'object') {
        const target = rows[value.ref];
        if (!target) resolvable = false;
        wanted[key] = target?.id;
      } else {
        wanted[key] = value;
      }
    }
    rows[record.as] = resolvable
      ? (await source.list(models(record.model))).find((row) =>
          Object.entries(wanted).every(([k, v]) => sameValue(row[k], v)),
        )
      : undefined;
  }
  return rows;
}
