/**
 * Shared types, status unions, and operation contracts for the CRM module.
 *
 * Statuses are string-literal unions derived from `as const` arrays so both
 * the runtime list (for validation/UI pickers) and the compile-time union stay
 * in lockstep. All monetary fields across the module are integer cents
 * (`*Cents`, INTEGER columns); rates/probabilities are decimals in `0`–`1`
 * (DECIMAL columns). See `packages/sales/AGENTS.md`.
 *
 * @packageDocumentation
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import type { Lead } from './models/Lead.js';
import type { OpportunityConversion } from './models/OpportunityConversion.js';
import type { PipelineDefinition } from './models/PipelineDefinition.js';
import type { PipelineStage } from './models/PipelineStage.js';

// ─────────────────────────────────────────────────────────────────────────────
// Status unions
// ─────────────────────────────────────────────────────────────────────────────

/** Lifecycle statuses for a {@link SalesRepresentativeOptions | SalesRepresentative} role. */
export const SALES_REPRESENTATIVE_STATUSES = [
  'active',
  'inactive',
  'suspended',
] as const;
export type SalesRepresentativeStatus =
  (typeof SALES_REPRESENTATIVE_STATUSES)[number];

/**
 * Lead lifecycle statuses. Transitions are guarded at save time (see the
 * `LEAD_STATUS_TRANSITIONS` map in `models/Lead.ts`):
 * `new → working|qualified|disqualified|merged`,
 * `working → qualified|disqualified|merged`, `qualified → merged`,
 * `disqualified → working|merged`; `merged` is terminal.
 */
export const LEAD_STATUSES = [
  'new',
  'working',
  'qualified',
  'disqualified',
  'merged',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Pipeline definition statuses — archived pipelines stay readable for history. */
export const PIPELINE_STATUSES = ['active', 'archived'] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

/**
 * Opportunity lifecycle statuses. `open → won|lost` is enforced at save time;
 * `won` and `lost` are terminal (post-terminal stage moves are rejected).
 */
export const OPPORTUNITY_STATUSES = ['open', 'won', 'lost'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/** The two subject types a SalesActivity row can attach to. */
export const SALES_ACTIVITY_SUBJECT_KINDS = ['lead', 'opportunity'] as const;
export type SalesActivitySubjectKind =
  (typeof SALES_ACTIVITY_SUBJECT_KINDS)[number];

/**
 * Recommended activity kinds for the SalesActivity audit/next-action trail.
 *
 * The `activityKind` field itself is an OPEN string — consumers may record
 * their own kinds (e.g. `'demo'`, `'site_visit'`) without a schema change.
 * Framework-written kinds (`qualification`, `stage_change`, `merge`) come
 * from this list.
 */
export const SALES_ACTIVITY_KINDS = [
  'note',
  'call',
  'email',
  'meeting',
  'task',
  'assignment',
  'qualification',
  'stage_change',
  'merge',
  'status_change',
] as const;
export type RecommendedSalesActivityKind =
  (typeof SALES_ACTIVITY_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Default pipeline seed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Natural `key` of the seeded default pipeline
 * (`PipelineDefinitionCollection.ensureDefaultPipeline()`).
 */
export const DEFAULT_PIPELINE_KEY = 'default';

/** Seed shape for one default pipeline stage. */
export interface DefaultPipelineStageSeed {
  key: string;
  name: string;
  /** Default win probability adopted by opportunities entering the stage. */
  probability: number;
  /** Terminal-won flag — entering this stage closes the opportunity as won. */
  isWon?: boolean;
  /** Terminal-lost flag — entering this stage closes the opportunity as lost. */
  isLost?: boolean;
}

/**
 * The 7 default stages seeded by `ensureDefaultPipeline()`, in order.
 *
 * Seeded stages are ordinary rows: consumers may rename, reorder, re-weight,
 * or add stages via normal PipelineStage collection operations without any
 * Lead/Opportunity model change. Sort order is seeded in steps of 10 to leave
 * headroom for inserting custom stages between defaults.
 */
export const DEFAULT_PIPELINE_STAGES: readonly DefaultPipelineStageSeed[] = [
  { key: 'new', name: 'New', probability: 0.1 },
  { key: 'qualified', name: 'Qualified', probability: 0.25 },
  { key: 'discovery', name: 'Discovery', probability: 0.4 },
  { key: 'proposal', name: 'Proposal', probability: 0.6 },
  { key: 'negotiation', name: 'Negotiation', probability: 0.8 },
  { key: 'closed_won', name: 'Closed Won', probability: 1.0, isWon: true },
  { key: 'closed_lost', name: 'Closed Lost', probability: 0.0, isLost: true },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Model constructor options
// ─────────────────────────────────────────────────────────────────────────────

export interface SalesRepresentativeOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  profileId?: string;
  earnerId?: string;
  status?: SalesRepresentativeStatus;
  title?: string;
  metadata?: string;
}

export interface LeadOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  name?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  organizationName?: string;
  profileId?: string;
  ownerRepId?: string;
  status?: LeadStatus;
  sourceKind?: string;
  sourceId?: string;
  acquisitionContext?: string;
  intakeRef?: string;
  mergedIntoId?: string;
  qualifiedAt?: Date | null;
  metadata?: string;
}

export interface PipelineDefinitionOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  key?: string;
  name?: string;
  isDefault?: boolean;
  status?: PipelineStatus;
  metadata?: string;
}

export interface PipelineStageOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  pipelineId?: string;
  key?: string;
  name?: string;
  sortOrder?: number;
  probability?: number;
  isWon?: boolean;
  isLost?: boolean;
  metadata?: string;
}

export interface OpportunityOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  name?: string;
  leadId?: string;
  ownerRepId?: string;
  pipelineId?: string;
  stageId?: string;
  expectedValueCents?: number;
  currency?: string;
  probability?: number;
  expectedCloseAt?: Date | null;
  status?: OpportunityStatus;
  outcomeReason?: string;
  wonAt?: Date | null;
  lostAt?: Date | null;
  sourceKind?: string;
  sourceId?: string;
  metadata?: string;
}

export interface SalesActivityOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  subjectKind?: SalesActivitySubjectKind;
  subjectId?: string;
  activityKind?: string;
  summary?: string;
  dueAt?: Date | null;
  completedAt?: Date | null;
  actorProfileId?: string;
  metadata?: string;
}

export interface OpportunityConversionOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  opportunityId?: string;
  targetKind?: string;
  targetId?: string;
  note?: string;
  metadata?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection operation contracts
// ─────────────────────────────────────────────────────────────────────────────

/** Params for `PipelineDefinitionCollection.ensureDefaultPipeline()`. */
export interface EnsureDefaultPipelineParams {
  /**
   * Explicit tenant scope for the seeded pipeline/stages. Usually omitted —
   * an ambient `withTenant()` context auto-populates tenancy; pass it when
   * seeding outside a tenant context on behalf of a specific tenant.
   */
  tenantId?: string | null;
}

/** Result of `PipelineDefinitionCollection.ensureDefaultPipeline()`. */
export interface EnsureDefaultPipelineResult {
  pipeline: PipelineDefinition;
  /** All stages of the pipeline ordered by `sortOrder`. */
  stages: PipelineStage[];
}

/** Params for `LeadCollection.qualify()`. */
export interface QualifyLeadParams {
  leadId: string;
  /** Opportunity name; defaults to the lead's name. */
  opportunityName?: string;
  /** Target pipeline; defaults to the seeded default pipeline. */
  pipelineId?: string;
  /** Owning rep for the opportunity; defaults to the lead's `ownerRepId`. */
  ownerRepId?: string;
  /** Expected deal value in integer cents. */
  expectedValueCents?: number;
  /** ISO 4217 currency code; defaults to `'USD'`. */
  currency?: string;
  expectedCloseAt?: Date | null;
  /** Clock for the `qualifiedAt` stamp; defaults to now. */
  now?: Date;
}

/** Params for `LeadCollection.mergeLeads()`. */
export interface MergeLeadsParams {
  /** The surviving (canonical) lead. */
  winnerId: string;
  /** The duplicate lead to fold into the winner; becomes terminal `merged`. */
  loserId: string;
  /** Profile of the operator performing the merge, for the audit trail. */
  actorProfileId?: string;
  /** Human-readable merge reason, recorded in both audit rows. */
  reason?: string;
}

/** Result of `LeadCollection.mergeLeads()`. */
export interface MergeLeadsResult {
  winner: Lead;
  loser: Lead;
}

/** Params for `OpportunityCollection.moveToStage()`. */
export interface MoveToStageParams {
  opportunityId: string;
  /** Target stage — must belong to the opportunity's pipeline. */
  stageId: string;
  /** Profile of the actor moving the stage, for the audit trail. */
  actorProfileId?: string;
  /**
   * Outcome note recorded on the opportunity (conventionally set when moving
   * into a terminal-lost stage, e.g. `'budget cut'`).
   */
  outcomeReason?: string;
  /** Override the stage's default probability for this opportunity. */
  probabilityOverride?: number;
  /** Clock for the `wonAt`/`lostAt` stamps; defaults to now. */
  now?: Date;
}

/** Params for `OpportunityConversionCollection.recordConversion()`. */
export interface RecordConversionParams {
  opportunityId: string;
  /** Downstream record kind — open string: `'client'`, `'project'`, `'contract'`, `'subscription'`, … */
  targetKind: string;
  /** Identifier of the downstream record (created by the caller, never by CRM). */
  targetId: string;
  note?: string;
}

/** Result of `OpportunityConversionCollection.recordConversion()`. */
export interface RecordConversionResult {
  conversion: OpportunityConversion;
  /** `false` when the natural-key link already existed (idempotent repeat). */
  created: boolean;
}
