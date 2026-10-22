/** Browser-only view contracts. Every value must come from an authenticated host. */
import type { IntakeEvidenceDTO, IntakeFailure, IntakeItemDTO } from './dto.js';
import type {
  ActionResult,
  IntakeValues,
  PreviewPlanInput,
  PreviewProposalInput,
  ProposalReview,
  ResultReference,
  ReviewInput,
} from './execution-dto.js';
import type {
  CandidatePage,
  CompletedAnalysisSnapshot,
  GenerationOutput,
} from './proposal-dto.js';

export type InboxState =
  | 'processing'
  | 'unresolved'
  | 'waiting'
  | 'failed'
  | 'deferred'
  | 'partially_completed'
  | 'completed';
export interface ReviewAction {
  review: ProposalReview;
  /** Absent on state-only stale/expired/unavailable entries. */
  args?: IntakeValues;
  handlerId?: string;
  handlerVersion?: string;
  attemptId?: string;
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
  /** Latest recorded instruction; future interpretations carry it. */
  current: ReviewerInstruction | null;
  /** The instruction the displayed generation was produced under. */
  applied: ReviewerInstruction | null;
  /** Displayed suggestions predate the current instruction. */
  stale: boolean;
  /** Safe failure category of the latest attempt when the reinterpretation did not complete. */
  failure?: IntakeFailure;
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
/** Transport-neutral callbacks. Implement on an authenticated host; props confer no permission. */
export interface IntakeReviewHost {
  list(input: {
    state?: InboxState;
    assigneeId?: string;
    cursor?: string;
  }): Promise<{ items: InboxEntry[]; nextCursor?: string }>;
  load(itemId: string, cursor?: string): Promise<ItemReviewView>;
  upload(files: File[], requestId: string): Promise<{ itemId: string }>;
  preview(input: {
    itemId: string;
    attemptId: string;
    index: number;
    requestId: string;
  }): Promise<void>;
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
  /** Record reviewer guidance and request a background reinterpretation; never approval. */
  instruct?: (input: ReviewerInstructionInput) => Promise<void>;
  /** Explicit correctness judgment only; never called implicitly after review or apply. */
  feedback?: (
    input: import('./feedback-dto.js').RecordFeedbackInput,
  ) => Promise<import('./feedback-dto.js').FeedbackReceipt | void>;
}
