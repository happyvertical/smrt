/**
 * ServiceTargetEngine — Service Target clocks with timed escalation
 * (FR-30/FR-31).
 *
 * Owns the full clock lifecycle on a case:
 * - **start** — one clock per configured target type from the case's plan
 *   terms (the frozen `planSnapshot` wins over the live plan; sensible
 *   defaults with no plan), `dueAt` computed in *covered* time through the
 *   plan's coverage calendar, plus a one-shot `_smrt_jobs` row
 *   (`SupportServiceTarget.checkAndEscalate`) scheduled at `dueAt`;
 * - **satisfy** — outbound specialist/agent interactions satisfy the
 *   acknowledgement/response clocks and roll the recurring update clock to
 *   its next cycle; satisfied clocks cancel their escalation job;
 * - **pause/resume** — case statuses listed in the plan's `pauseStatuses`
 *   freeze clocks (FR-29b: waiting periods pause clocks *only when the plan
 *   says so*); resume recomputes `dueAt` from the remaining covered minutes
 *   and enqueues a fresh job;
 * - **resolve/reopen** — resolution satisfies the resolution clock and
 *   cancels the rest; reopening starts fresh clocks on a new cycle;
 * - **breach** — an overdue clock is marked breached and escalated through
 *   the plan's escalation policy (notify or reassign via
 *   {@link SupportRoutingService}), with optional delayed follow-up steps.
 *
 * The engine is invoked by the application around
 * {@link SupportCaseService} calls; it deliberately takes explicit `at`
 * instants so behavior is deterministic and testable.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { type SmrtJob, SmrtJobCollection } from '@happyvertical/smrt-jobs';
import type { SupportCase } from '../models/support-case.js';
import type { SupportInteraction } from '../models/support-interaction.js';
import { DEFAULT_TARGET_MINUTES } from '../models/support-plan.js';
import {
  SupportEscalationCollection,
  type SupportServiceTarget,
  SupportServiceTargetCollection,
} from '../models/support-service-target.js';
import {
  type EscalationStep,
  OPEN_SUPPORT_CASE_STATUSES,
  type ServiceTargetMinutes,
  type ServiceTargetType,
  type SupportCaseStatus,
} from '../types.js';
import {
  addCoveredMinutes,
  type CoverageCalendar,
  coveredMinutesBetween,
} from './coverage-calendar.js';
import { SupportCaseService } from './support-case-service.js';
import { SupportRoutingService } from './support-routing-service.js';

/** Queue name for support escalation jobs. */
export const SUPPORT_JOB_QUEUE = 'support';

/** Priority for escalation jobs (`high` — breaches are time-critical). */
export const ESCALATION_JOB_PRIORITY = 75;

/** Severity assumed when a case has not been assigned one yet. */
export const DEFAULT_SEVERITY_KEY = 'sev3';

/** Case statuses that pause clocks when the plan doesn't say otherwise. */
const DEFAULT_PAUSE_STATUSES = ['waiting_on_client'];

const MINUTE_MS = 60_000;

/** Clock target types in start order. */
const TARGET_TYPES: ServiceTargetType[] = [
  'acknowledgement',
  'response',
  'update',
  'resolution',
];

/** The plan terms a case's clocks run against (snapshot-first). */
export interface ResolvedTargetPlanTerms {
  calendar: CoverageCalendar;
  pauseStatuses: string[];
  escalationPolicy: EscalationStep[];
  targetsForSeverity(severity: string): ServiceTargetMinutes;
}

/** Options for {@link ServiceTargetEngine.create}. */
export interface ServiceTargetEngineOptions extends SmrtObjectOptions {
  /** Share an existing case service (and its collections) with the engine. */
  caseService?: SupportCaseService;
  /**
   * Whether to enqueue real `_smrt_jobs` escalation rows (default `true`).
   * Disable only where a jobs table is unavailable by design.
   */
  scheduleJobs?: boolean;
}

function targetMinutesFor(
  minutes: ServiceTargetMinutes,
  targetType: ServiceTargetType,
): number | null {
  switch (targetType) {
    case 'acknowledgement':
      return minutes.acknowledgementMinutes;
    case 'response':
      return minutes.responseMinutes;
    case 'update':
      return minutes.updateMinutes;
    case 'resolution':
      return minutes.resolutionMinutes;
    default:
      return null;
  }
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseIsoDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * The clock engine. Construct with {@link ServiceTargetEngine.create}.
 */
export class ServiceTargetEngine {
  readonly caseService: SupportCaseService;
  readonly targets: SupportServiceTargetCollection;
  readonly escalations: SupportEscalationCollection;
  readonly jobs: SmrtJobCollection;
  readonly scheduleJobs: boolean;

  private readonly options: SmrtObjectOptions;
  private routing?: SupportRoutingService;

  protected constructor(deps: {
    options: SmrtObjectOptions;
    caseService: SupportCaseService;
    targets: SupportServiceTargetCollection;
    escalations: SupportEscalationCollection;
    jobs: SmrtJobCollection;
    scheduleJobs: boolean;
  }) {
    this.options = deps.options;
    this.caseService = deps.caseService;
    this.targets = deps.targets;
    this.escalations = deps.escalations;
    this.jobs = deps.jobs;
    this.scheduleJobs = deps.scheduleJobs;
  }

  static async create(
    options: ServiceTargetEngineOptions,
  ): Promise<ServiceTargetEngine> {
    const { caseService, scheduleJobs, ...smrtOptions } = options;
    const [service, targets, escalations, jobs] = await Promise.all([
      caseService ?? SupportCaseService.create(smrtOptions),
      SupportServiceTargetCollection.create(smrtOptions),
      SupportEscalationCollection.create(smrtOptions),
      SmrtJobCollection.create(smrtOptions),
    ]);
    return new ServiceTargetEngine({
      options: smrtOptions,
      caseService: service,
      targets,
      escalations,
      jobs,
      scheduleJobs: scheduleJobs ?? true,
    });
  }

  private async resolveCase(
    caseRef: SupportCase | string,
  ): Promise<SupportCase> {
    return typeof caseRef === 'string'
      ? this.caseService.getCase(caseRef)
      : caseRef;
  }

  private requireId(entity: { id?: string | null }, label: string): string {
    if (!entity.id) {
      throw new Error(`${label} has no id — was it saved?`);
    }
    return entity.id;
  }

  private async getRoutingService(): Promise<SupportRoutingService> {
    if (!this.routing) {
      this.routing = await SupportRoutingService.create({
        ...this.options,
        caseService: this.caseService,
      });
    }
    return this.routing;
  }

  /**
   * Resolve the plan terms governing a case's clocks: the frozen
   * `planSnapshot` when present, else the loaded plan, else conservative
   * defaults (24×7 calendar, default target minutes, pause on
   * `waiting_on_client`, empty escalation policy).
   */
  async resolvePlanTerms(
    supportCase: SupportCase,
  ): Promise<ResolvedTargetPlanTerms> {
    const snapshot = supportCase.getPlanSnapshot();
    if (Object.keys(snapshot).length > 0) {
      const coverage = Array.isArray(snapshot.coverage)
        ? (snapshot.coverage as CoverageCalendar['windows'])
        : [];
      const calendar: CoverageCalendar = {
        windows: coverage,
        holidays: asStringArray(snapshot.holidays) ?? [],
        timezone:
          typeof snapshot.timezone === 'string' && snapshot.timezone
            ? snapshot.timezone
            : 'UTC',
      };
      const targets =
        snapshot.targets && typeof snapshot.targets === 'object'
          ? (snapshot.targets as Record<string, Partial<ServiceTargetMinutes>>)
          : {};
      return {
        calendar,
        // An explicit (even empty) snapshot list is authoritative — FR-29b:
        // clocks pause only when the plan says so.
        pauseStatuses:
          asStringArray(snapshot.pauseStatuses) ?? DEFAULT_PAUSE_STATUSES,
        escalationPolicy: Array.isArray(snapshot.escalationPolicy)
          ? (snapshot.escalationPolicy as EscalationStep[])
          : [],
        targetsForSeverity: (severity: string) => ({
          ...DEFAULT_TARGET_MINUTES,
          ...(targets[severity] ?? {}),
        }),
      };
    }

    if (supportCase.planId) {
      const plan = await this.caseService.plans.get({ id: supportCase.planId });
      if (plan) {
        return {
          calendar: {
            windows: plan.getCoverage(),
            holidays: plan.getHolidays(),
            timezone: plan.timezone || 'UTC',
          },
          pauseStatuses: plan.getPauseStatuses(),
          escalationPolicy: plan.getEscalationPolicy(),
          targetsForSeverity: (severity: string) =>
            plan.targetsForSeverity(severity),
        };
      }
    }

    return {
      calendar: { windows: [], holidays: [], timezone: 'UTC' },
      pauseStatuses: [...DEFAULT_PAUSE_STATUSES],
      escalationPolicy: [],
      targetsForSeverity: () => ({ ...DEFAULT_TARGET_MINUTES }),
    };
  }

  /**
   * Start the case's Service Target clocks (idempotent: target types that
   * already have an active clock are skipped). One clock per non-null
   * configured minutes for the case severity — the `update` clock only when
   * the plan configures `updateMinutes`. A first start creates cycle 0;
   * starting again after clocks settled (e.g. a reopen) creates the next
   * cycle, preserving the settled rows.
   */
  async startTargetsForCase(
    caseRef: SupportCase | string,
    opts: { at?: Date } = {},
  ): Promise<SupportServiceTarget[]> {
    const supportCase = await this.resolveCase(caseRef);
    return this.startTargets(supportCase, opts.at ?? new Date());
  }

  private async startTargets(
    supportCase: SupportCase,
    at: Date,
  ): Promise<SupportServiceTarget[]> {
    const caseId = this.requireId(supportCase, 'SupportCase');
    const terms = await this.resolvePlanTerms(supportCase);
    const severity = supportCase.severity || DEFAULT_SEVERITY_KEY;
    const minutes = terms.targetsForSeverity(severity);
    const existing = await this.targets.forCase(caseId);

    const created: SupportServiceTarget[] = [];
    for (const targetType of TARGET_TYPES) {
      const baseMinutes = targetMinutesFor(minutes, targetType);
      if (baseMinutes === null) {
        continue;
      }
      const active = await this.targets.activeTarget(caseId, targetType);
      if (active) {
        continue;
      }
      // Next cycle above any prior (settled) row of this type — first start
      // is cycle 0; a reopen starts the next cycle. Never reuse a settled
      // row's cycle: `(case_id, target_type, cycle)` are conflict columns,
      // so an equal-cycle create would upsert over the historical row.
      const prior = existing.filter(
        (target) => target.targetType === targetType,
      );
      const cycle =
        prior.length > 0
          ? Math.max(...prior.map((target) => target.cycle)) + 1
          : 0;
      created.push(
        await this.startTarget(supportCase, terms, {
          targetType,
          cycle,
          severity,
          baseMinutes,
          at,
        }),
      );
    }
    return created;
  }

  private async startTarget(
    supportCase: SupportCase,
    terms: ResolvedTargetPlanTerms,
    input: {
      targetType: ServiceTargetType;
      cycle: number;
      severity: string;
      baseMinutes: number;
      at: Date;
    },
  ): Promise<SupportServiceTarget> {
    const dueAt = addCoveredMinutes(
      terms.calendar,
      input.at,
      input.baseMinutes,
    );
    const target = await this.targets.create({
      tenantId: supportCase.tenantId,
      caseId: this.requireId(supportCase, 'SupportCase'),
      targetType: input.targetType,
      cycle: input.cycle,
      severity: input.severity,
      baseMinutes: input.baseMinutes,
      startedAt: input.at,
      dueAt,
      status: 'pending',
      metadata: JSON.stringify({ consumedMinutes: 0 }),
    });
    await this.scheduleEscalationJob(target, dueAt);
    await this.caseService.recordEvent(supportCase, 'target_scheduled', {
      actorKind: 'system',
      occurredAt: input.at,
      summary: `${input.targetType} target scheduled (cycle ${input.cycle}, due ${dueAt.toISOString()})`,
      payload: {
        targetId: target.id,
        targetType: input.targetType,
        cycle: input.cycle,
        severity: input.severity,
        baseMinutes: input.baseMinutes,
        dueAt: dueAt.toISOString(),
      },
    });
    return target;
  }

  /**
   * Enqueue the one-shot escalation job for a clock at `runAt` and record
   * its id on the target (`escalationJobId`) so satisfying can cancel it.
   */
  private async scheduleEscalationJob(
    target: SupportServiceTarget,
    runAt: Date,
  ): Promise<void> {
    if (!this.scheduleJobs) {
      return;
    }
    const job = await this.jobs.enqueueJob(
      {
        tenantId: target.tenantId ?? null,
        queue: SUPPORT_JOB_QUEUE,
        objectType: 'SupportServiceTarget',
        objectId: this.requireId(target, 'SupportServiceTarget'),
        method: 'checkAndEscalate',
        args: {},
        runAt,
        priority: ESCALATION_JOB_PRIORITY,
      },
      // Trusted internal caller: escalation jobs carry clock correctness, so
      // they must not be dropped by the per-tenant creation cap. Their count
      // is bounded by the tenant's active clocks.
      { tenantJobCap: 0 },
    );
    target.escalationJobId = job.id ?? '';
    await target.save();
  }

  /**
   * Cancel a clock's pending escalation job, tolerating jobs that already
   * ran, were cancelled, or are missing (at-least-once semantics).
   */
  private async cancelEscalationJob(
    target: SupportServiceTarget,
  ): Promise<void> {
    if (!target.escalationJobId) {
      return;
    }
    try {
      const job: SmrtJob | null = await this.jobs.get({
        id: target.escalationJobId,
      });
      if (job && (job.status === 'pending' || job.status === 'running')) {
        await job.cancel();
      }
    } catch {
      // Already terminal or missing — the target state is authoritative.
    }
  }

  /**
   * React to a recorded interaction. Outbound specialist/agent interactions
   * satisfy the acknowledgement clock (first outbound of any kind), the
   * response clock (first substantive outbound — the same trigger), and the
   * active update-cycle clock (which then restarts at the next cycle from
   * the interaction instant). Inbound client interactions never satisfy
   * clocks.
   */
  async onInteractionRecorded(
    caseRef: SupportCase | string,
    interaction: SupportInteraction,
  ): Promise<SupportServiceTarget[]> {
    if (interaction.direction !== 'outbound') {
      return [];
    }
    if (
      interaction.actorKind !== 'specialist' &&
      interaction.actorKind !== 'agent'
    ) {
      return [];
    }
    const supportCase = await this.resolveCase(caseRef);
    const caseId = this.requireId(supportCase, 'SupportCase');
    const at = interaction.occurredAt ?? new Date();
    const satisfied: SupportServiceTarget[] = [];

    for (const targetType of ['acknowledgement', 'response'] as const) {
      const target = await this.targets.activeTarget(caseId, targetType);
      if (target) {
        await this.satisfyTarget(supportCase, target, at);
        satisfied.push(target);
      }
    }

    const update = await this.targets.activeTarget(caseId, 'update');
    if (update) {
      await this.satisfyTarget(supportCase, update, at);
      satisfied.push(update);
      const terms = await this.resolvePlanTerms(supportCase);
      const severity = supportCase.severity || DEFAULT_SEVERITY_KEY;
      const updateMinutes = terms.targetsForSeverity(severity).updateMinutes;
      if (updateMinutes !== null) {
        await this.startTarget(supportCase, terms, {
          targetType: 'update',
          cycle: update.cycle + 1,
          severity,
          baseMinutes: updateMinutes,
          at,
        });
      }
    }

    return satisfied;
  }

  private async satisfyTarget(
    supportCase: SupportCase,
    target: SupportServiceTarget,
    at: Date,
  ): Promise<void> {
    if (target.pausedAt) {
      target.pausedTotalSeconds += Math.max(
        0,
        Math.round((at.getTime() - target.pausedAt.getTime()) / 1000),
      );
      target.pausedAt = null;
    }
    target.status = 'satisfied';
    target.satisfiedAt = at;
    await target.save();
    await this.cancelEscalationJob(target);
    await this.caseService.recordEvent(supportCase, 'target_satisfied', {
      actorKind: 'system',
      occurredAt: at,
      summary: `${target.targetType} target satisfied`,
      payload: {
        targetId: target.id,
        targetType: target.targetType,
        cycle: target.cycle,
      },
    });
  }

  /**
   * React to a case lifecycle transition:
   * - to `resolved` — satisfy the resolution clock, cancel every other
   *   active clock (and its job);
   * - to `closed` — cancel all remaining active clocks;
   * - reopen (`resolved`/`closed` → an open status) — start fresh clocks on
   *   the next cycle for every type;
   * - entering a plan pause status — freeze pending clocks (FR-29b: only
   *   when the plan says so);
   * - leaving a pause status — resume paused clocks with `dueAt` recomputed
   *   from the remaining covered minutes and a fresh escalation job.
   */
  async onCaseTransition(
    caseRef: SupportCase | string,
    from: SupportCaseStatus,
    to: SupportCaseStatus,
    opts: { at?: Date } = {},
  ): Promise<void> {
    const supportCase = await this.resolveCase(caseRef);
    const at = opts.at ?? new Date();

    if (to === 'resolved' || to === 'closed') {
      await this.settleTargetsForTerminal(supportCase, to, at);
      return;
    }

    const reopened =
      (from === 'resolved' || from === 'closed') &&
      OPEN_SUPPORT_CASE_STATUSES.includes(to);
    if (reopened) {
      await this.startTargets(supportCase, at);
      return;
    }

    const terms = await this.resolvePlanTerms(supportCase);
    const wasPaused = terms.pauseStatuses.includes(from);
    const nowPaused = terms.pauseStatuses.includes(to);
    if (!wasPaused && nowPaused) {
      await this.pauseTargets(supportCase, terms, at);
    } else if (wasPaused && !nowPaused) {
      await this.resumeTargets(supportCase, terms, at);
    }
  }

  private async settleTargetsForTerminal(
    supportCase: SupportCase,
    to: 'resolved' | 'closed',
    at: Date,
  ): Promise<void> {
    const caseId = this.requireId(supportCase, 'SupportCase');
    if (to === 'resolved') {
      const resolution = await this.targets.activeTarget(caseId, 'resolution');
      if (resolution) {
        await this.satisfyTarget(supportCase, resolution, at);
      }
    }
    const remaining = await this.targets.list({
      where: { caseId, 'status in': ['pending', 'paused'] },
    });
    for (const target of remaining) {
      if (target.pausedAt) {
        target.pausedTotalSeconds += Math.max(
          0,
          Math.round((at.getTime() - target.pausedAt.getTime()) / 1000),
        );
        target.pausedAt = null;
      }
      target.status = 'cancelled';
      target.cancelledAt = at;
      await target.save();
      await this.cancelEscalationJob(target);
    }
  }

  private async pauseTargets(
    supportCase: SupportCase,
    terms: ResolvedTargetPlanTerms,
    at: Date,
  ): Promise<void> {
    const caseId = this.requireId(supportCase, 'SupportCase');
    const pending = await this.targets.list({
      where: { caseId, status: 'pending' },
    });
    for (const target of pending) {
      const meta = target.getMetadata();
      // Covered minutes consumed by the segment that just ended (since the
      // last resume, or the clock start), accumulated across segments so
      // resume can compute the remaining covered minutes exactly.
      const segmentStart = parseIsoDate(meta.lastResumedAt) ?? target.startedAt;
      const consumedMinutes =
        asFiniteNumber(meta.consumedMinutes) +
        coveredMinutesBetween(terms.calendar, segmentStart, at);
      target.setMetadata({ ...meta, consumedMinutes });
      target.pausedAt = at;
      target.status = 'paused';
      await target.save();
      await this.cancelEscalationJob(target);
      await this.caseService.recordEvent(supportCase, 'target_paused', {
        actorKind: 'system',
        occurredAt: at,
        summary: `${target.targetType} target paused`,
        payload: {
          targetId: target.id,
          targetType: target.targetType,
          cycle: target.cycle,
          consumedMinutes,
        },
      });
    }
  }

  private async resumeTargets(
    supportCase: SupportCase,
    terms: ResolvedTargetPlanTerms,
    at: Date,
  ): Promise<void> {
    const caseId = this.requireId(supportCase, 'SupportCase');
    const paused = await this.targets.list({
      where: { caseId, status: 'paused' },
    });
    for (const target of paused) {
      const meta = target.getMetadata();
      const remainingMinutes = Math.max(
        target.baseMinutes - asFiniteNumber(meta.consumedMinutes),
        0,
      );
      if (target.pausedAt) {
        target.pausedTotalSeconds += Math.max(
          0,
          Math.round((at.getTime() - target.pausedAt.getTime()) / 1000),
        );
      }
      target.pausedAt = null;
      target.status = 'pending';
      const dueAt = addCoveredMinutes(terms.calendar, at, remainingMinutes);
      target.dueAt = dueAt;
      target.setMetadata({ ...meta, lastResumedAt: at.toISOString() });
      await target.save();
      await this.scheduleEscalationJob(target, dueAt);
      await this.caseService.recordEvent(supportCase, 'target_resumed', {
        actorKind: 'system',
        occurredAt: at,
        summary: `${target.targetType} target resumed (due ${dueAt.toISOString()})`,
        payload: {
          targetId: target.id,
          targetType: target.targetType,
          cycle: target.cycle,
          remainingMinutes,
          dueAt: dueAt.toISOString(),
        },
      });
    }
  }

  /**
   * Escalate a breached clock through the plan's escalation policy: write
   * the {@link SupportEscalation} audit row, apply the step action
   * (`notify` records the profiles to notify; `reassign` routes to the next
   * eligible specialist, excluding the current assignee), bump the case
   * escalation level, transition the case to `escalated` (unless already
   * resolved/closed), and schedule the next policy step when it declares a
   * `delayMinutes`.
   */
  async escalateForBreach(
    target: SupportServiceTarget,
    opts: { at?: Date } = {},
  ): Promise<void> {
    const at = opts.at ?? target.breachedAt ?? new Date();
    const supportCase = await this.caseService.getCase(target.caseId);
    const terms = await this.resolvePlanTerms(supportCase);
    const level = supportCase.escalationLevel + 1;
    const step: EscalationStep = terms.escalationPolicy[level - 1] ?? {
      level,
      action: 'notify',
    };

    const escalation = await this.escalations.create({
      tenantId: supportCase.tenantId,
      caseId: this.requireId(supportCase, 'SupportCase'),
      level,
      reason: 'target_breach',
      targetId: target.id,
      targetType: target.targetType,
      action: step.action,
      fromSpecialistId: supportCase.assignedSpecialistId,
      notifiedProfileIds: JSON.stringify(step.notifyProfileIds ?? []),
      occurredAt: at,
    });

    let reassignedTo: string | null = null;
    if (step.action === 'reassign') {
      const routing = await this.getRoutingService();
      const exclude = supportCase.assignedSpecialistId
        ? [supportCase.assignedSpecialistId]
        : [];
      const result = await routing.autoAssign(supportCase, {
        at,
        exclude,
        actorKind: 'system',
      });
      if (result.assigned && result.specialistId) {
        reassignedTo = result.specialistId;
        escalation.toSpecialistId = result.specialistId;
        await escalation.save();
      }
    }

    supportCase.escalationLevel = level;
    supportCase.escalatedAt = at;
    const terminal =
      supportCase.status === 'resolved' || supportCase.status === 'closed';
    if (!terminal && supportCase.status !== 'escalated') {
      await this.caseService.transition(supportCase, 'escalated', {
        actorKind: 'system',
        reason: `${target.targetType} target breached`,
      });
    } else {
      await supportCase.save();
    }

    await this.caseService.recordEvent(supportCase, 'target_breached', {
      actorKind: 'system',
      occurredAt: at,
      summary: `${target.targetType} target breached`,
      payload: {
        targetId: target.id,
        targetType: target.targetType,
        cycle: target.cycle,
        dueAt: target.dueAt.toISOString(),
      },
    });
    await this.caseService.recordEvent(supportCase, 'escalation', {
      actorKind: 'system',
      occurredAt: at,
      summary: `Escalated to level ${level} (${step.action})`,
      payload: {
        escalationId: escalation.id,
        level,
        action: step.action,
        targetId: target.id,
        targetType: target.targetType,
        notifiedProfileIds: step.notifyProfileIds ?? [],
        reassignedTo,
      },
    });

    // Delayed follow-up: the next policy step (when it declares a delay)
    // re-fires checkAndEscalate on the same target at `at + delay` wall
    // time; the pending level marker gates the breached-target branch.
    const next = terms.escalationPolicy[level];
    if (next && next.delayMinutes != null && next.delayMinutes >= 0) {
      const runAt = new Date(at.getTime() + next.delayMinutes * MINUTE_MS);
      const meta = target.getMetadata();
      target.setMetadata({
        ...meta,
        pendingEscalationLevel: next.level,
        pendingEscalationAt: runAt.toISOString(),
      });
      await target.save();
      if (this.scheduleJobs) {
        await this.jobs.enqueueJob(
          {
            tenantId: target.tenantId ?? null,
            queue: SUPPORT_JOB_QUEUE,
            objectType: 'SupportServiceTarget',
            objectId: this.requireId(target, 'SupportServiceTarget'),
            method: 'checkAndEscalate',
            args: {},
            runAt,
            priority: ESCALATION_JOB_PRIORITY,
          },
          { tenantJobCap: 0 },
        );
      }
    }
  }

  /**
   * Continue a delayed escalation on an already-breached clock: consumes the
   * pending-level marker and escalates the next policy step, unless the case
   * has since left its open states.
   */
  async continueEscalation(
    target: SupportServiceTarget,
    at: Date,
  ): Promise<boolean> {
    const meta = target.getMetadata();
    const pendingAt = parseIsoDate(meta.pendingEscalationAt);
    if (meta.pendingEscalationLevel == null || pendingAt === null) {
      return false;
    }
    if (at.getTime() < pendingAt.getTime()) {
      return false;
    }
    const {
      pendingEscalationLevel: _level,
      pendingEscalationAt: _at,
      ...rest
    } = meta;
    target.setMetadata(rest);
    await target.save();

    const supportCase = await this.caseService.getCase(target.caseId);
    if (!supportCase.isOpen()) {
      return false;
    }
    await this.escalateForBreach(target, { at });
    return true;
  }
}

export default ServiceTargetEngine;
