/**
 * @happyvertical/smrt-features
 *
 * Code-first feature flags for the SMRT framework.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

export { FeatureDefinition } from './feature-definition.js';
export { FeatureDefinitionCollection } from './feature-definitions.js';
export {
  FEATURE_GRANT_SOURCE_SLOT_KEY,
  getFeatureGrantSource,
  setFeatureGrantSource,
} from './feature-grants.js';
export { FeatureOverride } from './feature-override.js';
export {
  FeatureOverrideAuthorizationError,
  type FeatureOverrideAuthorizer,
  FeatureOverrideService,
  type FeatureOverrideWriteRequest,
} from './feature-override-service.js';
export { FeatureOverrideCollection } from './feature-overrides.js';
export { FeatureResolver } from './feature-resolver.js';
export {
  type FeatureSettingsRow,
  FeatureSettingsService,
  type FeatureSettingsServiceOptions,
  featureOverrideEffectFromValue,
  InvalidFeatureScopeError,
  type ListFeatureSettingsOptions,
  type SetFeatureOverrideRequest,
  UnknownFeatureKeyError,
} from './feature-settings.js';
export { FeatureSyncService } from './feature-sync.js';
export {
  defineFrameworkFeature,
  type FrameworkFeatureDefinition,
  getFrameworkFeature,
  isFrameworkFeatureKey,
  listFrameworkFeatures,
} from './framework-features.js';
export {
  KillSwitchService,
  type KillSwitchState,
  readKillSwitch,
  setKillSwitch,
} from './kill-switch.js';
export {
  checkFeature,
  FEATURE_DISABLED_CODE,
  FEATURE_GATE_STATUS,
  FEATURE_UPGRADE_REQUIRED_CODE,
  type FeatureDisabled,
  type FeatureGateDenial,
  type FeatureGateOptions,
  type FeatureGateResult,
  FeatureUnavailableError,
  type FeatureUpgradeRequired,
  featureDenialResponse,
  featureGateResponse,
  requireFeature,
} from './require-feature.js';
export {
  FEATURE_BACKUP_VAULT,
  FEATURE_CLOUD_HOSTED,
  FEATURE_INFERENCE_HOSTED,
  FEATURE_PLUGINS_REMOTE,
  FEATURE_SYNC_DEVICES,
  STANDARD_FEATURE_KEYS,
  STANDARD_FEATURES,
  type StandardFeatureKey,
} from './standard-features.js';

export {
  type FeatureDecisionLayer,
  type FeatureDefinitionOptions,
  type FeatureDefinitionSeed,
  type FeatureGrantingPlan,
  type FeatureGrantSnapshot,
  type FeatureGrantSource,
  type FeatureMetadata,
  FeatureOverrideEffect,
  type FeatureOverrideOptions,
  type FeatureResolution,
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
