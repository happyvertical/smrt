export type {
  ActionResult,
  ExecutionCeiling,
  IntakeValues,
  PlanReview,
  PreviewPlanInput,
  PreviewProposalInput,
  ProposalReview,
  ResultReference,
  ReviewInput,
} from './execution-dto.js';

/** Safe receipt outcome; storage locations and worker errors are never returned. */
export type ReceiptResult =
  | { kind: 'accepted' | 'duplicate'; itemId: string; receiptVersion: number }
  | { kind: 'retry'; category: 'busy' | 'unavailable' }
  | {
      kind: 'rejected';
      category: 'conflict' | 'expired' | 'invalid' | 'limit';
    };

/** Authorized item projection. */
export interface IntakeItemDTO {
  id: string;
  receiptState: string;
  processingState: string;
  analysisRevision: number;
  cancelled: boolean;
  traceId: string;
}

/** Authorized evidence metadata; bytes are served by the service separately. */
export interface IntakeEvidenceDTO {
  id: string;
  partId: string;
  parentEvidenceId: string | null;
  mediaType: string;
  contentHash: string;
  byteLength: number;
  /**
   * Original name supplied by the source (upload, attachment, folder), with
   * control, bidi and zero-width characters removed. Still untrusted text:
   * render it as text, never as markup or a path.
   */
  filename?: string;
}

/** Explicit resource limits captured with each receipt. */
export interface IntakeLimits {
  maxBytes: number;
  maxParts: number;
  maxAttempts: number;
  leaseMs: number;
  maxOutputBytes: number;
}

/** Categorized provider/stage failure; raw exception text is never persisted. */
export type IntakeFailure =
  | 'unsupported_type'
  | 'malformed_output'
  | 'limit'
  | 'timeout'
  | 'unavailable'
  | 'authentication'
  | 'cancelled'
  | 'integrity';

/** Stage output is versioned independently from immutable input revisions. */
export interface AnalysisOutput {
  status: 'completed' | 'partial' | 'failed' | 'needs_attention';
  provider: string;
  model: string;
  version: string;
  output: Record<string, unknown>;
  usage: Record<string, number>;
  error?: IntakeFailure;
  confidence?: number;
}

/** Host-selected extraction settings for an inline receipt; the same shape
 * the job path persists in its `stage: 'extract'` configuration. */
export interface InlineInterpretationInput {
  /** Stable per receipt: retries replay the same immutable revisions. */
  requestId: string;
  extraction: {
    configurationRevision: string;
    limits: {
      maxBytes: number;
      maxPages: number;
      maxPixels: number;
      maxOutputBytes: number;
      timeoutMs: number;
      maxTokens: number;
      workerHeapMb: number;
    };
  };
}
/** Terminal projection of one in-process stage; identical ledger semantics to a job. */
export interface InlineStageResult {
  analysisId: string;
  revision: number;
  attemptId: string;
  state: 'completed' | 'partial' | 'needs_attention' | 'failed';
  error: IntakeFailure | null;
}
export interface InlineInterpretation {
  itemId: string;
  extraction: InlineStageResult;
  /** Absent when extraction did not complete or partially complete. */
  generation?: InlineStageResult;
  /** The authorized, catalog-live generation snapshot when generation completed. */
  analysis?: import('./proposal-dto.js').CompletedAnalysisSnapshot;
}
/** Bounded own-submission listing; the cursor is an opaque item identifier. */
export interface OwnProposalsInput {
  cursor?: string;
  limit?: number;
}
export interface OwnProposalsPage {
  items: Array<{
    item: IntakeItemDTO;
    /** Null when the submission's reviews cannot currently be read. */
    reviews: import('./review-dto.js').ReviewPage | null;
    /** Set without a reason: nothing about the denied target is disclosed. */
    unavailable?: true;
  }>;
  nextCursor?: string;
}

export type * from './feedback-dto.js';
export type * from './proposal-dto.js';
export type * from './review-dto.js';
