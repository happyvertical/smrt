import type { DatabaseInterface } from '@happyvertical/sql';
import { LessonProgressCollection } from './collections.js';
import { groupSharingDigest } from './group-sharing-hash.js';
import { interestThemeFromColumns } from './learner-interest-theme.js';
import {
  LearnerAuthorizationError,
  type LearnerRequest,
  LearnerValidationError,
} from './learner-service.js';
import type { LessonQuestionRefInput } from './question-contracts.js';
import { canonical } from './question-render.js';
import { QuestionResponseScopeError } from './question-response-contracts.js';
import {
  QuestionResponseService,
  revisionView,
} from './question-response-service.js';
import {
  MAX_TUTOR_BODY_CHARS,
  MAX_TUTOR_CHOICES,
  MAX_TUTOR_CONTEXT_CHARS,
  MAX_TUTOR_FEEDBACK_CHARS,
  MAX_TUTOR_KEY_CHARS,
  MAX_TUTOR_OBJECTIVES,
  MAX_TUTOR_PROMPT_CHARS,
  MAX_TUTOR_QUESTIONS,
  MAX_TUTOR_SUBPARTS,
  MAX_TUTOR_TITLE_CHARS,
  TUTOR_AUDIENCES,
  type TutorAudience,
  type TutorContext,
  type TutorQuestionItem,
} from './tutor-contracts.js';

type Row = Record<string, unknown>;

export type TutorContextRequest = LearnerRequest & {
  audience: TutorAudience;
  enrollmentId?: string;
  lessonId?: string;
  /** Focus one question of the lesson (a question revision id). */
  questionRevisionId?: string;
};

/**
 * Composes the bounded `TutorContext` for one learner. Pure data: no AI call,
 * no prompt text. Every read uses this service's executor and the
 * `education.tutor.read` decision of the host authorizer, with the same
 * actor/tenant/relationship checks as `LearnerService`.
 */
export class TutorContextService extends QuestionResponseService {
  protected override createTransactionService(db: DatabaseInterface): this {
    return new TutorContextService(
      db,
      this.authorize,
      this.authorizeCatalog,
    ) as this;
  }

  async compose(request: TutorContextRequest): Promise<TutorContext> {
    if (!TUTOR_AUDIENCES.includes(request?.audience))
      throw new LearnerValidationError('Invalid tutor audience');
    if (
      (request.lessonId && !request.enrollmentId) ||
      (request.questionRevisionId && !request.lessonId)
    )
      throw new LearnerValidationError(
        'A tutor lesson or question needs its enrollment and lesson',
      );
    let truncated = false;
    const cut = (value: unknown, max: number): string => {
      const text = typeof value === 'string' ? value : '';
      if (text.length <= max) return text;
      truncated = true;
      return text.slice(0, max);
    };
    const enrollment = request.enrollmentId
      ? await this.requireEnrollment(
          request as LearnerRequest & { enrollmentId: string },
          'education.tutor.read',
        )
      : null;
    const learner = enrollment
      ? await this.db.get('learners', {
          id: request.learnerId,
          tenant_id: request.tenantId,
        })
      : await this.requireActor(request, 'education.tutor.read').then(
          (row) => ({
            id: String(row.id),
            display_name: row.displayName,
            level: row.level,
            user_id: row.userId,
            interest_theme_label: row.interestThemeLabel,
            interest_theme_key: row.interestThemeKey,
          }),
        );
    if (!learner) throw new LearnerAuthorizationError();
    const own = String(learner.user_id) === request.actorUserId;
    // The guardian audience may carry answer material, so it is never the
    // learner's own view, whatever the host would answer.
    if (request.audience === 'guardian' && own)
      throw new LearnerAuthorizationError();
    const guardian = request.audience === 'guardian';

    let courseView: TutorContext['course'] = null;
    let sectionView: TutorContext['section'] = null;
    let lessonView: TutorContext['lesson'] = null;
    let progressView: TutorContext['progress'] = null;
    let questions: TutorQuestionItem[] = [];
    let objectives: string[] = [];
    let answerKeyAvailable = false;
    let focus: string | null = null;
    let submissions: TutorContext['submissions'] = {
      count: 0,
      latestStatus: null,
    };
    let feedback: TutorContext['feedback'] = null;

    if (enrollment && request.lessonId) {
      const scope = await this.lessonScope(request, enrollment);
      const entry = scope.entries.find(
        ({ lesson }) => String(lesson.id) === request.lessonId,
      );
      if (!entry) throw new LearnerAuthorizationError();
      const { lesson, course } = entry;
      const lessonRow = (await this.db.get('lessons', {
        id: request.lessonId,
      })) as Row | null;
      const section = (await this.db.get('course_sections', {
        id: lesson.sectionId,
      })) as Row | null;
      const released = await this.releasedLesson(request, enrollment);
      const withheld =
        String(course.licenseKind) === 'personal-use-copy' ||
        String(released?.lesson.license_kind ?? '') === 'personal-use-copy';
      const source = released
        ? String(released.lesson.body ?? '')
        : String(lesson.body ?? '');
      courseView = {
        id: String(course.id),
        title: cut(course.title, MAX_TUTOR_TITLE_CHARS),
      };
      sectionView = section
        ? { title: cut(section.title, MAX_TUTOR_TITLE_CHARS) }
        : null;
      lessonView = {
        id: request.lessonId,
        title: cut(
          released?.lesson.title ?? lesson.title,
          MAX_TUTOR_TITLE_CHARS,
        ),
        kind:
          String(lessonRow?._meta_type ?? 'Lesson')
            .split(':')
            .pop() ?? '',
        body: withheld ? '' : cut(source, MAX_TUTOR_BODY_CHARS),
        bodyWithheld: withheld,
        estimatedMinutes: Number(
          released?.lesson.estimated_minutes ?? lesson.estimatedMinutes ?? 0,
        ),
      };

      // Questions: the learner-visible rendering only; keys are read solely to
      // say that one exists and, for a guardian, to carry their text.
      const items: TutorQuestionItem[] = [];
      const objectiveIds: string[] = [];
      if (released) {
        for (const [index, ref] of released.refs.entries()) {
          const row = await this.revisionRow(request, ref);
          if (row.answer_key_json) answerKeyAvailable = true;
          const view = revisionView(row, guardian);
          for (const id of JSON.parse(
            String(row.objective_ids_json || '[]'),
          ) as string[])
            if (!objectiveIds.includes(id)) objectiveIds.push(id);
          items.push({
            ordinal: index + 1,
            questionRevisionId: view.id,
            prompt: cut(view.prompt, MAX_TUTOR_PROMPT_CHARS),
            responseType: view.responseType,
            choices: view.choices.slice(0, MAX_TUTOR_CHOICES).map((c) => ({
              id: c.id,
              label: cut(c.label, MAX_TUTOR_PROMPT_CHARS),
            })),
            subparts: view.subparts.slice(0, MAX_TUTOR_SUBPARTS).map((p) => ({
              partKey: p.partKey,
              prompt: cut(p.prompt, MAX_TUTOR_PROMPT_CHARS),
            })),
            pointsPossible: view.pointsPossible,
            ...(guardian
              ? {
                  answerKey: view.answerKey
                    ? cut(JSON.stringify(view.answerKey), MAX_TUTOR_KEY_CHARS)
                    : null,
                  rubric: view.rubric
                    ? cut(JSON.stringify(view.rubric), MAX_TUTOR_KEY_CHARS)
                    : null,
                }
              : {}),
          });
          if (
            (view.choices.length > MAX_TUTOR_CHOICES ||
              view.subparts.length > MAX_TUTOR_SUBPARTS) &&
            !truncated
          )
            truncated = true;
        }
      }
      if (request.questionRevisionId) {
        const wanted = items.find(
          (i) => i.questionRevisionId === request.questionRevisionId,
        );
        if (!wanted) throw new LearnerAuthorizationError();
        focus = wanted.questionRevisionId;
      }
      if (items.length > MAX_TUTOR_QUESTIONS) {
        truncated = true;
        const keep = new Set(
          items
            .filter((i) => i.questionRevisionId !== focus)
            .slice(0, focus ? MAX_TUTOR_QUESTIONS - 1 : MAX_TUTOR_QUESTIONS)
            .map((i) => i.questionRevisionId),
        );
        if (focus) keep.add(focus);
        questions = items.filter((i) => keep.has(i.questionRevisionId));
      } else questions = items;

      objectives = await this.objectiveStatements(
        request.tenantId,
        objectiveIds,
        cut,
      );
      if (objectives.length > MAX_TUTOR_OBJECTIVES) {
        truncated = true;
        objectives = objectives.slice(0, MAX_TUTOR_OBJECTIVES);
      }

      // A key may also be a private answer-key asset or a worksheet key link;
      // only the fact is carried, never an id or locator.
      if (
        !answerKeyAvailable &&
        (await this.db.tableExists('lesson_assets')) &&
        (
          (await this.db.list('lesson_assets', {
            lesson_id: request.lessonId,
            relationship: 'answer-key',
          })) as Row[]
        ).filter((row) => !row.retired_at).length > 0
      )
        answerKeyAvailable = true;
      if (!answerKeyAvailable && String(lessonRow?.answer_url ?? '').trim())
        answerKeyAvailable = true;

      const progress = await (
        await LessonProgressCollection.create({ db: this.db })
      ).get(
        {
          enrollmentId: String(enrollment.id),
          lessonId: request.lessonId,
          tenantId: request.tenantId,
          learnerId: request.learnerId,
        },
        { cache: false },
      );
      if (progress) {
        const projected = await this.projectProgress(request, progress);
        progressView = {
          status: projected.status,
          completedAt: projected.completedAt
            ? new Date(projected.completedAt).toISOString()
            : null,
        };
      }
      submissions = await this.submissionSummary(request);
      feedback = await this.releasedFeedback(
        request,
        enrollment,
        guardian,
        cut,
      );
    }

    const base = {
      version: 1 as const,
      audience: request.audience,
      learner: {
        id: String(learner.id),
        displayName: cut(learner.display_name, MAX_TUTOR_TITLE_CHARS),
        level: Number(learner.level ?? 0),
        // Allowlisted: only the learner-safe label and key, never settings.
        interestTheme: interestThemeFromColumns(
          learner.interest_theme_label,
          learner.interest_theme_key,
        ),
      },
      enrollment: enrollment
        ? {
            id: String(enrollment.id),
            courseId: enrollment.courseId,
            status: enrollment.status,
            lessonsPerWeek: enrollment.paceLessonsPerWeek || null,
          }
        : null,
      course: courseView,
      section: sectionView,
      lesson: lessonView,
      objectives,
      progress: progressView,
      focusQuestionRevisionId: focus,
      submissions,
      feedback,
      answerKeyAvailable,
    };
    // Overall bound: drop trailing questions (never the focus) until it fits.
    const build = (): TutorContext => {
      const body = { ...base, questions, truncated };
      return {
        ...body,
        contextHash: groupSharingDigest(canonical(body)),
      };
    };
    while (
      JSON.stringify(build()).length > MAX_TUTOR_CONTEXT_CHARS &&
      questions.length > 0
    ) {
      const drop = [...questions]
        .reverse()
        .find((q) => q.questionRevisionId !== focus);
      if (!drop) break;
      questions = questions.filter((q) => q !== drop);
      truncated = true;
    }
    // The focused question alone can still be oversized: shrink its lists and
    // text in steps, keeping its identity (revision id) until the very end.
    const fits = () =>
      JSON.stringify(build()).length <= MAX_TUTOR_CONTEXT_CHARS;
    const shrinkFocus = (
      apply: (q: TutorQuestionItem) => TutorQuestionItem,
    ) => {
      questions = questions.map((q) =>
        q.questionRevisionId === focus ? apply(q) : q,
      );
      truncated = true;
    };
    const textCuts = [1000, 400, 150, 40];
    for (let step = 0; step < textCuts.length && !fits(); step++) {
      const text = textCuts[step];
      const lists = Math.max(1, 6 >> step);
      const clip = (value: string) =>
        value.length > text ? value.slice(0, text) : value;
      shrinkFocus((q) => ({
        ...q,
        prompt: clip(q.prompt),
        choices: q.choices
          .slice(0, lists)
          .map((c) => ({ id: c.id, label: clip(c.label) })),
        subparts: q.subparts
          .slice(0, lists)
          .map((p) => ({ partKey: p.partKey, prompt: clip(p.prompt) })),
        ...(q.answerKey != null ? { answerKey: clip(q.answerKey) } : {}),
        ...(q.rubric != null ? { rubric: clip(q.rubric) } : {}),
      }));
    }
    // Last resort: drop bulky optional fields before identity.
    if (!fits())
      shrinkFocus((q) => ({
        ...q,
        choices: [],
        subparts: [],
        ...(q.answerKey != null ? { answerKey: null } : {}),
        ...(q.rubric != null ? { rubric: null } : {}),
        prompt: q.prompt.slice(0, 40),
      }));
    // JSON escaping can still push the lesson body, feedback or objectives past
    // the ceiling (a control character serializes to six characters): halve
    // those in turn until the serialized context fits.
    for (let guard = 0; !fits() && guard < 32; guard++) {
      truncated = true;
      if (base.lesson && base.lesson.body.length > 0)
        base.lesson = {
          ...base.lesson,
          body: base.lesson.body.slice(0, base.lesson.body.length >> 1),
        };
      else if (base.feedback && base.feedback.text.length > 0)
        base.feedback = {
          ...base.feedback,
          text: base.feedback.text.slice(0, base.feedback.text.length >> 1),
        };
      else if (base.objectives.length > 0)
        base.objectives = base.objectives.slice(0, -1);
      else break;
    }
    return build();
  }

  /** The released lesson revision and ordered question refs, or null if none. */
  private async releasedLesson(
    request: TutorContextRequest,
    enrollment: { id: unknown; learnerId: string },
  ): Promise<{ lesson: Row; refs: LessonQuestionRefInput[] } | null> {
    for (const table of [
      'enrollment_release_pins',
      'released_lessons',
      'lesson_revisions',
      'question_revisions',
    ])
      if (!(await this.db.tableExists(table))) return null;
    try {
      const found = await this.lessonQuestions(
        request.tenantId,
        enrollment,
        request.lessonId as string,
      );
      return { lesson: found.row, refs: found.refs };
    } catch (error) {
      if (error instanceof QuestionResponseScopeError) return null;
      throw error;
    }
  }

  private async objectiveStatements(
    tenantId: string,
    ids: string[],
    cut: (value: unknown, max: number) => string,
  ): Promise<string[]> {
    if (
      !ids.length ||
      !(await this.db.tableExists('learning_objective_revisions'))
    )
      return [];
    const out: string[] = [];
    for (const id of ids) {
      const rows = (await this.db.list('learning_objective_revisions', {
        tenant_id: tenantId,
        objective_id: id,
      })) as Row[];
      const head = rows.reduce<Row | null>(
        (best, row) =>
          !best || Number(row.sequence) > Number(best.sequence) ? row : best,
        null,
      );
      if (head) out.push(cut(head.statement, MAX_TUTOR_TITLE_CHARS));
    }
    return out;
  }

  /** Count and latest status only: no notes, intake ids or files. */
  private async submissionSummary(request: TutorContextRequest) {
    if (!(await this.db.tableExists('submissions')))
      return { count: 0, latestStatus: null };
    const rows = (await this.db.list('submissions', {
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
      lesson_id: request.lessonId,
    })) as Row[];
    rows.sort(
      (a, b) =>
        new Date(b.submitted_at as string).getTime() -
        new Date(a.submitted_at as string).getTime(),
    );
    return {
      count: rows.length,
      latestStatus: rows[0] ? String(rows[0].status) : null,
    };
  }

  /**
   * Learner audience: the newest assessment revision a guardian explicitly
   * released, its feedback text only (no score, concept labels or per-question
   * detail). Guardian audience: the newest guardian-confirmed revision, else
   * the newest one.
   */
  private async releasedFeedback(
    request: TutorContextRequest,
    enrollment: { id: unknown },
    guardian: boolean,
    cut: (value: unknown, max: number) => string,
  ): Promise<TutorContext['feedback']> {
    for (const table of [
      'workbook_activities',
      'workbook_attempts',
      'workbook_assessment_revisions',
      'workbook_feedback_releases',
    ])
      if (!(await this.db.tableExists(table))) return null;
    const activity = await this.findLessonActivity(request, {
      enrollmentId: String(enrollment.id),
      lessonId: request.lessonId,
    });
    if (!activity) return null;
    const attempts = (await this.db.list('workbook_attempts', {
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
      activity_id: String(activity.id),
    })) as Row[];
    const revisions: Row[] = [];
    for (const attempt of attempts) {
      const rows = (await this.db.list('workbook_assessment_revisions', {
        tenant_id: request.tenantId,
        learner_id: request.learnerId,
        attempt_id: String(attempt.id),
      })) as Row[];
      if (guardian) revisions.push(...rows);
      else {
        const releases = (await this.db.list('workbook_feedback_releases', {
          tenant_id: request.tenantId,
          learner_id: request.learnerId,
          attempt_id: String(attempt.id),
        })) as Row[];
        const ids = new Set(releases.map((r) => String(r.revision_id)));
        revisions.push(...rows.filter((r) => ids.has(String(r.id))));
      }
    }
    const at = (r: Row) => new Date(r.recorded_at as string).getTime();
    revisions.sort(
      (a, b) => at(b) - at(a) || String(b.id).localeCompare(String(a.id)),
    );
    const pick = guardian
      ? (revisions.find((r) => r.kind === 'guardian') ?? revisions[0])
      : revisions[0];
    if (!pick) return null;
    let text = '';
    try {
      const parsed = JSON.parse(String(pick.assessment_json)) as {
        feedback?: unknown;
      };
      text = typeof parsed.feedback === 'string' ? parsed.feedback : '';
    } catch {
      return null;
    }
    return text.trim() ? { text: cut(text, MAX_TUTOR_FEEDBACK_CHARS) } : null;
  }
}
