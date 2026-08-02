/**
 * CRM module of `@happyvertical/smrt-sales`.
 *
 * Leads, Opportunities, configurable Pipelines, the SalesRepresentative
 * role, the SalesActivity audit/next-action trail, and idempotent
 * OpportunityConversion links. No referral or commission semantics live
 * here — the only commissions touchpoint is the string `earnerId` FK on
 * SalesRepresentative (see `packages/sales/AGENTS.md`).
 *
 * @packageDocumentation
 */

// Collections
export { LeadCollection } from './collections/LeadCollection.js';
export { OpportunityCollection } from './collections/OpportunityCollection.js';
export { OpportunityConversionCollection } from './collections/OpportunityConversionCollection.js';
export { PipelineDefinitionCollection } from './collections/PipelineDefinitionCollection.js';
export { PipelineStageCollection } from './collections/PipelineStageCollection.js';
export { SalesActivityCollection } from './collections/SalesActivityCollection.js';
export { SalesRepresentativeCollection } from './collections/SalesRepresentativeCollection.js';
// Models
export { Lead } from './models/Lead.js';
export { Opportunity } from './models/Opportunity.js';
export { OpportunityConversion } from './models/OpportunityConversion.js';
export { PipelineDefinition } from './models/PipelineDefinition.js';
export { PipelineStage } from './models/PipelineStage.js';
export { SalesActivity } from './models/SalesActivity.js';
export { SalesRepresentative } from './models/SalesRepresentative.js';
export type {
  AssignLeadInput,
  AssignLeadResult,
  CompleteLeadNextActionInput,
  CompleteLeadNextActionResult,
  DisqualifyLeadInput,
  GetLeadWorkStateInput,
  LeadHumanActivityKind,
  LeadWorkflowValidationReason,
  LeadWorkQueueInput,
  LeadWorkQueueProjection,
  LeadWorkQueueState,
  LeadWorkState,
  RecordLeadActivityInput,
  ScheduleLeadNextActionInput,
  StartWorkingInput,
} from './services/LeadWorkflowService.js';
// Services
export {
  LEAD_HUMAN_ACTIVITY_KINDS,
  LeadWorkflowService,
  LeadWorkflowValidationError,
  MAX_LEAD_WORKFLOW_TEXT_LENGTH,
  projectLeadWorkQueue,
} from './services/LeadWorkflowService.js';
// Types, status unions, and operation contracts
export * from './types.js';
