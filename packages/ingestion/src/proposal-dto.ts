/** Browser-safe proposal messages. No callbacks or authority-bearing context. */
import type { CapabilityDeclaration } from '@happyvertical/smrt-types';
import type { AnalysisOutput, IntakeEvidenceDTO } from './dto.js';
import type {
  IntakeValues,
  PlanReview,
  ProposalReview,
} from './execution-dto.js';
import type { EvidenceLocation, ProviderIdentity } from './extraction-types.js';

export interface GenerationSourcePin {
  attemptId: string;
  revision: number;
  inputDigest: string;
  outputDigest: string;
  evidenceDigest: string;
}
export interface CompletedAnalysisSnapshot extends GenerationSourcePin {
  itemId: string;
  configuration: IntakeValues;
  evidence: IntakeEvidenceDTO[];
  result: AnalysisOutput;
}
export interface ProposalCandidate {
  key: string;
  model: string;
  id: string;
  revision: string;
  label: string;
}
export interface CandidatePage {
  items: ProposalCandidate[];
  truncated: boolean;
}
export type ProposalReferenceField =
  | { kind: 'candidate'; model: string }
  | { kind: 'evidence' };
export interface ProposalCatalogEntry {
  id: string;
  version: string;
  description: string;
  kind: 'operation' | 'plan';
  /** A plan has no invented aggregate classification; its ordered definition is pinned. */
  capability: CapabilityDeclaration | null;
  argsSchema: IntakeValues;
  references: Record<string, ProposalReferenceField>;
  operation:
    | { model: string; action: string; version: string }
    | { playbookKey: string; definitionHash: string };
}
export interface ProposalEvidenceReference {
  evidenceId: string;
  location: EvidenceLocation;
}
export interface GeneratedSuggestion {
  handlerId: string;
  handlerVersion: string;
  args: IntakeValues;
  evidence: ProposalEvidenceReference[];
  alternatives: string[];
  missingFields: string[];
  explanation: string;
  disposition: 'ready_for_review' | 'needs_review';
}
/**
 * Value-free record that the validator replaced model-declared `missingFields`
 * with the schema's computed set (#4284): counts only, never field names.
 */
export interface MissingFieldsCorrection {
  /** Suggestions whose declaration was replaced. */
  suggestions: number;
  /** Missing fields the model did not declare. */
  added: number;
  /** Declared fields that were not actually missing. */
  removed: number;
}
export interface GenerationOutput {
  version: 1;
  outcome:
    | 'proposals'
    | 'unknown'
    | 'ambiguous'
    | 'no_action'
    | 'needs_review'
    | 'provider_error';
  suggestions: GeneratedSuggestion[];
  splits: Array<{ evidenceId: string; groups: number[][]; digest: string }>;
  warnings: string[];
  omittedSuggestions: number;
  source: GenerationSourcePin;
  offered: Array<{
    handler: ProposalCatalogEntry;
    candidates: ProposalCandidate[];
  }>;
  provenance: {
    feedback?: {
      query: string;
      selection: import('./feedback-dto.js').FeedbackReferences;
    };
    /** Identity of the reviewer instruction the model was guided by. */
    reviewerInstruction?: { id: string; digest: string };
    configurationVersion: string;
    promptVersion: string;
    catalogDigest: string;
    policyVersions: string[];
    generative: ProviderIdentity;
    /** Canonical provider revision for the configured generative alias. */
    generativeResponseModel?: string;
    decision: {
      configured: boolean;
      provider?: string;
      model?: string;
      version?: string;
      /** Whether the recorded answers were allowed to withhold readiness. */
      readiness?: 'gate' | 'record';
      /** Per-request token window forwarded to the client, when configured. */
      maxLen?: number;
      answers?: IntakeValues;
      usage?: Record<string, number>;
    };
    usage: Record<string, number>;
    /**
     * Repeated `alternatives`/`missingFields` entries dropped from the
     * generator output before validation (#4286); absent when none were.
     */
    duplicatesRemoved?: number;
    /**
     * Split proposals dropped because they failed a fixed check, named here
     * (#4288); never page numbers or evidence ids. Absent when none were.
     */
    splitsDropped?: { count: number; checks: string[] };
    /**
     * Bounded, value-free reason for a failed stage, next to its warning
     * category: JSON paths, schema keywords and constants, never document text.
     */
    failure?: { category: string; reason: string };
    /** Present only when a declaration was corrected; absent output is unchanged. */
    missingFieldsCorrection?: MissingFieldsCorrection;
  };
  automaticActionEligible: false;
}
export interface PreviewGeneratedInput {
  itemId: string;
  attemptId: string;
  /** Explicit stable business intentions supplied by the host, never the model. */
  selections: Array<{
    index: number;
    intentionKey: string;
    expectedRevision: number;
    requestId: string;
  }>;
}
export type GeneratedPreview =
  | { kind: 'operation'; review: ProposalReview }
  | { kind: 'plan'; review: PlanReview };

/** Persisted interpretation payload under CompletedAnalysisSnapshot.result.output. */
export interface GenerationAnalysisOutput {
  proposals: GenerationOutput;
}
/** What a failed-attempt capture holds (#4285). */
export type FailedAttemptCaptureSource =
  /** The provider's reply text, refused by the SDK adapter (e.g. invalid JSON). */
  | 'raw_response'
  /** The generator's parsed output that failed validation or a limit, as JSON. */
  | 'generated_output';
export type FailedAttemptCaptureStatus = 'captured' | 'redaction_failed';
/**
 * Opt-in diagnostic capture of a failed interpretation attempt. It contains
 * document-derived model output: read it only through the reviewer-authorized
 * `getFailedAttemptCapture`, and never put it in lists, logs or telemetry.
 */
export interface FailedAttemptCapture {
  itemId: string;
  attemptId: string;
  source: FailedAttemptCaptureSource;
  /** `redaction_failed`: the host hook failed, so no text was stored. */
  status: FailedAttemptCaptureStatus;
  /** Redacted, bounded text; present only when `status` is `captured`. */
  text?: string;
  /** The text was cut at `maxBytes` (or at the generation output bound). */
  truncated: boolean;
  /** A host redaction hook was configured for this capture. */
  redacted: boolean;
  maxBytes: number;
  capturedAt: string;
}
