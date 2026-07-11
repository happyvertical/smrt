/**
 * ServiceTargetEngine tests (#1929): plan-snapshot clock creation with real
 * one-shot `_smrt_jobs` escalation rows, idempotent starts, satisfy-on-reply
 * with job cancellation, update-cycle recurrence, plan-governed pause/resume
 * (FR-29b), resolution settlement, and breach escalation through the plan's
 * policy steps (notify → delayed reassign).
 *
 * Real in-memory SQLite throughout — the `_smrt_jobs` table is created from
 * the runtime registry (the smrt-vitest plugin loads the jobs package
 * manifest cross-package) inside the isolated transaction, since the local
 * manifest file only carries this package's objects.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import { SmrtJobCollection } from '@happyvertical/smrt-jobs';
import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupportCase } from '../models/support-case.js';
import type { SupportPlan } from '../models/support-plan.js';
import {
  SupportEscalationCollection,
  type SupportServiceTarget,
  SupportServiceTargetCollection,
} from '../models/support-service-target.js';
import {
  SupportAvailabilityCollection,
  SupportSpecialistCollection,
} from '../models/support-specialist.js';
import type { EscalationStep } from '../types.js';
import { ServiceTargetEngine } from './service-target-engine.js';
import { SupportCaseService } from './support-case-service.js';

const MODEL_NAMES = [
  'SupportCase',
  'SupportInteraction',
  'SupportCaseEvent',
  'SupportWorkLink',
  'SupportPlan',
  'SupportServiceTarget',
  'SupportEscalation',
  'SupportSpecialist',
  'SupportQualification',
  'SupportAvailability',
  'SmrtJob',
];

// Fixed instants — 2026-01-05 is a Monday.
const T0 = new Date('2026-01-05T10:00:00Z');
const at = (isoTime: string): Date => new Date(`2026-01-05T${isoTime}Z`);

describe('ServiceTargetEngine', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let service: SupportCaseService;
  let engine: ServiceTargetEngine;
  let targets: SupportServiceTargetCollection;
  let escalations: SupportEscalationCollection;
  let jobs: SmrtJobCollection;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
    // `SmrtJob` lives in `@happyvertical/smrt-jobs`, outside this package's
    // manifest file — create its `_smrt_jobs` table from the runtime
    // registry inside the isolated transaction.
    await getTestDatabase({
      db: ctx.db as unknown as DatabaseInterface,
      classes: ['SmrtJob'],
      includeSystemTables: false,
    });
    service = await SupportCaseService.create({ db: ctx.db });
    engine = await ServiceTargetEngine.create({
      db: ctx.db,
      caseService: service,
    });
    targets = await SupportServiceTargetCollection.create({ db: ctx.db });
    escalations = await SupportEscalationCollection.create({ db: ctx.db });
    jobs = await SmrtJobCollection.create({ db: ctx.db });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function makePlan(
    overrides: Partial<{
      pauseStatuses: string[];
      escalationPolicy: EscalationStep[];
      updateMinutes: number | null;
    }> = {},
  ): Promise<SupportPlan> {
    return service.plans.create({
      planKey: `plan-${crypto.randomUUID().slice(0, 8)}`,
      name: 'Gold',
      timezone: 'UTC',
      coverage: '[]',
      holidays: '[]',
      targets: JSON.stringify({
        sev2: {
          acknowledgementMinutes: 30,
          responseMinutes: 120,
          updateMinutes: overrides.updateMinutes ?? 60,
          resolutionMinutes: 480,
        },
      }),
      pauseStatuses: JSON.stringify(
        overrides.pauseStatuses ?? ['waiting_on_client'],
      ),
      escalationPolicy: JSON.stringify(overrides.escalationPolicy ?? []),
    });
  }

  async function openPlannedCase(
    plan: SupportPlan,
    input: Record<string, unknown> = {},
  ): Promise<SupportCase> {
    return service.openCase({
      subject: 'Dashboard is slow',
      severity: 'sev2',
      planId: plan.id,
      ...input,
    });
  }

  async function reloadTarget(id: string): Promise<SupportServiceTarget> {
    const found = await targets.get({ id });
    if (!found) throw new Error(`target not found: ${id}`);
    return found;
  }

  function byType(
    list: SupportServiceTarget[],
    targetType: string,
  ): SupportServiceTarget {
    const found = list.find((target) => target.targetType === targetType);
    if (!found) throw new Error(`no ${targetType} target in ${list.length}`);
    return found;
  }

  describe('startTargetsForCase', () => {
    it('creates one clock per configured target type from the plan snapshot, with real pending jobs at dueAt', async () => {
      const plan = await makePlan();
      const supportCase = await openPlannedCase(plan);
      const created = await engine.startTargetsForCase(supportCase, { at: T0 });

      expect(created.map((t) => t.targetType).sort()).toEqual([
        'acknowledgement',
        'resolution',
        'response',
        'update',
      ]);
      const ack = byType(created, 'acknowledgement');
      expect(ack.status).toBe('pending');
      expect(ack.cycle).toBe(0);
      expect(ack.severity).toBe('sev2');
      expect(ack.baseMinutes).toBe(30);
      expect(ack.startedAt.toISOString()).toBe(T0.toISOString());
      expect(ack.dueAt.toISOString()).toBe(at('10:30:00').toISOString());
      expect(byType(created, 'response').dueAt.toISOString()).toBe(
        at('12:00:00').toISOString(),
      );
      expect(byType(created, 'update').dueAt.toISOString()).toBe(
        at('11:00:00').toISOString(),
      );
      expect(byType(created, 'resolution').dueAt.toISOString()).toBe(
        at('18:00:00').toISOString(),
      );

      // Real one-shot _smrt_jobs rows, linked via escalationJobId.
      for (const target of created) {
        expect(target.escalationJobId).toBeTruthy();
        const job = await jobs.get({ id: target.escalationJobId });
        expect(job).not.toBeNull();
        expect(job?.status).toBe('pending');
        expect(job?.queue).toBe('support');
        expect(job?.objectType).toBe('SupportServiceTarget');
        expect(job?.objectId).toBe(target.id);
        expect(job?.method).toBe('checkAndEscalate');
        expect(job?.priority).toBe(75);
        expect(job?.runAt.toISOString()).toBe(target.dueAt.toISOString());
      }

      const events = await service.events.forCase(supportCase.id ?? '', {
        eventType: 'target_scheduled',
      });
      expect(events).toHaveLength(4);
    });

    it('is idempotent while clocks are active', async () => {
      const plan = await makePlan();
      const supportCase = await openPlannedCase(plan);
      await engine.startTargetsForCase(supportCase, { at: T0 });
      const second = await engine.startTargetsForCase(supportCase, {
        at: at('10:05:00'),
      });

      expect(second).toHaveLength(0);
      expect(await targets.forCase(supportCase.id ?? '')).toHaveLength(4);
    });

    it('uses default target minutes when the case has no plan', async () => {
      const supportCase = await service.openCase({ subject: 'No plan' });
      const created = await engine.startTargetsForCase(supportCase, { at: T0 });

      // DEFAULT_TARGET_MINUTES: acknowledgement 60, response 240, no update,
      // no resolution.
      expect(created.map((t) => t.targetType).sort()).toEqual([
        'acknowledgement',
        'response',
      ]);
      expect(byType(created, 'acknowledgement').dueAt.toISOString()).toBe(
        at('11:00:00').toISOString(),
      );
    });

    it('skips job rows when scheduleJobs is disabled', async () => {
      const quietEngine = await ServiceTargetEngine.create({
        db: ctx.db,
        caseService: service,
        scheduleJobs: false,
      });
      const plan = await makePlan();
      const supportCase = await openPlannedCase(plan);
      const created = await quietEngine.startTargetsForCase(supportCase, {
        at: T0,
      });

      expect(created.length).toBeGreaterThan(0);
      expect(created.every((t) => t.escalationJobId === '')).toBe(true);
      expect(await jobs.listByStatus('pending')).toHaveLength(0);
    });
  });

  describe('onInteractionRecorded', () => {
    it('satisfies acknowledgement and response on the first outbound reply and cancels their jobs', async () => {
      const plan = await makePlan();
      const supportCase = await openPlannedCase(plan);
      const created = await engine.startTargetsForCase(supportCase, { at: T0 });
      const ackJobId = byType(created, 'acknowledgement').escalationJobId;
      const responseJobId = byType(created, 'response').escalationJobId;

      const interaction = await service.recordInteraction(supportCase, {
        direction: 'outbound',
        channelKind: 'chat',
        actorKind: 'specialist',
        body: 'Looking into it now.',
        occurredAt: at('10:10:00'),
      });
      await engine.onInteractionRecorded(supportCase, interaction);

      const ack = await reloadTarget(
        byType(created, 'acknowledgement').id ?? '',
      );
      const response = await reloadTarget(byType(created, 'response').id ?? '');
      expect(ack.status).toBe('satisfied');
      expect(ack.satisfiedAt?.toISOString()).toBe(at('10:10:00').toISOString());
      expect(response.status).toBe('satisfied');

      expect((await jobs.get({ id: ackJobId }))?.status).toBe('cancelled');
      expect((await jobs.get({ id: responseJobId }))?.status).toBe('cancelled');

      const satisfiedEvents = await service.events.forCase(
        supportCase.id ?? '',
        { eventType: 'target_satisfied' },
      );
      expect(satisfiedEvents.length).toBeGreaterThanOrEqual(2);
    });

    it('rolls the update clock to the next cycle from the interaction instant', async () => {
      const plan = await makePlan();
      const supportCase = await openPlannedCase(plan);
      const created = await engine.startTargetsForCase(supportCase, { at: T0 });
      const cycleZero = byType(created, 'update');

      const interaction = await service.recordInteraction(supportCase, {
        direction: 'outbound',
        channelKind: 'chat',
        actorKind: 'agent',
        body: 'Status update: mitigation in progress.',
        occurredAt: at('10:40:00'),
      });
      await engine.onInteractionRecorded(supportCase, interaction);

      expect((await reloadTarget(cycleZero.id ?? '')).status).toBe('satisfied');
      const next = await targets.activeTarget(supportCase.id ?? '', 'update');
      expect(next).not.toBeNull();
      expect(next?.cycle).toBe(1);
      expect(next?.startedAt.toISOString()).toBe(at('10:40:00').toISOString());
      expect(next?.dueAt.toISOString()).toBe(at('11:40:00').toISOString());
      const nextJob = await jobs.get({ id: next?.escalationJobId ?? '' });
      expect(nextJob?.status).toBe('pending');
      expect(nextJob?.runAt.toISOString()).toBe(at('11:40:00').toISOString());
    });

    it('a templated acknowledgement satisfies only the acknowledgement clock', async () => {
      const plan = await makePlan();
      const supportCase = await openPlannedCase(plan);
      const created = await engine.startTargetsForCase(supportCase, { at: T0 });
      const updateZero = byType(created, 'update');

      // The AI workflow marks its instant receipt with
      // `metadata.acknowledgement` — it must not satisfy response/update
      // clocks (that would neuter response Service Targets on AI cases).
      const ackInteraction = await service.recordInteraction(supportCase, {
        direction: 'outbound',
        channelKind: 'chat',
        actorKind: 'agent',
        body: 'Thanks — case opened, on it.',
        occurredAt: at('10:01:00'),
        metadata: { acknowledgement: true },
      });
      await engine.onInteractionRecorded(supportCase, ackInteraction);

      expect(
        (await reloadTarget(byType(created, 'acknowledgement').id ?? ''))
          .status,
      ).toBe('satisfied');
      expect(
        (await reloadTarget(byType(created, 'response').id ?? '')).status,
      ).toBe('pending');
      expect((await reloadTarget(updateZero.id ?? '')).status).toBe('pending');

      // The substantive answer then satisfies the response clock.
      const answer = await service.recordInteraction(supportCase, {
        direction: 'outbound',
        channelKind: 'chat',
        actorKind: 'agent',
        body: 'Here is the fix: …',
        occurredAt: at('10:15:00'),
      });
      await engine.onInteractionRecorded(supportCase, answer);
      expect(
        (await reloadTarget(byType(created, 'response').id ?? '')).status,
      ).toBe('satisfied');
    });

    it('never satisfies clocks from inbound client interactions', async () => {
      const plan = await makePlan();
      const supportCase = await openPlannedCase(plan);
      const created = await engine.startTargetsForCase(supportCase, { at: T0 });

      const inbound = await service.recordInteraction(supportCase, {
        direction: 'inbound',
        channelKind: 'chat',
        actorKind: 'client',
        body: 'Any update?',
        occurredAt: at('10:20:00'),
      });
      await engine.onInteractionRecorded(supportCase, inbound);

      const ack = await reloadTarget(
        byType(created, 'acknowledgement').id ?? '',
      );
      expect(ack.status).toBe('pending');
    });
  });

  describe('onCaseTransition — pause and resume (FR-29b)', () => {
    it('pauses pending clocks entering a plan pause status and resumes with the remaining covered minutes', async () => {
      const plan = await makePlan();
      const supportCase = await openPlannedCase(plan);
      const created = await engine.startTargetsForCase(supportCase, { at: T0 });
      const ack = byType(created, 'acknowledgement');
      const firstJobId = ack.escalationJobId;

      await service.transition(supportCase, 'in_progress', {
        actorKind: 'specialist',
      });
      await service.transition(supportCase, 'waiting_on_client', {
        actorKind: 'specialist',
      });
      await engine.onCaseTransition(
        supportCase,
        'in_progress',
        'waiting_on_client',
        { at: at('10:15:00') },
      );

      const paused = await reloadTarget(ack.id ?? '');
      expect(paused.status).toBe('paused');
      expect(paused.pausedAt?.toISOString()).toBe(at('10:15:00').toISOString());
      expect(paused.getMetadata().consumedMinutes).toBe(15);
      expect((await jobs.get({ id: firstJobId }))?.status).toBe('cancelled');

      await service.transition(supportCase, 'in_progress', {
        actorKind: 'specialist',
      });
      await engine.onCaseTransition(
        supportCase,
        'waiting_on_client',
        'in_progress',
        { at: at('11:00:00') },
      );

      const resumed = await reloadTarget(ack.id ?? '');
      expect(resumed.status).toBe('pending');
      expect(resumed.pausedAt).toBeNull();
      expect(resumed.pausedTotalSeconds).toBe(45 * 60);
      // 30 base − 15 consumed = 15 covered minutes left from 11:00.
      expect(resumed.dueAt.toISOString()).toBe(at('11:15:00').toISOString());
      expect(resumed.escalationJobId).not.toBe(firstJobId);
      const freshJob = await jobs.get({ id: resumed.escalationJobId });
      expect(freshJob?.status).toBe('pending');
      expect(freshJob?.runAt.toISOString()).toBe(at('11:15:00').toISOString());

      const caseId = supportCase.id ?? '';
      expect(
        await service.events.forCase(caseId, { eventType: 'target_paused' }),
      ).not.toHaveLength(0);
      expect(
        await service.events.forCase(caseId, { eventType: 'target_resumed' }),
      ).not.toHaveLength(0);
    });

    it('does NOT pause clocks when the plan does not list the status (FR-29b)', async () => {
      const plan = await makePlan({ pauseStatuses: [] });
      const supportCase = await openPlannedCase(plan);
      const created = await engine.startTargetsForCase(supportCase, { at: T0 });
      const ack = byType(created, 'acknowledgement');

      await service.transition(supportCase, 'in_progress', {
        actorKind: 'specialist',
      });
      await service.transition(supportCase, 'waiting_on_client', {
        actorKind: 'specialist',
      });
      await engine.onCaseTransition(
        supportCase,
        'in_progress',
        'waiting_on_client',
        { at: at('10:15:00') },
      );

      const untouched = await reloadTarget(ack.id ?? '');
      expect(untouched.status).toBe('pending');
      expect(untouched.dueAt.toISOString()).toBe(at('10:30:00').toISOString());
      expect((await jobs.get({ id: ack.escalationJobId }))?.status).toBe(
        'pending',
      );
    });
  });

  describe('onCaseTransition — resolution and reopen', () => {
    it('satisfies the resolution clock and cancels the rest on resolve', async () => {
      const plan = await makePlan();
      const supportCase = await openPlannedCase(plan);
      const created = await engine.startTargetsForCase(supportCase, { at: T0 });

      await service.resolve(supportCase, {
        actorKind: 'specialist',
        summary: 'Rebuilt the index.',
      });
      await engine.onCaseTransition(supportCase, 'new', 'resolved', {
        at: at('12:00:00'),
      });

      const resolution = await reloadTarget(
        byType(created, 'resolution').id ?? '',
      );
      expect(resolution.status).toBe('satisfied');
      for (const targetType of ['acknowledgement', 'response', 'update']) {
        const target = await reloadTarget(byType(created, targetType).id ?? '');
        expect(target.status).toBe('cancelled');
        expect(target.cancelledAt?.toISOString()).toBe(
          at('12:00:00').toISOString(),
        );
        expect((await jobs.get({ id: target.escalationJobId }))?.status).toBe(
          'cancelled',
        );
      }
    });

    it('starts fresh clocks on the next cycle when a case reopens', async () => {
      const plan = await makePlan();
      const supportCase = await openPlannedCase(plan);
      await engine.startTargetsForCase(supportCase, { at: T0 });
      await service.resolve(supportCase, {
        actorKind: 'specialist',
        summary: 'Done.',
      });
      await engine.onCaseTransition(supportCase, 'new', 'resolved', {
        at: at('12:00:00'),
      });

      await service.reopen(supportCase, { actorKind: 'client' });
      await engine.onCaseTransition(supportCase, 'resolved', 'triaged', {
        at: at('13:00:00'),
      });

      const ack = await targets.activeTarget(
        supportCase.id ?? '',
        'acknowledgement',
      );
      expect(ack).not.toBeNull();
      expect(ack?.cycle).toBe(1);
      expect(ack?.startedAt.toISOString()).toBe(at('13:00:00').toISOString());
      expect(ack?.dueAt.toISOString()).toBe(at('13:30:00').toISOString());
      expect(await targets.forCase(supportCase.id ?? '')).toHaveLength(8);
    });
  });

  describe('checkAndEscalate', () => {
    const POLICY: EscalationStep[] = [
      { level: 1, action: 'notify', notifyProfileIds: ['profile-lead'] },
      { level: 2, action: 'reassign', delayMinutes: 30 },
    ];

    async function breachedSetup(): Promise<{
      supportCase: SupportCase;
      ack: SupportServiceTarget;
    }> {
      const plan = await makePlan({ escalationPolicy: POLICY });
      const supportCase = await openPlannedCase(plan);
      const created = await engine.startTargetsForCase(supportCase, { at: T0 });
      return { supportCase, ack: byType(created, 'acknowledgement') };
    }

    it('marks an overdue pending clock breached, escalates level 1, and schedules the delayed level-2 step', async () => {
      const { supportCase, ack } = await breachedSetup();

      const result = await ack.checkAndEscalate({ at: at('11:00:00') });
      expect(result.outcome).toBe('breached');

      const breached = await reloadTarget(ack.id ?? '');
      expect(breached.status).toBe('breached');
      expect(breached.breachedAt?.toISOString()).toBe(
        at('11:00:00').toISOString(),
      );

      const rows = await escalations.forCase(supportCase.id ?? '');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.level).toBe(1);
      expect(rows[0]?.reason).toBe('target_breach');
      expect(rows[0]?.action).toBe('notify');
      expect(rows[0]?.targetId).toBe(ack.id);
      expect(rows[0]?.targetType).toBe('acknowledgement');
      expect(rows[0]?.getNotifiedProfileIds()).toEqual(['profile-lead']);

      const reloaded = await service.getCase(supportCase.id ?? '');
      expect(reloaded.escalationLevel).toBe(1);
      expect(reloaded.escalatedAt?.toISOString()).toBe(
        at('11:00:00').toISOString(),
      );
      expect(reloaded.status).toBe('escalated');

      const caseId = supportCase.id ?? '';
      expect(
        await service.events.forCase(caseId, { eventType: 'target_breached' }),
      ).toHaveLength(1);
      expect(
        await service.events.forCase(caseId, { eventType: 'escalation' }),
      ).toHaveLength(1);

      // The level-2 follow-up job: same target/method, 30 wall-clock minutes
      // later, with the pending level recorded on the target.
      const pending = await jobs.listByStatus('pending');
      const followUp = pending.find(
        (job) =>
          job.objectId === ack.id &&
          job.runAt.toISOString() === at('11:30:00').toISOString(),
      );
      expect(followUp).toBeTruthy();
      expect(breached.getMetadata().pendingEscalationLevel).toBe(2);
    });

    it('is idempotent on satisfied targets and on breached targets before the follow-up is due', async () => {
      const { supportCase, ack } = await breachedSetup();

      await ack.checkAndEscalate({ at: at('11:00:00') });
      // Redelivery (at-least-once) before the level-2 delay elapses: no-op.
      const redelivery = await ack.checkAndEscalate({ at: at('11:05:00') });
      expect(redelivery.outcome).toBe('noop');
      expect(await escalations.forCase(supportCase.id ?? '')).toHaveLength(1);
      expect(
        (await service.getCase(supportCase.id ?? '')).escalationLevel,
      ).toBe(1);

      // Satisfied clocks never escalate. (Reload the case: the escalation
      // above transitioned the persisted row to 'escalated'.)
      const escalatedCase = await service.getCase(supportCase.id ?? '');
      const created = await targets.forCase(supportCase.id ?? '');
      const response = byType(created, 'response');
      const interaction = await service.recordInteraction(escalatedCase, {
        direction: 'outbound',
        channelKind: 'chat',
        actorKind: 'specialist',
        body: 'Answered.',
        occurredAt: at('11:10:00'),
      });
      await engine.onInteractionRecorded(escalatedCase, interaction);
      const satisfiedResult = await response.checkAndEscalate({
        at: at('12:30:00'),
      });
      expect(satisfiedResult.outcome).toBe('noop');
      expect(await escalations.forCase(supportCase.id ?? '')).toHaveLength(1);
    });

    it('no-ops when the clock was rescheduled to a later dueAt', async () => {
      const { ack } = await breachedSetup();
      const result = await ack.checkAndEscalate({ at: at('10:15:00') });
      expect(result.outcome).toBe('rescheduled');
      expect((await reloadTarget(ack.id ?? '')).status).toBe('pending');
    });

    it('level-2 reassign moves the case to the next eligible specialist, excluding the current assignee', async () => {
      const specialists = await SupportSpecialistCollection.create({
        db: ctx.db,
      });
      const availabilities = await SupportAvailabilityCollection.create({
        db: ctx.db,
      });

      const current = await specialists.create({
        profileId: 'profile-current',
        displayName: 'Current Carol',
        timezone: 'UTC',
      });
      const backup = await specialists.create({
        profileId: 'profile-backup',
        displayName: 'Backup Bob',
        timezone: 'UTC',
      });
      for (const specialist of [current, backup]) {
        await availabilities.create({
          specialistId: specialist.id,
          kind: 'weekly',
          weekday: 1,
          startMinute: 0,
          endMinute: 1440,
        });
      }

      const { supportCase, ack } = await breachedSetup();
      await service.assign(supportCase, {
        actorKind: 'system',
        specialistId: current.id ?? '',
      });

      await ack.checkAndEscalate({ at: at('11:00:00') });
      const followUp = await ack.checkAndEscalate({ at: at('11:30:00') });
      expect(followUp.outcome).toBe('escalated');

      const rows = await escalations.forCase(supportCase.id ?? '');
      expect(rows).toHaveLength(2);
      const level2 = rows.find((row) => row.level === 2);
      expect(level2?.action).toBe('reassign');
      expect(level2?.fromSpecialistId).toBe(current.id);
      expect(level2?.toSpecialistId).toBe(backup.id);

      const reloaded = await service.getCase(supportCase.id ?? '');
      expect(reloaded.escalationLevel).toBe(2);
      expect(reloaded.assignedSpecialistId).toBe(backup.id);
    });
  });
});
