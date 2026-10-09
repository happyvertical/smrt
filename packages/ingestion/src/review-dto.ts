/** Browser-only view contracts. Every value must come from an authenticated host. */
import type { IntakeEvidenceDTO, IntakeItemDTO } from './dto.js';
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
  /** Host-projected safe state, never raw server exception text. */
  availability: 'available' | 'stale' | 'revoked' | 'expired' | 'unavailable';
  message?: string;
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
  /** Explicit correctness judgment only; never called implicitly after review or apply. */
  feedback?: (input: {
    itemId: string;
    actionId?: string;
    judgment: 'correct' | 'incorrect';
    comment: string;
    requestId: string;
  }) => Promise<void>;
}
