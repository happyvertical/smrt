/** Browser-only view contracts. Every value must come from an authenticated host. */
import type {
  IntakeEvidenceDTO,
  IntakeFailure,
  IntakeItemDTO,
  ItemDisposition,
} from './dto.js';
import type {
  ActionResult,
  IntakeValues,
  PreviewPlanInput,
  PreviewProposalInput,
  ProposalReview,
  ResolveItemInput,
  ResultReference,
  ReviewInput,
  StartActionInput,
} from './execution-dto.js';
import type {
  CandidatePage,
  CompletedAnalysisSnapshot,
  GenerationOutput,
  ProposalCatalogEntry,
} from './proposal-dto.js';

export type InboxState =
  | 'processing'
  | 'unresolved'
  | 'waiting'
  | 'failed'
  | 'deferred'
  | 'partially_completed'
  | 'completed'
  | 'resolved';
export interface ReviewAction {
  review: ProposalReview;
  /** Absent on state-only stale/expired/unavailable entries. */
  args?: IntakeValues;
  handlerId?: string;
  handlerVersion?: string;
  attemptId?: string;
  /** `reviewer-selected` marks a human-started action; never automation-eligible. */
  origin?: string;
  dependencies?: Record<string, ResultReference>;
  result?: ActionResult;
  /** Authorized identity/CAS only; hosts must collect fresh explicit args. */
  stalePlan?: {
    id: string;
    key: string;
    revision: number;
    handlerId: string;
    handlerVersion: string;
  };
  plan?: {
    id: string;
    key: string;
    revision: number;
    stepIndex: number;
    args: IntakeValues;
    handlerId: string;
    handlerVersion: string;
    attemptId: string;
  };
}
export interface ReviewPage {
  /** A saved target changed: omit stale generation output, retain authorized reviews. */
  generationStale?: boolean;
  actions: ReviewAction[];
  nextCursor?: string;
}
export interface Assignment {
  assigneeId: string | null;
  version: number;
}
export interface InboxEntry {
  item: IntakeItemDTO;
  label: string;
  state: InboxState;
  assignment: Assignment;
  /**
   * An inbox row's preview of its primary original, present only on `list`
   * entries and only when the host supplies the opt-in `rowEvidence` option
   * (#4213). The part is chosen by role: the shallowest child part (an
   * upload's file, an email's first attachment), else the first root part.
   * `list` reads the page's durable parts in one batched query, asks
   * `rowEvidence` once for the page, and fills this from its answer; it is
   * absent when the host omits `rowEvidence`, does not answer for the row,
   * or the item has no durable parts. `load` never sets it.
   */
  evidence?: InboxEvidence;
}
/** A row's preview: the primary part's identity plus host URLs, never text. */
export interface InboxEvidence {
  evidence: IntakeEvidenceDTO;
  label: string;
  /** Host-authorized same-origin content URL, never an object-storage key. */
  viewUrl?: string;
  /** Optional host-authorized same-origin preview image for the row. */
  thumbnailUrl?: string;
}
export interface EvidenceView {
  evidence: IntakeEvidenceDTO;
  label: string;
  /** Host-authorized same-origin content URL, never an object-storage key. */
  viewUrl?: string;
  text?: string;
}
export interface ItemReviewView {
  entry: InboxEntry;
  evidence: EvidenceView[];
  analysis?: CompletedAnalysisSnapshot;
  generation?: GenerationOutput;
  /** Handlers the item's catalog currently offers a reviewer; presentation only. */
  catalog?: ProposalCatalogEntry[];
  /** Reviewer and reason of a resolved item, loaded under review authority. */
  disposition?: ItemDisposition;
  reviews: ReviewPage;
  /** Present when an instruction was recorded or carried by the displayed generation. */
  instruction?: ReviewerInstructionView;
  /** Host-projected safe state, never raw server exception text. */
  availability: 'available' | 'stale' | 'revoked' | 'expired' | 'unavailable';
  message?: string;
}
/** Immutable authenticated reviewer guidance for one item; it steers the model only. */
export interface ReviewerInstruction {
  id: string;
  text: string;
  actorId: string;
  recordedAt: string;
  /** The instruction this one replaced for future interpretations, if any. */
  supersedesId: string | null;
  digest: string;
}
export interface ReviewerInstructionInput {
  itemId: string;
  attemptId: string;
  expectedRevision: number;
  text: string;
  requestId: string;
}
export interface ReviewerInstructionView {
  /**
   * Latest recorded instruction that is still in effect: the item's newest
   * extraction carries it, so its interpretations do. Null when none was
   * recorded or a host reprocess dropped it (see `dropped`).
   */
  current: ReviewerInstruction | null;
  /**
   * Latest recorded instruction that a host reprocess dropped (a reprocess
   * builds its own configuration and cannot carry human corrections). It no
   * longer applies; the reviewer can re-record it.
   */
  dropped?: ReviewerInstruction;
  /** The instruction the displayed generation was produced under. */
  applied: ReviewerInstruction | null;
  /** Displayed suggestions predate the current instruction. */
  stale: boolean;
  /** Safe failure category, or `not_started` when interpretation was never appended in time. */
  failure?: IntakeFailure | 'not_started';
  /** Server-side "in flight", including the gap between extraction and interpretation. */
  reinterpreting?: boolean;
  /** Record/retry binding when no current generation is displayable: the latest completed generation attempt and the item's current revision. */
  binding?: { attemptId: string; expectedRevision: number };
}
export interface LogicalSplitInput {
  itemId: string;
  attemptId: string;
  expectedRevision: number;
  evidenceId: string;
  groups: number[][];
  requestId: string;
}
/**
 * A preview the handler refused on its own validation of the arguments. The
 * reviewer may correct the arguments and retry; it is never an access result.
 */
export interface PreviewRejection {
  rejected: 'invalid';
}
/** Transport-neutral callbacks. Implement on an authenticated host; props confer no permission. */
export interface IntakeReviewHost {
  /** Newest receipt first; `limit` defaults to 20 and is clamped to 1..100. */
  list(input: {
    state?: InboxState;
    assigneeId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: InboxEntry[]; nextCursor?: string }>;
  load(itemId: string, cursor?: string): Promise<ItemReviewView>;
  upload(files: File[], requestId: string): Promise<{ itemId: string }>;
  preview(input: {
    itemId: string;
    attemptId: string;
    index: number;
    requestId: string;
    /**
     * Explicit human arguments completing a `needs_review` suggestion. The host
     * publishes them through the ordinary operation/plan preview, never through
     * the generated snapshot, so the handler validates them again.
     */
    args?: IntakeValues;
    /**
     * Throws on every failure. A handler's refusal of the arguments is
     * `HandlerArgumentsInvalidError` (by `name`); a transport may instead
     * resolve `{ rejected: 'invalid' }` for that one case.
     */
  }): Promise<void | PreviewRejection>;
  decide(input: ReviewInput): Promise<void>;
  apply(actionId: string): Promise<ActionResult>;
  editPlan?: (input: PreviewPlanInput) => Promise<void>;
  editAction?: (input: PreviewProposalInput) => Promise<void>;
  candidates(input: {
    itemId: string;
    handlerId: string;
    handlerVersion: string;
    query: string;
  }): Promise<CandidatePage>;
  assign(input: {
    itemId: string;
    expectedVersion: number;
    assigneeId: string | null;
    requestId: string;
  }): Promise<void>;
  split(input: LogicalSplitInput): Promise<void>;
  /** Start a reviewer-chosen handler; the server previews and requires normal approval. */
  startAction?: (input: StartActionInput) => Promise<void>;
  /** Close the item as handled without an action; terminal and distinct from reject. */
  resolve?: (input: ResolveItemInput) => Promise<void>;
  /**
   * Record reviewer guidance and request a background reinterpretation; never
   * approval. Resolves `{ stale: true }` when the anchor is superseded or work
   * is still in flight, a refresh-and-retry signal rather than a denial, and
   * `{ invalid: true }` when the text fails validation (empty, whitespace-only
   * or longer than 4,000 characters), shown inline rather than as a denial.
   */
  instruct?: (
    input: ReviewerInstructionInput,
  ) => Promise<void | { stale: true } | { invalid: true }>;
  /** Explicit correctness judgment only; never called implicitly after review or apply. */
  feedback?: (
    input: import('./feedback-dto.js').RecordFeedbackInput,
  ) => Promise<import('./feedback-dto.js').FeedbackReceipt | void>;
}
