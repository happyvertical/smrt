import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectGovernanceService } from '../services/project-governance-service.js';

const project = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  projectType: '@happyvertical/work:WorkspaceProject',
  projectId: '22222222-2222-4222-8222-222222222222',
};
const manager = {
  type: 'user' as const,
  id: '33333333-3333-4333-8333-333333333333',
  canManage: true,
};
const owner = {
  type: 'user' as const,
  id: '44444444-4444-4444-8444-444444444444',
};

describe('ProjectGovernanceService', () => {
  let db: DatabaseInterface;
  let service: ProjectGovernanceService;

  beforeEach(async () => {
    db = await getTestDatabase(
      process.env.SMRT_TEST_POSTGRES_URL
        ? { type: 'postgres', url: process.env.SMRT_TEST_POSTGRES_URL }
        : { type: 'sqlite', url: ':memory:' },
    );
    enableTenancy();
    service = await ProjectGovernanceService.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    if (process.env.SMRT_TEST_POSTGRES_URL)
      await db.query('DELETE FROM project_governance_events');
    if (process.env.SMRT_TEST_POSTGRES_URL)
      await db.query('DELETE FROM project_questions');
    if (process.env.SMRT_TEST_POSTGRES_URL)
      await db.query('DELETE FROM project_decisions');
    await db.close?.();
  });

  it('keeps a question open until its assigned owner answers and records history', async () => {
    const question = await service.createQuestion({
      ...project,
      prompt: 'Who owns launch approval?',
      owner,
      contextReferences: [
        { kind: 'spec', ref: 'spec:launch', label: 'Launch section' },
        { kind: 'conversation', ref: 'thread:42' },
      ],
      actor: manager,
    });

    expect(question.status).toBe('open');
    expect(question.getContextReferences()).toHaveLength(2);
    await expect(
      service.answerQuestion({
        ...project,
        questionId: question.id as string,
        answer: 'The delivery owner.',
        expectedRevision: 1,
        actor: { type: 'user', id: '55555555-5555-4555-8555-555555555555' },
      }),
    ).rejects.toThrow(/cannot change/i);

    const answered = await service.answerQuestion({
      ...project,
      questionId: question.id as string,
      answer: 'The delivery owner.',
      expectedRevision: 1,
      actor: owner,
    });
    expect(answered).toMatchObject({
      status: 'answered',
      answer: 'The delivery owner.',
      revision: 2,
    });
    expect(answered.answeredAt).toBeInstanceOf(Date);

    const history = await service.historyForQuestion({
      ...project,
      questionId: question.id as string,
    });
    expect(
      history.map((event) => [event.action, event.actorId, event.revision]),
    ).toEqual([
      ['created', manager.id, 1],
      ['answered', owner.id, 2],
    ]);
    expect(history[1]).toMatchObject({
      fromStatus: 'open',
      toStatus: 'answered',
      value: 'The delivery owner.',
    });
  });

  it('preserves immutable history after hydration', async () => {
    const question = await service.createQuestion({
      ...project,
      prompt: 'Audit me',
      actor: manager,
    });
    const [event] = await service.historyForQuestion({
      ...project,
      questionId: question.id as string,
    });
    event.note = 'Rewritten';
    await expect(
      withTenant({ tenantId: project.tenantId }, () => event.save()),
    ).rejects.toThrow();
    await expect(
      withTenant({ tenantId: project.tenantId }, () => event.delete()),
    ).rejects.toThrow(/append-only/i);
    const [unchanged] = await service.historyForQuestion({
      ...project,
      questionId: question.id as string,
    });
    expect(unchanged.note).toBe('');
  });

  it('rejects stale writes without adding another event', async () => {
    const question = await service.createQuestion({
      ...project,
      prompt: 'What is the launch date?',
      owner,
      actor: manager,
    });
    await service.answerQuestion({
      ...project,
      questionId: question.id as string,
      answer: 'November 1',
      expectedRevision: 1,
      actor: owner,
    });

    await expect(
      service.answerQuestion({
        ...project,
        questionId: question.id as string,
        answer: 'November 2',
        expectedRevision: 1,
        actor: owner,
      }),
    ).rejects.toThrow(/changed/i);
    expect(
      await service.historyForQuestion({
        ...project,
        questionId: question.id as string,
      }),
    ).toHaveLength(2);
  });

  it('validates decision options and rolls back an invalid outcome', async () => {
    const decision = await service.createDecision({
      ...project,
      question: 'How should customers authenticate?',
      options: [
        { id: 'magic-link', label: 'Magic link' },
        { id: 'password', label: 'Password' },
      ],
      owner,
      contextReferences: [{ kind: 'cookbook', ref: 'saas/auth' }],
      actor: manager,
    });

    await expect(
      service.decide({
        ...project,
        decisionId: decision.id as string,
        outcome: 'social-only',
        rationale: 'Fewer fields',
        expectedRevision: 1,
        actor: owner,
      }),
    ).rejects.toThrow(/option id/i);

    const decided = await service.decide({
      ...project,
      decisionId: decision.id as string,
      outcome: 'magic-link',
      rationale: 'Fits the low-friction onboarding goal.',
      expectedRevision: 1,
      actor: owner,
    });
    expect(decided).toMatchObject({
      status: 'decided',
      outcome: 'magic-link',
      rationale: 'Fits the low-friction onboarding goal.',
      revision: 2,
    });
    expect(decided.getOptions()).toHaveLength(2);
    expect(
      await service.historyForDecision({
        ...project,
        decisionId: decision.id as string,
      }),
    ).toHaveLength(2);
  });

  it('does not expose or mutate a record through another project or tenant', async () => {
    const question = await service.createQuestion({
      ...project,
      prompt: 'Who signs off?',
      owner,
      actor: manager,
    });
    expect(
      await service.listForProject({
        ...project,
        projectId: '77777777-7777-4777-8777-777777777777',
      }),
    ).toEqual({ questions: [], decisions: [] });
    await expect(
      service.answerQuestion({
        ...project,
        projectId: '77777777-7777-4777-8777-777777777777',
        questionId: question.id as string,
        answer: 'Nobody',
        expectedRevision: 1,
        actor: owner,
      }),
    ).rejects.toThrow(/not found/i);

    await expect(
      withTenant({ tenantId: project.tenantId }, () =>
        service.listForProject({
          ...project,
          tenantId: '66666666-6666-4666-8666-666666666666',
        }),
      ),
    ).rejects.toThrow(/tenant|isolation/i);
    await expect(
      withTenant({ tenantId: '66666666-6666-4666-8666-666666666666' }, () =>
        service.historyForQuestion({
          ...project,
          questionId: question.id as string,
        }),
      ),
    ).rejects.toThrow(/tenant|isolation/i);
  });

  it('requires manager authority for creation and lifecycle administration', async () => {
    await expect(
      service.createQuestion({
        ...project,
        prompt: 'Should this be recorded?',
        actor: owner,
      }),
    ).rejects.toThrow(/cannot change/i);

    const question = await service.createQuestion({
      ...project,
      prompt: 'Should this be deferred?',
      owner,
      actor: manager,
    });
    await expect(
      service.deferQuestion({
        ...project,
        questionId: question.id as string,
        note: '',
        expectedRevision: 1,
        actor: manager,
      }),
    ).rejects.toThrow(/note is required/i);
    const deferred = await service.deferQuestion({
      ...project,
      questionId: question.id as string,
      note: 'Waiting for the contract review.',
      expectedRevision: 1,
      actor: manager,
    });
    expect(deferred.status).toBe('deferred');
    const reopened = await service.reopenQuestion({
      ...project,
      questionId: question.id as string,
      expectedRevision: 2,
      actor: manager,
    });
    expect(reopened).toMatchObject({ status: 'open', revision: 3 });
  });

  it('defaults governance records to internal and filters client visibility', async () => {
    await service.createQuestion({
      ...project,
      prompt: 'Internal risk?',
      actor: manager,
    });
    const client = await service.createQuestion({
      ...project,
      prompt: 'Your preference?',
      visibility: 'client',
      actor: manager,
    });
    await service.createDecision({
      ...project,
      question: 'Internal choice?',
      actor: manager,
    });
    const visible = await service.listForProject(project, {
      visibility: 'client',
    });
    expect(visible.questions.map((item) => item.id)).toEqual([client.id]);
    expect(visible.decisions).toEqual([]);
    expect((await service.listForProject(project)).questions).toHaveLength(2);
  });

  it('rejects malformed context references and duplicate decision options', async () => {
    await expect(
      service.createQuestion({
        ...project,
        prompt: 'What source raised this?',
        contextReferences: [{ kind: 'unsupported' as never, ref: 'source:1' }],
        actor: manager,
      }),
    ).rejects.toThrow(/context reference/i);

    await expect(
      service.createDecision({
        ...project,
        question: 'Which choice?',
        options: [
          { id: 'same', label: 'First' },
          { id: 'same', label: 'Second' },
        ],
        actor: manager,
      }),
    ).rejects.toThrow(/unique/i);
  });
});
