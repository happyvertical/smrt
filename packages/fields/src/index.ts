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
  FieldPolicySuggestionCollection,
  FieldPolicySuggestionConflictError,
} from './collections/FieldPolicySuggestionCollection.js';
export {
  decodeHistogramKey,
  FieldUsageCounterCollection,
  isHistogramEligibleField,
  MAX_USAGE_REPORT_ENTRIES,
  serializeHistogramSample,
} from './collections/FieldUsageCounterCollection.js';
export {
  applyFieldPolicyToDataSurface,
  type FieldPolicyDataSurfaceOptions,
  policyToDataSurfaceDescriptor,
} from './data-surface.js';
export {
  assertDefaultValueMatchesFieldType,
  buildCodeSeedDelta,
  buildCodeSeedVisibility,
  type FieldDefinitionMap,
  getCodeDefault,
  getCodeSeedGroup,
  getFieldReadPermission,
  getObjectFieldMap,
  isPolicyAddressableField,
  isRequiredField,
  isSensitiveField,
  isStorableReferenceId,
  isTransientField,
  isUsableRequiredDefault,
  type RegisteredFieldInfo,
  requireRegisteredObject,
  sanitizeFieldUIHints,
} from './field-definitions.js';
export {
  resolveFieldPolicy,
  resolveFieldPolicyExplained,
  resolveSurvivingTenantChainIds,
} from './field-policy-resolver.js';
export { FieldPolicy } from './models/FieldPolicy.js';
export {
  ACTIVE_SUGGESTION_KEY,
  FieldPolicySuggestion,
} from './models/FieldPolicySuggestion.js';
export {
  FieldUsageCounter,
  fieldUsagePeriodForDate,
  MAX_DISTINCT_USERS_PER_BUCKET,
  MAX_VALUE_HISTOGRAM_BUCKETS,
} from './models/FieldUsageCounter.js';
export {
  ensureFieldPolicyPermissionsRegistered,
  FIELD_POLICY_PERMISSION_DEFINITIONS,
  MANAGE_FIELD_POLICY_PERMISSION,
  PERSONALIZE_FIELD_POLICY_PERMISSION,
} from './permissions.js';
export {
  type BuildFieldPolicySettingsCatalogOptions,
  buildFieldPolicySettingsCatalog,
  type FieldPolicyCatalogField,
  type FieldPolicyCatalogObjectSummary,
  type FieldPolicyDetailItem,
  type FieldPolicySettingsCatalogData,
  type FieldPolicySettingsCatalogPage,
  type FieldPolicySettingsCatalogQuery,
  type FieldPolicySummaryItem,
  fieldPolicyCatalogItemId,
  parseFieldPolicyCatalogQuery,
} from './settings-catalog.js';
export {
  type AcceptFieldPolicySuggestionResult,
  APP_FIELD_POLICY_SCOPE_KEY,
  type DismissFieldPolicySuggestionResult,
  type ExplainedObjectFieldPolicy,
  FIELD_POLICY_SCOPE_TYPES,
  FIELD_POLICY_VISIBILITIES,
  type FieldPolicyAuditRow,
  type FieldPolicyAuditSnapshot,
  type FieldPolicyBatchResult,
  type FieldPolicyDelta,
  type FieldPolicyDriftReason,
  type FieldPolicyDriftRow,
  type FieldPolicyEditorCapabilities,
  type FieldPolicyEditorRow,
  type FieldPolicyEditorState,
  type FieldPolicyEditorStateDenied,
  type FieldPolicyEditorStateResult,
  type FieldPolicyLayerContribution,
  type FieldPolicyOptions,
  type FieldPolicyScopeType,
  type FieldPolicySuggestionData,
  type FieldPolicySuggestionKind,
  type FieldPolicySuggestionStatus,
  type FieldPolicyTenantHierarchyLoader,
  type FieldPolicyTenantHierarchyProvider,
  type FieldPolicyTenantNode,
  type FieldPolicyUsersModule,
  type FieldPolicyUsersTenantRecord,
  type FieldPolicyVisibility,
  type FieldUsageReportEntry,
  type FieldUsageReportResult,
  type PendingFieldPolicySuggestionsResult,
  type ResolvedFieldPolicy,
  type ResolvedObjectFieldPolicy,
  type ResolveFieldPolicyOptions,
} from './types.js';
export {
  FieldUsageLearningAgent,
  pruneFieldPolicySuggestions,
  pruneFieldUsageCounters,
  runFieldPolicySuggestionGeneration,
  runFieldUsageMaintenance,
} from './usage-learning.js';
export {
  ensureFieldUsageLearningSchedules,
  FIELD_USAGE_LEARNING_AGENT_TYPE,
} from './usage-schedules.js';

// Contribute the field-policy capabilities to the shared runtime catalog on
// import, so normal role seeding and every server gate recognize the slugs.
ensureFieldPolicyPermissionsRegistered();
