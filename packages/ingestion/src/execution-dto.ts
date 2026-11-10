/** Browser-safe execution messages. Authority and handler callbacks live on the server. */
export type IntakeValues = Record<string, unknown>;
/** Captured by the authenticated source host, not by extracted content. */
export interface ExecutionCeiling {
  principalId: string;
  permissions: string[];
  handlers: string[];
  operations: string[];
}
export interface ResultReference {
  actionId: string;
  proposalRevision: number;
  resultField: string;
  expectedModel: string;
}
export interface PreviewProposalInput {
  itemId: string;
  actionId: string;
  attemptId: string;
  expectedRevision: number;
  requestId: string;
  handlerId: string;
  handlerVersion: string;
  args: IntakeValues;
  dependencies?: Record<string, ResultReference>;
}
export interface ProposalReview {
  actionId: string;
  proposalId: string;
  revision: number;
  reviewVersion: number;
  bindingHash: string;
  display: IntakeValues;
  state: string;
}
export interface ReviewInput {
  actionId: string;
  expectedRevision: number;
  expectedReviewVersion: number;
  bindingHash: string;
  requestId: string;
  decision: 'approve' | 'reject' | 'defer' | 'correct';
  reason?: string;
  correctedArgs?: IntakeValues;
}
/** Reviewer-chosen handler for any item; previewed and approved like a generated proposal. */
export interface StartActionInput {
  itemId: string;
  handlerId: string;
  handlerVersion: string;
  args: IntakeValues;
  requestId: string;
  reason?: string;
}
/** Close an item as handled without an action; distinct from rejecting a proposal. */
export interface ResolveItemInput {
  itemId: string;
  disposition: 'resolve_no_action';
  requestId: string;
  reason?: string;
}
export interface ActionResult {
  state:
    | 'succeeded'
    | 'failed'
    | 'outcome_unknown'
    | 'executing'
    | 'waiting_review';
  actionId: string;
  result?: IntakeValues;
  resultDigest?: string;
  tombstone?: boolean;
}

export interface PreviewPlanInput {
  itemId: string;
  attemptId: string;
  planKey: string;
  expectedRevision: number;
  requestId: string;
  handlerId: string;
  handlerVersion: string;
  args: IntakeValues;
}
export interface PlanReview {
  id: string;
  key: string;
  revision: number;
  digest: string;
  steps: ProposalReview[];
}
