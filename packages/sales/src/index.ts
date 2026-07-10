import './__smrt-register__.js';

export {
  LeadCollection,
  LeadMergeCollection,
  OpportunityCollection,
  PipelineDefinitionCollection,
  PipelineStageCollection,
  SalesActivityCollection,
} from './collections/index.js';

export {
  Lead,
  LeadMerge,
  Opportunity,
  PipelineDefinition,
  PipelineStage,
  SalesActivity,
} from './models/index.js';

export { SalesService, type SalesServiceOptions } from './services/index.js';

export {
  type AcquisitionEvent,
  type ActivityDetails,
  type ConvertLeadToOpportunityArgs,
  type ConvertLeadToOpportunityResult,
  type CreateLeadArgs,
  DEFAULT_PIPELINE_STAGE_DEFINITIONS,
  type DefaultPipelineStageDefinition,
  type EnsureDefaultPipelineResult,
  type LeadMergeOptions,
  type LeadMergeSnapshot,
  type LeadOptions,
  type LeadStatus,
  type MergeLeadArgs,
  type MergeLeadResult,
  type MoveOpportunityArgs,
  type OpportunityOptions,
  type OpportunityOutcome,
  type PipelineDefinitionOptions,
  type PipelineStageKey,
  type PipelineStageOptions,
  type QualifyLeadArgs,
  type SalesActivityOptions,
  type SalesActivitySnapshot,
  type SalesActivityType,
} from './types.js';

export { SALES_MODULE_META, SALES_UI_SLOTS } from './ui.js';
