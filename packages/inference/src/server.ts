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
  AGENT_TOKEN_TTL_SECONDS,
  type AgentCredentials,
  type McpTokenStoreLike,
  tokenCredentials,
} from './agent-cli/credentials.js';
// Local engine adapters (Node-only).
export {
  type AgentCliLocation,
  type AgentCliStatus,
  cliEnv,
  detectAgentCli,
  detectAgentClis,
  locateCli,
  preflightAgentCli,
} from './agent-cli/detect.js';
export {
  childEnv,
  nodeDir,
} from './agent-cli/env.js';
export {
  candidateDirs,
  defaultLocateDeps,
  type LocateDeps,
  locateBinary,
} from './agent-cli/locate.js';
export {
  AgentLogin,
  LOGIN_TIMEOUT_MS,
  type LoginSnapshot,
  type LoginState,
} from './agent-cli/login.js';
export {
  type CollectResult,
  killTree,
  type RunOptions,
  type RunResult,
  runCollect,
  runProcess,
} from './agent-cli/runner.js';
export { createAgentCliService } from './agent-cli/service.js';
export {
  type AgentRunSpec,
  assertLoopbackUrl,
  buildAgentRun,
  type SpecInput,
  TOKEN_ENV,
} from './agent-cli/session.js';
export {
  type AgentEvent,
  claudeParser,
  codexParser,
  MCP_SERVER_NAME,
  shellToolName,
} from './agent-cli/stream.js';
export {
  AGENT_TOOL_INFO,
  AGENT_TOOLS,
  type AgentTool,
  type AgentToolInfo,
  isAgentTool,
} from './agent-cli/tools.js';
export {
  type AgentEngineDeps,
  type AgentTurnEvent,
  type AgentTurnHost,
  type AgentTurnLimits,
  type AgentTurnMessage,
  type AgentTurnOptions,
  type AgentTurnStop,
  DEFAULT_AGENT_LIMITS,
  reportAgentFailure,
  runAgentTurn,
  tokenFailureMessage,
} from './agent-cli/turn.js';
export {
  CHATGPT_AUTH_HOST,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_SIGN_IN_WINDOW_MS,
  type ChatGPTPlanConnection,
  type ChatGPTPlanConnectionOptions,
  type ChatGPTPlanModel,
  type ChatGPTPlanModelLister,
  type ChatGPTPlanStatus,
  type ChatGPTSessionStore,
  ChatGPTSignedOutError,
  type ChatGPTSignInErrorCode,
  type ChatGPTTokenSource,
  createChatGPTPlanConnection,
  isChatGPTAuthorizationUrl,
} from './chatgpt/connection.js';
export {
  type ChatGPTModelOptions,
  createChatGPTModel,
} from './chatgpt/model.js';
export {
  type ChatGPTPlanFailureKind,
  type ChatGPTPlanResolverOptions,
  classifyChatGPTPlanFailure,
  createChatGPTPlanResolver,
} from './chatgpt/resolver.js';
export {
  browserCommand,
  type ChatGPTFailureNote,
  chatgptFailureNote,
  openSystemBrowser,
  type SpawnLike,
} from './chatgpt/support.js';
export * from './design-run.js';
export * from './design-run-store.js';
export {
  type EngineModel,
  EngineModelFailure,
  type EngineModelReply,
  type EngineModelRequest,
  type EngineModelToolCall,
  engineModelReply,
} from './engine-model.js';
export {
  chatgptEngineStatus,
  cliEngineStatus,
  cliTool,
  engineLabel,
  type InferenceEngineAction,
  type InferenceEngineId,
  type InferenceEngineStatus,
  type InferenceEngineStatusHost,
  inferenceEngineStatus,
} from './engine-status.js';
export * from './models/DesignRunRecord.js';
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
  createInferenceSettingsController,
  type InferenceControllerSession,
  type InferenceSettingsController,
  type InferenceSettingsControllerOptions,
  type InferenceSettingsOutcome,
  type InferenceSettingsPageData,
} from './settings/controller.js';
export {
  createInferenceSettingsHost,
  type InferenceSettingsHost,
  type InferenceSettingsHostOptions,
  type InferenceSettingsSession,
  inferenceSettingsFailure,
} from './settings/host.js';
export {
  type InferenceKeyPayload,
  inferenceKeyIsSet,
  saveInferenceKey,
} from './settings/key-store.js';
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
export * from './work-profiles.js';
