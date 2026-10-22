import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  assertTenantReadAllowed,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { ProjectDecisionCollection } from '../collections/ProjectDecisions.js';
import { ProjectGovernanceEventCollection } from '../collections/ProjectGovernanceEvents.js';
import { ProjectQuestionCollection } from '../collections/ProjectQuestions.js';
import type { ProjectDecision } from '../models/ProjectDecision.js';
import type { ProjectQuestion } from '../models/ProjectQuestion.js';
import {
  serializeContextReferences,
  serializeDecisionOptions,
} from '../models/project-governance-validation.js';
import type {
  ProjectDecisionCreateInput,
  ProjectDecisionStatus,
  ProjectGovernanceAction,
  ProjectGovernanceActor,
  ProjectGovernanceOwner,
  ProjectGovernanceRecordKind,
  ProjectGovernanceScope,
  ProjectGovernanceVisibility,
  ProjectQuestionCreateInput,
  ProjectQuestionStatus,
} from '../project-governance-types.js';

const QUESTION_TYPE = '@happyvertical/smrt-projects:ProjectQuestion';
const DECISION_TYPE = '@happyvertical/smrt-projects:ProjectDecision';
type Database = ProjectQuestionCollection['db'];
interface GovernanceEventDetails {
  note?: string;
  value?: string;
  rationale?: string;
  fromOwnerType?: ProjectGovernanceActor['type'] | '';
  fromOwnerId?: string;
  toOwnerType?: ProjectGovernanceActor['type'] | '';
  toOwnerId?: string;
}

export class ProjectGovernanceConflictError extends Error {
  constructor(message = 'Project governance record has changed.') {
    super(message);
    this.name = 'ProjectGovernanceConflictError';
  }
}

export class ProjectGovernanceAuthorizationError extends Error {
  constructor(message = 'Actor cannot change this project governance record.') {
    super(message);
    this.name = 'ProjectGovernanceAuthorizationError';
  }
}

export class ProjectGovernanceService {
  constructor(
    private readonly questions: ProjectQuestionCollection,
    private readonly decisions: ProjectDecisionCollection,
    private readonly events: ProjectGovernanceEventCollection,
  ) {}

  static async create(
    options: SmrtClassOptions = {},
  ): Promise<ProjectGovernanceService> {
    return new ProjectGovernanceService(
      await ProjectQuestionCollection.create(options),
      await ProjectDecisionCollection.create(options),
      await ProjectGovernanceEventCollection.create(options),
    );
  }

  async listForProject(
    scope: ProjectGovernanceScope,
    options: { visibility?: ProjectGovernanceVisibility } = {},
  ): Promise<{
    questions: ProjectQuestion[];
    decisions: ProjectDecision[];
  }> {
    validateScope(scope);
    const [questions, decisions] = await Promise.all([
      this.questions.listForProject(scope, undefined, options.visibility),
      this.decisions.listForProject(scope, undefined, options.visibility),
    ]);
    return { questions, decisions };
  }

  async createQuestion(
    input: ProjectQuestionCreateInput,
  ): Promise<ProjectQuestion> {
    validateScope(input);
    requireManager(input.actor);
    const prompt = input.prompt.trim();
    if (!prompt) throw new TypeError('Project question prompt is required.');
    return this.transaction(this.questions, async (db) => {
      const questions = await ProjectQuestionCollection.create({ db });
      const question = await withTenant({ tenantId: input.tenantId }, () =>
        questions.create({
          visibility: input.visibility ?? 'internal',
          tenantId: input.tenantId,
          metaType: input.projectType,
          metaId: input.projectId,
          prompt,
          ownerType: input.owner?.type ?? '',
          ownerId: input.owner?.id ?? '',
          contextReferences: serializeContextReferences(
            input.contextReferences ?? [],
          ),
        }),
      );
      await withTenant({ tenantId: input.tenantId }, () => question.save());
      await this.recordEvent(
        db,
        question,
        'question',
        'created',
        input.actor,
        '',
        'open',
      );
      return question;
    });
  }

  async createDecision(
    input: ProjectDecisionCreateInput,
  ): Promise<ProjectDecision> {
    validateScope(input);
    requireManager(input.actor);
    const question = input.question.trim();
    if (!question)
      throw new TypeError('Project decision question is required.');
    return this.transaction(this.decisions, async (db) => {
      const decisions = await ProjectDecisionCollection.create({ db });
      const decision = await withTenant({ tenantId: input.tenantId }, () =>
        decisions.create({
          visibility: input.visibility ?? 'internal',
          tenantId: input.tenantId,
          metaType: input.projectType,
          metaId: input.projectId,
          question,
          decisionOptions: serializeDecisionOptions(input.options ?? []),
          ownerType: input.owner?.type ?? '',
          ownerId: input.owner?.id ?? '',
          contextReferences: serializeContextReferences(
            input.contextReferences ?? [],
          ),
        }),
      );
      await withTenant({ tenantId: input.tenantId }, () => decision.save());
      await this.recordEvent(
        db,
        decision,
        'decision',
        'created',
        input.actor,
        '',
        'open',
      );
      return decision;
    });
  }

  async answerQuestion(
    input: ProjectGovernanceScope & {
      questionId: string;
      answer: string;
      note?: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
  ): Promise<ProjectQuestion> {
    const answer = input.answer.trim();
    if (!answer) throw new TypeError('Project question answer is required.');
    return this.mutateQuestion(input, 'answered', 'answered', (question) => {
      question.answer = answer;
      question.answeredAt = new Date();
      return { value: answer, note: input.note ?? '' };
    });
  }

  async decide(
    input: ProjectGovernanceScope & {
      decisionId: string;
      outcome: string;
      rationale?: string;
      note?: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
  ): Promise<ProjectDecision> {
    const outcome = input.outcome.trim();
    if (!outcome) throw new TypeError('Project decision outcome is required.');
    return this.mutateDecision(input, 'decided', 'decided', (decision) => {
      const options = decision.getOptions();
      if (
        options.length > 0 &&
        !options.some((option) => option.id === outcome)
      )
        throw new TypeError(
          'Project decision outcome must match an option id.',
        );
      decision.outcome = outcome;
      decision.rationale = input.rationale?.trim() ?? '';
      decision.decidedAt = new Date();
      return {
        value: outcome,
        rationale: decision.rationale,
        note: input.note ?? '',
      };
    });
  }

  async assignQuestion(
    input: ProjectGovernanceScope & {
      questionId: string;
      owner: ProjectGovernanceOwner | null;
      note?: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
  ): Promise<ProjectQuestion> {
    requireManager(input.actor);
    return this.mutateQuestion(
      input,
      undefined,
      'assigned',
      (question) => {
        const fromOwnerType = question.ownerType;
        const fromOwnerId = question.ownerId;
        assign(question, input.owner);
        return {
          note:
            input.note ?? (input.owner ? 'Owner assigned.' : 'Owner cleared.'),
          fromOwnerType,
          fromOwnerId,
          toOwnerType: question.ownerType,
          toOwnerId: question.ownerId,
        };
      },
      false,
    );
  }

  async assignDecision(
    input: ProjectGovernanceScope & {
      decisionId: string;
      owner: ProjectGovernanceOwner | null;
      note?: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
  ): Promise<ProjectDecision> {
    requireManager(input.actor);
    return this.mutateDecision(
      input,
      undefined,
      'assigned',
      (decision) => {
        const fromOwnerType = decision.ownerType;
        const fromOwnerId = decision.ownerId;
        assign(decision, input.owner);
        return {
          note:
            input.note ?? (input.owner ? 'Owner assigned.' : 'Owner cleared.'),
          fromOwnerType,
          fromOwnerId,
          toOwnerType: decision.ownerType,
          toOwnerId: decision.ownerId,
        };
      },
      false,
    );
  }

  async deferQuestion(
    input: ProjectGovernanceScope & {
      questionId: string;
      note: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
  ): Promise<ProjectQuestion> {
    requireManager(input.actor);
    return this.mutateQuestion(
      input,
      'deferred',
      'deferred',
      () => ({ note: requiredNote(input.note) }),
      false,
    );
  }

  async deferDecision(
    input: ProjectGovernanceScope & {
      decisionId: string;
      note: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
  ): Promise<ProjectDecision> {
    requireManager(input.actor);
    return this.mutateDecision(
      input,
      'deferred',
      'deferred',
      () => ({ note: requiredNote(input.note) }),
      false,
    );
  }

  async reopenQuestion(
    input: ProjectGovernanceScope & {
      questionId: string;
      note?: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
  ): Promise<ProjectQuestion> {
    requireManager(input.actor);
    return this.mutateQuestion(
      input,
      'open',
      'reopened',
      (question) => {
        question.answer = '';
        question.answeredAt = null;
        return { note: input.note ?? '' };
      },
      false,
    );
  }

  async reopenDecision(
    input: ProjectGovernanceScope & {
      decisionId: string;
      note?: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
  ): Promise<ProjectDecision> {
    requireManager(input.actor);
    return this.mutateDecision(
      input,
      'open',
      'reopened',
      (decision) => {
        decision.outcome = '';
        decision.rationale = '';
        decision.decidedAt = null;
        return { note: input.note ?? '' };
      },
      false,
    );
  }

  async supersedeQuestion(
    input: ProjectGovernanceScope & {
      questionId: string;
      note: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
  ): Promise<ProjectQuestion> {
    requireManager(input.actor);
    return this.mutateQuestion(
      input,
      'superseded',
      'superseded',
      () => ({ note: requiredNote(input.note) }),
      false,
    );
  }

  async supersedeDecision(
    input: ProjectGovernanceScope & {
      decisionId: string;
      note: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
  ): Promise<ProjectDecision> {
    requireManager(input.actor);
    return this.mutateDecision(
      input,
      'superseded',
      'superseded',
      () => ({ note: requiredNote(input.note) }),
      false,
    );
  }

  async historyForQuestion(
    input: ProjectGovernanceScope & { questionId: string },
  ) {
    validateScope(input);
    const question = await this.questions.getForProject(
      input,
      input.questionId,
    );
    if (!question) throw new Error('Project question not found.');
    return this.events.listForRecord({
      tenantId: input.tenantId,
      recordType: QUESTION_TYPE,
      recordId: input.questionId,
    });
  }

  async historyForDecision(
    input: ProjectGovernanceScope & { decisionId: string },
  ) {
    validateScope(input);
    const decision = await this.decisions.getForProject(
      input,
      input.decisionId,
    );
    if (!decision) throw new Error('Project decision not found.');
    return this.events.listForRecord({
      tenantId: input.tenantId,
      recordType: DECISION_TYPE,
      recordId: input.decisionId,
    });
  }

  private async mutateQuestion(
    input: ProjectGovernanceScope & {
      questionId: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
    status: ProjectQuestionStatus | undefined,
    action: ProjectGovernanceAction,
    apply: (question: ProjectQuestion) => GovernanceEventDetails,
    allowOwner = true,
  ): Promise<ProjectQuestion> {
    validateScope(input);
    return this.transaction(this.questions, async (db) => {
      const collection = await ProjectQuestionCollection.create({ db });
      const current = await this.lockQuestion(db, collection, input);
      authorize(current, input.actor, allowOwner);
      const from = current.status;
      validateQuestionTransition(from, status);
      const event = apply(current);
      if (status) current.status = status;
      current.revision += 1;
      await withTenant({ tenantId: input.tenantId }, () => current.save());
      await this.recordEvent(
        db,
        current,
        'question',
        action,
        input.actor,
        from,
        current.status,
        event,
      );
      return current;
    });
  }

  private async mutateDecision(
    input: ProjectGovernanceScope & {
      decisionId: string;
      expectedRevision: number;
      actor: ProjectGovernanceActor;
    },
    status: ProjectDecisionStatus | undefined,
    action: ProjectGovernanceAction,
    apply: (decision: ProjectDecision) => GovernanceEventDetails,
    allowOwner = true,
  ): Promise<ProjectDecision> {
    validateScope(input);
    return this.transaction(this.decisions, async (db) => {
      const collection = await ProjectDecisionCollection.create({ db });
      const current = await this.lockDecision(db, collection, input);
      authorize(current, input.actor, allowOwner);
      const from = current.status;
      validateDecisionTransition(from, status);
      const event = apply(current);
      if (status) current.status = status;
      current.revision += 1;
      await withTenant({ tenantId: input.tenantId }, () => current.save());
      await this.recordEvent(
        db,
        current,
        'decision',
        action,
        input.actor,
        from,
        current.status,
        event,
      );
      return current;
    });
  }

  private async lockQuestion(
    db: Database,
    collection: ProjectQuestionCollection,
    input: ProjectGovernanceScope & {
      questionId: string;
      expectedRevision: number;
    },
  ): Promise<ProjectQuestion> {
    await lockRow(db, collection.tableName, input.questionId, input);
    const current = await collection.getForProject(input, input.questionId);
    if (!current) throw new Error('Project question not found.');
    if (current.revision !== input.expectedRevision)
      throw new ProjectGovernanceConflictError();
    return current;
  }

  private async lockDecision(
    db: Database,
    collection: ProjectDecisionCollection,
    input: ProjectGovernanceScope & {
      decisionId: string;
      expectedRevision: number;
    },
  ): Promise<ProjectDecision> {
    await lockRow(db, collection.tableName, input.decisionId, input);
    const current = await collection.getForProject(input, input.decisionId);
    if (!current) throw new Error('Project decision not found.');
    if (current.revision !== input.expectedRevision)
      throw new ProjectGovernanceConflictError();
    return current;
  }

  private async recordEvent(
    db: Database,
    record: ProjectQuestion | ProjectDecision,
    recordKind: ProjectGovernanceRecordKind,
    action: ProjectGovernanceAction,
    actor: ProjectGovernanceActor,
    fromStatus: string,
    toStatus: string,
    details: GovernanceEventDetails = {},
  ): Promise<void> {
    const events = await ProjectGovernanceEventCollection.create({ db });
    await withTenant({ tenantId: record.tenantId }, () =>
      events.create({
        tenantId: record.tenantId,
        metaType: recordKind === 'question' ? QUESTION_TYPE : DECISION_TYPE,
        metaId: record.id as string,
        recordKind,
        action,
        actorType: actor.type,
        actorId: actor.id,
        fromStatus,
        toStatus,
        note: details.note ?? '',
        value: details.value ?? '',
        rationale: details.rationale ?? '',
        fromOwnerType: details.fromOwnerType ?? '',
        fromOwnerId: details.fromOwnerId ?? '',
        toOwnerType: details.toOwnerType ?? '',
        toOwnerId: details.toOwnerId ?? '',
        revision: record.revision,
      }),
    );
  }

  private async transaction<T>(
    collection: ProjectQuestionCollection | ProjectDecisionCollection,
    work: (db: Database) => Promise<T>,
  ): Promise<T> {
    if (!collection.db.transaction)
      throw new Error('Project governance mutations require transactions.');
    return collection.db.transaction(work);
  }
}

async function lockRow(
  db: Database,
  tableName: string,
  id: string,
  scope: ProjectGovernanceScope,
): Promise<void> {
  const table = `"${tableName.replace(/"/g, '""')}"`;
  await withTenant({ tenantId: scope.tenantId }, () =>
    db.query(
      `UPDATE ${table} SET revision = revision WHERE id = ? AND tenant_id = ? AND meta_type = ? AND meta_id = ?`,
      id,
      scope.tenantId,
      scope.projectType,
      scope.projectId,
    ),
  );
}

function validateScope(scope: ProjectGovernanceScope): void {
  if (
    !scope.tenantId.trim() ||
    !scope.projectType.trim() ||
    !scope.projectId.trim()
  )
    throw new TypeError('Tenant, project type, and project id are required.');
  if (!scope.projectType.includes(':'))
    throw new TypeError('Project type must be a qualified SMRT class name.');
  assertTenantReadAllowed(scope.tenantId, 'ProjectGovernanceService');
}

function requireManager(actor: ProjectGovernanceActor): void {
  validateActor(actor);
  if (!actor.canManage) throw new ProjectGovernanceAuthorizationError();
}

function authorize(
  record: { ownerType: string; ownerId: string },
  actor: ProjectGovernanceActor,
  allowOwner: boolean,
): void {
  validateActor(actor);
  if (actor.canManage) return;
  if (
    allowOwner &&
    record.ownerType === actor.type &&
    record.ownerId === actor.id
  )
    return;
  throw new ProjectGovernanceAuthorizationError();
}

function validateActor(actor: ProjectGovernanceActor): void {
  if (!['user', 'agent', 'system'].includes(actor.type) || !actor.id.trim())
    throw new TypeError('A valid project governance actor is required.');
}

function assign(
  record: { ownerType: ProjectGovernanceActor['type'] | ''; ownerId: string },
  owner: ProjectGovernanceOwner | null,
): void {
  if (
    owner &&
    (!owner.id.trim() || !['user', 'agent', 'system'].includes(owner.type))
  )
    throw new TypeError('A valid project governance owner is required.');
  record.ownerType = owner?.type ?? '';
  record.ownerId = owner?.id.trim() ?? '';
}

function requiredNote(note: string): string {
  const value = note.trim();
  if (!value) throw new TypeError('A note is required.');
  return value;
}

function validateQuestionTransition(
  from: ProjectQuestionStatus,
  to?: ProjectQuestionStatus,
): void {
  if (!to) return;
  const allowed: Record<ProjectQuestionStatus, ProjectQuestionStatus[]> = {
    open: ['answered', 'deferred', 'superseded'],
    answered: ['superseded'],
    deferred: ['open', 'superseded'],
    superseded: [],
  };
  if (!allowed[from].includes(to))
    throw new TypeError(
      `Invalid project question transition: ${from} -> ${to}.`,
    );
}

function validateDecisionTransition(
  from: ProjectDecisionStatus,
  to?: ProjectDecisionStatus,
): void {
  if (!to) return;
  const allowed: Record<ProjectDecisionStatus, ProjectDecisionStatus[]> = {
    open: ['decided', 'deferred', 'superseded'],
    decided: ['superseded'],
    deferred: ['open', 'superseded'],
    superseded: [],
  };
  if (!allowed[from].includes(to))
    throw new TypeError(
      `Invalid project decision transition: ${from} -> ${to}.`,
    );
}
