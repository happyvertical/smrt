/**
 * Manifest-as-definition-registry helpers.
 *
 * Field policy is validated and seeded from the LIVE `ObjectRegistry` (never
 * from checked-in `manifest.json` artifacts): the registry is the runtime
 * source of truth for which objects/fields exist, their types, their security
 * flags, and their `_meta.ui` presentation hints (#2046).
 */

import type { FieldUIHints } from '@happyvertical/smrt-core';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { FieldPolicyDelta, FieldPolicyVisibility } from './types.js';

/**
 * Field map for one object, keyed by field name (includes inherited fields).
 * Derived structurally from the PUBLIC `ObjectRegistry.getAllFields` return
 * type — core does not export its internal `RegisteredField` name.
 */
export type FieldDefinitionMap = Awaited<
  ReturnType<typeof ObjectRegistry.getAllFields>
>;

/** One field's registered metadata, as returned by `getAllFields`. */
export type RegisteredFieldInfo =
  FieldDefinitionMap extends Map<string, infer F> ? F : never;

/**
 * Resolve `objectRef` (qualified `@package/name:ClassName`) against the live
 * registry, throwing a descriptive error when the class is unknown.
 */
export function requireRegisteredObject(objectRef: string): void {
  if (!objectRef || !objectRef.includes(':')) {
    throw new Error(
      `Field policy objectRef must be a qualified class name ` +
        `("@package/name:ClassName"), got "${objectRef}"`,
    );
  }
  if (!ObjectRegistry.getClassByQualifiedName(objectRef)) {
    throw new Error(
      `Unknown field policy objectRef "${objectRef}": no class with that ` +
        `qualified name is registered`,
    );
  }
}

/** Load the full (inherited) field map for a registered objectRef. */
export async function getObjectFieldMap(
  objectRef: string,
): Promise<FieldDefinitionMap> {
  requireRegisteredObject(objectRef);
  return ObjectRegistry.getAllFields(objectRef);
}

/**
 * Narrow a manifest `_meta.ui` bag to the known {@link FieldUIHints} keys with
 * their expected primitive types, dropping junk (mirrors the sanitization the
 * web emission applies in core's `web-collections.ts`).
 */
export function sanitizeFieldUIHints(value: unknown): FieldUIHints | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const ui: FieldUIHints = {
    ...(typeof raw.basic === 'boolean' ? { basic: raw.basic } : {}),
    ...(typeof raw.group === 'string' ? { group: raw.group } : {}),
    ...(typeof raw.order === 'number' && Number.isFinite(raw.order)
      ? { order: raw.order }
      : {}),
    ...(typeof raw.locked === 'boolean' ? { locked: raw.locked } : {}),
  };
  return Object.keys(ui).length > 0 ? ui : undefined;
}

/** Security rail: `sensitive` may live top-level or under `_meta` (STI merges). */
export function isSensitiveField(field: RegisteredFieldInfo): boolean {
  return field.sensitive === true || field._meta?.sensitive === true;
}

/** Security rail: `readPermission` may live top-level or under `_meta`. */
export function getFieldReadPermission(
  field: RegisteredFieldInfo,
): string | undefined {
  if (typeof field.readPermission === 'string') {
    return field.readPermission;
  }
  const metaPermission = field._meta?.readPermission;
  return typeof metaPermission === 'string' ? metaPermission : undefined;
}

export function isTransientField(field: RegisteredFieldInfo): boolean {
  return field.transient === true || field._meta?.transient === true;
}

/** A field is required when flagged required and not explicitly nullable. */
export function isRequiredField(field: RegisteredFieldInfo): boolean {
  if (field._meta?.nullable === true) {
    return false;
  }
  return field.required === true || field._meta?.required === true;
}

/** The manifest/code default for a field, boxed; `undefined` when none. */
export function getCodeDefault(
  field: RegisteredFieldInfo,
): { value: unknown } | undefined {
  if (field.default !== undefined) {
    return { value: field.default };
  }
  if (field._meta?.default !== undefined) {
    return { value: field._meta.default };
  }
  return undefined;
}

/**
 * A resolved default satisfies the required-field invariant only when it is a
 * value a form could actually submit: explicit `null` and the empty string do
 * not count (a required text field "defaulting" to `''` is still unfilled).
 */
export function isUsableRequiredDefault(
  defaultBox: { value: unknown } | undefined,
): boolean {
  if (!defaultBox) {
    return false;
  }
  return defaultBox.value !== null && defaultBox.value !== '';
}

/**
 * Compute the code-seed visibility for every field of an object using the
 * cold-start rule (#2046): with no `ui.basic` markers anywhere on the object,
 * every field is `basic`; once any field is marked `basic: true`, unmarked
 * fields default to `advanced` (and an explicit `basic: false` is always
 * `advanced`).
 */
export function buildCodeSeedVisibility(
  fields: FieldDefinitionMap,
): Map<string, FieldPolicyVisibility> {
  let hasBasicMarkers = false;
  const hints = new Map<string, FieldUIHints | undefined>();
  for (const [name, field] of fields) {
    const ui = sanitizeFieldUIHints(field._meta?.ui);
    hints.set(name, ui);
    if (ui?.basic === true) {
      hasBasicMarkers = true;
    }
  }

  const visibility = new Map<string, FieldPolicyVisibility>();
  for (const [name] of fields) {
    const ui = hints.get(name);
    if (ui?.basic === true) {
      visibility.set(name, 'basic');
    } else if (ui?.basic === false || hasBasicMarkers) {
      visibility.set(name, 'advanced');
    } else {
      visibility.set(name, 'basic');
    }
  }
  return visibility;
}

/** Code-seed delta for one field (visibility supplied by the cold-start pass). */
export function buildCodeSeedDelta(
  field: RegisteredFieldInfo,
  visibility: FieldPolicyVisibility,
): FieldPolicyDelta {
  const ui = sanitizeFieldUIHints(field._meta?.ui);
  const help =
    typeof field.description === 'string'
      ? field.description
      : typeof field._meta?.description === 'string'
        ? field._meta.description
        : undefined;
  const codeDefault = getCodeDefault(field);

  return {
    ...(codeDefault ? { default: codeDefault } : {}),
    visibility,
    ...(help !== undefined ? { help } : {}),
    ...(ui?.order !== undefined ? { order: ui.order } : {}),
    ...(ui?.locked === true ? { locked: true } : {}),
  };
}

/** Code-seed grouping key (`ui.group`) — not overridable by stored rows. */
export function getCodeSeedGroup(field: RegisteredFieldInfo): string | null {
  return sanitizeFieldUIHints(field._meta?.ui)?.group ?? null;
}

/**
 * Type-check a parsed default value against the manifest field type.
 *
 * Explicit `null` is allowed only for optional fields (a required field with a
 * null default has no usable default). Unsupported field types reject defaults
 * outright (fail closed).
 */
export function assertDefaultValueMatchesFieldType(
  objectRef: string,
  fieldName: string,
  field: RegisteredFieldInfo,
  value: unknown,
): void {
  const label = `Field policy default for "${objectRef}.${fieldName}"`;

  if (value === null) {
    if (isRequiredField(field)) {
      throw new Error(
        `${label} may not be null: the field is required, so a null default ` +
          `is never a usable default`,
      );
    }
    return;
  }

  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') {
        throw new Error(`${label} must be a string (field type "text")`);
      }
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${label} must be an integer (field type "integer")`);
      }
      return;
    case 'decimal':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `${label} must be a finite number (field type "decimal")`,
        );
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(`${label} must be a boolean (field type "boolean")`);
      }
      return;
    case 'datetime':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new Error(
          `${label} must be a date-parseable string (field type "datetime")`,
        );
      }
      return;
    case 'json':
      // Any JSON value (it already survived JSON.parse).
      return;
    case 'foreignKey':
    case 'crossPackageRef':
      if (typeof value !== 'string') {
        throw new Error(
          `${label} must be a string id (field type "${field.type}")`,
        );
      }
      return;
    default:
      throw new Error(
        `${label} is not supported: defaults cannot target ` +
          `"${String(field.type)}" fields`,
      );
  }
}
