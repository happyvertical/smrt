/** Validation of portable app model declarations. No registry, database or host dependencies. */
import type { CookbookModels } from '@happyvertical/smrt-types';
import { toSnakeCase } from '../utils/naming.js';

export const CUSTOM_FIELD_TYPES = [
  'text',
  'longText',
  'integer',
  'decimal',
  'money',
  'date',
  'datetime',
  'boolean',
  'choice',
  'reference',
] as const;
const RESERVED = new Set(
  '__proto__ prototype constructor id slug context tenantId displayLabel createdAt updatedAt metaType metaData _meta_type _meta_data abstract arguments await boolean break byte case catch char class const continue debugger default delete do double else enum eval export extends false final finally float for function goto if implements import in instanceof int interface let long native new null package private protected public return short static super switch synchronized this throw throws transient true try typeof var void volatile while with yield save initialize toJSON toPublicJSON then select from to where table column group order insert update values join limit offset drop alter create index primary foreign key references'.split(
    ' ',
  ),
);
export const CUSTOM_MODEL_NAME = '^[A-Z][A-Za-z0-9]{0,63}$';
export const CUSTOM_FIELD_NAME = '^[a-z][A-Za-z0-9]{0,63}$';
export const CUSTOM_PACKAGE_NAME = '^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$';
export const CUSTOM_MODEL_REF =
  '^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*:[A-Z][A-Za-z0-9]*$';
export function isCustomIdentifier(
  value: unknown,
  model = false,
): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(model ? CUSTOM_MODEL_NAME : CUSTOM_FIELD_NAME).test(value) &&
    !RESERVED.has(value)
  );
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Paths are relative to the cookbook, suitable for validateCookbook diagnostics. */
export function validateCookbookModels(
  input: unknown,
): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];
  const bad = (path: string, message: string) => errors.push({ path, message });
  if (!record(input))
    return [{ path: 'models', message: 'models must be an object' }];
  if (input.version !== 1)
    bad('models.version', 'Unsupported models version (expected 1)');
  if (
    typeof input.packageName !== 'string' ||
    !new RegExp(CUSTOM_PACKAGE_NAME).test(input.packageName)
  )
    bad(
      'models.packageName',
      'models.packageName must be a scoped app package',
    );
  for (const key of Object.keys(input))
    if (!['version', 'packageName', 'lists', 'fields'].includes(key))
      bad(`models.${key}`, 'Unknown models property');
  const checkFields = (value: unknown, path: string) => {
    if (!record(value)) {
      bad(path, 'fields must be an object');
      return;
    }
    const columns = new Set<string>();
    for (const [name, field] of Object.entries(value)) {
      const at = `${path}.${name}`;
      if (!isCustomIdentifier(name))
        bad(
          at,
          'Unsafe or reserved field name; choose a descriptive name such as sortOrder, groupName, fromDate or toDate (unquoted SDK columns, sdk#1513)',
        );
      const column = toSnakeCase(name);
      if (columns.has(column)) bad(at, 'Field storage name collision');
      columns.add(column);
      if (
        !record(field) ||
        !(CUSTOM_FIELD_TYPES as readonly unknown[]).includes(field.type)
      ) {
        bad(at, 'Unknown field type');
        continue;
      }
      const allowed = [
        'type',
        ...(field.type === 'money'
          ? ['currency']
          : field.type === 'choice'
            ? ['choices']
            : field.type === 'reference'
              ? ['target']
              : []),
      ];
      for (const key of Object.keys(field))
        if (!allowed.includes(key))
          bad(
            `${at}.${key}`,
            'Unknown field property (labels and visibility belong in policies)',
          );
      if (field.type === 'money') {
        if (
          typeof field.currency !== 'string' ||
          !/^[A-Z]{3}$/.test(field.currency)
        )
          bad(`${at}.currency`, 'Money requires a three-letter currency code');
        if (Object.hasOwn(value, `${name}Currency`))
          bad(at, 'Money currency companion collides with another field');
      }
      if (
        field.type === 'choice' &&
        (!Array.isArray(field.choices) ||
          !field.choices.length ||
          field.choices.length > 100 ||
          field.choices.some(
            (v) => typeof v !== 'string' || !v || v.length > 200,
          ) ||
          new Set(field.choices).size !== field.choices.length)
      )
        bad(`${at}.choices`, 'Choice requires 1–100 distinct non-empty values');
      if (
        field.type === 'reference' &&
        (typeof field.target !== 'string' ||
          !(
            new RegExp(CUSTOM_MODEL_REF).test(field.target) ||
            isCustomIdentifier(field.target, true)
          ))
      )
        bad(
          `${at}.target`,
          'Reference requires a qualified model or custom list name',
        );
    }
  };
  if (!record(input.lists))
    bad('models.lists', 'models.lists must be an object');
  else
    for (const [name, list] of Object.entries(input.lists)) {
      const at = `models.lists.${name}`;
      if (!isCustomIdentifier(name, true))
        bad(at, 'Unsafe or reserved model name');
      if (!record(list)) {
        bad(at, 'List must be an object');
        continue;
      }
      for (const key of Object.keys(list))
        if (!['label', 'icon', 'displayField', 'fields'].includes(key))
          bad(`${at}.${key}`, 'Unknown list property');
      if (
        typeof list.label !== 'string' ||
        !list.label.trim() ||
        list.label.length > 200
      )
        bad(`${at}.label`, 'List label must contain 1–200 characters');
      if (
        typeof list.icon !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(list.icon)
      )
        bad(`${at}.icon`, 'Invalid icon name');
      checkFields(list.fields, `${at}.fields`);
      if (
        typeof list.displayField !== 'string' ||
        !record(list.fields) ||
        !record(list.fields[list.displayField]) ||
        ['reference'].includes(
          String(
            (list.fields[list.displayField] as Record<string, unknown>)?.type,
          ),
        )
      )
        bad(
          `${at}.displayField`,
          'Display field must name an own scalar field',
        );
    }
  if (!record(input.fields))
    bad('models.fields', 'models.fields must be an object');
  else
    for (const [name, fields] of Object.entries(input.fields)) {
      if (!new RegExp(CUSTOM_MODEL_REF).test(name))
        bad(
          `models.fields.${name}`,
          'Override requires a qualified model identity',
        );
      checkFields(fields, `models.fields.${name}`);
    }
  return errors;
}

/** Extend the existing engine catalog so policies/navigation see custom declarations. */
export function cookbookModelCatalog<
  T extends {
    models: readonly {
      id: string;
      name: string;
      packageId: string;
      fields?: readonly { name: string }[];
      exposed?: boolean;
    }[];
  },
>(catalog: T, models?: CookbookModels): T {
  if (!models) return catalog;
  const next = new Map(
    catalog.models.map((m) => [
      m.id,
      { ...m, fields: m.fields ? [...m.fields] : undefined },
    ]),
  );
  for (const [name, list] of Object.entries(models.lists))
    next.set(`${models.packageName}:${name}`, {
      id: `${models.packageName}:${name}`,
      name,
      packageId: models.packageName.split('/')[1].replace(/^smrt-/, ''),
      exposed: true,
      fields: Object.entries(list.fields).flatMap(([name, field]) => [
        { name },
        ...(field.type === 'money' ? [{ name: `${name}Currency` }] : []),
      ]),
    });
  for (const [id, fields] of Object.entries(models.fields)) {
    const model = next.get(id);
    if (model?.fields)
      model.fields.push(
        ...Object.entries(fields)
          .flatMap(([name, field]) => [
            name,
            ...(field.type === 'money' ? [`${name}Currency`] : []),
          ])
          .filter((name) => !model.fields!.some((f) => f.name === name))
          .map((name) => ({ name })),
      );
  }
  return { ...catalog, models: [...next.values()] };
}
