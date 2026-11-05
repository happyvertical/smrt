import type {
  ProjectContextReference,
  ProjectDecisionOption,
  ProjectDecisionStatus,
  ProjectQuestionOption,
  ProjectQuestionStatus,
} from '../project-governance-types.js';

export interface ProjectQuestionView {
  id: string;
  prompt: string;
  status: ProjectQuestionStatus;
  answer?: string;
  options?: ProjectQuestionOption[];
  selectedOptionId?: string;
  ownerLabel?: string;
  contextReferences?: ProjectContextReference[];
  revision: number;
  canResolve?: boolean;
}

export interface ProjectDecisionView {
  id: string;
  question: string;
  status: ProjectDecisionStatus;
  options?: ProjectDecisionOption[];
  outcome?: string;
  rationale?: string;
  ownerLabel?: string;
  contextReferences?: ProjectContextReference[];
  revision: number;
  canResolve?: boolean;
}

export interface ProjectQuestionAnswerInput {
  id: string;
  answer: string;
  selectedOptionId?: string;
  expectedRevision: number;
}

export interface ProjectDecisionResolveInput {
  id: string;
  outcome: string;
  rationale: string;
  expectedRevision: number;
}

/** Kind of governance record presented by `ProjectInterview`. */
export type ProjectInterviewRecordKind = 'question' | 'decision';

/**
 * Host-supplied plain-language framing for one interview record, keyed by the
 * question or decision id. The host decides what each record unblocks; the
 * component only renders it.
 */
export interface ProjectInterviewFraming {
  /** Why the answer matters, in plain language. */
  why?: string;
  /** Labels of the work this answer unblocks. */
  unblocks?: string[];
  /** Option to present first and mark as recommended. */
  recommendedOptionId?: string;
}

/** Emitted whenever the interview moves to another record or completes. */
export interface ProjectInterviewAdvanceDetail {
  /** Zero-based position in the interview; equals `total` on completion. */
  index: number;
  total: number;
  /** Current record, or `null` when the completion state is shown. */
  id: string | null;
  kind: ProjectInterviewRecordKind | null;
  reason: 'next' | 'back' | 'skip' | 'answered' | 'review';
}
