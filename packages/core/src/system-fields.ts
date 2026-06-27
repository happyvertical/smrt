/**
 * Canonical SMRT system fields inherited from `SmrtObject`.
 *
 * These fields exist on every persistent object at runtime even when they are
 * not declared in a child class manifest. Keep this definition lightweight:
 * presence matters for metadata consumers, while schema generation still owns
 * the exact SQL defaults and constraints for these columns.
 */

import type { FieldDefinition } from './scanner/types.js';

export const SMRT_SYSTEM_FIELDS: Readonly<Record<string, FieldDefinition>> =
  Object.freeze({
    id: Object.freeze({
      type: 'text',
      _meta: Object.freeze({ __smrtSystemField: true }),
    }),
    slug: Object.freeze({
      type: 'text',
      _meta: Object.freeze({ __smrtSystemField: true }),
    }),
    context: Object.freeze({
      type: 'text',
      _meta: Object.freeze({ __smrtSystemField: true }),
    }),
    created_at: Object.freeze({
      type: 'datetime',
      _meta: Object.freeze({ __smrtSystemField: true }),
    }),
    updated_at: Object.freeze({
      type: 'datetime',
      _meta: Object.freeze({ __smrtSystemField: true }),
    }),
  });

export function isInjectedSmrtSystemField(field: unknown): boolean {
  const meta = (field as { _meta?: { __smrtSystemField?: unknown } } | null)
    ?._meta;
  return Boolean(meta?.__smrtSystemField);
}

export function cloneSmrtSystemFields(): Record<string, FieldDefinition> {
  const fields: Record<string, FieldDefinition> = {};

  for (const [fieldName, fieldDef] of Object.entries(SMRT_SYSTEM_FIELDS)) {
    fields[fieldName] = {
      ...fieldDef,
      _meta: { ...(fieldDef._meta || {}) },
    };
  }

  return fields;
}

export function prependSmrtSystemFields<T extends FieldDefinition>(
  fields: Map<string, T>,
): Map<string, T> {
  const merged = new Map<string, T>();

  // The cloned system fields are plain `FieldDefinition`s. `T` is a
  // `FieldDefinition` superset that only adds optional members (e.g. the
  // registry's `RegisteredField`), so a freshly-cloned system field is a
  // structurally-valid `T` at runtime; the downcast records that. Keeping the
  // signature generic preserves the caller's richer element type instead of
  // widening every returned field back to the base `FieldDefinition`.
  for (const [fieldName, fieldDef] of Object.entries(cloneSmrtSystemFields())) {
    merged.set(fieldName, fieldDef as T);
  }

  for (const [fieldName, fieldDef] of fields.entries()) {
    if (isInjectedSmrtSystemField(fieldDef) && merged.has(fieldName)) {
      continue;
    }
    merged.set(fieldName, fieldDef);
  }

  return merged;
}
