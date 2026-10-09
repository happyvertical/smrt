/** Browser-safe feedback contracts. All provenance is resolved by the server. */
import type { IntakeValues } from './execution-dto.js';
export interface FeedbackBinding {
  itemId: string;
  actionId: string;
  expectedRevision: number;
  expectedReviewVersion: number;
  bindingHash: string;
}
export interface RecordFeedbackInput extends FeedbackBinding {
  judgment: 'correct' | 'incorrect';
  comment?: string;
  requestId: string;
  supersedesId?: string;
}
export interface ObserveFeedbackInput extends FeedbackBinding {
  kind: 'action_decision' | 'downstream_outcome';
  eventId: string;
}
export interface FeedbackExample {
  feedbackId: string;
  digest: string;
  itemId: string;
  actionId: string;
  revision: number;
  handlerId: string;
  handlerVersion: string;
  judgment: 'correct' | 'incorrect';
  query: string;
  args: IntakeValues;
  model: { provider: string; model: string; version: string };
  promptVersion: string;
  configurationVersion: string;
}
export interface FeedbackReceipt {
  id: string;
  digest: string;
  kind: 'interpretation' | 'action_decision' | 'downstream_outcome';
}
export interface FeedbackReferences {
  version: string;
  configurationDigest: string;
  examples: Array<{ feedbackId: string; digest: string }>;
}
export interface FeedbackSelection {
  version: string;
  configurationDigest: string;
  examples: FeedbackExample[];
}
export interface RoutingRule {
  handlerId: string;
  handlerVersion: string;
  /** Routing only; never grants, executable instructions or automation settings. */
  matchTerms: string[];
  args: IntakeValues;
}
export interface RuleSuggestion {
  id: string;
  digest: string;
  itemId: string;
  rule: RoutingRule;
  supportingFeedback: Array<{ id: string; digest: string }>;
  expectedPolicyVersion: string;
  preview: string;
  automaticActionEligible: false;
}
export interface SuggestRuleInput extends FeedbackBinding {
  supportingFeedbackIds: string[];
  requestId: string;
}
export interface ReadRuleInput extends FeedbackBinding {
  suggestionId: string;
}
export interface AdoptRuleInput extends FeedbackBinding {
  suggestionId: string;
  expectedDigest: string;
  expectedPolicyVersion: string;
  requestId: string;
}
export interface RuleAdoption {
  id: string;
  policyVersion: string;
  auditId: string;
  automaticActionEligible: false;
}

export interface RetrieveFeedbackInput {
  itemId: string;
  query: string;
}
