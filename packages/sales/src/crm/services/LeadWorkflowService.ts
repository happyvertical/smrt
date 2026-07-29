/**
 * Tenant-safe, audited follow-up workflow for CRM Leads.
 *
 * The service is intentionally the narrow mutation seam for the generic
 * pre-qualification loop. It does not create opportunities, conversions, or
 * downstream records; those lifecycles remain owned by their existing CRM
 * collections and by the consuming application respectively.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  requireTenantId,
  TenantContextError,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { LeadCollection } from '../collections/LeadCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';
import type { Lead } from '../models/Lead.js';
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
  queue: LeadWorkQueueProjection;
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
  | 'completion_replay_conflict';

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
}

interface TransactionCapableDatabase extends DatabaseInterface {
  transaction?<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
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
    });
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
    const [owner, openTasks] = await Promise.all([
      lead.ownerRepId
        ? this.deps.representatives.get(
            { id: lead.ownerRepId },
            { cache: false },
          )
        : Promise.resolve(null),
      this.deps.activities.findOpenTasks('lead', leadId),
    ]);
    const earliestOpenTask = openTasks[0] ?? null;
    return {
      lead,
      // The tenant-scoped lookup determines visibility; do not make the
      // reusable projection depend on nullable field hydration details.
      owner,
      earliestOpenTask,
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
    fn: (deps: LeadWorkflowServiceDeps, tenantId: string) => Promise<T>,
  ): Promise<T> {
    const tenantId = this.requireActiveTenant();
    const db = this.deps.leads.db as TransactionCapableDatabase;
    if (typeof db.transaction !== 'function') {
      throw this.refusal(
        'transaction_unavailable',
        'Lead workflow mutations require a transaction-capable database adapter',
      );
    }
    const transaction = db.transaction;
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
          },
          tenantId,
        ),
      );

    // PostgreSQL transactions have independent pooled sessions and acquire a
    // row lock below. SQLite/DuckDB/JSON multiplex one connection instead;
    // chain their whole mutation so two readers cannot both complete one task.
    if (this.supportsRowLocks(db)) return await runTransaction();
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
    deps: LeadWorkflowServiceDeps,
    leadId: string,
    tenantId: string,
  ): Promise<Lead> {
    if (this.supportsRowLocks(deps.leads.db)) {
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
    deps: LeadWorkflowServiceDeps,
    taskId: string,
    leadId: string,
    tenantId: string,
  ): Promise<SalesActivity> {
    if (this.supportsRowLocks(deps.activities.db)) {
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

  private async readLead(
    leads: LeadCollection,
    leadId: string,
    tenantId: string,
  ): Promise<Lead> {
    const lead = await leads.get({ id: leadId }, { cache: false });
    if (!lead || lead.tenantId !== tenantId) {
      throw this.refusal(
        'lead_unavailable',
        'Lead is unavailable in the active tenant',
      );
    }
    return lead;
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
    if (!normalized) {
      throw this.refusal(
        field === 'ownerRepId'
          ? 'representative_unavailable'
          : 'invalid_metadata',
        `Lead workflow ${field} is required`,
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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
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

export default LeadWorkflowService;
