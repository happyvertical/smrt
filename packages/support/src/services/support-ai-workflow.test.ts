/**
 * SupportAiWorkflow tests (#1928): the Automated Support Response pass —
 * auditable per-phase runs, conservative defaults, policy-gated autonomous
 * resolution, and every Human Handoff trigger (low confidence, sensitivity,
 * high severity, explicit client request, boundary failure, attempt caps)
 * with the no-repeat guarantee. Only the AI boundary and the knowledge
 * provider are mocked — they model the external AI calls.
 */

import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type KnowledgeSnippet,
  type SupportAiAnswerResult,
  type SupportAiBoundary,
  type SupportAiClassifyResult,
  SupportAiWorkflow,
  type SupportKnowledgeProvider,
  severityRank,
} from './support-ai-workflow.js';
import type { OpenCaseInput } from './support-case-service.js';

const MODEL_NAMES = [
  'SupportCase',
  'SupportInteraction',
  'SupportCaseEvent',
  'SupportWorkLink',
  'SupportPlan',
  'SupportPolicy',
  'SupportAiRun',
];

interface BoundaryScript {
  classify?: Partial<SupportAiClassifyResult>;
  answer?: Partial<SupportAiAnswerResult>;
  classifyError?: Error;
  answerError?: Error;
}

const DEFAULT_REPLY = 'Clearing the CDN cache resolves the 500 errors.';

function createBoundary(script: BoundaryScript = {}) {
  const classifyCalls: Array<{
    subject: string;
    body: string;
    severityKeys: string[];
    sensitiveCategories: string[];
  }> = [];
  const answerCalls: Array<{
    subject: string;
    body: string;
    knowledge: KnowledgeSnippet[];
    caseSummary: string;
  }> = [];
  const boundary: SupportAiBoundary = {
    classify(input) {
      classifyCalls.push(input);
      if (script.classifyError) {
        return Promise.reject(script.classifyError);
      }
      return Promise.resolve({
        severity: 'sev4',
        category: 'question',
        sensitive: false,
        confidence: 0.9,
        ...script.classify,
      });
    },
    answer(input) {
      answerCalls.push(input);
      if (script.answerError) {
        return Promise.reject(script.answerError);
      }
      return Promise.resolve({
        reply: DEFAULT_REPLY,
        confidence: 0.9,
        proposedResolution: false,
        ...script.answer,
      });
    },
  };
  return { boundary, classifyCalls, answerCalls };
}

describe('SupportAiWorkflow', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createWorkflow(
    script: BoundaryScript = {},
    extras: { knowledge?: KnowledgeSnippet[] } = {},
  ) {
    const { boundary, classifyCalls, answerCalls } = createBoundary(script);
    const knowledge: SupportKnowledgeProvider = {
      retrieve: () => Promise.resolve(extras.knowledge ?? []),
    };
    const workflow = await SupportAiWorkflow.create({
      db: ctx.db,
      boundary,
      knowledge,
    });
    return { workflow, classifyCalls, answerCalls };
  }

  function openCase(
    workflow: SupportAiWorkflow,
    overrides: Partial<OpenCaseInput> = {},
  ) {
    return workflow.caseService.openCase({
      subject: 'Dashboard shows 500 errors',
      description: 'Every page load returns a 500 since this morning.',
      channelKind: 'chat',
      clientProfileId: 'client-1',
      ...overrides,
    });
  }

  async function outboundFor(workflow: SupportAiWorkflow, caseId: string) {
    const interactions =
      await workflow.caseService.interactions.forCase(caseId);
    return interactions.filter((item) => item.direction === 'outbound');
  }

  async function handoffPayloads(workflow: SupportAiWorkflow, caseId: string) {
    const events = await workflow.caseService.events.forCase(caseId, {
      eventType: 'handoff',
    });
    return events.map((event) => event.getPayload());
  }

  it('records an auditable Automated Support Response on intake', async () => {
    const snippets: KnowledgeSnippet[] = [
      {
        kind: 'fact',
        ref: 'fact-42',
        label: 'CDN KB',
        content: 'Clearing the CDN cache fixes stale 500s.',
      },
    ];
    const { workflow, answerCalls } = await createWorkflow(
      { classify: { severity: 'sev3', category: 'availability' } },
      { knowledge: snippets },
    );
    const supportCase = await openCase(workflow);
    const interaction = await workflow.caseService.recordInteraction(
      supportCase,
      {
        direction: 'inbound',
        channelKind: 'chat',
        actorKind: 'client',
        body: 'Every page load returns a 500 since this morning.',
        sourceKey: 'chat:msg-1',
      },
    );

    const runs = await workflow.processIntake({
      outcome: 'created',
      supportCase,
      interaction,
    });

    expect(runs.map((run) => `${run.phase}:${run.outcome}`)).toEqual([
      'acknowledge:completed',
      'classify:completed',
      'answer:completed',
      'troubleshoot:skipped',
      'resolve:skipped',
    ]);

    // The acknowledgement and the answer are real outbound interactions.
    const outbound = await outboundFor(workflow, supportCase.id ?? '');
    expect(outbound).toHaveLength(2);
    const ack = outbound.find((item) => item.sourceKey.startsWith('ai:ack:'));
    const answer = outbound.find((item) =>
      item.sourceKey.startsWith('ai:answer:'),
    );
    expect(ack?.body).toContain(supportCase.caseNumber);
    expect(ack?.actorKind).toBe('agent');
    expect(answer?.body).toBe(DEFAULT_REPLY);
    expect(answer?.actorKind).toBe('agent');

    // Each run is auditable: correlation ids, confidence, knowledge refs.
    const answerRun = runs[2];
    expect(answerRun?.confidence).toBeCloseTo(0.9);
    expect(answerRun?.getKnowledgeRefs()).toMatchObject([
      { kind: 'fact', ref: 'fact-42' },
    ]);
    expect(answerRun?.responseInteractionId).toBe(answer?.id);
    expect(runs.every((run) => (run.correlationId ?? '').length > 0)).toBe(
      true,
    );
    expect(runs.every((run) => run.interactionId === interaction.id)).toBe(
      true,
    );
    const classifyRun = runs[1];
    expect(classifyRun?.getClassification()).toMatchObject({
      severity: 'sev3',
      category: 'availability',
      sensitive: false,
    });

    // The boundary saw the retrieved knowledge and the case summary.
    expect(answerCalls).toHaveLength(1);
    expect(answerCalls[0]?.knowledge).toEqual(snippets);
    expect(answerCalls[0]?.caseSummary).toContain(supportCase.caseNumber);

    // The classification landed on the case; the ack stamped the clock.
    const reloaded = await workflow.caseService.getCase(supportCase.id ?? '');
    expect(reloaded.severity).toBe('sev3');
    expect(reloaded.category).toBe('availability');
    expect(reloaded.acknowledgedAt).toBeInstanceOf(Date);

    // The case audit trail carries one ai_run event per phase.
    const aiRunEvents = await workflow.caseService.events.forCase(
      supportCase.id ?? '',
      { eventType: 'ai_run' },
    );
    expect(aiRunEvents).toHaveLength(5);
  });

  it('keeps conservative defaults: no policy row never resolves a case', async () => {
    // Even a would-be-resolving answer stays advisory without a policy row.
    const { workflow } = await createWorkflow({
      answer: { confidence: 0.99, proposedResolution: true },
    });
    const supportCase = await openCase(workflow);

    const runs = await workflow.processCase(supportCase.id ?? '');

    expect(runs.map((run) => `${run.phase}:${run.outcome}`)).toEqual([
      'acknowledge:completed',
      'classify:completed',
      'answer:completed',
      'troubleshoot:skipped',
      'resolve:skipped',
    ]);
    const reloaded = await workflow.caseService.getCase(supportCase.id ?? '');
    expect(reloaded.status).toBe('new');
    expect(reloaded.resolvedAt).toBeNull();
    expect(reloaded.resolutionKind).toBe('');
  });

  it('resolves autonomously when the policy allows it', async () => {
    const { workflow } = await createWorkflow({
      classify: { severity: 'sev4', confidence: 0.95 },
      answer: { confidence: 0.95, proposedResolution: true },
    });
    await workflow.policies.create({
      name: 'auto-resolve-low-risk',
      autoResolve: true,
      autoResolveMaxSeverity: 'sev3',
      confidenceThreshold: 0.7,
    });
    const supportCase = await openCase(workflow);

    const runs = await workflow.processCase(supportCase.id ?? '');

    expect(runs[4]?.phase).toBe('resolve');
    expect(runs[4]?.outcome).toBe('completed');
    const reloaded = await workflow.caseService.getCase(supportCase.id ?? '');
    expect(reloaded.status).toBe('resolved');
    expect(reloaded.resolutionKind).toBe('automated');
    expect(reloaded.resolutionSummary).toBe(DEFAULT_REPLY);
  });

  it('hands off low-confidence answers without posting them', async () => {
    const { workflow } = await createWorkflow({
      answer: { confidence: 0.3 },
    });
    const supportCase = await openCase(workflow);

    const runs = await workflow.processCase(supportCase.id ?? '');

    const answerRun = runs.find((run) => run.phase === 'answer');
    expect(answerRun?.outcome).toBe('handed_off');
    expect(answerRun?.confidence).toBeCloseTo(0.3);

    // Only the acknowledgement went out — never the low-confidence reply.
    const outbound = await outboundFor(workflow, supportCase.id ?? '');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.sourceKey.startsWith('ai:ack:')).toBe(true);

    // The handoff event carries the prior automated work (FR-28b).
    const payloads = await handoffPayloads(workflow, supportCase.id ?? '');
    const handoff = payloads.find(
      (payload) => payload.trigger === 'low_confidence',
    );
    expect(handoff).toBeDefined();
    const pkg = handoff?.contextPackage as {
      aiRuns: Array<{ phase: string; outcome: string }>;
    };
    expect(
      pkg.aiRuns.some(
        (run) => run.phase === 'answer' && run.outcome === 'handed_off',
      ),
    ).toBe(true);
    expect(pkg.aiRuns.some((run) => run.phase === 'classify')).toBe(true);
  });

  it('hands off sensitive classifications and never resolves them', async () => {
    const { workflow, answerCalls } = await createWorkflow({
      classify: {
        severity: 'sev4',
        category: 'billing-dispute',
        sensitive: true,
      },
      answer: { confidence: 0.95, proposedResolution: true },
    });
    await workflow.policies.create({
      name: 'permissive',
      autoResolve: true,
      autoResolveMaxSeverity: 'sev4',
    });
    const supportCase = await openCase(workflow);

    const runs = await workflow.processCase(supportCase.id ?? '');

    // Sensitivity stops autonomous answering — the boundary is never asked.
    expect(answerCalls).toHaveLength(0);
    expect(runs.find((run) => run.phase === 'answer')?.outcome).toBe(
      'handed_off',
    );
    expect(runs.find((run) => run.phase === 'resolve')?.outcome).toBe(
      'skipped',
    );

    const payloads = await handoffPayloads(workflow, supportCase.id ?? '');
    expect(payloads.some((payload) => payload.trigger === 'sensitive')).toBe(
      true,
    );
    const reloaded = await workflow.caseService.getCase(supportCase.id ?? '');
    expect(reloaded.sensitive).toBe(true);
    expect(reloaded.status).not.toBe('resolved');
  });

  it('routes a human on high severity while still answering (FR-28a)', async () => {
    const { workflow } = await createWorkflow({
      classify: { severity: 'sev1' },
    });
    const supportCase = await openCase(workflow);

    const runs = await workflow.processCase(supportCase.id ?? '');

    const payloads = await handoffPayloads(workflow, supportCase.id ?? '');
    expect(
      payloads.some(
        (payload) =>
          payload.trigger === 'high_severity' && payload.deduped !== true,
      ),
    ).toBe(true);

    // The confident answer still went out in parallel.
    expect(runs.find((run) => run.phase === 'answer')?.outcome).toBe(
      'completed',
    );
    const outbound = await outboundFor(workflow, supportCase.id ?? '');
    expect(
      outbound.some((item) => item.sourceKey.startsWith('ai:answer:')),
    ).toBe(true);

    // Without a routing seam the case queues for a human.
    const reloaded = await workflow.caseService.getCase(supportCase.id ?? '');
    expect(reloaded.status).toBe('triaged');
  });

  it('honours an explicit human request exactly once across passes', async () => {
    const { workflow, answerCalls } = await createWorkflow({
      answer: { confidence: 0.95, proposedResolution: true },
    });
    await workflow.policies.create({
      name: 'permissive',
      autoResolve: true,
      autoResolveMaxSeverity: 'sev4',
    });
    const supportCase = await openCase(workflow);
    await workflow.caseService.requestHuman(supportCase, {
      byProfileId: 'client-1',
    });

    const first = await workflow.processCase(supportCase.id ?? '');
    expect(first.find((run) => run.phase === 'answer')?.outcome).toBe(
      'handed_off',
    );
    expect(first.find((run) => run.phase === 'resolve')?.outcome).toBe(
      'skipped',
    );
    expect(answerCalls).toHaveLength(0);

    const second = await workflow.processCase(supportCase.id ?? '');
    expect(second.find((run) => run.phase === 'answer')?.outcome).toBe(
      'handed_off',
    );

    // The client_request handoff fired exactly once; the repeat deduped.
    const payloads = (
      await handoffPayloads(workflow, supportCase.id ?? '')
    ).filter((payload) => payload.trigger === 'client_request');
    expect(payloads.filter((payload) => payload.deduped !== true)).toHaveLength(
      1,
    );
    expect(payloads.filter((payload) => payload.deduped === true)).toHaveLength(
      1,
    );

    const reloaded = await workflow.caseService.getCase(supportCase.id ?? '');
    expect(reloaded.status).not.toBe('resolved');
  });

  it('audits boundary failures and hands off failed automation', async () => {
    const { workflow } = await createWorkflow({
      classifyError: new Error('model exploded'),
    });
    const supportCase = await openCase(workflow);

    const runs = await workflow.processCase(supportCase.id ?? '');

    expect(runs.map((run) => `${run.phase}:${run.outcome}`)).toEqual([
      'acknowledge:completed',
      'classify:failed',
    ]);
    expect(runs[1]?.error).toContain('model exploded');
    const payloads = await handoffPayloads(workflow, supportCase.id ?? '');
    expect(
      payloads.some((payload) => payload.trigger === 'failed_resolution'),
    ).toBe(true);

    // An answer-phase throw is audited the same way.
    const { workflow: failing } = await createWorkflow({
      answerError: new Error('answer melted'),
    });
    const other = await openCase(failing, { subject: 'Another outage' });
    const otherRuns = await failing.processCase(other.id ?? '');
    expect(otherRuns.map((run) => `${run.phase}:${run.outcome}`)).toEqual([
      'acknowledge:completed',
      'classify:completed',
      'answer:failed',
    ]);
    expect(otherRuns[2]?.error).toContain('answer melted');
    const otherPayloads = await handoffPayloads(failing, other.id ?? '');
    expect(
      otherPayloads.some((payload) => payload.trigger === 'failed_resolution'),
    ).toBe(true);
  });

  it('stops answering once maxAutoAttempts is exhausted', async () => {
    const { workflow, answerCalls } = await createWorkflow();
    await workflow.policies.create({ name: 'one-shot', maxAutoAttempts: 1 });
    const supportCase = await openCase(workflow);

    await workflow.processCase(supportCase.id ?? '');
    const second = await workflow.processCase(supportCase.id ?? '');

    expect(second.map((run) => `${run.phase}:${run.outcome}`)).toEqual([
      'acknowledge:skipped',
      'classify:completed',
      'answer:skipped',
      'troubleshoot:skipped',
      'resolve:skipped',
    ]);
    expect(answerCalls).toHaveLength(1);
    const answers = (await outboundFor(workflow, supportCase.id ?? '')).filter(
      (item) => item.sourceKey.startsWith('ai:answer:'),
    );
    expect(answers).toHaveLength(1);
    const payloads = await handoffPayloads(workflow, supportCase.id ?? '');
    expect(payloads.some((payload) => payload.trigger === 'policy')).toBe(true);
  });

  it('drafts email replies unless the policy allows sending', async () => {
    const { workflow } = await createWorkflow();
    const drafted = await openCase(workflow, { channelKind: 'email' });
    await workflow.processCase(drafted.id ?? '');
    const draftAnswer = (await outboundFor(workflow, drafted.id ?? '')).find(
      (item) => item.sourceKey.startsWith('ai:answer:'),
    );
    expect(draftAnswer?.getMetadata().draft).toBe(true);

    // Undelivered drafts stamp nothing — the client never saw them (codex
    // P1, PR #1943).
    const draftedReloaded = await workflow.caseService.getCase(
      drafted.id ?? '',
    );
    expect(draftedReloaded.acknowledgedAt).toBeNull();
    expect(draftedReloaded.firstRespondedAt).toBeNull();

    await workflow.policies.create({
      name: 'send-email-replies',
      autoSendEmailReplies: true,
    });
    const sent = await openCase(workflow, {
      subject: 'Another email issue',
      channelKind: 'email',
    });
    await workflow.processCase(sent.id ?? '');
    const sentAnswer = (await outboundFor(workflow, sent.id ?? '')).find(
      (item) => item.sourceKey.startsWith('ai:answer:'),
    );
    expect(sentAnswer?.getMetadata().draft).toBe(false);
  });

  it('never auto-resolves from an unsent email draft', async () => {
    const { workflow } = await createWorkflow({
      classify: { severity: 'sev4', confidence: 0.95 },
      answer: { confidence: 0.95, proposedResolution: true },
    });
    await workflow.policies.create({
      name: 'resolve-but-draft',
      autoResolve: true,
      autoResolveMaxSeverity: 'sev3',
      // autoSendEmailReplies stays false — the answer is only a draft.
    });
    const supportCase = await openCase(workflow, { channelKind: 'email' });
    const runs = await workflow.processCase(supportCase.id ?? '');

    const resolveRun = runs.find((run) => run.phase === 'resolve');
    expect(resolveRun?.outcome).toBe('skipped');
    const reloaded = await workflow.caseService.getCase(supportCase.id ?? '');
    expect(reloaded.status).not.toBe('resolved');

    // The same policy over a chat case resolves autonomously — the gate is
    // specifically the undelivered draft.
    const chatCase = await openCase(workflow, {
      subject: 'chat twin',
      channelKind: 'chat',
    });
    await workflow.processCase(chatCase.id ?? '');
    const chatReloaded = await workflow.caseService.getCase(chatCase.id ?? '');
    expect(chatReloaded.status).toBe('resolved');
  });

  it('counts low-confidence answers toward maxAutoAttempts', async () => {
    const { workflow, answerCalls } = await createWorkflow({
      answer: { confidence: 0.1 },
    });
    await workflow.policies.create({
      name: 'one-shot-low',
      maxAutoAttempts: 1,
    });
    const supportCase = await openCase(workflow);

    const first = await workflow.processCase(supportCase.id ?? '');
    expect(first.find((run) => run.phase === 'answer')?.outcome).toBe(
      'handed_off',
    );

    // The boundary was consumed by the low-confidence attempt — a second
    // pass must not spin another answer (codex P2, PR #1943).
    const second = await workflow.processCase(supportCase.id ?? '');
    const secondAnswer = second.find((run) => run.phase === 'answer');
    expect(secondAnswer?.outcome).toBe('skipped');
    expect(answerCalls).toHaveLength(1);
  });

  it('never overwrites human triage during classification', async () => {
    const { workflow } = await createWorkflow({
      classify: { severity: 'sev4', category: 'billing' },
    });
    const supportCase = await openCase(workflow);
    supportCase.severity = 'sev2'; // human triage before the AI pass
    await supportCase.save();

    await workflow.processCase(supportCase.id ?? '');

    const reloaded = await workflow.caseService.getCase(supportCase.id ?? '');
    expect(reloaded.severity).toBe('sev2');
    // Empty fields are still filled in.
    expect(reloaded.category).toBe('billing');
  });

  it('does nothing when the case opts out of AI or is no longer open', async () => {
    const { workflow, classifyCalls } = await createWorkflow();

    const optedOut = await openCase(workflow);
    optedOut.aiEnabled = false;
    await optedOut.save();
    expect(await workflow.processCase(optedOut.id ?? '')).toEqual([]);

    const resolved = await openCase(workflow, { subject: 'Already handled' });
    await workflow.caseService.resolve(resolved, {
      actorKind: 'specialist',
      summary: 'done',
    });
    expect(await workflow.processCase(resolved.id ?? '')).toEqual([]);

    expect(classifyCalls).toHaveLength(0);
    expect(await workflow.aiRuns.forCase(optedOut.id ?? '')).toEqual([]);
  });

  it('ranks severity keys by numeric suffix and fails closed otherwise', () => {
    expect(severityRank('sev1')).toBe(1);
    expect(severityRank('sev4')).toBe(4);
    expect(Number.isNaN(severityRank(''))).toBe(true);
    expect(Number.isNaN(severityRank('critical'))).toBe(true);
    expect(Number.isNaN(severityRank(null))).toBe(true);
  });
});
