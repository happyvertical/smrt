/**
 * @happyvertical/smrt-features
 *
 * Code-first feature flags for the SMRT framework.
 *
 * @packageDocumentation
 */

export { FeatureDefinition } from './feature-definition.js';
export { FeatureDefinitionCollection } from './feature-definitions.js';
export { FeatureOverride } from './feature-override.js';
export { FeatureOverrideCollection } from './feature-overrides.js';
export { FeatureResolver } from './feature-resolver.js';
export { FeatureSyncService } from './feature-sync.js';

export {
  type FeatureDefinitionOptions,
  type FeatureDefinitionSeed,
  type FeatureMetadata,
  FeatureOverrideEffect,
  type FeatureOverrideOptions,
  type FeatureResolutionContext,
  type FeatureResolverOptions,
  type FeatureScopeType,
  type FeatureSyncResult,
  type FeatureTenantHierarchyLoader,
  type FeatureTenantHierarchyProvider,
  type FeatureTenantNode,
  type FeatureUsersModule,
  GLOBAL_FEATURE_SCOPE_ID,
  type SyncDefinitionsOptions,
  type SyncManifestOptions,
} from './types.js';

export {
  createFeatureKey,
  findFeatureDefaultInRegistry,
  parseFeatureKey,
  resolveFeatureKeyForTarget,
} from './utils.js';
