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
  /**
   * Present once a reviewer closed the item without an action; terminal. Item
   * readers see only the state and time; the reviewer and reason are returned
   * by review surfaces (`getItemDisposition`, `ItemReviewView.disposition`).
   */
  disposition?: ItemDispositionState;
}

/** Item-level projection of a terminal disposition; carries no reviewer content. */
export interface ItemDispositionState {
  state: 'resolved';
  /** When the disposition was recorded (ISO 8601). */
  at: string;
}

/** Reviewer-owned terminal disposition; redaction keeps only the kind. */
export interface ItemDisposition {
  kind: 'resolved_no_action';
  reviewer: string;
  reason: string;
  decidedAt: string;
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

export type * from './feedback-dto.js';
export type * from './proposal-dto.js';
export type * from './review-dto.js';
