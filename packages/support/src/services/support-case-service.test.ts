/**
 * SupportCaseService tests (#1926): the closed write facade — case opening
 * with plan snapshots, interaction recording (idempotent, response stamps,
 * waiting-on-client unpark), guarded transitions with audit events,
 * assignment, resolution, reopen history, work links, and the merged
 * timeline.
 */

import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SupportCaseService } from './support-case-service.js';

const MODEL_NAMES = [
  'SupportCase',
  'SupportInteraction',
  'SupportCaseEvent',
  'SupportWorkLink',
  'SupportPlan',
];

describe('SupportCaseService', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let service: SupportCaseService;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
    service = await SupportCaseService.create({ db: ctx.db });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('opens a case with a created event and a case number', async () => {
    const supportCase = await service.openCase({
      subject: 'Cannot log in',
      description: 'Password reset loops forever',
      clientProfileId: 'profile-client-1',
      channelKind: 'chat',
    });

    expect(supportCase.caseNumber).toMatch(/^SUP-/);
    expect(supportCase.status).toBe('new');

    const events = await service.events.forCase(supportCase.id ?? '');
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('created');
  });

  it('captures the plan snapshot when opening under a plan', async () => {
    const plan = await service.plans.create({
      planKey: 'gold',
      name: 'Gold',
      includedMinutes: 600,
      overageHourlyRate: 150.0,
    });
    const supportCase = await service.openCase({
      subject: 'Slow dashboard',
      planId: plan.id,
    });

    expect(supportCase.planId).toBe(plan.id);
    const snapshot = supportCase.getPlanSnapshot();
    expect(snapshot.planKey).toBe('gold');
    expect(snapshot.overageHourlyRate).toBe(150);

    const events = await service.events.forCase(supportCase.id ?? '');
    expect(events.map((event) => event.eventType)).toContain('plan_applied');
  });

  describe('recordInteraction', () => {
    it('is idempotent on sourceKey', async () => {
      const supportCase = await service.openCase({ subject: 'dup test' });
      const first = await service.recordInteraction(supportCase, {
        direction: 'inbound',
        channelKind: 'chat',
        actorKind: 'client',
        body: 'hello',
        sourceKey: 'chat:msg-1',
      });
      const second = await service.recordInteraction(supportCase, {
        direction: 'inbound',
        channelKind: 'chat',
        actorKind: 'client',
        body: 'hello again (same transport row)',
        sourceKey: 'chat:msg-1',
      });

      expect(second.id).toBe(first.id);
      const all = await service.interactions.forCase(supportCase.id ?? '');
      expect(all).toHaveLength(1);
    });

    it('stamps acknowledgedAt and firstRespondedAt on the first outbound reply', async () => {
      const supportCase = await service.openCase({ subject: 'stamps' });
      expect(supportCase.acknowledgedAt).toBeNull();

      await service.recordInteraction(supportCase, {
        direction: 'outbound',
        channelKind: 'chat',
        actorKind: 'agent',
        body: 'On it!',
      });

      expect(supportCase.acknowledgedAt).toBeInstanceOf(Date);
      expect(supportCase.firstRespondedAt).toBeInstanceOf(Date);
    });

    it('an acknowledgement-marked receipt stamps acknowledgedAt but not firstRespondedAt', async () => {
      const supportCase = await service.openCase({ subject: 'ack only' });

      await service.recordInteraction(supportCase, {
        direction: 'outbound',
        channelKind: 'chat',
        actorKind: 'agent',
        body: 'Thanks — case opened.',
        metadata: { acknowledgement: true },
      });
      expect(supportCase.acknowledgedAt).toBeInstanceOf(Date);
      expect(supportCase.firstRespondedAt).toBeNull();

      await service.recordInteraction(supportCase, {
        direction: 'outbound',
        channelKind: 'chat',
        actorKind: 'agent',
        body: 'Here is the actual answer.',
      });
      expect(supportCase.firstRespondedAt).toBeInstanceOf(Date);
    });

    it('moves a waiting_on_client case back to in_progress on inbound', async () => {
      const supportCase = await service.openCase({ subject: 'unpark' });
      await service.transition(supportCase, 'in_progress', {
        actorKind: 'specialist',
      });
      await service.transition(supportCase, 'waiting_on_client', {
        actorKind: 'specialist',
      });

      await service.recordInteraction(supportCase, {
        direction: 'inbound',
        channelKind: 'chat',
        actorKind: 'client',
        body: 'here is the info you asked for',
      });

      expect(supportCase.status).toBe('in_progress');
    });
  });

  it('records transition audit events with from/to', async () => {
    const supportCase = await service.openCase({ subject: 'audit' });
    await service.transition(supportCase, 'triaged', {
      actorKind: 'specialist',
      actorProfileId: 'profile-spec-1',
      reason: 'triage sweep',
    });

    const events = await service.events.forCase(supportCase.id ?? '', {
      eventType: 'transition',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.getPayload()).toMatchObject({
      from: 'new',
      to: 'triaged',
      reason: 'triage sweep',
    });
  });

  it('assigns and reassigns with rationale, flipping new/triaged to assigned', async () => {
    const supportCase = await service.openCase({ subject: 'assign' });
    await service.assign(supportCase, {
      actorKind: 'system',
      specialistId: 'spec-1',
      rationale: { score: 0.9 },
    });
    expect(supportCase.status).toBe('assigned');
    expect(supportCase.assignedSpecialistId).toBe('spec-1');

    await service.assign(supportCase, {
      actorKind: 'specialist',
      actorProfileId: 'manager-1',
      specialistId: 'spec-2',
    });
    expect(supportCase.assignedSpecialistId).toBe('spec-2');

    const events = await service.events.forCase(supportCase.id ?? '', {
      eventType: 'assignment',
    });
    expect(events).toHaveLength(2);
    expect(events[1]?.getPayload()).toMatchObject({
      specialistId: 'spec-2',
      previousSpecialistId: 'spec-1',
    });
  });

  it('resolves, closes, and reopens preserving the prior resolution in history', async () => {
    const supportCase = await service.openCase({ subject: 'lifecycle' });
    await service.resolve(supportCase, {
      actorKind: 'specialist',
      actorProfileId: 'spec-1',
      summary: 'Cleared the cache',
      resolutionKind: 'human',
    });
    expect(supportCase.status).toBe('resolved');
    expect(supportCase.resolutionSummary).toBe('Cleared the cache');

    await service.close(supportCase, { actorKind: 'system' });
    expect(supportCase.status).toBe('closed');
    expect(supportCase.closedAt).toBeInstanceOf(Date);

    await service.reopen(supportCase, {
      actorKind: 'client',
      reason: 'It broke again',
    });
    expect(supportCase.status).toBe('triaged');
    expect(supportCase.reopenCount).toBe(1);
    expect(supportCase.resolvedAt).toBeNull();
    expect(supportCase.resolutionSummary).toBe('');

    const reopenEvents = await service.events.forCase(supportCase.id ?? '', {
      eventType: 'reopened',
    });
    expect(reopenEvents).toHaveLength(1);
    const payload = reopenEvents[0]?.getPayload() as {
      priorResolution: { resolutionSummary: string };
    };
    expect(payload.priorResolution.resolutionSummary).toBe('Cleared the cache');
  });

  it('records a client human request once and audits every ask', async () => {
    const supportCase = await service.openCase({ subject: 'human please' });
    await service.requestHuman(supportCase, { byProfileId: 'client-1' });
    const stamped = supportCase.humanRequestedAt;
    expect(stamped).toBeInstanceOf(Date);

    await service.requestHuman(supportCase, { byProfileId: 'client-1' });
    expect(supportCase.humanRequestedAt).toEqual(stamped);

    const events = await service.events.forCase(supportCase.id ?? '', {
      eventType: 'human_requested',
    });
    expect(events).toHaveLength(2);
  });

  it('links delivery work and records status echoes without driving execution', async () => {
    const supportCase = await service.openCase({ subject: 'bug fix needed' });
    const link = await service.linkWork(supportCase, {
      actorKind: 'specialist',
      linkKind: 'development_work_item',
      targetType: '@happyvertical/smrt-projects:Issue',
      targetId: 'issue-42',
      targetLabel: 'web#42: fix login',
      externalUrl: 'https://github.com/acme/web/issues/42',
    });
    expect(link.linkKind).toBe('development_work_item');

    await service.recordWorkStatus(link.id ?? '', {
      status: 'done',
      note: 'deployed in v1.2.3',
    });
    const reloaded = await service.workLinks.get({ id: link.id });
    expect(reloaded?.status).toBe('done');
    expect(reloaded?.lastStatusAt).toBeInstanceOf(Date);

    const events = await service.events.forCase(supportCase.id ?? '', {
      eventType: 'work_linked',
    });
    expect(events).toHaveLength(2);
  });

  it('merges interactions and events into one chronological timeline', async () => {
    const supportCase = await service.openCase({ subject: 'timeline' });
    await service.recordInteraction(supportCase, {
      direction: 'inbound',
      channelKind: 'chat',
      actorKind: 'client',
      body: 'first message',
      occurredAt: new Date(Date.now() - 60_000),
    });
    await service.transition(supportCase, 'triaged', { actorKind: 'system' });

    const timeline = await service.getTimeline(supportCase.id ?? '');
    expect(timeline.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < timeline.length; i++) {
      const current = timeline[i];
      const previous = timeline[i - 1];
      expect(current?.occurredAt.getTime()).toBeGreaterThanOrEqual(
        previous?.occurredAt.getTime() ?? 0,
      );
    }
    expect(timeline.some((item) => item.kind === 'interaction')).toBe(true);
    expect(timeline.some((item) => item.kind === 'event')).toBe(true);
  });
});
