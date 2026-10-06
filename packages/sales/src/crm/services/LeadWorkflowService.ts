/**
 * Tenant-safe, audited follow-up workflow for CRM Leads.
 *
 * The service is the narrow mutation seam for generic Lead intake, follow-up,
 * qualification, and Opportunity closure. It delegates persistence lifecycles
 * to their owning collections and never creates downstream records.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  requireTenantId,
  TenantContextError,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { LeadCollection } from '../collections/LeadCollection.js';
import { OpportunityCollection } from '../collections/OpportunityCollection.js';
import { OpportunityConversionCollection } from '../collections/OpportunityConversionCollection.js';
import { PipelineDefinitionCollection } from '../collections/PipelineDefinitionCollection.js';
import { PipelineStageCollection } from '../collections/PipelineStageCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';
import type { Lead } from '../models/Lead.js';
import type { Opportunity } from '../models/Opportunity.js';
import type { OpportunityConversion } from '../models/OpportunityConversion.js';
import {
  permitSalesActivityWorkflowCompletion,
  type SalesActivity,
} from '../models/SalesActivity.js';
import type { SalesRepresentative } from '../models/SalesRepresentative.js';
import type { LeadStatus } from '../types.js';

/** Human follow-up kinds accepted by {@link LeadWorkflowService.recordActivity}. */
export const LEAD_HUMAN_ACTIVITY_KINDS = [
  'note',
  'call',
  'email',
  'meeting',
] as const;
export type LeadHumanActivityKind = (typeof LEAD_HUMAN_ACTIVITY_KINDS)[number];

/** Maximum persisted text length for generic workflow summaries and reasons. */
export const MAX_LEAD_WORKFLOW_TEXT_LENGTH = 1_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Queue state for a lead's next actionable follow-up step. */
export type LeadWorkQueueState =
  | 'terminal'
  | 'reopenable'
  | 'unassigned'
  | 'no_next_action'
  | 'overdue'
  | 'due_today'
  | 'upcoming';

/** Plain input consumed by {@link projectLeadWorkQueue}; safe for host view mappers. */
export interface LeadWorkQueueInput {
  status: LeadStatus;
  ownerRepId?: string | null;
  nextAction?: { dueAt?: Date | null } | null;
  /** Inject a clock to make queue classification deterministic. */
  now?: Date;
  /**
   * Optional IANA timezone used only for the calendar-day boundary. Omitting
   * it leaves the host/runtime timezone in control; CRM never imposes one.
   */
  timeZone?: string;
}

/** Reusable, policy-free work-queue projection. */
export interface LeadWorkQueueProjection {
  state: LeadWorkQueueState;
  isActionable: boolean;
  isUnassigned: boolean;
  hasNoNextAction: boolean;
  isOverdue: boolean;
  isDueToday: boolean;
  isUpcoming: boolean;
  isTerminal: boolean;
  isReopenable: boolean;
}

/**
 * Classify a lead without assuming an SLA, automatic owner, or timezone.
 * Terminal qualified/merged rows are never queued; disqualified leads remain
 * explicitly reopenable rather than being conflated with immutable terminals.
 */
export function projectLeadWorkQueue(
  input: LeadWorkQueueInput,
): LeadWorkQueueProjection {
  const terminal = input.status === 'qualified' || input.status === 'merged';
  const reopenable = input.status === 'disqualified';
  const ownerRepId = input.ownerRepId?.trim() ?? '';
  const dueAt = input.nextAction?.dueAt ?? null;
  const dueTime = dueAt instanceof Date ? dueAt.getTime() : Number.NaN;
  const now = input.now ?? new Date();
  const nowTime = now.getTime();

  if (terminal) return queueProjection('terminal');
  if (reopenable) return queueProjection('reopenable');
  if (!ownerRepId) return queueProjection('unassigned');
  if (!Number.isFinite(dueTime)) return queueProjection('no_next_action');
  if (dueTime < nowTime) return queueProjection('overdue');

  const dueDay = calendarDayKey(new Date(dueTime), input.timeZone);
  const nowDay = calendarDayKey(now, input.timeZone);
  return queueProjection(dueDay === nowDay ? 'due_today' : 'upcoming');
}

/** Details returned to reusable UI after one tenant-safe work-state read. */
export interface LeadWorkState {
  lead: Lead;
  owner: SalesRepresentative | null;
  earliestOpenTask: SalesActivity | null;
  /** Canonical opportunity created from this lead, when one is visible. */
  opportunity: Opportunity | null;
  queue: LeadWorkQueueProjection;
}

export type LeadDedupePolicy = 'none' | 'email' | 'email_or_org';

export interface CreateLeadInput {
  name: string;
  email?: string;
  contactName?: string;
  phone?: string;
  organizationName?: string;
  sourceKind: string;
  sourceId?: string;
  acquisitionContext?: Record<string, unknown>;
  ownerRepId?: string;
  actorProfileId?: string;
  dedupe?: LeadDedupePolicy;
  idempotencyKey?: string;
  now?: Date;
}

export interface CreateLeadResult {
  lead: Lead;
  created: boolean;
  /** A terminal possible duplicate that requires an explicit caller decision. */
  duplicateOf?: Lead;
}

export interface QualifyLeadInput {
  leadId: string;
  pipelineId?: string;
  actorProfileId: string;
  opportunityName?: string;
  expectedValueCents?: number;
  currency?: string;
  expectedCloseAt?: Date | null;
  now?: Date;
}

export interface QualifyLeadResult {
  lead: Lead;
  opportunity: Opportunity;
  created: boolean;
}

export interface OpportunityConversionInput {
  targetKind: string;
  targetId: string;
  note?: string;
}

export interface CloseOpportunityInput {
  opportunityId: string;
  outcome: 'won' | 'lost';
  actorProfileId: string;
  reason?: string;
  conversion?: OpportunityConversionInput;
  now?: Date;
}

export interface CloseOpportunityResult {
  opportunity: Opportunity;
  conversion?: OpportunityConversion;
  changed: boolean;
  conversionCreated?: boolean;
}

export interface AssignLeadInput {
  leadId: string;
  ownerRepId: string;
  actorProfileId: string;
  now?: Date;
}

export interface AssignLeadResult {
  lead: Lead;
  /** `false` when the active representative already owned the Lead. */
  changed: boolean;
}

export interface StartWorkingInput {
  leadId: string;
  actorProfileId: string;
  now?: Date;
}

export interface DisqualifyLeadInput {
  leadId: string;
  actorProfileId: string;
  reason: string;
  now?: Date;
}

export interface RecordLeadActivityInput {
  leadId: string;
  actorProfileId: string;
  activityKind: LeadHumanActivityKind;
  summary: string;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface ScheduleLeadNextActionInput {
  leadId: string;
  actorProfileId: string;
  summary: string;
  dueAt: Date;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface CompleteLeadNextActionInput {
  leadId: string;
  taskId: string;
  actorProfileId: string;
  now?: Date;
}

export interface CompleteLeadNextActionResult {
  task: SalesActivity;
  /** `false` for a compatible exact replay after the task was completed. */
  completed: boolean;
}

export interface GetLeadWorkStateInput {
  leadId: string;
  now?: Date;
  timeZone?: string;
}

/** Stable machine-readable refusal reasons for workflow callers. */
export type LeadWorkflowValidationReason =
  | 'tenant_context_required'
  | 'transaction_unavailable'
  | 'lead_unavailable'
  | 'representative_unavailable'
  | 'representative_inactive'
  | 'lead_not_actionable'
  | 'invalid_transition'
  | 'reason_required'
  | 'reason_too_long'
  | 'summary_required'
  | 'summary_too_long'
  | 'invalid_activity_kind'
  | 'invalid_metadata'
  | 'invalid_due_at'
  | 'task_unavailable'
  | 'task_not_open'
  | 'completion_replay_conflict'
  | 'name_required'
  | 'contact_required'
  | 'invalid_email'
  | 'source_kind_required'
  | 'invalid_dedupe_policy'
  | 'invalid_idempotency_key'
  | 'idempotency_conflict'
  | 'pipeline_unavailable'
  | 'pipeline_has_no_terminal_stage'
  | 'opportunity_unavailable'
  | 'invalid_value'
  | 'invalid_conversion'
  | 'opportunity_replay_conflict';

/** Workflow validation error that never reveals cross-tenant row existence. */
export class LeadWorkflowValidationError extends Error {
  readonly code = 'LEAD_WORKFLOW_VALIDATION_ERROR' as const;

  constructor(
    readonly reason: LeadWorkflowValidationReason,
    message: string,
  ) {
    super(message);
    this.name = 'LeadWorkflowValidationError';
  }
}

interface LeadWorkflowServiceDeps {
  leads: LeadCollection;
  activities: SalesActivityCollection;
  representatives: SalesRepresentativeCollection;
  opportunities: OpportunityCollection;
  conversions: OpportunityConversionCollection;
  pipelines: PipelineDefinitionCollection;
  stages: PipelineStageCollection;
}

/** Transaction-scoped collections inherit the outer adapter's lock capability. */
interface LeadWorkflowTransactionDeps extends LeadWorkflowServiceDeps {
  supportsRowLocks: boolean;
}

interface TransactionCapableDatabase extends DatabaseInterface {
  transaction?<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}

interface NormalizedCreateLeadInput {
  name: string;
  email: string;
  contactName: string;
  phone: string;
  organizationName: string;
  sourceKind: string;
  sourceId: string;
  acquisitionContext: Record<string, unknown>;
  ownerRepId: string;
  actorProfileId: string;
  dedupe: LeadDedupePolicy;
  idempotencyKey: string;
  now: Date;
  intent: Record<string, unknown>;
}

/** Serialize mutations for adapters without independent row-locking sessions. */
const singleConnectionMutationTails = new WeakMap<
  DatabaseInterface,
  Promise<void>
>();

/**
 * Reusable Lead follow-up service. Every mutation is one transaction that
 * locks the target lead (and task when completing), applies the guarded model
 * transition, and appends its immutable audit record before commit.
 */
export class LeadWorkflowService {
  private constructor(private readonly deps: LeadWorkflowServiceDeps) {}

  static async create(
    options: SmrtClassOptions = {},
  ): Promise<LeadWorkflowService> {
    return new LeadWorkflowService({
      leads: await LeadCollection.create(options),
      activities: await SalesActivityCollection.create(options),
      representatives: await SalesRepresentativeCollection.create(options),
      opportunities: await OpportunityCollection.create(options),
      conversions: await OpportunityConversionCollection.create(options),
      pipelines: await PipelineDefinitionCollection.create(options),
      stages: await PipelineStageCollection.create(options),
    });
  }

  /** Create or explicitly report a tenant-local duplicate Lead. */
  async createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
    const normalized = this.normalizeCreateLeadInput(input);
    const tenantId = this.requireActiveTenant();
    const intent = stableStringify(normalized.intent);
    const intentHash = sha256(intent);
    const operationId =
      normalized.idempotencyKey || normalized.dedupe !== 'none'
        ? uuidFromHash(
            sha256(
              `lead-intake:${tenantId}:${
                normalized.idempotencyKey
                  ? `key:${normalized.idempotencyKey}`
                  : `intent:${intentHash}`
              }`,
            ),
          )
        : undefined;

    const result = await this.runMutation(async (deps, activeTenantId) => {
      if (operationId) {
        await this.lockOperationFence(deps, `lead-intake:${operationId}`);
        const replay = await deps.activities.get(
          { id: operationId },
          { cache: false },
        );
        if (replay) {
          const metadata = replay.getMetadata();
          if (
            replay.activityKind !== 'lead_intake' &&
            replay.activityKind !== 'inbound'
          ) {
            throw this.refusal(
              'idempotency_conflict',
              'Lead intake operation key is already used by another activity',
            );
          }
          if (metadata.intentHash !== intentHash) {
            throw this.refusal(
              'idempotency_conflict',
              'Lead intake idempotency key was already used with different input',
            );
          }
          return {
            leadId: replay.subjectId,
            created: false,
          };
        }
      }

      if (normalized.ownerRepId) {
        const representative = await deps.representatives.get(
          { id: normalized.ownerRepId },
          { cache: false },
        );
        if (!representative) {
          throw this.refusal(
            'representative_unavailable',
            'Representative is unavailable in the active tenant',
          );
        }
        if (!representative.isActive()) {
          throw this.refusal(
            'representative_inactive',
            'Representative is not active',
          );
        }
      }

      const matches = await this.findDedupeMatches(
        deps,
        activeTenantId,
        normalized,
      );
      const active = matches.find(
        (candidate) =>
          candidate.status === 'new' || candidate.status === 'working',
      );
      if (active) {
        const leadId = this.requireLeadId(active);
        await deps.activities.create({
          ...(operationId ? { id: operationId } : {}),
          tenantId: activeTenantId,
          subjectKind: 'lead',
          subjectId: leadId,
          activityKind: 'inbound',
          summary: 'Received duplicate lead intake',
          actorProfileId: normalized.actorProfileId,
          metadata: JSON.stringify({
            intentHash,
            created: false,
            dedupe: normalized.dedupe,
            receivedAt: normalized.now.toISOString(),
            sourceKind: normalized.sourceKind,
            sourceId: normalized.sourceId,
          }),
        });
        return { leadId, created: false };
      }

      const terminal = matches[0];
      if (terminal) {
        const duplicateOfId = this.requireLeadId(terminal);
        return {
          leadId: duplicateOfId,
          created: false,
          duplicateOfId,
        };
      }

      const lead = await deps.leads.create({
        tenantId: activeTenantId,
        name: normalized.name,
        email: normalized.email,
        contactName: normalized.contactName,
        phone: normalized.phone,
        organizationName: normalized.organizationName,
        sourceKind: normalized.sourceKind,
        sourceId: normalized.sourceId,
        acquisitionContext: stableStringify(normalized.acquisitionContext),
        ownerRepId: normalized.ownerRepId,
        status: 'new',
      });
      const leadId = this.requireLeadId(lead);
      await deps.activities.create({
        ...(operationId ? { id: operationId } : {}),
        tenantId: activeTenantId,
        subjectKind: 'lead',
        subjectId: leadId,
        activityKind: 'lead_intake',
        summary: 'Created lead from intake',
        actorProfileId: normalized.actorProfileId,
        metadata: JSON.stringify({
          intentHash,
          created: true,
          dedupe: normalized.dedupe,
          receivedAt: normalized.now.toISOString(),
          sourceKind: normalized.sourceKind,
          sourceId: normalized.sourceId,
        }),
      });
      return { leadId, created: true };
    });

    const lead = await this.readLead(this.deps.leads, result.leadId, tenantId);
    return {
      lead,
      created: result.created,
      ...(result.duplicateOfId ? { duplicateOf: lead } : {}),
    };
  }

  /** Qualify a Lead through the collection lifecycle in one transaction. */
  async qualifyLead(input: QualifyLeadInput): Promise<QualifyLeadResult> {
    const actorProfileId = this.requireIdentifier(
      input.actorProfileId,
      'actorProfileId',
    );
    if (input.pipelineId && !UUID_RE.test(input.pipelineId)) {
      throw this.refusal(
        'pipeline_unavailable',
        'Pipeline is unavailable in the active tenant',
      );
    }
    if (
      input.expectedValueCents !== undefined &&
      (!Number.isSafeInteger(input.expectedValueCents) ||
        input.expectedValueCents < 0)
    ) {
      throw this.refusal(
        'invalid_value',
        'Expected value must be a non-negative safe integer number of cents',
      );
    }
    const tenantId = this.requireActiveTenant();
    const result = await this.runMutation(async (deps, activeTenantId) => {
      const lead = await this.lockLead(deps, input.leadId, activeTenantId);
      if (lead.status === 'disqualified' || lead.status === 'merged') {
        throw this.refusal(
          'invalid_transition',
          `Lead cannot be qualified from '${lead.status}'`,
        );
      }
      if (input.pipelineId) {
        const pipeline = await deps.pipelines.get(
          { id: input.pipelineId },
          { cache: false },
        );
        if (!pipeline || pipeline.tenantId !== activeTenantId) {
          throw this.refusal(
            'pipeline_unavailable',
            'Pipeline is unavailable in the active tenant',
          );
        }
      }
      const leadId = this.requireLeadId(lead);
      const prior = await deps.opportunities.findByLead(leadId);
      let opportunity: Opportunity;
      try {
        opportunity = await deps.leads.qualify({
          leadId,
          actorProfileId,
          pipelineId: input.pipelineId,
          opportunityName: input.opportunityName,
          expectedValueCents: input.expectedValueCents,
          currency: input.currency,
          expectedCloseAt: input.expectedCloseAt,
          now: input.now,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('pipeline') ||
            error.message.includes('stages'))
        ) {
          throw this.refusal('pipeline_unavailable', error.message);
        }
        throw error;
      }
      return {
        leadId,
        opportunityId: this.requireOpportunityId(opportunity),
        created: prior.length === 0,
      };
    });
    // SQLite and DuckDB root handles multiplex one native connection. Keep
    // post-commit result reads sequential so their prepared statements cannot
    // overlap on that connection.
    const lead = await this.readLead(this.deps.leads, result.leadId, tenantId);
    const opportunity = await this.readOpportunity(
      result.opportunityId,
      tenantId,
    );
    return { lead, opportunity, created: result.created };
  }

  /** Close an opportunity at its configured terminal stage and optionally link conversion. */
  async closeOpportunity(
    input: CloseOpportunityInput,
  ): Promise<CloseOpportunityResult> {
    const actorProfileId = this.requireIdentifier(
      input.actorProfileId,
      'actorProfileId',
    );
    if (!UUID_RE.test(input.opportunityId)) {
      throw this.refusal(
        'opportunity_unavailable',
        'Opportunity is unavailable in the active tenant',
      );
    }
    if (input.outcome !== 'won' && input.outcome !== 'lost') {
      throw this.refusal(
        'invalid_transition',
        "Opportunity outcome must be 'won' or 'lost'",
      );
    }
    if (input.conversion && input.outcome !== 'won') {
      throw this.refusal(
        'invalid_conversion',
        'A conversion can only be recorded for a won opportunity',
      );
    }
    const conversion = input.conversion
      ? {
          targetKind: this.requireOpenIdentifier(
            input.conversion.targetKind,
            'conversion targetKind',
          ),
          targetId: this.requireOpenIdentifier(
            input.conversion.targetId,
            'conversion targetId',
          ),
          note: input.conversion.note?.trim() ?? '',
        }
      : undefined;
    const reason = input.reason?.trim();
    if (reason && reason.length > MAX_LEAD_WORKFLOW_TEXT_LENGTH) {
      throw this.refusal(
        'reason_too_long',
        `Lead workflow reason must be at most ${MAX_LEAD_WORKFLOW_TEXT_LENGTH} characters`,
      );
    }
    const tenantId = this.requireActiveTenant();
    const result = await this.runMutation(async (deps, activeTenantId) => {
      const opportunity = await this.lockOpportunity(
        deps,
        input.opportunityId,
        activeTenantId,
      );
      let changed = false;
      if (opportunity.status !== 'open') {
        if (opportunity.status !== input.outcome) {
          throw this.refusal(
            'opportunity_replay_conflict',
            `Opportunity is already closed as '${opportunity.status}'`,
          );
        }
        if (reason && opportunity.outcomeReason !== reason) {
          throw this.refusal(
            'opportunity_replay_conflict',
            'Opportunity was already closed with a different reason',
          );
        }
      } else {
        const stages = await deps.stages.list({
          where: { pipelineId: opportunity.pipelineId },
          orderBy: 'sort_order ASC',
        });
        const terminal = stages.find((stage) =>
          input.outcome === 'won' ? stage.isWon : stage.isLost,
        );
        if (!terminal?.id) {
          throw this.refusal(
            'pipeline_has_no_terminal_stage',
            `Opportunity pipeline has no '${input.outcome}' terminal stage`,
          );
        }
        await deps.opportunities.moveToStage({
          opportunityId: input.opportunityId,
          stageId: terminal.id,
          actorProfileId,
          outcomeReason: reason,
          now: input.now,
        });
        changed = true;
      }

      let conversionId: string | undefined;
      let conversionCreated: boolean | undefined;
      if (conversion) {
        const recorded = await deps.conversions.recordConversion({
          opportunityId: input.opportunityId,
          ...conversion,
        });
        conversionId = this.requireConversionId(recorded.conversion);
        conversionCreated = recorded.created;
      }
      return {
        opportunityId: input.opportunityId,
        changed,
        conversionId,
        conversionCreated,
      };
    });
    const opportunity = await this.readOpportunity(
      result.opportunityId,
      tenantId,
    );
    const persistedConversion = result.conversionId
      ? await this.deps.conversions.get(
          { id: result.conversionId },
          { cache: false },
        )
      : undefined;
    return {
      opportunity,
      changed: result.changed,
      ...(persistedConversion ? { conversion: persistedConversion } : {}),
      ...(result.conversionCreated !== undefined
        ? { conversionCreated: result.conversionCreated }
        : {}),
    };
  }

  /** Assign or reassign an active representative, with one audit row per change. */
  async assignLead(input: AssignLeadInput): Promise<AssignLeadResult> {
    const actorProfileId = this.requireIdentifier(
      input.actorProfileId,
      'actorProfileId',
    );
    const ownerRepId = this.requireIdentifier(input.ownerRepId, 'ownerRepId');
    return await this.runMutation(async (deps, tenantId) => {
      const lead = await this.lockLead(deps, input.leadId, tenantId);
      this.assertActiveFollowUpLead(lead);
      const representative = await deps.representatives.get(
        { id: ownerRepId },
        { cache: false },
      );
      // The tenant-scoped collection lookup is the membership boundary. Do
      // not infer tenancy from a nullable hydrated field: a missing foreign
      // row and a cross-tenant row deliberately have the same refusal.
      if (!representative) {
        throw this.refusal(
          'representative_unavailable',
          'Representative is unavailable in the active tenant',
        );
      }
      if (!representative.isActive()) {
        throw this.refusal(
          'representative_inactive',
          'Representative is not active',
        );
      }
      if (lead.ownerRepId === ownerRepId) return { lead, changed: false };

      const priorOwnerRepId = lead.ownerRepId;
      lead.ownerRepId = ownerRepId;
      await lead.save();
      await this.appendAudit(deps.activities, lead, {
        actorProfileId,
        activityKind: 'assignment',
        summary: priorOwnerRepId
          ? 'Reassigned lead owner'
          : 'Assigned lead owner',
        metadata: {
          fromOwnerRepId: priorOwnerRepId || null,
          toOwnerRepId: ownerRepId,
          occurredAt: this.now(input.now).toISOString(),
        },
      });
      return { lead, changed: true };
    });
  }

  /** Start a new Lead or reopen a disqualified Lead for active follow-up. */
  async startWorking(input: StartWorkingInput): Promise<Lead> {
    const actorProfileId = this.requireIdentifier(
      input.actorProfileId,
      'actorProfileId',
    );
    return await this.runMutation(async (deps, tenantId) => {
      const lead = await this.lockLead(deps, input.leadId, tenantId);
      if (lead.status !== 'new' && lead.status !== 'disqualified') {
        throw this.refusal(
          'invalid_transition',
          `Lead cannot start working from '${lead.status}'`,
        );
      }
      const from = lead.status;
      lead.status = 'working';
      await lead.save();
      await this.appendAudit(deps.activities, lead, {
        actorProfileId,
        activityKind: 'status_change',
        summary:
          from === 'disqualified'
            ? 'Reopened lead follow-up'
            : 'Started lead follow-up',
        metadata: {
          from,
          to: 'working',
          occurredAt: this.now(input.now).toISOString(),
        },
      });
      return lead;
    });
  }

  /** Disqualify a new or working Lead with a required bounded rationale. */
  async disqualifyLead(input: DisqualifyLeadInput): Promise<Lead> {
    const actorProfileId = this.requireIdentifier(
      input.actorProfileId,
      'actorProfileId',
    );
    const reason = this.requireBoundedText(input.reason, 'reason');
    return await this.runMutation(async (deps, tenantId) => {
      const lead = await this.lockLead(deps, input.leadId, tenantId);
      if (lead.status !== 'new' && lead.status !== 'working') {
        throw this.refusal(
          'invalid_transition',
          `Lead cannot be disqualified from '${lead.status}'`,
        );
      }
      const from = lead.status;
      lead.status = 'disqualified';
      await lead.save();
      await this.appendAudit(deps.activities, lead, {
        actorProfileId,
        activityKind: 'status_change',
        summary: 'Disqualified lead',
        metadata: {
          from,
          to: 'disqualified',
          reason,
          occurredAt: this.now(input.now).toISOString(),
        },
      });
      return lead;
    });
  }

  /** Append one immutable human note, call, email, or meeting to an active Lead. */
  async recordActivity(input: RecordLeadActivityInput): Promise<SalesActivity> {
    const actorProfileId = this.requireIdentifier(
      input.actorProfileId,
      'actorProfileId',
    );
    const summary = this.requireBoundedText(input.summary, 'summary');
    if (!LEAD_HUMAN_ACTIVITY_KINDS.includes(input.activityKind)) {
      throw this.refusal(
        'invalid_activity_kind',
        'Activity kind is not a human follow-up activity',
      );
    }
    const metadata = this.canonicalMetadata(input.metadata);
    return await this.runMutation(async (deps, tenantId) => {
      const lead = await this.lockLead(deps, input.leadId, tenantId);
      this.assertActiveFollowUpLead(lead);
      return await deps.activities.create({
        tenantId,
        subjectKind: 'lead',
        subjectId: this.requireLeadId(lead),
        activityKind: input.activityKind,
        summary,
        actorProfileId,
        metadata,
      });
    });
  }

  /** Schedule one open `task` activity for an active Lead. */
  async scheduleNextAction(
    input: ScheduleLeadNextActionInput,
  ): Promise<SalesActivity> {
    const actorProfileId = this.requireIdentifier(
      input.actorProfileId,
      'actorProfileId',
    );
    const summary = this.requireBoundedText(input.summary, 'summary');
    const dueAt = this.requireValidDate(input.dueAt, 'dueAt');
    const metadata = this.canonicalMetadata(input.metadata);
    return await this.runMutation(async (deps, tenantId) => {
      const lead = await this.lockLead(deps, input.leadId, tenantId);
      this.assertActiveFollowUpLead(lead);
      return await deps.activities.create({
        tenantId,
        subjectKind: 'lead',
        subjectId: this.requireLeadId(lead),
        activityKind: 'task',
        summary,
        dueAt,
        actorProfileId,
        metadata,
      });
    });
  }

  /**
   * Complete one open lead task exactly once. The task is locked with its Lead
   * so concurrent callers serialize; a compatible retry returns the completed
   * task without adding a second immutable completion event.
   */
  async completeNextAction(
    input: CompleteLeadNextActionInput,
  ): Promise<CompleteLeadNextActionResult> {
    const actorProfileId = this.requireIdentifier(
      input.actorProfileId,
      'actorProfileId',
    );
    return await this.runMutation(async (deps, tenantId) => {
      const lead = await this.lockLead(deps, input.leadId, tenantId);
      this.assertActiveFollowUpLead(lead);
      const task = await this.lockLeadTask(
        deps,
        input.taskId,
        this.requireLeadId(lead),
        tenantId,
      );
      if (task.activityKind !== 'task' || !task.dueAt) {
        throw this.refusal(
          'task_unavailable',
          'Task is unavailable for this lead',
        );
      }

      if (task.completedAt) {
        const completion = await this.findTaskCompletionAudit(
          deps.activities,
          this.requireLeadId(lead),
          this.requireActivityId(task),
        );
        if (completion?.actorProfileId === actorProfileId) {
          return { task, completed: false };
        }
        throw this.refusal(
          'completion_replay_conflict',
          'Task was already completed by another actor or without compatible audit evidence',
        );
      }

      const completedAt = this.now(input.now);
      task.completedAt = completedAt;
      permitSalesActivityWorkflowCompletion(task);
      await task.save();
      await this.appendAudit(deps.activities, lead, {
        actorProfileId,
        activityKind: 'task_completion',
        summary: `Completed next action: ${task.summary}`,
        metadata: {
          taskId: this.requireActivityId(task),
          completedAt: completedAt.toISOString(),
        },
      });
      return { task, completed: true };
    });
  }

  /** Return a deterministic chronological activity trail across merged Lead history. */
  async getLeadTimeline(leadId: string): Promise<SalesActivity[]> {
    const tenantId = this.requireActiveTenant();
    const lead = await this.readLead(this.deps.leads, leadId, tenantId);
    return await this.deps.leads.activitiesIncludingMerged(
      this.requireLeadId(lead),
    );
  }

  /** Return the Lead, its visible owner, earliest open task, and queue projection. */
  async getLeadWorkState(input: GetLeadWorkStateInput): Promise<LeadWorkState> {
    const tenantId = this.requireActiveTenant();
    const lead = await this.readLead(this.deps.leads, input.leadId, tenantId);
    const leadId = this.requireLeadId(lead);
    const [owner, openTasks, linkedOpportunities] = await Promise.all([
      lead.ownerRepId
        ? this.deps.representatives.get(
            { id: lead.ownerRepId },
            { cache: false },
          )
        : Promise.resolve(null),
      this.deps.activities.findOpenTasks('lead', leadId),
      this.deps.opportunities.findByLead(leadId),
    ]);
    const earliestOpenTask = openTasks[0] ?? null;
    return {
      lead,
      // The tenant-scoped lookup determines visibility; do not make the
      // reusable projection depend on nullable field hydration details.
      owner,
      earliestOpenTask,
      opportunity: linkedOpportunities[0] ?? null,
      queue: projectLeadWorkQueue({
        status: lead.status,
        ownerRepId: lead.ownerRepId,
        nextAction: earliestOpenTask,
        now: input.now,
        timeZone: input.timeZone,
      }),
    };
  }

  private async runMutation<T>(
    fn: (deps: LeadWorkflowTransactionDeps, tenantId: string) => Promise<T>,
  ): Promise<T> {
    const tenantId = this.requireActiveTenant();
    const db = this.deps.leads.db as TransactionCapableDatabase;
    if (typeof db.transaction !== 'function') {
      throw this.refusal(
        'transaction_unavailable',
        'Lead workflow mutations require a transaction-capable database adapter',
      );
    }
    // `transaction()` is an adapter method, not a detached callback: bind the
    // database receiver before the serial queue invokes it later.
    const transaction = db.transaction.bind(db);
    // Transaction callback views intentionally omit pool-only lifecycle
    // methods such as `acquireSession`. Capture the pool capability before
    // entering the callback so PostgreSQL still takes its row-lock path.
    const supportsRowLocks = this.supportsRowLocks(db);
    const runTransaction = async () =>
      await transaction(async (tx) =>
        fn(
          {
            leads: await LeadCollection.create({
              db: tx,
              _reuseInitializedDb: true,
              _deferRuntimeInitialization: true,
            }),
            activities: await SalesActivityCollection.create({
              db: tx,
              _reuseInitializedDb: true,
              _deferRuntimeInitialization: true,
            }),
            representatives: await SalesRepresentativeCollection.create({
              db: tx,
              _reuseInitializedDb: true,
              _deferRuntimeInitialization: true,
            }),
            opportunities: await OpportunityCollection.create({
              db: tx,
              _reuseInitializedDb: true,
              _deferRuntimeInitialization: true,
            }),
            conversions: await OpportunityConversionCollection.create({
              db: tx,
              _reuseInitializedDb: true,
              _deferRuntimeInitialization: true,
            }),
            pipelines: await PipelineDefinitionCollection.create({
              db: tx,
              _reuseInitializedDb: true,
              _deferRuntimeInitialization: true,
            }),
            stages: await PipelineStageCollection.create({
              db: tx,
              _reuseInitializedDb: true,
              _deferRuntimeInitialization: true,
            }),
            supportsRowLocks,
          },
          tenantId,
        ),
      );

    // PostgreSQL transactions have independent pooled sessions and acquire a
    // row lock below. SQLite/DuckDB/JSON multiplex one connection instead;
    // chain their whole mutation so two readers cannot both complete one task.
    if (supportsRowLocks) return await runTransaction();
    const previous = singleConnectionMutationTails.get(db) ?? Promise.resolve();
    const turn = previous.then(runTransaction, runTransaction);
    singleConnectionMutationTails.set(
      db,
      turn.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await turn;
  }

  /** PostgreSQL gets a row lock; other adapters are serialized by runMutation. */
  private async lockLead(
    deps: LeadWorkflowTransactionDeps,
    leadId: string,
    tenantId: string,
  ): Promise<Lead> {
    if (!UUID_RE.test(leadId)) {
      throw this.refusal(
        'lead_unavailable',
        'Lead is unavailable in the active tenant',
      );
    }
    if (deps.supportsRowLocks) {
      const rows = await deps.leads.query(
        `SELECT * FROM ${deps.leads.tableName}
         WHERE id = $1 AND tenant_id = $2
         FOR UPDATE`,
        [leadId, tenantId],
        { allowRawOnTenantScoped: true },
      );
      const lead = rows[0];
      if (lead && lead.tenantId === tenantId) return lead;
      throw this.refusal(
        'lead_unavailable',
        'Lead is unavailable in the active tenant',
      );
    }
    return await this.readLead(deps.leads, leadId, tenantId);
  }

  private async lockLeadTask(
    deps: LeadWorkflowTransactionDeps,
    taskId: string,
    leadId: string,
    tenantId: string,
  ): Promise<SalesActivity> {
    if (!UUID_RE.test(taskId)) {
      throw this.refusal(
        'task_unavailable',
        'Task is unavailable for this lead',
      );
    }
    if (deps.supportsRowLocks) {
      const rows = await deps.activities.query(
        `SELECT * FROM ${deps.activities.tableName}
         WHERE id = $1
           AND subject_kind = 'lead'
           AND subject_id = $2
           AND tenant_id = $3
         FOR UPDATE`,
        [taskId, leadId, tenantId],
        { allowRawOnTenantScoped: true },
      );
      const task = rows[0];
      if (task && task.tenantId === tenantId) return task;
      throw this.refusal(
        'task_unavailable',
        'Task is unavailable for this lead',
      );
    }
    const task = await deps.activities.get({ id: taskId }, { cache: false });
    if (
      !task ||
      task.tenantId !== tenantId ||
      task.subjectKind !== 'lead' ||
      task.subjectId !== leadId
    ) {
      throw this.refusal(
        'task_unavailable',
        'Task is unavailable for this lead',
      );
    }
    return task;
  }

  private async lockOpportunity(
    deps: LeadWorkflowTransactionDeps,
    opportunityId: string,
    tenantId: string,
  ): Promise<Opportunity> {
    if (deps.supportsRowLocks) {
      const rows = await deps.opportunities.query(
        `SELECT * FROM ${deps.opportunities.tableName}
         WHERE id = $1 AND tenant_id = $2
         FOR UPDATE`,
        [opportunityId, tenantId],
        { allowRawOnTenantScoped: true },
      );
      const opportunity = rows[0];
      if (opportunity && opportunity.tenantId === tenantId) return opportunity;
      throw this.refusal(
        'opportunity_unavailable',
        'Opportunity is unavailable in the active tenant',
      );
    }
    return await this.readOpportunityFrom(
      deps.opportunities,
      opportunityId,
      tenantId,
    );
  }

  private async lockOperationFence(
    deps: LeadWorkflowTransactionDeps,
    key: string,
  ): Promise<void> {
    if (!deps.supportsRowLocks) return;
    await deps.leads.db.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      key,
    );
  }

  private async findDedupeMatches(
    deps: LeadWorkflowTransactionDeps,
    tenantId: string,
    input: NormalizedCreateLeadInput,
  ): Promise<Lead[]> {
    if (input.dedupe === 'none') return [];
    const clauses: string[] = [];
    const identityLocks: string[] = [];
    const params: string[] = [tenantId];
    if (input.email) {
      params.push(input.email);
      clauses.push(`LOWER(TRIM(email)) = $${params.length}`);
      identityLocks.push(`lead-dedupe:${tenantId}:email:${input.email}`);
    }
    if (input.dedupe === 'email_or_org' && input.organizationName) {
      const organizationName = input.organizationName.toLowerCase();
      params.push(organizationName);
      clauses.push(`LOWER(TRIM(organization_name)) = $${params.length}`);
      identityLocks.push(
        `lead-dedupe:${tenantId}:organization:${organizationName}`,
      );
    }
    if (clauses.length === 0) return [];
    if (deps.supportsRowLocks) {
      for (const identityLock of identityLocks.sort()) {
        await this.lockOperationFence(deps, identityLock);
      }
    }
    return await deps.leads.query(
      `SELECT * FROM ${deps.leads.tableName}
       WHERE tenant_id = $1 AND (${clauses.join(' OR ')})
       ORDER BY created_at DESC${deps.supportsRowLocks ? ' FOR UPDATE' : ''}`,
      params,
      { allowRawOnTenantScoped: true },
    );
  }

  private async readLead(
    leads: LeadCollection,
    leadId: string,
    tenantId: string,
  ): Promise<Lead> {
    if (!UUID_RE.test(leadId)) {
      throw this.refusal(
        'lead_unavailable',
        'Lead is unavailable in the active tenant',
      );
    }
    const lead = await leads.get({ id: leadId }, { cache: false });
    if (!lead || lead.tenantId !== tenantId) {
      throw this.refusal(
        'lead_unavailable',
        'Lead is unavailable in the active tenant',
      );
    }
    return lead;
  }

  private async readOpportunity(
    opportunityId: string,
    tenantId: string,
  ): Promise<Opportunity> {
    return await this.readOpportunityFrom(
      this.deps.opportunities,
      opportunityId,
      tenantId,
    );
  }

  private async readOpportunityFrom(
    opportunities: OpportunityCollection,
    opportunityId: string,
    tenantId: string,
  ): Promise<Opportunity> {
    const opportunity = await opportunities.get(
      { id: opportunityId },
      { cache: false },
    );
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw this.refusal(
        'opportunity_unavailable',
        'Opportunity is unavailable in the active tenant',
      );
    }
    return opportunity;
  }

  private normalizeCreateLeadInput(
    input: CreateLeadInput,
  ): NormalizedCreateLeadInput {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
      throw this.refusal('name_required', 'Lead name is required');
    }
    const email =
      typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
    if (!email && !phone) {
      throw this.refusal(
        'contact_required',
        'Lead intake requires at least one of email or phone',
      );
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      throw this.refusal('invalid_email', 'Lead email is invalid');
    }
    const sourceKind =
      typeof input.sourceKind === 'string' ? input.sourceKind.trim() : '';
    if (!sourceKind) {
      throw this.refusal('source_kind_required', 'Lead sourceKind is required');
    }
    const dedupe = input.dedupe ?? 'email';
    if (!['none', 'email', 'email_or_org'].includes(dedupe)) {
      throw this.refusal(
        'invalid_dedupe_policy',
        'Lead dedupe policy is invalid',
      );
    }
    const idempotencyKey = input.idempotencyKey?.trim() ?? '';
    if (idempotencyKey.length > 255) {
      throw this.refusal(
        'invalid_idempotency_key',
        'Lead idempotency key must be at most 255 characters',
      );
    }
    const acquisitionContext = input.acquisitionContext ?? {};
    if (
      !isPlainJsonObject(acquisitionContext) ||
      !isJsonValue(acquisitionContext, new Set<object>())
    ) {
      throw this.refusal(
        'invalid_metadata',
        'Lead acquisitionContext must be a plain JSON object with JSON values',
      );
    }
    const ownerRepId = input.ownerRepId
      ? this.requireIdentifier(input.ownerRepId, 'ownerRepId')
      : '';
    const actorProfileId = input.actorProfileId
      ? this.requireIdentifier(input.actorProfileId, 'actorProfileId')
      : '';
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw this.refusal('invalid_due_at', 'Lead intake now must be valid');
    }
    const normalized = {
      name,
      email,
      contactName: input.contactName?.trim() ?? '',
      phone,
      organizationName: input.organizationName?.trim() ?? '',
      sourceKind,
      sourceId: input.sourceId?.trim() ?? '',
      acquisitionContext,
      ownerRepId,
      actorProfileId,
      dedupe,
      idempotencyKey,
      now,
    };
    return {
      ...normalized,
      intent: {
        name: normalized.name,
        email: normalized.email,
        contactName: normalized.contactName,
        phone: normalized.phone,
        organizationName: normalized.organizationName,
        sourceKind: normalized.sourceKind,
        sourceId: normalized.sourceId,
        acquisitionContext: normalized.acquisitionContext,
        ownerRepId: normalized.ownerRepId,
        dedupe: normalized.dedupe,
      },
    };
  }

  private assertActiveFollowUpLead(lead: Lead): void {
    if (lead.status !== 'new' && lead.status !== 'working') {
      throw this.refusal(
        'lead_not_actionable',
        `Lead is not actionable for ordinary follow-up while '${lead.status}'`,
      );
    }
  }

  private async appendAudit(
    activities: SalesActivityCollection,
    lead: Lead,
    input: {
      actorProfileId: string;
      activityKind: string;
      summary: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<SalesActivity> {
    return await activities.create({
      tenantId: lead.tenantId,
      subjectKind: 'lead',
      subjectId: this.requireLeadId(lead),
      activityKind: input.activityKind,
      summary: input.summary,
      actorProfileId: input.actorProfileId,
      metadata: JSON.stringify(input.metadata),
    });
  }

  private async findTaskCompletionAudit(
    activities: SalesActivityCollection,
    leadId: string,
    taskId: string,
  ): Promise<SalesActivity | null> {
    const activity = (await activities.findBySubject('lead', leadId)).find(
      (candidate) =>
        candidate.activityKind === 'task_completion' &&
        candidate.getMetadata().taskId === taskId,
    );
    return activity ?? null;
  }

  private requireActiveTenant(): string {
    try {
      return requireTenantId();
    } catch (error) {
      if (!(error instanceof TenantContextError)) throw error;
      throw this.refusal(
        'tenant_context_required',
        'Lead workflow operations require an active tenant context',
      );
    }
  }

  private canonicalMetadata(
    metadata: Record<string, unknown> | undefined,
  ): string {
    const value = metadata ?? {};
    if (!isPlainJsonObject(value) || !isJsonValue(value, new Set<object>())) {
      throw this.refusal(
        'invalid_metadata',
        'Activity metadata must be a plain JSON object with JSON values',
      );
    }
    return JSON.stringify(value);
  }

  private requireBoundedText(
    value: string,
    field: 'summary' | 'reason',
  ): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      throw this.refusal(
        field === 'summary' ? 'summary_required' : 'reason_required',
        `Lead workflow ${field} is required`,
      );
    }
    if (normalized.length > MAX_LEAD_WORKFLOW_TEXT_LENGTH) {
      throw this.refusal(
        field === 'summary' ? 'summary_too_long' : 'reason_too_long',
        `Lead workflow ${field} must be at most ${MAX_LEAD_WORKFLOW_TEXT_LENGTH} characters`,
      );
    }
    return normalized;
  }

  private requireIdentifier(value: string, field: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    const requiresUuid = field === 'ownerRepId' || field === 'actorProfileId';
    if (!normalized || (requiresUuid && !UUID_RE.test(normalized))) {
      throw this.refusal(
        field === 'ownerRepId'
          ? 'representative_unavailable'
          : 'invalid_metadata',
        `Lead workflow ${field} must be a UUID`,
      );
    }
    return normalized;
  }

  private requireValidDate(value: Date, field: string): Date {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw this.refusal(
        'invalid_due_at',
        `Lead workflow ${field} must be a valid date`,
      );
    }
    return value;
  }

  private requireLeadId(lead: Lead): string {
    if (!lead.id)
      throw this.refusal(
        'lead_unavailable',
        'Lead is unavailable in the active tenant',
      );
    return lead.id;
  }

  private requireActivityId(activity: SalesActivity): string {
    if (!activity.id)
      throw this.refusal(
        'task_unavailable',
        'Task is unavailable for this lead',
      );
    return activity.id;
  }

  private requireOpportunityId(opportunity: Opportunity): string {
    if (!opportunity.id) {
      throw this.refusal(
        'opportunity_unavailable',
        'Opportunity is unavailable in the active tenant',
      );
    }
    return opportunity.id;
  }

  private requireConversionId(conversion: OpportunityConversion): string {
    if (!conversion.id) {
      throw this.refusal(
        'invalid_conversion',
        'Opportunity conversion could not be persisted',
      );
    }
    return conversion.id;
  }

  private requireOpenIdentifier(value: string, field: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      throw this.refusal('invalid_conversion', `${field} is required`);
    }
    return normalized;
  }

  private now(value: Date | undefined): Date {
    return value ?? new Date();
  }

  private supportsRowLocks(db: DatabaseInterface): boolean {
    return (
      typeof (db as TransactionCapableDatabase).acquireSession === 'function'
    );
  }

  private refusal(
    reason: LeadWorkflowValidationReason,
    message: string,
  ): LeadWorkflowValidationError {
    return new LeadWorkflowValidationError(reason, message);
  }
}

function queueProjection(state: LeadWorkQueueState): LeadWorkQueueProjection {
  return {
    state,
    isActionable:
      state === 'unassigned' ||
      state === 'no_next_action' ||
      state === 'overdue' ||
      state === 'due_today' ||
      state === 'upcoming',
    isUnassigned: state === 'unassigned',
    hasNoNextAction: state === 'no_next_action',
    isOverdue: state === 'overdue',
    isDueToday: state === 'due_today',
    isUpcoming: state === 'upcoming',
    isTerminal: state === 'terminal',
    isReopenable: state === 'reopenable',
  };
}

function calendarDayKey(date: Date, timeZone: string | undefined): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    // A host-provided timezone is advisory queue-display input, not a reason
    // for a work-state projection to fail. Invalid IANA values use the
    // runtime timezone just as an omitted value does.
    formatter = new Intl.DateTimeFormat('en-US', options);
  }
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    try {
      return value.every((item) => isJsonValue(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (isPlainJsonObject(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    try {
      return Object.values(value).every((item) => isJsonValue(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  return false;
}

/** Canonical JSON representation used only for stable intake intent hashes. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isPlainJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Format 128 hash bits as an RFC 4122 version-5-shaped UUID. */
function uuidFromHash(hash: string): string {
  const chars = hash.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(
    16,
  );
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export default LeadWorkflowService;
