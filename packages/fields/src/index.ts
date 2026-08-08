/**
 * @happyvertical/smrt-fields
 *
 * Layered field policy store and resolver for SMRT objects (epic #2045):
 * per-field defaults, visibility tiers, help text, labels, ordering, and org
 * locks, personalized at app, tenant, and user scope over the code seed.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

import { ensureFieldPolicyPermissionsRegistered } from './permissions.js';

export {
  clearFieldPolicyCache,
  getFieldPolicyCacheTtlMs,
  invalidateFieldPolicyCache,
} from './cache.js';
export { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';
export {
  assertDefaultValueMatchesFieldType,
  buildCodeSeedDelta,
  buildCodeSeedVisibility,
  type FieldDefinitionMap,
  getCodeDefault,
  getCodeSeedGroup,
  getFieldReadPermission,
  getObjectFieldMap,
  isRequiredField,
  isSensitiveField,
  isTransientField,
  isUsableRequiredDefault,
  type RegisteredFieldInfo,
  requireRegisteredObject,
  sanitizeFieldUIHints,
} from './field-definitions.js';
export {
  resolveFieldPolicy,
  resolveFieldPolicyExplained,
} from './field-policy-resolver.js';
export { FieldPolicy } from './models/FieldPolicy.js';
export {
  ensureFieldPolicyPermissionsRegistered,
  FIELD_POLICY_PERMISSION_DEFINITIONS,
  MANAGE_FIELD_POLICY_PERMISSION,
  PERSONALIZE_FIELD_POLICY_PERMISSION,
} from './permissions.js';
export {
  APP_FIELD_POLICY_SCOPE_KEY,
  type ExplainedObjectFieldPolicy,
  FIELD_POLICY_SCOPE_TYPES,
  FIELD_POLICY_VISIBILITIES,
  type FieldPolicyBatchResult,
  type FieldPolicyDelta,
  type FieldPolicyEditorCapabilities,
  type FieldPolicyEditorRow,
  type FieldPolicyEditorState,
  type FieldPolicyEditorStateDenied,
  type FieldPolicyEditorStateResult,
  type FieldPolicyLayerContribution,
  type FieldPolicyOptions,
  type FieldPolicyScopeType,
  type FieldPolicyTenantHierarchyLoader,
  type FieldPolicyTenantHierarchyProvider,
  type FieldPolicyTenantNode,
  type FieldPolicyUsersModule,
  type FieldPolicyUsersTenantRecord,
  type FieldPolicyVisibility,
  type ResolvedFieldPolicy,
  type ResolvedObjectFieldPolicy,
  type ResolveFieldPolicyOptions,
} from './types.js';

// Contribute the field-policy capabilities to the shared runtime catalog on
// import, so normal role seeding and every server gate recognize the slugs.
ensureFieldPolicyPermissionsRegistered();
