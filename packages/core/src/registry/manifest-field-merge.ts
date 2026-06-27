import type { FieldDefinition, FieldMeta } from '../scanner/types.js';
import type { RegisteredField } from './types';

/**
 * Manifest-sourced field input handled by the merge helpers.
 *
 * Manifest fields are plain {@link FieldDefinition}s. Already-registered
 * runtime fields are the canonical {@link RegisteredField} superset, which
 * extends `FieldDefinition`, so a `FieldDefinition` parameter accepts both
 * shapes as the incoming `fieldDef`. The helpers return the canonical
 * {@link RegisteredField} so merged fields stay assignable back into the
 * `Map<string, RegisteredField>` they came from.
 */
type ManifestFieldInput = FieldDefinition;

function hasOwnDefinedValue(source: object | undefined, key: string): boolean {
  return (
    !!source &&
    Object.hasOwn(source, key) &&
    (source as Record<string, unknown>)[key] !== undefined
  );
}

function readExistingFieldMeta(
  existingField: RegisteredField,
  key: 'required' | 'default' | 'description',
) {
  if (hasOwnDefinedValue(existingField, key)) {
    return existingField[key];
  }

  if (hasOwnDefinedValue(existingField?._meta, key)) {
    return existingField._meta?.[key];
  }

  return undefined;
}

function readManifestFieldMeta(
  fieldDef: ManifestFieldInput,
  key: 'required' | 'default' | 'description',
) {
  if (hasOwnDefinedValue(fieldDef, key)) {
    return fieldDef[key];
  }

  if (hasOwnDefinedValue(fieldDef?._meta, key)) {
    return fieldDef._meta?.[key];
  }

  return undefined;
}

function assignDefinedMeta(
  target: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
) {
  if (!source) {
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
}

export function createFieldFromManifest(
  fieldDef: ManifestFieldInput,
): RegisteredField {
  const meta: FieldMeta = {};

  assignDefinedMeta(meta, fieldDef?._meta);

  // Write through the open `FieldMeta` index signature: assigning the same
  // loop value to a union of named keys (`default` is `unknown`, the others
  // narrower) collapses the write target to `undefined`, so route by string.
  const metaRecord = meta as Record<string, unknown>;
  for (const key of ['required', 'default', 'description'] as const) {
    const value = readManifestFieldMeta(fieldDef, key);
    if (value !== undefined) {
      metaRecord[key] = value;
    }
  }

  // Preserve top-level `related` for relationship-graph lookups
  // (foreignKey / crossPackageRef / oneToMany / manyToMany all rely on it).
  const out: RegisteredField = {
    type: fieldDef.type,
    _meta: meta,
  };
  if (fieldDef.related !== undefined) {
    out.related = fieldDef.related;
  }
  return out;
}

export function mergeManifestField(
  existingField: RegisteredField,
  fieldDef: ManifestFieldInput,
): RegisteredField {
  const hasTenancyMarker =
    existingField.__tenancy?.isTenantIdField ||
    existingField._meta?.__tenancy?.isTenantIdField;

  const nextMeta: FieldMeta = {
    ...(existingField._meta || {}),
  };

  assignDefinedMeta(nextMeta, fieldDef?._meta);

  // See createFieldFromManifest: route writes through the index signature so a
  // shared loop value isn't narrowed to the `undefined`-only union write target.
  const nextMetaRecord = nextMeta as Record<string, unknown>;
  for (const key of ['required', 'default', 'description'] as const) {
    const manifestValue = readManifestFieldMeta(fieldDef, key);
    if (manifestValue !== undefined) {
      nextMetaRecord[key] = manifestValue;
      continue;
    }

    const existingValue = readExistingFieldMeta(existingField, key);
    if (existingValue !== undefined && nextMetaRecord[key] === undefined) {
      nextMetaRecord[key] = existingValue;
    }
  }

  return {
    ...existingField,
    type:
      !hasTenancyMarker && fieldDef.type ? fieldDef.type : existingField.type,
    _meta: nextMeta,
  };
}

export function manifestFieldDiffers(
  existingField: RegisteredField,
  fieldDef: ManifestFieldInput,
): boolean {
  const mergedField = mergeManifestField(existingField, fieldDef);

  return (
    mergedField.type !== existingField.type ||
    JSON.stringify(mergedField._meta || {}) !==
      JSON.stringify(existingField._meta || {})
  );
}
