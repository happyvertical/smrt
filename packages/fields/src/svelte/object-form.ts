/** Pure selection and ordering helpers used by ObjectForm and non-DOM tests. */
import type { ResolvedObjectFieldPolicy } from '../types.js';
import type { ObjectFormField, ObjectFormFieldDefinition } from './types.js';

const SYSTEM_FIELD_NAMES = new Set([
  'id',
  'tenantId',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
]);

const FORMABLE_WIRE_TYPES = new Set([
  'text',
  'integer',
  'decimal',
  'boolean',
  'datetime',
  'json',
  'foreignKey',
  'crossPackageRef',
]);

/** Safe web definition × resolved policy intersection, ordered deterministically. */
export function resolveObjectFormFields(
  webFields: Readonly<Record<string, ObjectFormFieldDefinition>>,
  resolvedPolicy: ResolvedObjectFieldPolicy,
): ObjectFormField[] {
  return Object.entries(webFields)
    .filter(
      ([name, definition]) =>
        !SYSTEM_FIELD_NAMES.has(name) &&
        !name.startsWith('_smrt_') &&
        FORMABLE_WIRE_TYPES.has(definition.type) &&
        resolvedPolicy.fields[name] !== undefined,
    )
    .map(([name, definition]) => {
      const policyField = resolvedPolicy.fields[name];
      return {
        name,
        definition,
        group: policyField.group ?? definition.ui?.group ?? null,
        order: policyField.order ?? definition.ui?.order ?? null,
      };
    })
    .sort(
      (left, right) =>
        (left.order ?? Number.MAX_SAFE_INTEGER) -
          (right.order ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name),
    );
}
