/**
 * @happyvertical/smrt-playbooks
 *
 * Code-first playbooks — named, described, layered step sequences an agent
 * follows — with config, app-level, tenant-level, and runtime overrides.
 *
 * A playbook resolves to a plan the agent executes step by step. Nothing in
 * this package executes a step, so a playbook is never an authority boundary:
 * every step is authorized independently at the REST boundary or, server-side,
 * by `PrincipalRun.assertToolAllowed()`.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

export { clearPlaybookCache, getPlaybookCacheTtlMs } from './cache.js';
export { PlaybookOverrideCollection } from './collections/PlaybookOverrideCollection.js';
export {
  PlaybookOverride,
  type PlaybookOverrideOptions,
} from './models/PlaybookOverride.js';
export { definePlaybook, PlaybookRegistry } from './playbook-registry.js';
export { resolvePlaybook } from './playbook-resolver.js';
// Preflight (#2590) — advisory prediction, never a grant.
export {
  createBrowserStepEvaluator,
  createServerStepEvaluator,
  PLAYBOOK_PREFLIGHT_UNAVAILABLE,
  preflightPlan,
  preflightPlaybook,
  worstVerdict,
} from './preflight.js';
export {
  clearPlaybookPreflightCache,
  getPlaybookPreflightCacheTtlMs,
} from './preflight-cache.js';
export type {
  BrowserPreflightLayerSource,
  BrowserPreflightOptions,
  PlaybookPreflightAvailableReport,
  PlaybookPreflightReport,
  PlaybookPreflightRequest,
  PlaybookPreflightUnavailableReport,
  PreflightLayer,
  PreflightLayerReport,
  PreflightReason,
  PreflightStepEvaluation,
  PreflightStepEvaluator,
  PreflightStepReport,
  PreflightSummary,
  PreflightVerdict,
  ServerPreflightOptions,
} from './preflight-types.js';
export {
  type BrowserPreflightProviderOptions,
  createBrowserPlaybookPreflight,
  createRestPreflightLayerSource,
} from './rest-preflight.js';
export type {
  PlaybookAcceptance,
  PlaybookCacheValue,
  PlaybookConfigOverrideInput,
  PlaybookDefinition,
  PlaybookDefinitionInput,
  PlaybookEditableConfig,
  PlaybookFailurePolicy,
  PlaybookIntentRecord,
  PlaybookIntentResolver,
  PlaybookIntentStep,
  PlaybookLayer,
  PlaybookMetadata,
  PlaybookOperationClassifier,
  PlaybookOperationStep,
  PlaybookPackageConfig,
  PlaybookPlan,
  PlaybookPlane,
  PlaybookPlanStep,
  PlaybookRejection,
  PlaybookRejectionReason,
  PlaybookResolution,
  PlaybookStep,
  ResolvePlaybookOptions,
} from './types.js';
export { PLAYBOOK_PLANES } from './types.js';
export {
  FAIL_CLOSED_CLASSIFICATION,
  normalizeEditableConfig,
} from './utils.js';

/** @internal */
export const PACKAGE_VERSION_INITIALIZED = true;
