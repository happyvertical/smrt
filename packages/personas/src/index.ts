/**
 * @happyvertical/smrt-personas
 *
 * Tenant-owned, context-scoped agent personas and their resolution. Layers over
 * `@happyvertical/smrt-agents`' `TenantAgent` availability/ceiling gate to
 * decide how an agent should behave for a given tenant and context.
 *
 * Also home to the persona **learning & adaptation loop** (#1889): feedback
 * signals feed confidence-scored reinforcement, a scheduled reflection runner
 * consolidates episodes + feedback into pending directive proposals, and a
 * permission-gated approval service (the `personas.activate-directive` split)
 * activates an approved rewrite as a tenant/persona-scoped prompt override.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

import { ensurePersonaPermissionsRegistered } from './directive-principal.js';

export {
  AgentPersona,
  AgentPersonaCollection,
  canonicalAgentClass,
  personaAppliesToContext,
  personaContextRank,
} from './agent-persona.js';
export {
  DirectiveActivationDeniedError,
  type DirectiveApprovalResult,
  DirectiveApprovalService,
  type DirectiveApprovalServiceOptions,
  DirectiveNotPendingError,
  type DirectiveRejectionResult,
  type ProposalRef,
} from './directive-approval.js';
export {
  ACTIVATE_DIRECTIVE_PERMISSION,
  DIRECTIVE_ACTIVATION_PERMISSION_DEF,
  type DirectivePrincipal,
  ensurePersonaPermissionsRegistered,
  principalFromPermissions,
  registerPersonaPermissions,
  resolveDirectivePrincipal,
} from './directive-principal.js';
export {
  computeDirectiveFingerprint,
  type DirectiveEvidence,
  DirectiveProposal,
  DirectiveProposalCollection,
  type DirectiveProposalStatus,
} from './directive-proposal.js';
export {
  Feedback,
  FeedbackCollection,
  type FeedbackOutcomeOptions,
  type FeedbackSignalType,
  type FeedbackSource,
  feedbackSourceFor,
  HUMAN_SIGNAL_TYPES,
} from './feedback.js';
export {
  type PersonaMemoryLike,
  personaLearningMemory,
  personaMemoryScope,
  reinforceFromFeedback,
} from './persona-memory.js';
export {
  applyPersonaInstructions,
  ensurePersonaInstructionsPrompt,
  type PersonaLike,
  personaInstructionsPromptKey,
  resolvePersonaInstructions,
  upsertPromptTemplateOverride,
} from './persona-prompt.js';
export {
  availabilityFromResolvedAgent,
  type ManifestPersonaDefaults,
  type PersonaAvailabilityGate,
  type PersonaContext,
  PersonaResolver,
  type ResolvedPersona,
  type ResolvePersonaOptions,
} from './persona-resolver.js';
export {
  type DirectiveDraft,
  type DirectiveReflector,
  type ReflectionInput,
  type ReflectionPersona,
  type ReflectionPersonaInput,
  ReflectionRunner,
  type ReflectionRunnerOptions,
  type ReflectionRunOptions,
  type ReflectionRunResult,
} from './reflection-runner.js';

// Contribute the persona directive-activation permission to the runtime catalog
// on import, so any consumer of this package sees the gate's slug.
ensurePersonaPermissionsRegistered();
