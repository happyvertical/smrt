/**
 * HumanHandoffService tests (#1928): the lossless Human Handoff — the full
 * context package (case state + merged timeline + AI runs) travels with the
 * handoff so the Client never repeats themselves, the routing seam records
 * assignments with rationale, unrouted cases queue for triage, and the
 * no-repeat guarantee dedupes triggers until released.
 */

import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type HandoffContextPackage,
  HumanHandoffService,
} from './human-handoff-service.js';
import {
  type SupportAiBoundary,
  SupportAiWorkflow,
} from './support-ai-workflow.js';
import { SupportCaseService } from './support-case-service.js';

const MODEL_NAMES = [
  'SupportCase',
  'SupportInteraction',
  'SupportCaseEvent',
  'SupportWorkLink',
  'SupportPlan',
  'SupportPolicy',
  'SupportAiRun',
];

describe('HumanHandoffService', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let caseService: SupportCaseService;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
    caseService = await SupportCaseService.create({ db: ctx.db });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function openCase(overrides: Record<string, unknown> = {}) {
    return caseService.openCase({
      subject: 'Checkout intermittently fails',
      description: 'Roughly one in ten checkouts errors out.',
      channelKind: 'chat',
      clientProfileId: 'client-1',
      projectId: 'project-9',
      ...overrides,
    });
  }

  it('transfers the complete case context: state, timeline, and AI runs', async () => {
    const plan = await caseService.plans.create({
      planKey: 'gold',
      name: 'Gold',
    });
    const boundary: SupportAiBoundary = {
      classify: () =>
        Promise.resolve({
          severity: 'sev3',
          category: 'performance',
          sensitive: false,
          confidence: 0.8,
        }),
      answer: () =>
        Promise.resolve({
          reply: 'Retry with the cache disabled.',
          confidence: 0.9,
          proposedResolution: false,
        }),
    };
    const workflow = await SupportAiWorkflow.create({ db: ctx.db, boundary });
    const supportCase = await workflow.caseService.openCase({
      subject: 'Checkout intermittently fails',
      description: 'Roughly one in ten checkouts errors out.',
      channelKind: 'chat',
      clientProfileId: 'client-1',
      projectId: 'project-9',
      planId: plan.id,
    });
    await workflow.caseService.recordInteraction(supportCase, {
      direction: 'inbound',
      channelKind: 'chat',
      actorKind: 'client',
      body: 'Roughly one in ten checkouts errors out.',
      sourceKey: 'chat:msg-1',
    });
    await workflow.processCase(supportCase.id ?? '');

    const handoffs = await HumanHandoffService.create({ db: ctx.db });
    const result = await handoffs.handoff(supportCase.id ?? '', {
      trigger: 'manual',
      note: 'operator escalation',
    });
    expect(result.alreadyActive).toBe(false);

    const events = await caseService.events.forCase(supportCase.id ?? '', {
      eventType: 'handoff',
    });
    expect(events).toHaveLength(1);
    const payload = events[0]?.getPayload() as {
      trigger: string;
      note: string | null;
      contextPackage: HandoffContextPackage;
    };
    expect(payload.trigger).toBe('manual');
    expect(payload.note).toBe('operator escalation');

    const pkg = payload.contextPackage;
    expect(pkg.caseNumber).toBe(supportCase.caseNumber);
    expect(pkg.subject).toBe('Checkout intermittently fails');
    expect(pkg.status).toBe('new');
    expect(pkg.severity).toBe('sev3');
    expect(pkg.category).toBe('performance');
    expect(pkg.clientProfileId).toBe('client-1');
    expect(pkg.projectId).toBe('project-9');
    expect(pkg.planId).toBe(plan.id);

    // The client's own words travel with the handoff (FR-28b).
    expect(
      pkg.timeline.some(
        (item) =>
          item.kind === 'interaction' &&
          item.body === 'Roughly one in ten checkouts errors out.',
      ),
    ).toBe(true);
    expect(pkg.timeline.some((item) => item.kind === 'event')).toBe(true);
    expect(pkg.timeline.every((item) => item.occurredAt.length > 0)).toBe(true);

    // Every prior automated-work run is included.
    expect(pkg.aiRuns).toHaveLength(5);
    expect(
      pkg.aiRuns.some(
        (run) =>
          run.phase === 'classify' &&
          (run.classification as { severity?: string }).severity === 'sev3',
      ),
    ).toBe(true);
    expect(
      pkg.aiRuns.some(
        (run) => run.phase === 'answer' && run.confidence === 0.9,
      ),
    ).toBe(true);

    // buildContextPackage is directly consumable by apps.
    const direct = await handoffs.buildContextPackage(supportCase.id ?? '');
    expect(direct.caseNumber).toBe(pkg.caseNumber);
    expect(direct.aiRuns).toHaveLength(5);

    // The unrouted handoff queued the case for a human.
    expect(result.supportCase.status).toBe('triaged');
  });

  it('routes through the assignSpecialist seam and records the rationale', async () => {
    const calls: Array<{ caseId: string | null; trigger: string }> = [];
    const handoffs = await HumanHandoffService.create({
      db: ctx.db,
      assignSpecialist: (supportCase, context) => {
        calls.push({
          caseId: supportCase.id ?? null,
          trigger: context.trigger,
        });
        return Promise.resolve({
          specialistId: 'spec-77',
          rationale: { score: 0.92 },
        });
      },
    });
    const supportCase = await openCase();

    const result = await handoffs.handoff(supportCase, {
      trigger: 'high_severity',
    });

    expect(calls).toEqual([
      { caseId: supportCase.id, trigger: 'high_severity' },
    ]);
    expect(result.supportCase.assignedSpecialistId).toBe('spec-77');
    expect(result.supportCase.status).toBe('assigned');

    const assignments = await caseService.events.forCase(supportCase.id ?? '', {
      eventType: 'assignment',
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.getPayload()).toMatchObject({
      specialistId: 'spec-77',
      rationale: { score: 0.92 },
    });
  });

  it('queues the case for triage when no routing seam is configured', async () => {
    const handoffs = await HumanHandoffService.create({ db: ctx.db });
    const supportCase = await openCase();

    await handoffs.handoff(supportCase, { trigger: 'low_confidence' });

    expect(supportCase.status).toBe('triaged');
    expect(supportCase.assignedSpecialistId).toBeNull();
    const transitions = await caseService.events.forCase(supportCase.id ?? '', {
      eventType: 'transition',
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.getPayload()).toMatchObject({
      from: 'new',
      to: 'triaged',
      reason: 'human handoff queued',
    });
  });

  it('dedupes repeat handoffs while active and allows a new one after release', async () => {
    const handoffs = await HumanHandoffService.create({ db: ctx.db });
    const supportCase = await openCase();

    const first = await handoffs.handoff(supportCase, {
      trigger: 'low_confidence',
    });
    expect(first.alreadyActive).toBe(false);

    const repeat = await handoffs.handoff(supportCase, {
      trigger: 'high_severity',
    });
    expect(repeat.alreadyActive).toBe(true);

    await handoffs.releaseHandoff(supportCase);
    const afterRelease = await handoffs.handoff(supportCase, {
      trigger: 'manual',
    });
    expect(afterRelease.alreadyActive).toBe(false);

    const payloads = (
      await caseService.events.forCase(supportCase.id ?? '', {
        eventType: 'handoff',
      })
    ).map((event) => event.getPayload());
    expect(payloads).toHaveLength(3);
    const deduped = payloads.filter((payload) => payload.deduped === true);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.trigger).toBe('high_severity');
  });

  it('stamps the client human request on client_request triggers', async () => {
    const handoffs = await HumanHandoffService.create({ db: ctx.db });
    const supportCase = await openCase();

    await handoffs.handoff(supportCase, {
      trigger: 'client_request',
      requestedByProfileId: 'client-1',
      note: 'please, a person',
    });

    expect(supportCase.humanRequestedAt).toBeInstanceOf(Date);
    const requests = await caseService.events.forCase(supportCase.id ?? '', {
      eventType: 'human_requested',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.actorProfileId).toBe('client-1');
    expect(requests[0]?.getPayload()).toMatchObject({
      note: 'please, a person',
    });
  });
});
