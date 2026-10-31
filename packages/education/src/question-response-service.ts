import type { DatabaseInterface } from '@happyvertical/sql';
import { CourseRequestKeyConflictError } from './course-authoring-contracts.js';
import { resolveEnrollmentLessons } from './course-release-scope.js';
import { groupSharingDigest } from './group-sharing-hash.js';
import {
  LearnerAuthorizationError,
  type LearnerRequest,
  LearnerService,
} from './learner-service.js';
import {
  type LearnerLessonView,
  type LessonLayoutParams,
  type LessonQuestionRefInput,
  QUESTION_COMPLETION_MODES,
  type QuestionAssistance,
  type QuestionChoice,
  type QuestionCompletionMode,
  type QuestionProvenance,
  type QuestionResponseType,
  type QuestionRevisionView,
  type QuestionSubpart,
} from './question-contracts.js';
import {
  type QuestionResponse,
  QuestionResponseCollection,
} from './question-models.js';
import {
  buildGuardianWorksheet,
  buildLearnerWorksheet,
  canonical,
  worksheetVersionId,
} from './question-render.js';
import {
  type LessonQuestionResponses,
  type QuestionResponseContent,
  QuestionResponseNotFoundError,
  QuestionResponseScopeError,
  QuestionResponseValidationError,
  type QuestionResponseView,
} from './question-response-contracts.js';

type Row = Record<string, unknown>;
const KEY = /^[A-Za-z0-9._:@/-]{1,200}$/;
const ASSISTANCE: readonly QuestionAssistance[] = [
  'independent',
  'assisted',
  'unknown',
];
const MAX_TEXT = 20000;
const bad = (message: string) => new QuestionResponseValidationError(message);

type AtomContent = {
  text?: string;
  numeric?: number;
  choiceIds?: string[];
};
function atom(value: unknown, where: string): AtomContent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw bad(`${where} must be an object`);
  const out: AtomContent = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === 'text') {
      if (typeof member !== 'string' || member.length > MAX_TEXT)
        throw bad(`${where} text is invalid`);
      out.text = member;
    } else if (key === 'numeric') {
      if (typeof member !== 'number' || !Number.isFinite(member))
        throw bad(`${where} numeric is invalid`);
      out.numeric = member;
    } else if (key === 'choiceIds') {
      if (
        !Array.isArray(member) ||
        member.length > 100 ||
        member.some((id) => typeof id !== 'string' || !id || id.length > 200) ||
        new Set(member).size !== member.length
      )
        throw bad(`${where} choiceIds are invalid`);
      out.choiceIds = [...member];
    } else if (key !== 'parts' || where !== 'response')
      throw bad(`${where} has an unsupported member`);
  }
  return out;
}
/** Closed-shape check: no member other than the documented ones is accepted. */
function normalizeContent(input: unknown): QuestionResponseContent {
  const content: QuestionResponseContent = atom(input, 'response');
  const parts = (input as Row).parts;
  if (parts !== undefined) {
    if (!parts || typeof parts !== 'object' || Array.isArray(parts))
      throw bad('response parts must be an object');
    const entries = Object.entries(parts);
    if (entries.length > 100) throw bad('response has too many parts');
    content.parts = {};
    for (const [partKey, value] of entries) {
      if (!KEY.test(partKey)) throw bad('response part key is invalid');
      content.parts[partKey] = atom(value, 'part');
    }
  }
  if (Object.keys(content).length === 0) throw bad('response is empty');
  return content;
}
function checkAgainst(content: QuestionResponseContent, revision: Row) {
  const choices = new Set(
    (JSON.parse(String(revision.choices_json)) as QuestionChoice[]).map(
      (c) => c.id,
    ),
  );
  const subparts = new Set(
    (JSON.parse(String(revision.subparts_json)) as QuestionSubpart[]).map(
      (p) => p.partKey,
    ),
  );
  const unknownChoice = (ids?: string[]) => ids?.some((id) => !choices.has(id));
  if (unknownChoice(content.choiceIds))
    throw bad('response names a choice the question does not have');
  for (const [partKey, part] of Object.entries(content.parts ?? {})) {
    if (!subparts.has(partKey))
      throw bad('response names a part the question does not have');
    if (unknownChoice(part.choiceIds))
      throw bad('response names a choice the question does not have');
  }
}

/** Never reads or carries keys for the learner audience; guardians get them. */
function revisionView(row: Row, keyed: boolean): QuestionRevisionView {
  const parse = (value: unknown) => JSON.parse(String(value));
  return {
    id: String(row.id),
    questionId: String(row.question_id),
    parentRevisionId: row.parent_revision_id
      ? String(row.parent_revision_id)
      : null,
    sequence: Number(row.sequence),
    prompt: String(row.prompt),
    responseType: String(row.response_type) as QuestionResponseType,
    choices: parse(row.choices_json),
    subparts: parse(row.subparts_json),
    media: parse(row.media_json),
    // Objective wording is authoring data; the worksheet bundles do not use it.
    objectives: [],
    conceptIds: parse(row.concept_ids_json),
    answerKey: keyed && row.answer_key_json ? parse(row.answer_key_json) : null,
    rubric: keyed && row.rubric_json ? parse(row.rubric_json) : null,
    pointsPossible:
      row.points_possible === null || row.points_possible === undefined
        ? null
        : Number(row.points_possible),
    provenance: String(row.provenance) as QuestionProvenance,
    fieldProvenance: keyed ? parse(row.field_provenance_json) : {},
    authorUserId: '',
    delegatingGuardianUserId: null,
    delegationId: null,
    recordedAt: new Date(row.recorded_at as string | Date).toISOString(),
  };
}

type LessonRequest = LearnerRequest & {
  enrollmentId: string;
  lessonId: string;
};
export type RecordQuestionResponseRequest = LessonRequest & {
  questionRevisionId: string;
  requestKey: string;
  response: QuestionResponseContent;
  /** Learners record online responses; printable/interactive need their own path. */
  completionMode?: 'online';
  assistance?: QuestionAssistance;
  /** Names the response this one corrects; omit for a new attempt. */
  correctsResponseId?: string;
};
export type GuardianCorrectionRequest = LessonRequest & {
  questionRevisionId: string;
  requestKey: string;
  correctsResponseId: string;
  /** Omit to record assistance only: the corrected response's answer is kept. */
  response?: QuestionResponseContent;
  assistance?: QuestionAssistance;
};

/**
 * Guarded write path for learner question responses (SMRT #4515). Extends the
 * learner boundary: the actor must be the learner (own enrollment) to record,
 * or the authorized guardian to review/correct; the question revision must be in
 * the enrollment's effective lesson set. Rows are append-only; question
 * revisions are never written.
 */
export class QuestionResponseService extends LearnerService {
  protected override createTransactionService(db: DatabaseInterface): this {
    return new QuestionResponseService(
      db,
      this.authorize,
      this.authorizeCatalog,
    ) as this;
  }

  /** The learner records an online attempt, or corrects their own response. */
  async recordResponse(
    request: RecordQuestionResponseRequest,
  ): Promise<QuestionResponseView> {
    return this.mutate((service) => service.write(request, 'learner'));
  }

  /** A guardian appends a correction and/or assistance note; never overwrites. */
  async recordGuardianCorrection(
    request: GuardianCorrectionRequest,
  ): Promise<QuestionResponseView> {
    return this.mutate((service) => service.write(request, 'guardian'));
  }

  /**
   * The lesson's questions and recorded responses. The audience follows the
   * actor: the learner gets the keyless bundle, an authorized guardian the
   * keyed one. It is never a request choice.
   */
  async readLessonResponses(
    request: LessonRequest,
  ): Promise<LessonQuestionResponses> {
    const owner = await this.db.get('learners', {
      id: request.learnerId,
      tenant_id: request.tenantId,
    });
    const own = owner?.user_id === request.actorUserId;
    const enrollment = await this.requireEnrollment(
      request,
      own ? 'education.learner.respond' : 'education.learner.review-response',
    );
    const lesson = await this.lessonQuestions(
      request.tenantId,
      enrollment,
      request.lessonId,
    );
    const revisions = new Map<string, QuestionRevisionView>();
    for (const ref of lesson.refs)
      revisions.set(
        ref.questionRevisionId,
        revisionView(await this.revisionRow(request, ref), !own),
      );
    const input = {
      lessonRevisionId: lesson.lessonRevisionId,
      refs: lesson.refs,
      layoutParams: lesson.layoutParams,
      revisions,
    };
    const rows = (
      await (
        await QuestionResponseCollection.create({ db: this.db })
      ).list({
        where: {
          tenantId: request.tenantId,
          learnerId: String(enrollment.learnerId),
          enrollmentId: String(enrollment.id),
        },
        limit: 100000,
      })
    ).filter((row) => revisions.has(row.questionRevisionId));
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const depth = (id: string | null): number =>
      id && byId.has(id)
        ? 1 + depth(byId.get(id)?.previousResponseId ?? null)
        : 0;
    rows.sort(
      (a, b) =>
        a.attemptNumber - b.attemptNumber ||
        depth(a.previousResponseId) - depth(b.previousResponseId) ||
        new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime() ||
        String(a.id).localeCompare(String(b.id)),
    );
    return {
      worksheet: own
        ? buildLearnerWorksheet(input)
        : buildGuardianWorksheet(input),
      responses: rows.map((row) => this.view(row, String(owner?.user_id))),
    };
  }

  /**
   * One effective lesson for rendering, learner-safe. The audience is the same
   * for the learner and an authorized guardian (`education.learner.read`, own or
   * guardian relationship): the keyless bundle and an allowlisted lesson, never
   * answer keys, rubrics, provenance, materials, source locators or the body of
   * a personal-use-copy lesson. Keys are read through `QuestionAuthoringService.
   * readReleasedLesson` (`read-draft`). A lesson outside the enrollment's
   * effective set is a `QuestionResponseScopeError`.
   */
  async readReleasedLesson(request: LessonRequest): Promise<LearnerLessonView> {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.read',
    );
    const lesson = await this.lessonQuestions(
      request.tenantId,
      enrollment,
      request.lessonId,
    );
    const revisions = new Map<string, QuestionRevisionView>();
    for (const ref of lesson.refs)
      revisions.set(
        ref.questionRevisionId,
        revisionView(await this.revisionRow(request, ref), false),
      );
    const row = lesson.row;
    const withheld = String(row.license_kind) === 'personal-use-copy';
    return {
      enrollmentId: String(enrollment.id),
      releaseId: lesson.releaseId,
      lessonKey: lesson.lessonKey,
      lessonId: request.lessonId,
      lessonRevisionId: lesson.lessonRevisionId,
      title: String(row.title),
      body: withheld ? '' : String(row.body),
      bodyWithheld: withheld,
      lessonType: String(row.lesson_type) as LearnerLessonView['lessonType'],
      completionRule: String(
        row.completion_rule,
      ) as LearnerLessonView['completionRule'],
      estimatedMinutes: Number(row.estimated_minutes),
      pinnedToOlderRelease: lesson.pinnedToOlderRelease,
      worksheet: buildLearnerWorksheet({
        lessonRevisionId: lesson.lessonRevisionId,
        refs: lesson.refs,
        layoutParams: lesson.layoutParams,
        revisions,
      }),
    };
  }

  private view(
    row: QuestionResponse,
    learnerUserId: string,
  ): QuestionResponseView {
    return {
      id: String(row.id),
      learnerId: row.learnerId,
      enrollmentId: row.enrollmentId,
      lessonRevisionId: row.lessonRevisionId,
      questionRevisionId: row.questionRevisionId,
      worksheetVersionId: row.worksheetVersionId,
      episodeId: row.episodeId,
      attemptNumber: Number(row.attemptNumber),
      previousResponseId: row.previousResponseId,
      completionMode: row.completionMode as QuestionCompletionMode,
      assistance: row.assistance as QuestionAssistance,
      response: JSON.parse(row.responseJson),
      actorUserId: row.actorUserId,
      byGuardian: row.actorUserId !== learnerUserId,
      recordedAt: new Date(row.recordedAt).toISOString(),
    };
  }

  /** Effective lesson row to its immutable lesson revision's ordered question refs. */
  private async lessonQuestions(
    tenantId: string,
    enrollment: { id: unknown; learnerId: string },
    lessonId: string,
  ) {
    const selection = await resolveEnrollmentLessons(
      this.db,
      tenantId,
      String(enrollment.id),
    );
    if (!selection) throw new QuestionResponseScopeError();
    // Pins always belong to the enrollment's own learner.
    if ([...selection.pinLearnerIds].some((id) => id !== enrollment.learnerId))
      throw new LearnerAuthorizationError();
    const effective = selection.lessons.find((l) => l.lessonId === lessonId);
    const released = effective
      ? await this.db.get('released_lessons', {
          tenant_id: tenantId,
          release_id: effective.releaseId,
          lesson_key: effective.lessonKey,
        })
      : null;
    const lesson =
      released && String(released.lesson_id) === lessonId
        ? await this.db.get('lesson_revisions', {
            id: String(released.lesson_revision_id),
            tenant_id: tenantId,
          })
        : null;
    if (!lesson) throw new QuestionResponseScopeError();
    return {
      row: lesson as Row,
      releaseId: String(effective?.releaseId),
      lessonKey: String(effective?.lessonKey),
      pinnedToOlderRelease: effective?.pinnedToOlderRelease === true,
      lessonRevisionId: String(lesson.id),
      refs: JSON.parse(
        String(lesson.questions_json || '[]'),
      ) as LessonQuestionRefInput[],
      layoutParams: JSON.parse(
        String(lesson.layout_params_json || '{}'),
      ) as LessonLayoutParams,
    };
  }

  private async revisionRow(
    request: { tenantId: string },
    ref: { questionRevisionId: string },
  ): Promise<Row> {
    const row = await this.db.get('question_revisions', {
      id: ref.questionRevisionId,
      tenant_id: request.tenantId,
    });
    if (!row) throw new QuestionResponseScopeError();
    return row as Row;
  }

  private async write(
    request: RecordQuestionResponseRequest | GuardianCorrectionRequest,
    role: 'learner' | 'guardian',
  ): Promise<QuestionResponseView> {
    const enrollment = await this.requireEnrollment(
      request,
      role === 'learner'
        ? 'education.learner.respond'
        : 'education.learner.review-response',
    );
    const learner = await this.db.get('learners', {
      id: enrollment.learnerId,
      tenant_id: request.tenantId,
    });
    // Learner actions are the learner's own; a guardian never starts an attempt.
    if ((learner?.user_id === request.actorUserId) !== (role === 'learner'))
      throw new LearnerAuthorizationError();
    const learnerUserId = String(learner?.user_id);
    if (typeof request.requestKey !== 'string' || !KEY.test(request.requestKey))
      throw bad('requestKey is required');
    if (
      typeof request.questionRevisionId !== 'string' ||
      !request.questionRevisionId
    )
      throw bad('questionRevisionId is required');
    const corrects = request.correctsResponseId;
    if (corrects !== undefined && (typeof corrects !== 'string' || !corrects))
      throw bad('correctsResponseId is invalid');
    if (role === 'guardian' && !corrects)
      throw bad('A guardian correction must name the response it corrects');
    if (
      request.assistance !== undefined &&
      !ASSISTANCE.includes(request.assistance)
    )
      throw bad('Invalid assistance');
    const mode = (request as RecordQuestionResponseRequest).completionMode;
    if (
      mode !== undefined &&
      (!QUESTION_COMPLETION_MODES.includes(mode) || mode !== 'online')
    )
      throw bad('Learners record online responses on this path');
    const supplied =
      request.response === undefined && role === 'guardian'
        ? undefined
        : normalizeContent(request.response);
    const payloadDigest = groupSharingDigest(
      canonical({
        role,
        actorUserId: request.actorUserId,
        enrollmentId: String(enrollment.id),
        lessonId: request.lessonId,
        questionRevisionId: request.questionRevisionId,
        corrects: corrects ?? null,
        mode: mode ?? null,
        assistance: request.assistance ?? null,
        response: supplied ?? null,
      }),
    );
    await this.lock('enrollments', String(enrollment.id), request.tenantId);
    const responses = await QuestionResponseCollection.create({ db: this.db });
    const replay = await responses.get(
      {
        tenantId: request.tenantId,
        learnerId: enrollment.learnerId,
        requestKey: request.requestKey,
      },
      { cache: false },
    );
    if (replay) {
      if (replay.payloadDigest !== payloadDigest)
        throw new CourseRequestKeyConflictError();
      return this.view(replay, learnerUserId);
    }
    const lesson = await this.lessonQuestions(
      request.tenantId,
      enrollment,
      request.lessonId,
    );
    if (
      !lesson.refs.some(
        (r) => r.questionRevisionId === request.questionRevisionId,
      )
    )
      throw new QuestionResponseScopeError();
    const revision = await this.revisionRow(request, request);
    if (supplied) checkAgainst(supplied, revision);
    let previous: Row | null = null;
    if (corrects) {
      previous = (await this.db.get('question_responses', {
        id: corrects,
        tenant_id: request.tenantId,
        learner_id: enrollment.learnerId,
        enrollment_id: String(enrollment.id),
        question_revision_id: request.questionRevisionId,
      })) as Row | null;
      if (!previous) throw new QuestionResponseNotFoundError();
    }
    let attemptNumber = 1;
    if (!previous) {
      const existing = await responses.list({
        where: {
          tenantId: request.tenantId,
          learnerId: enrollment.learnerId,
          enrollmentId: String(enrollment.id),
          questionRevisionId: request.questionRevisionId,
        },
        limit: 100000,
      });
      attemptNumber =
        existing.reduce((max, row) => Math.max(max, row.attemptNumber), 0) + 1;
    }
    const created = await responses.create({
      tenantId: request.tenantId,
      learnerId: enrollment.learnerId,
      enrollmentId: String(enrollment.id),
      questionRevisionId: request.questionRevisionId,
      lessonRevisionId: lesson.lessonRevisionId,
      worksheetVersionId: worksheetVersionId(lesson.refs, lesson.layoutParams),
      previousResponseId: previous ? String(previous.id) : null,
      episodeId: previous
        ? String(previous.episode_id)
        : globalThis.crypto.randomUUID(),
      attemptNumber: previous ? Number(previous.attempt_number) : attemptNumber,
      completionMode: previous ? String(previous.completion_mode) : 'online',
      assistance:
        request.assistance ??
        (previous ? String(previous.assistance) : 'unknown'),
      responseJson: supplied
        ? JSON.stringify(supplied)
        : String(previous?.response_json),
      actorUserId: request.actorUserId,
      requestKey: request.requestKey,
      payloadDigest,
      recordedAt: new Date(),
      _insertOnly: true,
    });
    return this.view(created, learnerUserId);
  }
}
