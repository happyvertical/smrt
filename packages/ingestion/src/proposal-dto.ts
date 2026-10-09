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
    configurationVersion: string;
    promptVersion: string;
    catalogDigest: string;
    policyVersions: string[];
    generative: ProviderIdentity;
    decision: {
      configured: boolean;
      provider?: string;
      model?: string;
      version?: string;
      answers?: IntakeValues;
      usage?: Record<string, number>;
    };
    usage: Record<string, number>;
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
