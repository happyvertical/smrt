/**
 * @happyvertical/smrt-inference/server — server half of the inference
 * settings screen (#4754). Node-only (it reuses the `./node` doctor and the
 * AI SDK provider list).
 *
 * - `InferenceSettingsService`: rows for `InferenceSettingsPanel`, writes
 *   through the authorizer-gated `InferenceOverrideService`, test
 *   connection, doctor, usage, local discovery and provider options.
 * - `createInferenceOverrideResolver()`: applies stored bindings at call time.
 * - The origin-bound key rule (`bindInferenceKey`, `inferenceKeyFor`); keys
 *   are stored by the host through smrt-secrets, never here.
 * - The smrt-preferences kind `inference` for user choices.
 */
import './__smrt-register__.js';

export {
  APP_INFERENCE_SCOPE_ID,
  InferenceOverride,
  type InferenceOverrideOptions,
} from './models/InferenceOverride.js';
export {
  InferenceOverrideCollection,
  type InferenceOverrideScopeType,
} from './models/InferenceOverrideCollection.js';
export {
  bindInferenceKey,
  InferenceKeyOriginError,
  type InferenceKeyRecord,
  inferenceKeyFor,
  inferenceKeyOrigin,
  inferenceProviderConfigFromKey,
  REDACTED_KEY,
  redactInferenceSecret,
} from './settings/keys.js';
export {
  buildInferenceOverrideLayers,
  type InferenceOverrideLayers,
  type InferenceOverrideRows,
  type InferenceSettingsConfig,
  loadInferenceOverrideLayers,
  mergeSettingsConfigs,
  readInferenceOverrideRows,
} from './settings/layers.js';
export {
  assertValidInferenceScope,
  InferenceOverrideAuthorizationError,
  type InferenceOverrideAuthorizer,
  InferenceOverrideService,
  type InferenceOverrideServiceOptions,
  type InferenceOverrideWriteRequest,
  InferenceTenantTargetNotAllowedError,
  type InferenceTenantTargetPolicy,
  type InferenceTenantTargetRequest,
  InvalidInferenceScopeError,
} from './settings/override-service.js';
export {
  CUSTOMIZE_INFERENCE_PERMISSION,
  createInferencePreferences,
  INFERENCE_PERMISSION_DEFINITIONS,
  INFERENCE_PREFERENCE_KIND,
  INFERENCE_PREFERENCE_SURFACE,
  type InferencePreferenceIssue,
  type InferencePreferenceRead,
  type InferencePreferenceStoreLike,
  type InferencePreferences,
  type InferencePreferencesApi,
  inferencePreferenceKind,
  PERSONALIZE_INFERENCE_PERMISSION,
  validateInferencePreferences,
} from './settings/preferences.js';
export {
  createInferenceOverrideResolver,
  type InferenceOverrideResolverOptions,
} from './settings/resolver.js';
export {
  type InferenceAliasSetting,
  InferenceBindingInUseError,
  type InferenceConnectionInput,
  type InferenceConnectionResult,
  type InferenceDefaultTierSetting,
  type InferenceFusionSetting,
  type InferenceProviderOption,
  InferenceSettingsConfigError,
  type InferenceSettingsLevel,
  InferenceSettingsService,
  type InferenceSettingsServiceOptions,
  type InferenceTierSettingsRow,
  type InferenceTranscriptSettings,
  type InferenceUsageReportDimension,
  type RegisteredFusionLike,
} from './settings/settings-service.js';
export {
  DEFAULT_TIER_BINDING,
  describeInferenceTarget,
  INFERENCE_MODES,
  type InferenceBindingId,
  InferenceBindingValueError,
  type InferenceMode,
  type InferenceTranscriptSettingsValue,
  inferenceTargetRef,
  isAllowedByList,
  matchesAllowPattern,
  normalizeTranscriptSettings,
  parseInferenceBinding,
  stripKeyMembers,
  TRANSCRIPTS_BINDING,
  tierBinding,
} from './settings/targets.js';
export {
  applyStoredTranscriptSettings,
  loadInferenceTranscriptSettings,
  storedTranscriptSettings,
} from './settings/transcripts.js';
