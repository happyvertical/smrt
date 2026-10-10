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
}

export const feedbackDiscoveryContext = Symbol(
  'ingestion.feedbackDiscoveryContext',
);
