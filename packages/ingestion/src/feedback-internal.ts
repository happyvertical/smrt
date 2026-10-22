import type { DatabaseInterface } from '@happyvertical/sql';
import type { HandlerContext } from './execution-contracts.js';
import type { IntakeValues, ProposalReview } from './execution-dto.js';
/** Owning execution boundary; not exported from any public entry point. */
export const feedbackActionTransaction = Symbol(
  'ingestion.feedbackActionTransaction',
);
export interface FeedbackActionContext {
  db: DatabaseInterface;
  context: HandlerContext;
  review: ProposalReview;
  itemId: string;
  attemptId: string;
  args: IntakeValues;
  analysis: IntakeValues;
  result: IntakeValues;
  handlerId: string;
  handlerVersion: string;
  /** `intake_actions.data.origin`, e.g. `generated-proposal` or `reviewer-selected`. */
  origin: string;
  /** The source item carries a terminal reviewer disposition. */
  resolved: boolean;
  /**
   * The action is approved and still effective: applied (`executing`,
   * `succeeded`) or `authorized` with an unexpired approval, on an unresolved item.
   */
  settled: boolean;
}

export const feedbackDiscoveryContext = Symbol(
  'ingestion.feedbackDiscoveryContext',
);
