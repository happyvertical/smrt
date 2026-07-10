export type BuiltInPipelineStageKey =
  | 'new'
  | 'qualified'
  | 'discovery'
  | 'proposal'
  | 'negotiation'
  | 'closed_won'
  | 'closed_lost';

export type PipelineStageKey = BuiltInPipelineStageKey | (string & {});

export const DEFAULT_PIPELINE_STAGE_DEFINITIONS = [
  {
    key: 'new',
    name: 'New',
    sortOrder: 0,
    terminal: false,
    outcome: 'open',
  },
  {
    key: 'qualified',
    name: 'Qualified',
    sortOrder: 1,
    terminal: false,
    outcome: 'open',
  },
  {
    key: 'discovery',
    name: 'Discovery',
    sortOrder: 2,
    terminal: false,
    outcome: 'open',
  },
  {
    key: 'proposal',
    name: 'Proposal',
    sortOrder: 3,
    terminal: false,
    outcome: 'open',
  },
  {
    key: 'negotiation',
    name: 'Negotiation',
    sortOrder: 4,
    terminal: false,
    outcome: 'open',
  },
  {
    key: 'closed_won',
    name: 'Closed Won',
    sortOrder: 5,
    terminal: true,
    outcome: 'won',
  },
  {
    key: 'closed_lost',
    name: 'Closed Lost',
    sortOrder: 6,
    terminal: true,
    outcome: 'lost',
  },
] as const satisfies readonly DefaultPipelineStageDefinition[];

export type LeadStatus =
  | 'new'
  | 'qualified'
  | 'converted'
  | 'merged'
  | 'disqualified';

export type OpportunityOutcome = 'open' | 'won' | 'lost';

export type SalesActivityType =
  | 'note'
  | 'email'
  | 'call'
  | 'meeting'
  | 'stage_change'
  | 'assignment'
  | 'qualification'
  | 'conversion'
  | 'merge'
  | 'outcome';

export interface AcquisitionEvent {
  source: string;
  occurredAt: string;
  campaign?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityDetails {
  [key: string]: unknown;
}

export interface SalesActivitySnapshot {
  id: string;
  type: SalesActivityType;
  summary: string;
  occurredAt: string;
  actorId: string | null;
  details: ActivityDetails;
  opportunityId?: string | null;
}

export interface OpportunitySnapshot {
  id: string;
  tenantId: string;
  leadId: string;
  pipelineId: string;
  stageId: string;
  ownerId: string | null;
  name: string;
  expectedValue: number;
  currency: string;
  nextAction: string;
  outcome: OpportunityOutcome;
  closedAt: string | null;
  lastStageChangeAt: string | null;
}

export interface LeadMergeSnapshot {
  sourceLead: {
    id: string;
    tenantId: string;
    name: string;
    email: string;
    organization: string;
    ownerId: string | null;
    status: LeadStatus;
    qualificationSummary: string;
    qualifiedAt: string | null;
    qualifiedById: string | null;
  };
  sourceAcquisitionHistory: AcquisitionEvent[];
  sourceActivities: SalesActivitySnapshot[];
  sourceOpportunity: OpportunitySnapshot | null;
  sourceOpportunityId: string | null;
}

export interface DefaultPipelineStageDefinition {
  key: PipelineStageKey;
  name: string;
  sortOrder: number;
  terminal: boolean;
  outcome: OpportunityOutcome;
}

export interface LeadOptions {
  tenantId?: string;
  name?: string;
  email?: string;
  organization?: string;
  ownerId?: string | null;
  status?: LeadStatus;
  qualificationSummary?: string;
  qualifiedAt?: Date | null;
  qualifiedById?: string | null;
  acquisitionHistory?: string;
  mergedIntoLeadId?: string | null;
}

export interface PipelineDefinitionOptions {
  tenantId?: string;
  key?: string;
  name?: string;
  description?: string;
  active?: boolean;
  isDefault?: boolean;
}

export interface PipelineStageOptions {
  tenantId?: string;
  pipelineId?: string;
  key?: PipelineStageKey;
  name?: string;
  sortOrder?: number;
  terminal?: boolean;
  outcome?: OpportunityOutcome;
}

export interface OpportunityOptions {
  tenantId?: string;
  leadId?: string;
  pipelineId?: string;
  stageId?: string;
  ownerId?: string | null;
  name?: string;
  expectedValue?: number;
  currency?: string;
  nextAction?: string;
  outcome?: OpportunityOutcome;
  closedAt?: Date | null;
  lastStageChangeAt?: Date | null;
}

export interface SalesActivityOptions {
  tenantId?: string;
  leadId?: string | null;
  opportunityId?: string | null;
  type?: SalesActivityType;
  actorId?: string | null;
  summary?: string;
  details?: string;
  occurredAt?: Date;
}

export interface LeadMergeOptions {
  tenantId?: string;
  sourceLeadId?: string;
  targetLeadId?: string;
  actorId?: string | null;
  sourceSnapshot?: string;
  mergedAt?: Date;
}

export interface EnsureDefaultPipelineResult {
  pipeline: {
    id: string;
    key: string;
    name: string;
  };
  stageIdsByKey: Record<string, string>;
}

export interface CreateLeadArgs {
  name: string;
  email?: string;
  organization?: string;
  ownerId?: string | null;
  acquisitionEvent?: AcquisitionEvent;
}

export interface QualifyLeadArgs {
  leadId: string;
  actorId?: string | null;
  summary?: string;
}

export interface ConvertLeadToOpportunityArgs {
  leadId: string;
  actorId?: string | null;
  pipelineId?: string;
  stageKey?: PipelineStageKey;
  ownerId?: string | null;
  name?: string;
  expectedValue?: number;
  currency?: string;
  nextAction?: string;
}

export interface ConvertLeadToOpportunityResult {
  opportunityId: string;
  leadId: string;
  created: boolean;
  stageKey: PipelineStageKey;
}

export interface MoveOpportunityArgs {
  opportunityId: string;
  actorId?: string | null;
  stageId?: string;
  stageKey?: PipelineStageKey;
  nextAction?: string;
}

export interface MergeLeadArgs {
  sourceLeadId: string;
  targetLeadId: string;
  actorId?: string | null;
}

export interface MergeLeadResult {
  mergeId: string;
  sourceLeadId: string;
  targetLeadId: string;
  created: boolean;
}
