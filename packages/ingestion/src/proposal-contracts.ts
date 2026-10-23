import type { DecisionClient } from '@happyvertical/smrt-core';
import type { HandlerContext } from './execution-contracts.js';
import type { IntakeValues } from './execution-dto.js';
import {
  type EvidenceLocation,
  type ProviderIdentity,
  providerIdentity,
} from './extraction-types.js';
import type {
  ProposalCandidate,
  ProposalCatalogEntry,
  ProposalReferenceField,
} from './proposal-dto.js';

/** Optional discovery capability on the existing application execution handler. */
export interface HandlerDiscovery {
  mediaTypes: readonly string[];
  /** Every existing-record argument exposed to generation must be declared here. */
  references: Readonly<Record<string, ProposalReferenceField>>;
  /** Database reads only; filter in the query before ranking/summarizing. */
  candidates?(
    query: string,
    context: HandlerContext,
    page: { limit: number },
  ): Promise<{
    items: Array<Omit<ProposalCandidate, 'key'>>;
    hasMore: boolean;
  }>;
}
export interface GenerationLimits {
  maxHandlers: number;
  maxCandidates: number;
  maxSuggestions: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxQueryLength: number;
  timeoutMs: number;
}
export interface GenerativeProposalInput {
  evidence: Array<{
    evidenceId: string;
    partId: string;
    parentEvidenceId: string | null;
    mediaType: string;
    contentHash: string;
    segments: Array<{ text: string; location: EvidenceLocation }>;
  }>;
  offered: Array<{
    handler: ProposalCatalogEntry;
    candidates: ProposalCandidate[];
  }>;
  instructions: string;
  /** Bounded, currently eligible examples; neither evidence nor authority. */
  examples?: import('./feedback-dto.js').FeedbackSelection;
  /** Authenticated human correction carried through fresh extraction; never model authority. */
  humanCorrection?: IntakeValues;
  /** Authenticated reviewer guidance; trusted steering only, never catalog or approval authority. */
  reviewerInstruction?: { id: string; text: string };
}
/** Inject only trusted SDK-bound adapters. Generative output is always untrusted. */
export interface ProposalGenerator {
  identity: ProviderIdentity;
  generate(
    input: GenerativeProposalInput,
    options: { signal: AbortSignal; maxOutputBytes: number },
  ): Promise<{
    output: unknown;
    completion: 'complete' | 'unknown';
    usage?: Record<string, number>;
    /** Provider-reported immutable model revision, when it safely resolves a configured alias. */
    responseModel?: string;
  }>;
}
/**
 * How validated decision answers affect readiness. `gate` (default) sends a
 * suggestion to `needs_review` when the thresholds are not met; `record` still
 * runs and persists the same answers but leaves outcome/disposition to the
 * validator. Neither mode makes any action automation-eligible.
 */
export type DecisionReadiness = 'gate' | 'record';
/** Public decision settings shared by generation and read configuration. */
export interface DecisionSettings {
  minimumDecisionProbability?: number;
  tieMargin?: number;
  /**
   * Per-request token window forwarded to the decision client as `maxLen`
   * (the SDK Laya provider option). Absent keeps the client/checkpoint default.
   */
  decisionMaxLen?: number;
  decisionReadiness?: DecisionReadiness;
}
export interface ProposalConfiguration extends DecisionSettings {
  version: string;
  promptVersion: string;
  generator: ProposalGenerator;
  /** Absent means the normal unconfigured decision path, never fake probability. */
  decision?: { client: DecisionClient; identity: ProviderIdentity };
  limits: GenerationLimits;
}
/** Credential-free configuration for validating persisted proposal snapshots. */
export interface ProposalReadConfiguration extends DecisionSettings {
  version: string;
  promptVersion: string;
  generator: ProviderIdentity;
  decision?: ProviderIdentity;
  limits: GenerationLimits;
}
/** Remove generation capability while preserving the public persisted configuration. */
export function proposalReadConfiguration(
  config: ProposalConfiguration | ProposalReadConfiguration,
): ProposalReadConfiguration {
  const generator = providerIdentity(
    'identity' in config.generator
      ? config.generator.identity
      : config.generator,
  );
  return {
    version: config.version,
    promptVersion: config.promptVersion,
    generator,
    ...(config.decision
      ? {
          decision: providerIdentity(
            'identity' in config.decision
              ? config.decision.identity
              : config.decision,
          ),
        }
      : {}),
    ...(config.minimumDecisionProbability === undefined
      ? {}
      : { minimumDecisionProbability: config.minimumDecisionProbability }),
    ...(config.tieMargin === undefined ? {} : { tieMargin: config.tieMargin }),
    ...(config.decisionMaxLen === undefined
      ? {}
      : { decisionMaxLen: config.decisionMaxLen }),
    ...(config.decisionReadiness === undefined
      ? {}
      : { decisionReadiness: config.decisionReadiness }),
    limits: {
      maxHandlers: config.limits.maxHandlers,
      maxCandidates: config.limits.maxCandidates,
      maxSuggestions: config.limits.maxSuggestions,
      maxInputBytes: config.limits.maxInputBytes,
      maxOutputBytes: config.limits.maxOutputBytes,
      maxQueryLength: config.limits.maxQueryLength,
      timeoutMs: config.limits.timeoutMs,
    },
  };
}
export interface GenerationStageConfiguration extends IntakeValues {
  stage: 'interpret';
  /** Copied from the pinned extraction source; verified against it before provider disclosure. */
  reviewerInstruction?: IntakeValues;
  proposals: {
    source: import('./proposal-dto.js').GenerationSourcePin;
    configurationVersion: string;
    promptVersion: string;
    catalogDigest: string;
    generator: ProviderIdentity;
    decision: ProviderIdentity | null;
    limits: GenerationLimits;
    minimumDecisionProbability: number;
    tieMargin: number;
    /** Present only when configured, so default digests stay stable. */
    decisionMaxLen?: number;
    /** Present only for `record`; `gate` is the default. */
    decisionReadiness?: 'record';
  };
}
