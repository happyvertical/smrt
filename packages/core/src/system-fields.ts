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

export function prependSmrtSystemFields(
  fields: Map<string, FieldDefinition>,
): Map<string, FieldDefinition> {
  const merged = new Map<string, FieldDefinition>();

  for (const [fieldName, fieldDef] of Object.entries(cloneSmrtSystemFields())) {
    merged.set(fieldName, fieldDef);
  }

  for (const [fieldName, fieldDef] of fields.entries()) {
    if (isInjectedSmrtSystemField(fieldDef) && merged.has(fieldName)) {
      continue;
    }
    merged.set(fieldName, fieldDef);
  }

  return merged;
}
