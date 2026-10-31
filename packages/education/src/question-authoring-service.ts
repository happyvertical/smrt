import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type CourseAuthoringActor,
  type CourseAuthoringAuthorizer,
  type CourseAuthoringOperation,
  CourseAuthoringValidationError,
  CourseRequestKeyConflictError,
  CourseStaleHeadError,
} from './course-authoring-contracts.js';
import { LessonRevisionCollection } from './course-authoring-models.js';
import {
  CourseAuthoringService,
  type CourseAuthoringServiceOptions,
} from './course-authoring-service.js';
import { delegationRecordFields } from './course-delegation.js';
import { groupSharingDigest } from './group-sharing-hash.js';
import {
  type NormalizedQuestionContent,
  normalizeQuestionContent,
} from './question-content.js';
import {
  type LearningObjectiveInput,
  LearningObjectiveKeyConflictError,
  LearningObjectiveNotFoundError,
  type LearningObjectiveView,
  type LessonLayoutParams,
  type LessonQuestionRefInput,
  MAX_RESOLVE_QUESTION_REVISIONS,
  QUESTION_PROMPT_SUMMARY_LENGTH,
  QUESTION_PROVENANCES,
  type QuestionContentInput,
  type QuestionField,
  type QuestionHeadView,
  type QuestionMediaRef,
  QuestionNotFoundError,
  type QuestionProvenance,
  type QuestionResponseType,
  type QuestionRevisionSummary,
  type QuestionRevisionView,
  type ReleasedLessonView,
  type ResolvedQuestionRevisions,
  type WorksheetBundle,
} from './question-contracts.js';
import {
  LearningObjectiveCollection,
  LearningObjectiveRevisionCollection,
  QuestionCollection,
  QuestionRevisionCollection,
} from './question-models.js';
import {
  buildGuardianWorksheet,
  buildLearnerWorksheet,
} from './question-render.js';

const KEY_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;
const NAMESPACE = 'smrt.education.question-authoring.v1';

type Row = Record<string, unknown>;
type Tx = DatabaseInterface;

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const digest = (value: unknown) => groupSharingDigest(canonical(value));
/** Deterministic UUID-shaped id; the same inputs always yield the same row id. */
function derived(...parts: string[]): string {
  const hex = groupSharingDigest(JSON.stringify([NAMESPACE, ...parts]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function requireKey(value: unknown, what = 'request key'): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value))
    throw new CourseAuthoringValidationError(`Invalid ${what}`);
  return value;
}
const iso = (date: unknown) => new Date(date as string | Date).toISOString();
const orNull = (value: unknown) => (value ? String(value) : null);
const num = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

export interface QuestionAuthoringServiceOptions
  extends CourseAuthoringServiceOptions {
  /** Trusted concept ids; when supplied, question and objective concepts must belong. */
  conceptVocabulary?: ReadonlyArray<{ id: string }>;
}

/** Plain-text, whitespace-collapsed, code-point-bounded excerpt of a prompt. */
function promptSummary(prompt: string): string {
  return Array.from(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
    prompt.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(),
  )
    .slice(0, QUESTION_PROMPT_SUMMARY_LENGTH)
    .join('')
    .trimEnd();
}

function usesGenerated(content: NormalizedQuestionContent) {
  return (
    content.provenance === 'generated' ||
    Object.values(content.fieldProvenance).includes('generated')
  );
}

interface NormalizedObjective {
  statement: string;
  conceptIds: string[];
  subject: string;
  levelMin: number;
  levelMax: number;
  provenance: QuestionProvenance;
}

/**
 * Actor-bound authoring of immutable questions and stable learning objectives.
 * It shares `CourseAuthoringService`'s authorizer and actions: writes need
 * `education.course.author` (plus `generate` for generated provenance); reads of
 * answer keys need `education.course.read-draft`.
 */
export class QuestionAuthoringService extends CourseAuthoringService {
  private readonly vocabulary: ReadonlySet<string> | undefined;

  constructor(
    db: DatabaseInterface,
    authorizer: CourseAuthoringAuthorizer,
    options: QuestionAuthoringServiceOptions = {},
  ) {
    super(db, authorizer, options);
    this.vocabulary = options.conceptVocabulary
      ? new Set(options.conceptVocabulary.map((c) => c.id))
      : undefined;
  }

  private normalize(content: QuestionContentInput) {
    return normalizeQuestionContent(content, {
      conceptVocabulary: this.vocabulary,
    });
  }

  private normalizeObjective(
    input: LearningObjectiveInput,
  ): NormalizedObjective {
    if (!input || typeof input !== 'object')
      throw new CourseAuthoringValidationError('Invalid objective');
    const provenance = input.provenance ?? 'supplied';
    if (
      typeof input.statement !== 'string' ||
      !input.statement.trim() ||
      input.statement.length > 2000 ||
      !QUESTION_PROVENANCES.includes(provenance)
    )
      throw new CourseAuthoringValidationError('Invalid objective');
    // Reuse the question validator for concept ids rather than a second copy.
    const { conceptIds } = this.normalize({
      prompt: 'objective',
      responseType: 'short-answer',
      conceptIds: input.conceptIds,
      provenance: 'supplied',
    });
    const subject = input.subject ?? '';
    const levelMin = input.levelMin ?? 0;
    const levelMax = input.levelMax ?? levelMin;
    if (
      typeof subject !== 'string' ||
      subject.length > 200 ||
      !Number.isSafeInteger(levelMin) ||
      !Number.isSafeInteger(levelMax) ||
      levelMin < 0 ||
      levelMax < levelMin
    )
      throw new CourseAuthoringValidationError('Invalid objective');
    return {
      statement: input.statement,
      conceptIds,
      subject,
      levelMin,
      levelMax,
      provenance,
    };
  }

  private async authorizeWrite(
    tx: Tx,
    actor: CourseAuthoringActor,
    generated: boolean,
    operation: CourseAuthoringOperation,
    courseId?: string,
  ) {
    const extra = courseId ? { courseId } : {};
    await this.authorize(
      tx,
      actor,
      'education.course.author',
      operation,
      extra,
    );
    if (generated)
      await this.authorize(
        tx,
        actor,
        'education.course.generate',
        operation,
        extra,
      );
  }

  /** Objectives and media named by a revision must exist in the same tenant. */
  private async requireReferences(
    tx: Tx,
    tenantId: string,
    content: NormalizedQuestionContent,
  ) {
    for (const id of content.objectiveIds)
      if (!(await tx.get('learning_objectives', { id, tenant_id: tenantId })))
        throw new LearningObjectiveNotFoundError();
    for (const media of content.media)
      if (!(await tx.get('assets', { id: media.assetId, tenant_id: tenantId })))
        throw new CourseAuthoringValidationError('Unknown media asset');
  }

  private async lock(tx: Tx, table: string, tenantId: string, id: string) {
    await tx.query(
      `UPDATE ${table} SET id = id WHERE id = ? AND tenant_id = ?`,
      [id, tenantId],
    );
  }

  private async head(
    tx: Tx,
    table: string,
    column: string,
    tenantId: string,
    id: string,
  ): Promise<Row | null> {
    const rows = (await tx.list(table, {
      tenant_id: tenantId,
      [column]: id,
    })) as Row[];
    return rows.reduce<Row | null>(
      (best, row) =>
        !best || Number(row.sequence) > Number(best.sequence) ? row : best,
      null,
    );
  }

  // -- questions ----------------------------------------------------------

  /** Creates the stable question identity and its first immutable revision. */
  async createQuestion(
    request: CourseAuthoringActor & {
      requestKey: string;
      courseId?: string;
      content: QuestionContentInput;
    },
  ): Promise<QuestionHeadView> {
    const requestKey = requireKey(request.requestKey);
    const content = this.normalize(request.content);
    const payloadDigest = digest({
      create: content,
      courseId: request.courseId ?? null,
      delegationId: request.delegationId ?? '',
    });
    return this.run(async (tx) => {
      await this.authorizeWrite(
        tx,
        request,
        usesGenerated(content),
        'create-question',
        request.courseId,
      );
      if (request.courseId)
        await this.identityRow(tx, request.tenantId, request.courseId);
      const questionId = derived('question', request.tenantId, requestKey);
      const existing = await tx.get('questions', {
        id: questionId,
        tenant_id: request.tenantId,
      });
      if (existing) {
        const first = await tx.get('question_revisions', {
          tenant_id: request.tenantId,
          question_id: questionId,
          request_key: requestKey,
        });
        if (!first || first.payload_digest !== payloadDigest)
          throw new CourseRequestKeyConflictError();
        return { questionId, headRevisionId: String(first.id), sequence: 1 };
      }
      await this.requireReferences(tx, request.tenantId, content);
      await (await QuestionCollection.create({ db: tx })).create({
        _insertOnly: true,
        id: questionId,
        tenantId: request.tenantId,
        courseId: request.courseId ?? null,
        createdByUserId: request.actorUserId,
        requestKey,
        recordedAt: new Date(),
      });
      const revision = await this.appendQuestionRevision(tx, request, {
        questionId,
        parent: null,
        sequence: 1,
        requestKey,
        payloadDigest,
        content,
      });
      return { questionId, headRevisionId: revision, sequence: 1 };
    });
  }

  private async appendQuestionRevision(
    tx: Tx,
    actor: CourseAuthoringActor,
    input: {
      questionId: string;
      parent: string | null;
      sequence: number;
      requestKey: string;
      payloadDigest: string;
      content: NormalizedQuestionContent;
    },
  ): Promise<string> {
    const { content } = input;
    const row = await (
      await QuestionRevisionCollection.create({ db: tx })
    ).create({
      _insertOnly: true,
      tenantId: actor.tenantId,
      questionId: input.questionId,
      parentRevisionId: input.parent,
      sequence: input.sequence,
      prompt: content.prompt,
      responseType: content.responseType,
      choicesJson: JSON.stringify(content.choices),
      subpartsJson: JSON.stringify(content.subparts),
      mediaJson: JSON.stringify(content.media),
      objectiveIdsJson: JSON.stringify(content.objectiveIds),
      conceptIdsJson: JSON.stringify(content.conceptIds),
      // A missing key or rubric stays NULL; it is never written as `{}`.
      answerKeyJson: content.answerKey
        ? JSON.stringify(content.answerKey)
        : null,
      rubricJson: content.rubric ? JSON.stringify(content.rubric) : null,
      pointsPossible: content.pointsPossible,
      provenance: content.provenance,
      fieldProvenanceJson: JSON.stringify(content.fieldProvenance),
      authorUserId: actor.actorUserId,
      ...delegationRecordFields(actor),
      requestKey: input.requestKey,
      payloadDigest: input.payloadDigest,
      recordedAt: new Date(),
    });
    return String(row.id);
  }

  /**
   * Appends an immutable revision when `expectedHeadRevisionId` is still the
   * head. A retried key replays its original result; the same key with a
   * different payload is a typed conflict.
   */
  async saveQuestionRevision(
    request: CourseAuthoringActor & {
      questionId: string;
      expectedHeadRevisionId: string;
      requestKey: string;
      content: QuestionContentInput;
    },
  ): Promise<QuestionHeadView> {
    const content = this.normalize(request.content);
    return this.saveRevision(request, 'save-question', {
      generated: usesGenerated(content),
      payload: { content },
      build: () => content,
    });
  }

  /** Replaces a question's objective links by appending a revision. */
  async linkObjectives(
    request: CourseAuthoringActor & {
      questionId: string;
      expectedHeadRevisionId: string;
      requestKey: string;
      objectiveIds: string[];
    },
  ): Promise<QuestionHeadView> {
    return this.saveRevision(request, 'link-objectives', {
      generated: false,
      payload: { objectiveIds: request.objectiveIds },
      build: (head) => {
        const previous = this.contentFromRow(head);
        const fieldProvenance = { ...previous.fieldProvenance };
        if (request.objectiveIds?.length)
          fieldProvenance.objectives = 'supplied';
        else delete fieldProvenance.objectives;
        return this.normalize({
          ...previous,
          objectiveIds: request.objectiveIds,
          fieldProvenance,
        });
      },
    });
  }

  private async saveRevision(
    request: CourseAuthoringActor & {
      questionId: string;
      expectedHeadRevisionId: string;
      requestKey: string;
    },
    operation: 'save-question' | 'link-objectives',
    plan: {
      generated: boolean;
      payload: unknown;
      build: (head: Row) => NormalizedQuestionContent;
    },
  ): Promise<QuestionHeadView> {
    const requestKey = requireKey(request.requestKey);
    const expected = requireKey(
      request.expectedHeadRevisionId,
      'expected head',
    );
    const payloadDigest = digest({
      expected,
      questionId: request.questionId,
      operation,
      payload: plan.payload,
      delegationId: request.delegationId ?? '',
    });
    return this.run(async (tx) => {
      const question = await this.questionRow(tx, request);
      await this.authorizeWrite(
        tx,
        request,
        plan.generated,
        operation,
        orNull(question?.course_id) ?? undefined,
      );
      if (!question) throw new QuestionNotFoundError();
      const replay = await tx.get('question_revisions', {
        tenant_id: request.tenantId,
        question_id: request.questionId,
        request_key: requestKey,
      });
      if (replay) {
        if (replay.payload_digest !== payloadDigest)
          throw new CourseRequestKeyConflictError();
        return {
          questionId: request.questionId,
          headRevisionId: String(replay.id),
          sequence: Number(replay.sequence),
        };
      }
      await this.lock(tx, 'questions', request.tenantId, request.questionId);
      const head = await this.head(
        tx,
        'question_revisions',
        'question_id',
        request.tenantId,
        request.questionId,
      );
      if (!head) throw new QuestionNotFoundError();
      if (String(head.id) !== expected)
        throw new CourseStaleHeadError(String(head.id));
      const content = plan.build(head);
      await this.requireReferences(tx, request.tenantId, content);
      const sequence = Number(head.sequence) + 1;
      const id = await this.appendQuestionRevision(tx, request, {
        questionId: request.questionId,
        parent: String(head.id),
        sequence,
        requestKey,
        payloadDigest,
        content,
      });
      return { questionId: request.questionId, headRevisionId: id, sequence };
    });
  }

  private async questionRow(
    tx: Tx,
    request: { tenantId: string; questionId: string },
  ): Promise<Row | null> {
    if (typeof request.questionId !== 'string' || !request.questionId)
      return null;
    return (await tx.get('questions', {
      id: request.questionId,
      tenant_id: request.tenantId,
    })) as Row | null;
  }

  private contentFromRow(row: Row): QuestionContentInput {
    return {
      prompt: String(row.prompt),
      responseType: String(row.response_type) as QuestionResponseType,
      choices: JSON.parse(String(row.choices_json)),
      subparts: JSON.parse(String(row.subparts_json)),
      media: JSON.parse(String(row.media_json)) as QuestionMediaRef[],
      objectiveIds: JSON.parse(String(row.objective_ids_json)),
      conceptIds: JSON.parse(String(row.concept_ids_json)),
      answerKey: row.answer_key_json
        ? JSON.parse(String(row.answer_key_json))
        : null,
      rubric: row.rubric_json ? JSON.parse(String(row.rubric_json)) : null,
      pointsPossible: num(row.points_possible),
      provenance: String(row.provenance) as QuestionProvenance,
      fieldProvenance: JSON.parse(String(row.field_provenance_json)),
    };
  }

  private async questionRevisionView(
    tx: Tx,
    tenantId: string,
    row: Row,
  ): Promise<QuestionRevisionView> {
    const content = this.contentFromRow(row);
    const objectives: QuestionRevisionView['objectives'] = [];
    for (const objectiveId of content.objectiveIds ?? []) {
      const identity = (await tx.get('learning_objectives', {
        id: objectiveId,
        tenant_id: tenantId,
      })) as Row | null;
      const latest = await this.head(
        tx,
        'learning_objective_revisions',
        'objective_id',
        tenantId,
        objectiveId,
      );
      if (!identity || !latest)
        throw new Error('Question revision references a missing objective');
      objectives.push({
        objectiveId,
        externalKey: String(identity.external_key),
        revisionId: String(latest.id),
        statement: String(latest.statement),
      });
    }
    return {
      id: String(row.id),
      questionId: String(row.question_id),
      parentRevisionId: orNull(row.parent_revision_id),
      sequence: Number(row.sequence),
      prompt: content.prompt,
      responseType: content.responseType,
      choices: content.choices ?? [],
      subparts: content.subparts ?? [],
      media: content.media ?? [],
      objectives,
      conceptIds: content.conceptIds ?? [],
      answerKey: content.answerKey ?? null,
      rubric: content.rubric ?? null,
      pointsPossible: content.pointsPossible ?? null,
      provenance: content.provenance,
      fieldProvenance: (content.fieldProvenance ?? {}) as Partial<
        Record<QuestionField, QuestionProvenance>
      >,
      authorUserId: String(row.author_user_id),
      delegatingGuardianUserId: orNull(row.delegating_guardian_user_id),
      delegationId: orNull(row.delegation_id),
      recordedAt: iso(row.recorded_at),
    };
  }

  /** Reads a question revision (the head unless `revisionId` is given), key included. */
  async readQuestion(
    request: CourseAuthoringActor & { questionId: string; revisionId?: string },
  ): Promise<{ head: QuestionHeadView; revision: QuestionRevisionView }> {
    return this.run(async (tx) => {
      const question = await this.questionRow(tx, request);
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-question',
        question?.course_id ? { courseId: String(question.course_id) } : {},
      );
      if (!question) throw new QuestionNotFoundError();
      const head = await this.head(
        tx,
        'question_revisions',
        'question_id',
        request.tenantId,
        request.questionId,
      );
      if (!head) throw new QuestionNotFoundError();
      const row = request.revisionId
        ? ((await tx.get('question_revisions', {
            id: request.revisionId,
            tenant_id: request.tenantId,
            question_id: request.questionId,
          })) as Row | null)
        : head;
      if (!row) throw new QuestionNotFoundError();
      return {
        head: {
          questionId: request.questionId,
          headRevisionId: String(head.id),
          sequence: Number(head.sequence),
        },
        revision: await this.questionRevisionView(tx, request.tenantId, row),
      };
    });
  }

  /**
   * Resolves question revision ids to reference labels for a host (e.g. a printed
   * worksheet's question list). Needs `read-draft` (operation
   * `resolve-question-revisions`, no course). Tenant-exact: an id that is unknown
   * or belongs to another tenant is simply reported in `missing`, with no
   * distinction. The result never carries answer keys, rubrics, choices, media or
   * provenance. At most 200 ids; duplicates are folded; an empty list, a
   * non-string or an over-long id is a validation error.
   */
  async resolveQuestionRevisions(
    request: CourseAuthoringActor & { revisionIds: string[] },
  ): Promise<ResolvedQuestionRevisions> {
    const raw = request.revisionIds;
    if (
      !Array.isArray(raw) ||
      raw.length < 1 ||
      raw.length > MAX_RESOLVE_QUESTION_REVISIONS ||
      raw.some(
        (id) => typeof id !== 'string' || id.length < 1 || id.length > 200,
      )
    )
      throw new CourseAuthoringValidationError(
        `revisionIds must hold 1-${MAX_RESOLVE_QUESTION_REVISIONS} revision ids`,
      );
    const ids = [...new Set(raw as string[])];
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'resolve-question-revisions',
      );
      const rows = (await tx.list('question_revisions', {
        tenant_id: request.tenantId,
        'id in': ids,
      })) as Row[];
      const found = new Map(rows.map((row) => [String(row.id), row]));
      const objectiveIds = new Set<string>();
      const linked = new Map<string, string[]>();
      for (const row of rows) {
        const own = JSON.parse(String(row.objective_ids_json)) as string[];
        linked.set(String(row.id), own);
        for (const id of own) objectiveIds.add(id);
      }
      const keys = new Map(
        objectiveIds.size
          ? (
              (await tx.list('learning_objectives', {
                tenant_id: request.tenantId,
                'id in': [...objectiveIds],
              })) as Row[]
            ).map((row) => [String(row.id), String(row.external_key)])
          : [],
      );
      const items: QuestionRevisionSummary[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const row = found.get(id);
        if (!row) {
          missing.push(id);
          continue;
        }
        const objectiveKeys = (linked.get(id) ?? [])
          .map((objectiveId) => keys.get(objectiveId))
          .filter((key): key is string => typeof key === 'string');
        items.push({
          revisionId: id,
          questionId: String(row.question_id),
          sequence: Number(row.sequence),
          responseType: String(row.response_type) as QuestionResponseType,
          promptSummary: promptSummary(String(row.prompt)),
          ...(objectiveKeys.length
            ? { learningObjectiveKeys: objectiveKeys }
            : {}),
        });
      }
      return { items, missing };
    });
  }

  // -- learning objectives ---------------------------------------------------

  /**
   * Creates a stable objective identity under a tenant-unique `externalKey`. The
   * same key with the same request replays; any other use of the key conflicts.
   */
  async createLearningObjective(
    request: CourseAuthoringActor & {
      requestKey: string;
      externalKey: string;
      objective: LearningObjectiveInput;
    },
  ): Promise<LearningObjectiveView> {
    const requestKey = requireKey(request.requestKey);
    const externalKey = requireKey(request.externalKey, 'objective key');
    const objective = this.normalizeObjective(request.objective);
    const payloadDigest = digest({
      create: objective,
      externalKey,
      delegationId: request.delegationId ?? '',
    });
    return this.run(async (tx) => {
      await this.authorizeWrite(
        tx,
        request,
        objective.provenance === 'generated',
        'create-objective',
      );
      const id = derived('objective', request.tenantId, externalKey);
      const existing = await tx.get('learning_objectives', {
        tenant_id: request.tenantId,
        external_key: externalKey,
      });
      if (existing) {
        const first = await tx.get('learning_objective_revisions', {
          tenant_id: request.tenantId,
          objective_id: String(existing.id),
          request_key: requestKey,
        });
        if (!first || first.payload_digest !== payloadDigest)
          throw new LearningObjectiveKeyConflictError();
        return this.objectiveView(tx, request.tenantId, String(existing.id));
      }
      await (await LearningObjectiveCollection.create({ db: tx })).create({
        _insertOnly: true,
        id,
        tenantId: request.tenantId,
        externalKey,
        createdByUserId: request.actorUserId,
        requestKey,
        recordedAt: new Date(),
      });
      await this.appendObjective(
        tx,
        request,
        {
          objectiveId: id,
          parent: null,
          sequence: 1,
          requestKey,
          payloadDigest,
        },
        objective,
      );
      return this.objectiveView(tx, request.tenantId, id);
    });
  }

  private async appendObjective(
    tx: Tx,
    actor: CourseAuthoringActor,
    link: {
      objectiveId: string;
      parent: string | null;
      sequence: number;
      requestKey: string;
      payloadDigest: string;
    },
    objective: NormalizedObjective,
  ) {
    await (await LearningObjectiveRevisionCollection.create({ db: tx })).create(
      {
        _insertOnly: true,
        tenantId: actor.tenantId,
        objectiveId: link.objectiveId,
        parentRevisionId: link.parent,
        sequence: link.sequence,
        statement: objective.statement,
        conceptIdsJson: JSON.stringify(objective.conceptIds),
        subject: objective.subject,
        levelMin: objective.levelMin,
        levelMax: objective.levelMax,
        provenance: objective.provenance,
        authorUserId: actor.actorUserId,
        ...delegationRecordFields(actor),
        requestKey: link.requestKey,
        payloadDigest: link.payloadDigest,
        recordedAt: new Date(),
      },
    );
  }

  /** Appends new wording; the objective's id and `externalKey` never change. */
  async saveLearningObjectiveRevision(
    request: CourseAuthoringActor & {
      objectiveId: string;
      expectedHeadRevisionId: string;
      requestKey: string;
      objective: LearningObjectiveInput;
    },
  ): Promise<LearningObjectiveView> {
    const requestKey = requireKey(request.requestKey);
    const expected = requireKey(
      request.expectedHeadRevisionId,
      'expected head',
    );
    const objective = this.normalizeObjective(request.objective);
    const payloadDigest = digest({
      expected,
      objectiveId: request.objectiveId,
      objective,
      delegationId: request.delegationId ?? '',
    });
    return this.run(async (tx) => {
      await this.authorizeWrite(
        tx,
        request,
        objective.provenance === 'generated',
        'save-objective',
      );
      const identity = await this.objectiveRow(tx, request);
      if (!identity) throw new LearningObjectiveNotFoundError();
      const replay = await tx.get('learning_objective_revisions', {
        tenant_id: request.tenantId,
        objective_id: request.objectiveId,
        request_key: requestKey,
      });
      if (replay) {
        if (replay.payload_digest !== payloadDigest)
          throw new CourseRequestKeyConflictError();
        return this.objectiveView(
          tx,
          request.tenantId,
          request.objectiveId,
          String(replay.id),
        );
      }
      await this.lock(
        tx,
        'learning_objectives',
        request.tenantId,
        request.objectiveId,
      );
      const head = await this.head(
        tx,
        'learning_objective_revisions',
        'objective_id',
        request.tenantId,
        request.objectiveId,
      );
      if (!head) throw new LearningObjectiveNotFoundError();
      if (String(head.id) !== expected)
        throw new CourseStaleHeadError(String(head.id));
      await this.appendObjective(
        tx,
        request,
        {
          objectiveId: request.objectiveId,
          parent: String(head.id),
          sequence: Number(head.sequence) + 1,
          requestKey,
          payloadDigest,
        },
        objective,
      );
      return this.objectiveView(tx, request.tenantId, request.objectiveId);
    });
  }

  private async objectiveRow(
    tx: Tx,
    request: { tenantId: string; objectiveId?: string; externalKey?: string },
  ): Promise<Row | null> {
    const where: Row = { tenant_id: request.tenantId };
    if (request.objectiveId) where.id = request.objectiveId;
    else if (request.externalKey) where.external_key = request.externalKey;
    else return null;
    return (await tx.get('learning_objectives', where)) as Row | null;
  }

  private async objectiveView(
    tx: Tx,
    tenantId: string,
    objectiveId: string,
    revisionId?: string,
  ): Promise<LearningObjectiveView> {
    const identity = (await tx.get('learning_objectives', {
      id: objectiveId,
      tenant_id: tenantId,
    })) as Row | null;
    const row = revisionId
      ? ((await tx.get('learning_objective_revisions', {
          id: revisionId,
          tenant_id: tenantId,
        })) as Row | null)
      : await this.head(
          tx,
          'learning_objective_revisions',
          'objective_id',
          tenantId,
          objectiveId,
        );
    if (!identity || !row) throw new LearningObjectiveNotFoundError();
    return {
      id: objectiveId,
      externalKey: String(identity.external_key),
      headRevisionId: String(row.id),
      sequence: Number(row.sequence),
      statement: String(row.statement),
      conceptIds: JSON.parse(String(row.concept_ids_json)),
      subject: String(row.subject),
      levelMin: Number(row.level_min),
      levelMax: Number(row.level_max),
      provenance: String(row.provenance) as QuestionProvenance,
    };
  }

  /** Reads an objective by id or by its stable external key. */
  async readLearningObjective(
    request: CourseAuthoringActor & {
      objectiveId?: string;
      externalKey?: string;
    },
  ): Promise<LearningObjectiveView> {
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-question',
      );
      const identity = await this.objectiveRow(tx, request);
      if (!identity) throw new LearningObjectiveNotFoundError();
      return this.objectiveView(tx, request.tenantId, String(identity.id));
    });
  }

  // -- worksheets -----------------------------------------------------------

  /**
   * Render input for one lesson of a release, from its pinned question
   * revisions. `learner` omits keys and rubrics by type. Both audiences need
   * `read-draft` here; learner delivery is a host path that calls
   * `buildLearnerWorksheet` over data it already authorized.
   */
  async getWorksheet(
    request: CourseAuthoringActor & {
      releaseId: string;
      lessonKey: string;
      audience: 'learner' | 'guardian';
    },
  ): Promise<WorksheetBundle> {
    if (!['learner', 'guardian'].includes(request.audience))
      throw new CourseAuthoringValidationError('Invalid audience');
    return this.run(async (tx) => {
      const release = (await tx.get('course_releases', {
        id: request.releaseId,
        tenant_id: request.tenantId,
      })) as Row | null;
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-worksheet',
        release ? { courseId: String(release.course_id) } : {},
      );
      if (!release) throw new QuestionNotFoundError();
      const { input } = await this.releasedLessonInput(
        tx,
        request.tenantId,
        request.releaseId,
        request.lessonKey,
      );
      return request.audience === 'guardian'
        ? buildGuardianWorksheet(input)
        : buildLearnerWorksheet(input);
    });
  }

  /** The release lesson's immutable revision row and keyed worksheet inputs. */
  private async releasedLessonInput(
    tx: Tx,
    tenantId: string,
    releaseId: string,
    lessonKey: string,
  ) {
    const released = (await tx.get('released_lessons', {
      tenant_id: tenantId,
      release_id: releaseId,
      lesson_key: lessonKey,
    })) as Row | null;
    const lesson = released
      ? ((await tx.get('lesson_revisions', {
          id: String(released.lesson_revision_id),
          tenant_id: tenantId,
        })) as Row | null)
      : null;
    if (!released || !lesson) throw new QuestionNotFoundError();
    const refs = JSON.parse(
      String(lesson.questions_json || '[]'),
    ) as LessonQuestionRefInput[];
    const layoutParams = JSON.parse(
      String(lesson.layout_params_json || '{}'),
    ) as LessonLayoutParams;
    const revisions = new Map<string, QuestionRevisionView>();
    for (const ref of refs) {
      const row = (await tx.get('question_revisions', {
        id: ref.questionRevisionId,
        tenant_id: tenantId,
      })) as Row | null;
      if (!row) throw new QuestionNotFoundError();
      revisions.set(
        ref.questionRevisionId,
        await this.questionRevisionView(tx, tenantId, row),
      );
    }
    return {
      released,
      lesson,
      input: {
        lessonRevisionId: String(lesson.id),
        refs,
        layoutParams,
        revisions,
      },
    };
  }

  /**
   * Authoring/guardian read of one released lesson: the full lesson revision
   * (materials, provenance, ordered question refs, layout params) and the keyed
   * worksheet bundle (answer keys and rubrics included). Needs `read-draft`;
   * learners use `QuestionResponseService.readReleasedLesson`, which is keyless
   * and limited to their effective lessons.
   */
  async readReleasedLesson(
    request: CourseAuthoringActor & { releaseId: string; lessonKey: string },
  ): Promise<ReleasedLessonView> {
    return this.run(async (tx) => {
      const release =
        typeof request.releaseId === 'string' && request.releaseId
          ? ((await tx.get('course_releases', {
              id: request.releaseId,
              tenant_id: request.tenantId,
            })) as Row | null)
          : null;
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-released-lesson',
        release ? { courseId: String(release.course_id) } : {},
      );
      if (!release) throw new QuestionNotFoundError();
      const { released, lesson, input } = await this.releasedLessonInput(
        tx,
        request.tenantId,
        request.releaseId,
        request.lessonKey,
      );
      const model = await (
        await LessonRevisionCollection.create({ db: tx })
      ).get(
        { id: String(lesson.id), tenantId: request.tenantId },
        { cache: false },
      );
      if (!model) throw new QuestionNotFoundError();
      return {
        releaseId: request.releaseId,
        courseId: String(release.course_id),
        lessonKey: String(released.lesson_key),
        lessonId: String(released.lesson_id),
        sectionId: String(released.section_id),
        lessonRevisionId: String(lesson.id),
        revision: this.lessonView(model),
        worksheet: buildGuardianWorksheet(input),
      };
    });
  }
}
