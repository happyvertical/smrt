import { generatedExpression } from '../generated-fields.js';
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
  key:
    | 'required'
    | 'default'
    | 'description'
    | 'min'
    | 'max'
    | 'minLength'
    | 'maxLength',
) {
  if (hasOwnDefinedValue(existingField, key)) {
    return existingField[key];
  }

  if (hasOwnDefinedValue(existingField?._meta, key)) {
    return existingField._meta?.[key];
  }

  return undefined;
}

/**
 * Read a schema-shaping field attribute from either placement.
 *
 * `required`, `default`, and `description` are written at the top level by
 * manifest field definitions but are normalized into `_meta` by
 * {@link createFieldFromManifest} / {@link mergeManifestField}. Any consumer
 * that shapes a column from a field must therefore check both placements, or
 * it silently drops NOT NULL and DEFAULT for every registry-sourced field
 * (issue #2372). Top level wins so an explicit manifest value overrides the
 * normalized copy.
 */
export function readFieldAttribute(
  fieldDef: ManifestFieldInput,
  key:
    | 'required'
    | 'default'
    | 'description'
    | 'min'
    | 'max'
    | 'minLength'
    | 'maxLength',
) {
  if (hasOwnDefinedValue(fieldDef, key)) {
    return fieldDef[key];
  }

  if (hasOwnDefinedValue(fieldDef?._meta, key)) {
    return fieldDef._meta?.[key];
  }

  return undefined;
}

const readManifestFieldMeta = readFieldAttribute;

/**
 * Allowed values of an enum- or literal-union-typed field (#3598). Manifest
 * fields carry them top-level; registry-sourced fields mirror them into
 * `_meta` (see {@link createFieldFromManifest}). Read both, top level first.
 */
export function readFieldEnum(
  field: ManifestFieldInput | undefined,
): ReadonlyArray<string | number> | undefined {
  const value = field?.enum ?? field?._meta?.enum;
  return Array.isArray(value) && value.length > 0
    ? (value as ReadonlyArray<string | number>)
    : undefined;
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

/**
 * Field policy attributes a definition may state at the top level.
 *
 * `sensitive` and `readPermission` decide who reads a value, `readonly` who
 * writes it, and `transient` whether it has a column. Consumers read each from
 * `_meta`, so every registration path copies them there, whatever else the
 * model declares. A build-time manifest states them in both places already; a
 * run-time definition (`registerRuntimeModel()`) states them only at the top
 * level, and would otherwise register a field without its policy.
 */
const FIELD_POLICY_ATTRIBUTES = [
  'sensitive',
  'readonly',
  'readPermission',
  'transient',
] as const;

function assignFieldPolicy(
  target: Record<string, unknown>,
  fieldDef: ManifestFieldInput,
): void {
  for (const key of FIELD_POLICY_ATTRIBUTES) {
    const value = fieldDef[key] ?? fieldDef._meta?.[key];
    if (value !== undefined) target[key] = value;
  }
}

/**
 * @param _generatedModel - Kept for existing callers. It once limited the
 *   policy attributes to models with a generated field; they are always
 *   copied now.
 */
export function createFieldFromManifest(
  fieldDef: ManifestFieldInput,
  _generatedModel = false,
): RegisteredField {
  const meta: FieldMeta = {};

  assignDefinedMeta(meta, fieldDef?._meta);

  // Write through the open `FieldMeta` index signature: assigning the same
  // loop value to a union of named keys (`default` is `unknown`, the others
  // narrower) collapses the write target to `undefined`, so route by string.
  const metaRecord = meta as Record<string, unknown>;
  for (const key of [
    'required',
    'default',
    'description',
    'min',
    'max',
    'minLength',
    'maxLength',
  ] as const) {
    const value = readManifestFieldMeta(fieldDef, key);
    if (value !== undefined) {
      metaRecord[key] = value;
    }
  }

  if (fieldDef.enum !== undefined) {
    metaRecord.enum = [...fieldDef.enum];
  }

  const generated = generatedExpression(fieldDef);
  if (generated !== undefined) metaRecord.generated = generated;
  assignFieldPolicy(metaRecord, fieldDef);

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

/**
 * @param _generatedModel - Kept for existing callers; see
 *   {@link createFieldFromManifest}.
 */
export function mergeManifestField(
  existingField: RegisteredField,
  fieldDef: ManifestFieldInput,
  _generatedModel = false,
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
  for (const key of [
    'required',
    'default',
    'description',
    'min',
    'max',
    'minLength',
    'maxLength',
  ] as const) {
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

  if (fieldDef.enum !== undefined) {
    nextMetaRecord.enum = [...fieldDef.enum];
  }

  const generated = generatedExpression(fieldDef);
  if (generated !== undefined) nextMetaRecord.generated = generated;
  assignFieldPolicy(nextMetaRecord, fieldDef);
  return {
    ...existingField,
    ...(generated !== undefined ? { generated } : {}),
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
