/**
 * Manifest-as-definition-registry helpers.
 *
 * Field policy is validated and seeded from the LIVE `ObjectRegistry` (never
 * from checked-in `manifest.json` artifacts): the registry is the runtime
 * source of truth for which objects/fields exist, their types, their security
 * flags, and their `_meta.ui` presentation hints (#2046).
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  DISPLAY_LABEL_FIELD,
  displayLabelFieldProblem,
  resolveDisplayLabelProjection,
} from '@happyvertical/smrt-core/ui-metadata';
import {
  getFieldReadPermission,
  isSensitiveField,
  isTransientField,
} from './policy.js';

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
  const fields = new Map(await ObjectRegistry.getAllFields(objectRef));
  const projection = resolveDisplayLabelProjection(
    ObjectRegistry.getConfig(objectRef).display?.label,
  );
  if (!projection) return fields;
  const edge = fields.get(projection.via);
  if (
    !edge ||
    !['foreignKey', 'crossPackageRef'].includes(edge.type) ||
    isSensitiveField(edge) ||
    isTransientField(edge) ||
    getFieldReadPermission(edge)
  ) {
    throw new Error(
      `Invalid display label reference ${objectRef}.${projection.via}`,
    );
  }
  if (
    [...fields.keys()].some(
      (name) => name === DISPLAY_LABEL_FIELD || name === 'display_label',
    )
  ) {
    throw new Error('displayLabel is reserved for the projected label.');
  }
  const target = ObjectRegistry.resolveRelationshipTarget(
    objectRef,
    projection.via,
  );
  if (!target)
    throw new Error(
      `Unresolved display label target ${objectRef}.${projection.via}`,
    );
  await ObjectRegistry.ensureManifestLoaded(target);
  const targetFields = await ObjectRegistry.getAllFields(target);
  const problem = displayLabelFieldProblem(
    Object.fromEntries(targetFields),
    projection.field,
  );
  const targetField = targetFields.get(projection.field);
  if (problem || !targetField?.type || getFieldReadPermission(targetField)) {
    throw new Error(
      `Invalid display label target ${target}.${projection.field}: ${problem ?? 'missing type or permission-gated field'}`,
    );
  }
  fields.set(DISPLAY_LABEL_FIELD, {
    type: 'text',
    readonly: true,
    ui: { basic: true },
  });
  return fields;
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
