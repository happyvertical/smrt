/**
 * @happyvertical/smrt-inference — inference binding behavior for SMRT tiers
 * (#4749). This entry is browser-safe; `./node` holds the doctor and
 * `./resolver` the per-user / per-tenant resolver over smrt-secrets (#4756).
 *
 * Importing it registers the executor (alias chains and fusions) and the
 * validating resolver into core's seam (`setInferenceExecutor()` /
 * `setInferenceResolver()`).
 */
import { registerInference } from './register.js';

export {
  classifyInferenceFailure,
  isInferenceAbort,
} from './classify.js';
export {
  CHAIN_KINDS,
  type ChainStep,
  candidateLabel,
  candidateToStep,
  EXECUTOR_KINDS,
  expandTarget,
  FUSION_GATE_CONTINUE,
  FUSION_SEAT_COUNTS,
  findFusionDefinitionIssues,
  findFusionPromptIssues,
  findInferenceConfigIssues,
  hasInferenceChains,
  validateInferenceConfig,
} from './config.js';
export {
  InferenceConfigError,
  InferenceExhaustedError,
  InferenceFusionError,
} from './errors.js';
export {
  type ChainExecutorOptions,
  createChainClient,
} from './executor.js';
export {
  clearFusions,
  createChainExecutor,
  createFusionClient,
  type DefineFusionInput,
  defineFusion,
  type FusionCallOptions,
  type FusionGateResult,
  type FusionPromptResolver,
  type FusionRunResult,
  type FusionSeatPrompt,
  type FusionSeatResult,
  type FusionSeatStatus,
  type FusionSeatUsage,
  getFusion,
  listFusions,
  runFusion,
  setFusionPromptResolver,
} from './fusion.js';
export {
  INFERENCE_PROVIDER_CONFIG_SECRET_TYPE,
  INFERENCE_PROVIDER_CONFIG_SOURCES,
  INFERENCE_PROVIDER_PARAM_KEYS,
  type InferenceProviderBinding,
  type InferenceProviderConfig,
  InferenceProviderConfigError,
  type InferenceProviderConfigSource,
  inferenceProviderBindingFor,
  inferenceProviderConfigSecretName,
  inferenceProviderSource,
  inferenceProviderTargets,
  parseInferenceProviderConfig,
  type RedactedInferenceProviderBinding,
  type RedactedInferenceProviderConfig,
  redactInferenceProviderConfig,
  redactInferenceTarget,
} from './provider-config.js';
export {
  createInferenceResolver,
  isInferenceRegistered,
  type RegisterInferenceOptions,
  registerInference,
} from './register.js';
export {
  INFERENCE_FAILURE_CLASSES,
  type InferenceConfigIssue,
  type InferenceFailureClass,
  type InferenceSubstitution,
  type InferenceSubstitutionReason,
} from './types.js';

registerInference();
