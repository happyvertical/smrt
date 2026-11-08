/**
 * @happyvertical/smrt-inference — inference binding behavior for SMRT tiers
 * (#4749). This entry is browser-safe; `./node` holds the doctor and
 * `./resolver` the per-user / per-tenant resolver over smrt-secrets (#4756).
 *
 * Importing it registers the chain executor and the validating resolver
 * into core's seam (`setInferenceExecutor()` / `setInferenceResolver()`).
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
  expandTarget,
  findInferenceConfigIssues,
  hasInferenceChains,
  validateInferenceConfig,
} from './config.js';
export { InferenceConfigError, InferenceExhaustedError } from './errors.js';
export {
  type ChainExecutorOptions,
  createChainClient,
  createChainExecutor,
} from './executor.js';
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
