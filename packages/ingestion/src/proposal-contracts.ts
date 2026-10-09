import type { DecisionClient } from '@happyvertical/smrt-core';
import type { HandlerContext } from './execution-contracts.js';
import type { IntakeValues } from './execution-dto.js';
import type { EvidenceLocation, ProviderIdentity } from './extraction-types.js';
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
  /** Authenticated human correction carried through fresh extraction; never model authority. */
  humanCorrection?: IntakeValues;
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
  }>;
}
export interface ProposalConfiguration {
  version: string;
  promptVersion: string;
  generator: ProposalGenerator;
  /** Absent means the normal unconfigured decision path, never fake probability. */
  decision?: { client: DecisionClient; identity: ProviderIdentity };
  minimumDecisionProbability?: number;
  tieMargin?: number;
  limits: GenerationLimits;
}
export interface GenerationStageConfiguration extends IntakeValues {
  stage: 'interpret';
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
  };
}
