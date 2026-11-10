import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  getPendingSchemaStatements,
  migrateSmrtSchemas,
} from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectGovernanceEventCollection } from '../collections/ProjectGovernanceEvents.js';
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

  it('records previous and next owner identities for every assignment', async () => {
    const question = await service.createQuestion({
      ...project,
      prompt: 'Choose the owner',
      owner,
      actor: manager,
    });
    const agent = {
      type: 'agent' as const,
      id: '77777777-7777-4777-8777-777777777777',
    };
    await service.assignQuestion({
      ...project,
      questionId: question.id as string,
      owner: agent,
      expectedRevision: 1,
      actor: manager,
    });
    await service.assignQuestion({
      ...project,
      questionId: question.id as string,
      owner: null,
      expectedRevision: 2,
      actor: manager,
    });
    const history = await service.historyForQuestion({
      ...project,
      questionId: question.id as string,
    });
    expect(history[1]).toMatchObject({
      action: 'assigned',
      fromOwnerType: 'user',
      fromOwnerId: owner.id,
      toOwnerType: 'agent',
      toOwnerId: agent.id,
      actorId: manager.id,
      revision: 2,
    });
    expect(history[2]).toMatchObject({
      action: 'assigned',
      fromOwnerType: 'agent',
      fromOwnerId: agent.id,
      toOwnerType: '',
      toOwnerId: '',
      revision: 3,
    });
    const decision = await service.createDecision({
      ...project,
      question: 'Assign decision?',
      actor: manager,
    });
    await service.assignDecision({
      ...project,
      decisionId: decision.id as string,
      owner,
      expectedRevision: 1,
      actor: manager,
    });
    const decisionHistory = await service.historyForDecision({
      ...project,
      decisionId: decision.id as string,
    });
    expect(decisionHistory[1]).toMatchObject({
      action: 'assigned',
      fromOwnerType: '',
      fromOwnerId: '',
      toOwnerType: 'user',
      toOwnerId: owner.id,
    });
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
  it('roundtrips structured options and explicit answer snapshots without choosing recommendations', async () => {
    const question = await service.createQuestion({
      ...project,
      prompt: 'How often?',
      owner,
      actor: manager,
      options: [
        { id: '15min', label: '15 minutes', recommended: true },
        { id: 'hourly', label: 'Hourly' },
      ],
    });
    expect(question).toMatchObject({
      status: 'open',
      answer: '',
      selectedOptionId: '',
      revision: 1,
    });
    expect(question.getOptions()).toEqual([
      { id: '15min', label: '15 minutes', recommended: true },
      { id: 'hourly', label: 'Hourly' },
      { id: 'other', label: 'Other' },
    ]);
    const answered = await service.answerQuestion({
      ...project,
      questionId: question.id as string,
      answer: '15 minutes',
      selectedOptionId: '15min',
      expectedRevision: 1,
      actor: owner,
      idempotencyKey: 'answer:1',
    });
    expect(answered).toMatchObject({
      answer: '15 minutes',
      selectedOptionId: '15min',
      revision: 2,
    });
    const hydrated = (await service.listForProject(project)).questions[0];
    expect(hydrated.getOptions()).toEqual(question.getOptions());
    expect(hydrated.selectedOptionId).toBe('15min');
    const history = await service.historyForQuestion({
      ...project,
      questionId: question.id as string,
    });
    expect(history[0].getAnswerSelection()).toBeNull();
    expect(history[1].getAnswerSelection()).toEqual({
      answer: '15 minutes',
      selectedOptionId: '15min',
      optionLabel: '15 minutes',
      expectedRevision: 1,
      idempotencyKey: 'answer:1',
    });
    const replay = await service.answerQuestion({
      ...project,
      questionId: question.id as string,
      answer: '15 minutes',
      selectedOptionId: '15min',
      expectedRevision: 1,
      actor: owner,
      idempotencyKey: 'answer:1',
    });
    expect(replay.revision).toBe(2);
    await expect(
      service.answerQuestion({
        ...project,
        questionId: question.id as string,
        answer: 'Different',
        selectedOptionId: '15min',
        expectedRevision: 1,
        actor: owner,
        idempotencyKey: 'answer:1',
      }),
    ).rejects.toThrow(/different input/);
    await expect(
      service.answerQuestion({
        ...project,
        questionId: question.id as string,
        answer: '15 minutes',
        selectedOptionId: '15min',
        expectedRevision: 1,
        actor: manager,
        idempotencyKey: 'answer:1',
      }),
    ).rejects.toThrow(/different input/);
    await expect(
      service.answerQuestion({
        ...project,
        questionId: question.id as string,
        answer: '15 minutes',
        selectedOptionId: '15min',
        expectedRevision: 1,
        actor: { type: 'agent', id: 'outsider' },
        idempotencyKey: 'answer:1',
      }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      service.answerQuestion({
        ...project,
        projectId: 'different-project',
        questionId: question.id as string,
        answer: '15 minutes',
        selectedOptionId: '15min',
        expectedRevision: 1,
        actor: owner,
        idempotencyKey: 'answer:1',
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      withTenant({ tenantId: 'another-tenant' }, () =>
        service.answerQuestion({
          ...project,
          questionId: question.id as string,
          answer: '15 minutes',
          selectedOptionId: '15min',
          expectedRevision: 1,
          actor: owner,
          idempotencyKey: 'answer:1',
        }),
      ),
    ).rejects.toThrow(/tenant|isolation/i);
    expect(
      await service.historyForQuestion({
        ...project,
        questionId: question.id as string,
      }),
    ).toHaveLength(2);
  });

  it('validates choices and malformed answers atomically, including Other', async () => {
    for (const options of [
      [{ id: 'other', label: 'Custom other' }],
      [{ id: 'Other', label: 'Collision' }],
      [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'Duplicate' },
      ],
      [{ id: 'a', label: 'A', recommended: 'yes' }],
      [{ id: 'a', label: 'A', description: 12 }],
    ]) {
      await expect(
        service.createQuestion({
          ...project,
          prompt: 'Invalid?',
          actor: manager,
          options: options as never,
        }),
      ).rejects.toThrow();
    }
    expect((await service.listForProject(project)).questions).toHaveLength(0);
    const question = await service.createQuestion({
      ...project,
      prompt: 'Preference?',
      owner,
      actor: manager,
      options: [{ id: 'a', label: 'A' }],
    });
    const base = {
      ...project,
      questionId: question.id as string,
      expectedRevision: 1,
      actor: owner,
    };
    for (const payload of [
      { answer: 'unknown', selectedOptionId: 'unknown' },
      { answer: '', selectedOptionId: 'other' },
      { answer: '   ', selectedOptionId: 'other' },
      { answer: 12 },
      { answer: 'x', selectedOptionId: 1 },
      { answer: 'x', selectedOptionId: ' a ' },
      { answer: 'x', idempotencyKey: '' },
      { answer: 'x', expectedRevision: 0 },
    ])
      await expect(
        service.answerQuestion({ ...base, ...payload } as never),
      ).rejects.toThrow();
    const [unchanged] = (await service.listForProject(project)).questions;
    expect(unchanged).toMatchObject({
      status: 'open',
      answer: '',
      revision: 1,
    });
    expect(await service.historyForQuestion(base)).toHaveLength(1);
    const answered = await service.answerQuestion({
      ...base,
      selectedOptionId: 'other',
      answer: ' Custom schedule ',
    });
    expect(answered).toMatchObject({
      answer: 'Custom schedule',
      selectedOptionId: 'other',
      revision: 2,
    });
    expect(
      (await service.historyForQuestion(base))[1].getAnswerSelection(),
    ).toMatchObject({
      selectedOptionId: 'other',
      optionLabel: 'Other',
      answer: 'Custom schedule',
    });
  });

  it('preserves old free-text answers and history without inferring a selection', async () => {
    const question = await service.createQuestion({
      ...project,
      prompt: 'How often?',
      owner,
      actor: manager,
    });
    const base = { ...project, questionId: question.id as string };
    const answered = await service.answerQuestion({
      ...base,
      answer: '15 minutes',
      expectedRevision: 1,
      actor: owner,
    });
    expect(answered).toMatchObject({
      answer: '15 minutes',
      selectedOptionId: '',
      revision: 2,
    });
    expect(answered.getOptions()).toEqual([]);
    const history = await service.historyForQuestion(base);
    expect(history[1].value).toBe('15 minutes');
    expect(history[1].getAnswerSelection()?.selectedOptionId).toBeUndefined();
    const before = history.map((event) => event.toJSON());
    await service.listForProject(project);
    expect(
      (await service.historyForQuestion(base)).map((event) => event.toJSON()),
    ).toEqual(before);
    const structured = await service.createQuestion({
      ...project,
      prompt: 'Legacy client?',
      owner,
      actor: manager,
      options: [{ id: 'a', label: 'A' }],
    });
    const legacy = await service.answerQuestion({
      ...project,
      questionId: structured.id as string,
      answer: 'A',
      expectedRevision: 1,
      actor: owner,
    });
    expect(legacy.selectedOptionId).toBe('');
  });
  it('rolls back answer and retry key if history persistence fails, then permits a retry', async () => {
    const question = await service.createQuestion({
      ...project,
      prompt: 'Retry?',
      owner,
      actor: manager,
      options: [{ id: 'a', label: 'A' }],
    });
    const input = {
      ...project,
      questionId: question.id as string,
      answer: 'A',
      selectedOptionId: 'a',
      actor: owner,
      expectedRevision: 1,
      idempotencyKey: 'retry:1',
    };
    const fail = vi
      .spyOn(ProjectGovernanceEventCollection.prototype, 'create')
      .mockRejectedValueOnce(new Error('Fixture history failure'));
    try {
      await expect(service.answerQuestion(input)).rejects.toThrow(
        'Fixture history failure',
      );
    } finally {
      fail.mockRestore();
    }
    const [unchanged] = (await service.listForProject(project)).questions;
    expect(unchanged).toMatchObject({
      answer: '',
      selectedOptionId: '',
      revision: 1,
      status: 'open',
    });
    expect(await service.historyForQuestion(input)).toHaveLength(1);
    expect((await service.answerQuestion(input)).revision).toBe(2);
    expect((await service.answerQuestion(input)).revision).toBe(2);
    expect(await service.historyForQuestion(input)).toHaveLength(2);
  });
  it('migrates old question/event schemas without rewriting legacy answers or audit history', async () => {
    const question = await service.createQuestion({
      ...project,
      prompt: 'Old cadence?',
      owner,
      actor: manager,
    });
    await service.answerQuestion({
      ...project,
      questionId: question.id as string,
      answer: '15 minutes',
      expectedRevision: 1,
      actor: owner,
    });
    // Fixture represents the deployed schema before #4337, with no selection metadata.
    await db.query(
      'ALTER TABLE project_questions DROP COLUMN question_options',
    );
    await db.query(
      'ALTER TABLE project_questions DROP COLUMN selected_option_id',
    );
    await db.query(
      'ALTER TABLE project_governance_events DROP COLUMN answer_selection',
    );
    const beforeQuestion = await db.query(
      'SELECT * FROM project_questions WHERE id = ?',
      question.id,
    );
    const beforeEvents = await db.query(
      'SELECT * FROM project_governance_events WHERE meta_id = ? ORDER BY revision',
      question.id,
    );
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    const own = {
      project_questions: schemas.project_questions,
      project_governance_events: schemas.project_governance_events,
    };
    const registry = vi
      .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
      .mockReturnValue(own);
    try {
      const plan = await getPendingSchemaStatements(db);
      expect(plan.statements.join(' ')).toContain('question_options');
      expect(plan.statements.join(' ')).toContain('selected_option_id');
      expect(plan.statements.join(' ')).toContain('answer_selection');
      expect(plan.statements.join(' ')).not.toMatch(/DROP TABLE|DELETE FROM/i);
      const migrated = await migrateSmrtSchemas({
        db,
        packageName: '@happyvertical/smrt-projects',
        postgresSafe: false,
      });
      expect(migrated.applied).toBe(true);
      expect((await getPendingSchemaStatements(db)).hasChanges).toBe(false);
    } finally {
      registry.mockRestore();
    }
    const afterQuestion = await db.query(
      'SELECT * FROM project_questions WHERE id = ?',
      question.id,
    );
    const { question_options, selected_option_id, ...unchangedQuestion } =
      afterQuestion.rows[0];
    expect(unchangedQuestion).toEqual(beforeQuestion.rows[0]);
    expect(question_options).toBe('[]');
    expect(selected_option_id).toBe('');
    const afterEvents = await db.query(
      'SELECT * FROM project_governance_events WHERE meta_id = ? ORDER BY revision',
      question.id,
    );
    expect(
      afterEvents.rows.map(({ answer_selection, ...event }) => event),
    ).toEqual(beforeEvents.rows);
    expect(
      afterEvents.rows.every((event) => event.answer_selection === ''),
    ).toBe(true);
    const [legacy] = (await service.listForProject(project)).questions;
    expect(legacy).toMatchObject({
      answer: '15 minutes',
      revision: 2,
      selectedOptionId: '',
    });
    expect(legacy.getOptions()).toEqual([]);
    expect(
      (
        await service.historyForQuestion({
          ...project,
          questionId: question.id as string,
        })
      ).every((event) => event.getAnswerSelection() === null),
    ).toBe(true);
  });
});
