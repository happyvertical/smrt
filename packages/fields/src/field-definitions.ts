/**
 * Manifest-as-definition-registry helpers.
 *
 * Field policy is validated and seeded from the LIVE `ObjectRegistry` (never
 * from checked-in `manifest.json` artifacts): the registry is the runtime
 * source of truth for which objects/fields exist, their types, their security
 * flags, and their `_meta.ui` presentation hints (#2046).
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

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
  if (!objectRef?.includes(':')) {
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

export {
  assertDefaultValueMatchesFieldType,
  buildCodeSeedDelta,
  buildCodeSeedVisibility,
  getCodeDefault,
  getCodeSeedGroup,
  getFieldReadPermission,
  isPolicyAddressableField,
  isRequiredField,
  isSensitiveField,
  isStorableReferenceId,
  isTransientField,
  isUsableRequiredDefault,
  sanitizeFieldUIHints,
} from './policy.js';
