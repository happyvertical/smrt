import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { normalizeQuestionContent } from './question-content.js';
import {
  QUESTION_COMPLETION_MODES,
  QUESTION_PROVENANCES,
  type QuestionContentInput,
  type QuestionProvenance,
} from './question-contracts.js';

const closed = { api: false, mcp: false, cli: false } as const;
const KEY = /^[A-Za-z0-9._:@/-]{1,200}$/;

function adopt(target: object, options: Record<string, unknown>) {
  for (const [key, value] of Object.entries(options))
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
}
function requireText(value: unknown, message: string, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(message);
}
function json(value: string | null, what: string) {
  try {
    return JSON.parse(value as string);
  } catch {
    throw new Error(`${what} must be JSON`);
  }
}
/** Append-only rows reject any rewrite of an existing id; replays are service-level. */
async function requireInsert(row: SmrtObject & { tenantId: string }) {
  if (!row.tenantId?.trim())
    throw new Error('Question records require a tenant');
  if (row.id && (await row.db.get(row.tableName, { id: row.id })))
    throw new Error('Question history is immutable');
}
async function requireOwned(
  row: SmrtObject & { tenantId: string },
  table: string,
  id: string,
  extra: Record<string, unknown> = {},
) {
  if (!(await row.db.get(table, { id, tenant_id: row.tenantId, ...extra })))
    throw new Error('Question record parent ownership mismatch');
}
function noDelete(): never {
  throw new Error(
    'Question history is immutable; erasure requires an owning retention operation',
  );
}
function validDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid question timestamp');
}
function requireProvenance(value: string) {
  if (!QUESTION_PROVENANCES.includes(value as QuestionProvenance))
    throw new Error('Invalid provenance');
}

/** Stable learning-objective identity: survives wording changes, variants and themes. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'learning_objectives',
  conflictColumns: ['tenant_id', 'external_key'],
  ...closed,
})
export class LearningObjective extends SmrtObject {
  @tenantId() tenantId = '';
  /** Stable coordination key (for example with hearthed.org#35); unique per tenant. */
  externalKey = '';
  createdByUserId = '';
  requestKey = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    requireText(this.externalKey, 'Objective requires a key', 200);
    if (!KEY.test(this.externalKey)) throw new Error('Invalid objective key');
    requireText(this.createdByUserId, 'Objective requires an author');
    requireText(this.requestKey, 'Objective requires a request key');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class LearningObjectiveCollection extends SmrtCollection<LearningObjective> {
  static readonly _itemClass = LearningObjective;
}

/** Append-only objective wording; the highest sequence is the head. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'learning_objective_revisions',
  conflictColumns: ['tenant_id', 'objective_id', 'request_key'],
  indexes: [
    {
      name: 'learning_objective_revisions_sequence_unique',
      columns: ['tenantId', 'objectiveId', 'sequence'],
      unique: true,
    },
  ],
  ...closed,
})
export class LearningObjectiveRevision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('LearningObjective', { required: true }) objectiveId = '';
  @foreignKey('LearningObjectiveRevision', { nullable: true })
  parentRevisionId: string | null = null;
  sequence = 1;
  @field({ type: 'text' }) statement = '';
  @field({ type: 'text' }) conceptIdsJson = '[]';
  subject = '';
  levelMin = 0;
  levelMax = 0;
  provenance = 'supplied';
  authorUserId = '';
  delegatingGuardianUserId = '';
  requestKey = '';
  payloadDigest = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    await requireOwned(this, 'learning_objectives', this.objectiveId);
    if (this.parentRevisionId)
      await requireOwned(
        this,
        'learning_objective_revisions',
        this.parentRevisionId,
        { objective_id: this.objectiveId },
      );
    requireText(this.statement, 'Objective requires a statement', 2000);
    requireText(this.authorUserId, 'Objective revision requires an author');
    requireText(this.requestKey, 'Objective revision requires a request key');
    requireProvenance(this.provenance);
    if (
      !Number.isSafeInteger(this.sequence) ||
      this.sequence < 1 ||
      !Number.isSafeInteger(this.levelMin) ||
      !Number.isSafeInteger(this.levelMax) ||
      this.levelMin < 0 ||
      this.levelMax < this.levelMin ||
      !Array.isArray(json(this.conceptIdsJson, 'Concepts'))
    )
      throw new Error('Invalid objective revision');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class LearningObjectiveRevisionCollection extends SmrtCollection<LearningObjectiveRevision> {
  static readonly _itemClass = LearningObjectiveRevision;
}

/** Stable question identity. Content lives only in immutable revisions. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'questions',
  conflictColumns: ['tenant_id', 'request_key'],
  ...closed,
})
export class Question extends SmrtObject {
  @tenantId() tenantId = '';
  /** Authored course this question was written for; reuse across courses is allowed. */
  @foreignKey('Course', { nullable: true }) courseId: string | null = null;
  createdByUserId = '';
  requestKey = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    if (this.courseId) await requireOwned(this, 'courses', this.courseId);
    requireText(this.createdByUserId, 'Question requires an author');
    requireText(this.requestKey, 'Question requires a request key');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class QuestionCollection extends SmrtCollection<Question> {
  static readonly _itemClass = Question;
}

/**
 * Immutable question snapshot. A missing answer key or rubric is stored as NULL
 * and never as an empty object, zero or an inferred value.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'question_revisions',
  conflictColumns: ['tenant_id', 'question_id', 'request_key'],
  indexes: [
    {
      name: 'question_revisions_sequence_unique',
      columns: ['tenantId', 'questionId', 'sequence'],
      unique: true,
    },
  ],
  ...closed,
})
export class QuestionRevision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Question', { required: true }) questionId = '';
  @foreignKey('QuestionRevision', { nullable: true }) parentRevisionId:
    | string
    | null = null;
  sequence = 1;
  @field({ type: 'text' }) prompt = '';
  responseType = 'short-answer';
  @field({ type: 'text' }) choicesJson = '[]';
  @field({ type: 'text' }) subpartsJson = '[]';
  @field({ type: 'text' }) mediaJson = '[]';
  @field({ type: 'text' }) objectiveIdsJson = '[]';
  @field({ type: 'text' }) conceptIdsJson = '[]';
  @field({ type: 'text', nullable: true }) answerKeyJson: string | null = null;
  @field({ type: 'text', nullable: true }) rubricJson: string | null = null;
  @field({ type: 'decimal', nullable: true }) pointsPossible: number | null =
    null;
  provenance = 'supplied';
  @field({ type: 'text' }) fieldProvenanceJson = '{}';
  authorUserId = '';
  delegatingGuardianUserId = '';
  requestKey = '';
  payloadDigest = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    await requireOwned(this, 'questions', this.questionId);
    if (this.parentRevisionId)
      await requireOwned(this, 'question_revisions', this.parentRevisionId, {
        question_id: this.questionId,
      });
    requireText(this.authorUserId, 'Question revision requires an author');
    requireText(this.requestKey, 'Question revision requires a request key');
    if (!Number.isSafeInteger(this.sequence) || this.sequence < 1)
      throw new Error('Invalid question revision');
    // The stored columns must round-trip through the same validator the service uses.
    const content = normalizeQuestionContent({
      prompt: this.prompt,
      responseType: this.responseType as QuestionContentInput['responseType'],
      choices: json(this.choicesJson, 'Choices'),
      subparts: json(this.subpartsJson, 'Subparts'),
      media: json(this.mediaJson, 'Media'),
      objectiveIds: json(this.objectiveIdsJson, 'Objectives'),
      conceptIds: json(this.conceptIdsJson, 'Concepts'),
      answerKey: this.answerKeyJson
        ? json(this.answerKeyJson, 'Answer key')
        : null,
      rubric: this.rubricJson ? json(this.rubricJson, 'Rubric') : null,
      pointsPossible: this.pointsPossible,
      provenance: this.provenance as QuestionProvenance,
      fieldProvenance: json(this.fieldProvenanceJson, 'Field provenance'),
    });
    if (this.answerKeyJson === '{}' || this.rubricJson === '{}')
      throw new Error('A missing key must be stored as null');
    for (const id of content.objectiveIds)
      await requireOwned(this, 'learning_objectives', id);
    for (const media of content.media)
      await requireOwned(this, 'assets', media.assetId);
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class QuestionRevisionCollection extends SmrtCollection<QuestionRevision> {
  static readonly _itemClass = QuestionRevision;
}

/**
 * Append-only learner response to one exact question revision. A correction is a
 * new row naming its predecessor; a response never rewrites question content.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'question_responses',
  conflictColumns: ['tenant_id', 'learner_id', 'request_key'],
  ...closed,
})
export class QuestionResponse extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('Enrollment', { required: true }) enrollmentId = '';
  @foreignKey('QuestionRevision', { required: true }) questionRevisionId = '';
  @foreignKey('LessonRevision', { nullable: true }) lessonRevisionId:
    | string
    | null = null;
  /** The worksheet render the learner saw, for scan matching. */
  worksheetVersionId = '';
  @foreignKey('Submission', { nullable: true }) submissionId: string | null =
    null;
  @foreignKey('QuestionResponse', { nullable: true }) previousResponseId:
    | string
    | null = null;
  /** Groups an attempt and its corrections. */
  episodeId = '';
  completionMode = 'online';
  assistance = 'unknown';
  @field({ type: 'text' }) responseJson = '{}';
  /** 1-based attempt (episode) number per learner and question revision. */
  attemptNumber = 1;
  actorUserId = '';
  requestKey = '';
  /** Digest of the request that wrote this row; empty for rows written directly. */
  payloadDigest = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    await requireOwned(this, 'learners', this.learnerId);
    await requireOwned(this, 'enrollments', this.enrollmentId, {
      learner_id: this.learnerId,
    });
    await requireOwned(this, 'question_revisions', this.questionRevisionId);
    if (this.lessonRevisionId)
      await requireOwned(this, 'lesson_revisions', this.lessonRevisionId);
    if (this.submissionId)
      await requireOwned(this, 'submissions', this.submissionId, {
        learner_id: this.learnerId,
      });
    if (this.previousResponseId)
      await requireOwned(this, 'question_responses', this.previousResponseId, {
        learner_id: this.learnerId,
        question_revision_id: this.questionRevisionId,
        episode_id: this.episodeId,
      });
    requireText(this.episodeId, 'Response requires an episode');
    requireText(this.actorUserId, 'Response requires an actor');
    requireText(this.requestKey, 'Response requires a request key');
    if (!Number.isSafeInteger(this.attemptNumber) || this.attemptNumber < 1)
      throw new Error('Invalid response attempt number');
    if (
      !QUESTION_COMPLETION_MODES.includes(
        this.completionMode as (typeof QUESTION_COMPLETION_MODES)[number],
      ) ||
      !['independent', 'assisted', 'unknown'].includes(this.assistance)
    )
      throw new Error('Invalid response mode or assistance');
    const response = json(this.responseJson, 'Response');
    if (!response || typeof response !== 'object' || Array.isArray(response))
      throw new Error('Response must be a JSON object');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class QuestionResponseCollection extends SmrtCollection<QuestionResponse> {
  static readonly _itemClass = QuestionResponse;
}
