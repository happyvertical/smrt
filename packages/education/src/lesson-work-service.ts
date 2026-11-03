import type { DatabaseInterface } from '@happyvertical/sql';
import { PDFDocument } from 'pdf-lib';
import type { Course } from './catalog.js';
import type { CatalogAuthorizer } from './catalog-service.js';
import {
  CourseCollection,
  CourseSectionCollection,
  CurriculumCollection,
  EnrollmentCollection,
  LessonProgressCollection,
  SubmissionCollection,
  WorksheetCollection,
} from './collections.js';
import {
  summarizeWorkEvidence,
  type WorkEvidenceInput,
} from './group-sharing-policy.js';
import {
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  type LearnerRequest,
} from './learner-service.js';
import {
  LessonPageCollection,
  lessonPageView,
  validLessonPageKey,
} from './lesson-pages.js';
import {
  readWorkCompletion,
  type WorkCompletionDecision,
  WorkCompletionDecisionCollection,
} from './lesson-work-completion.js';
import {
  aggregateWorkQuestions,
  type LessonActivityView,
  type LessonWorkPlacement,
  LessonWorkPlacementError,
  validateWorkAssessment,
  WORK_MATH_VOCABULARY,
  type WorkAssessment,
  WorkAssessmentValidationError,
  type WorkAssistance,
  type WorkAttemptPage,
  type WorkAttemptView,
  WorkCompletionConflictError,
  type WorkCompletionDecisionView,
  type WorkConceptSummary,
  type WorkPreservationState,
  type WorkRevisionView,
  type WorkTimeline,
  workAggregateFeedback,
} from './lesson-work-contracts.js';
import {
  type LessonActivity,
  LessonActivityCollection,
  type LessonWorkFiling,
  LessonWorkFilingCollection,
  type WorkAssessmentRevision,
  WorkAssessmentRevisionCollection,
  type WorkAttempt,
  WorkAttemptCollection,
  WorkFeedbackDeliveryCollection,
  WorkFeedbackReleaseCollection,
} from './lesson-work-models.js';
import {
  type SubmissionPage,
  SubmissionService,
  type SubmissionServiceOptions,
  type SubmissionView,
} from './submission-service.js';
import { normalizeWorkAnswerRegions } from './work-answer-regions.js';
import { normalizeWorkObservedLayout } from './work-layout.js';

type ActivityRequest = LearnerRequest & { activityId: string };
type AttemptRequest = ActivityRequest & { submissionId: string };
function createHash(algorithm: 'sha256') {
  const crypto =
    typeof process !== 'undefined' && process.getBuiltinModule?.('node:crypto');
  if (!crypto)
    throw new Error('Lesson work capture and revisions require a Node server');
  return crypto.createHash(algorithm);
}
function digest(value: unknown) {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function createdTime(row: object): number {
  const value = (row as { created_at?: unknown }).created_at;
  return value ? new Date(value as string).getTime() : 0;
}
/** A UUID-shaped id derived from its parts, so concurrent first inserts collide. */
function deterministicId(parts: unknown[]): string {
  const hex = digest(parts);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(
    (Number.parseInt(hex[16], 16) & 3) | 8
  ).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Optional course subject: text up to 200 characters, like authored courses. */
function courseSubject(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    throw new Error('Invalid course subject');
  return value.trim();
}
function nonempty(value: string, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new Error(`Invalid ${label}`);
}
function revisionView(row: WorkAssessmentRevision): WorkRevisionView {
  return {
    id: String(row.id),
    kind: row.kind as 'ai' | 'guardian',
    supersedesId: row.supersedesId,
    createdAt: row.recordedAt,
    actorUserId: row.actorUserId,
    sourceRevisionId: row.sourceRevisionId,
    decisionReason: row.decisionReason,
    assessment: JSON.parse(row.assessmentJson),
  };
}

function completionDecisionView(
  row: WorkCompletionDecision,
): WorkCompletionDecisionView {
  return {
    id: String(row.id),
    activityId: row.activityId,
    attemptId: row.attemptId,
    submissionId: row.submissionId,
    feedbackHeadId: row.feedbackHeadId,
    actorUserId: row.actorUserId,
    completedAt: new Date(row.recordedAt),
  };
}

/** Actor-bound durable lesson work workflow. No generated write surface. */
export class LessonWorkService extends SubmissionService {
  constructor(
    db: DatabaseInterface,
    authorize: LearnerAuthorizer,
    authorizeCatalog: CatalogAuthorizer,
    private readonly workOptions: SubmissionServiceOptions & {
      workVocabulary?: WorkAssessment['vocabulary'];
    },
  ) {
    super(db, authorize, authorizeCatalog, workOptions);
  }
  protected override createTransactionService(db: DatabaseInterface): this {
    return new LessonWorkService(
      db,
      this.authorize,
      this.authorizeCatalog,
      this.workOptions,
    ) as this;
  }
  /** Filed work snapshots the policy of the course it was placed in. */
  protected override async workPolicy(
    activity: LessonActivity,
  ): Promise<{ reviewRequired: boolean; policyVersion: number }> {
    // Placement and course only: a capture must not re-read the whole
    // completion history (that made long correction chains quadratic).
    const { placement } = await this.placement(activity);
    const course = placement
      ? await this.db.get('courses', { id: placement.courseId })
      : null;
    return {
      reviewRequired: ![false, 0, '0', 'f', 'false'].includes(
        (course?.work_review_required ?? true) as never,
      ),
      policyVersion: Number(course?.work_policy_version ?? 1) || 1,
    };
  }
  private async serialize(request: LearnerRequest) {
    // One lock order for book identities, policies, captures and decisions.
    await this.db.query(
      'UPDATE learners SET id=id WHERE id=? AND tenant_id=?',
      [request.learnerId, request.tenantId],
    );
  }
  private async activity(
    request: ActivityRequest,
    action: Parameters<LearnerAuthorizer>[0]['action'] = 'education.learner.read',
  ) {
    const learner = await this.requireActor(request, action);
    const row = await (
      await LessonActivityCollection.create({ db: this.db })
    ).get(
      {
        id: request.activityId,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
      },
      { cache: false },
    );
    if (!row) throw new LearnerAuthorizationError();
    if (
      row.captureKind === 'unfiled' &&
      (!row.photoIntakeId ||
        !(await this.db.get('workbook_photo_intakes', {
          id: row.photoIntakeId,
          tenant_id: request.tenantId,
          learner_id: request.learnerId,
        })))
    )
      throw new LearnerAuthorizationError();
    await this.requireEnrollment(
      { ...request, enrollmentId: row.enrollmentId },
      action,
    );
    return { row, learner };
  }
  private async filingHead(
    row: LessonActivity,
  ): Promise<LessonWorkFiling | null> {
    if (row.captureKind !== 'unfiled') return null;
    if (!(await this.db.tableExists('lesson_work_filings'))) return null;
    const rows = await (
      await LessonWorkFilingCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: row.tenantId,
        learnerId: row.learnerId,
        sourceActivityId: String(row.id),
      },
    });
    const superseded = new Set(rows.map((r) => r.previousRevisionId));
    const heads = rows.filter((r) => !superseded.has(String(r.id)));
    if (heads.length > 1)
      throw new Error('Lesson work filing history has conflicting heads');
    return heads[0] ?? null;
  }
  /** Effective placement: the filing head for filed work, else its own routing. */
  private async placement(
    row: LessonActivity,
    replay?: LessonWorkFiling,
  ): Promise<{
    head: LessonWorkFiling | null;
    placement: LessonWorkPlacement | null;
  }> {
    const head = replay ?? (await this.filingHead(row));
    if (head)
      return {
        head,
        placement: {
          courseId: head.courseId,
          enrollmentId: head.enrollmentId,
          lessonId: head.lessonId,
          lessonPageId: head.lessonPageId,
        },
      };
    if (row.captureKind === 'unfiled') return { head: null, placement: null };
    const enrollment = await this.db.get('enrollments', {
      id: row.enrollmentId,
      tenant_id: row.tenantId,
    });
    if (!enrollment) throw new LearnerAuthorizationError();
    const pages = await this.lessonPages(row.tenantId, row.lessonId);
    return {
      head: null,
      placement: {
        courseId: String(enrollment.course_id),
        enrollmentId: row.enrollmentId,
        lessonId: row.lessonId,
        lessonPageId: pages[0] ? String(pages[0].id) : null,
      },
    };
  }
  private async lessonPages(tenantId: string, lessonId: string) {
    if (!(await this.db.tableExists('lesson_pages'))) return [];
    const rows = await (
      await LessonPageCollection.create({ db: this.db })
    ).list({ where: { lessonId }, limit: 1000 });
    return rows
      .filter((r) => r.tenantId === null || r.tenantId === tenantId)
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.pageKey.localeCompare(b.pageKey) ||
          String(a.id).localeCompare(String(b.id)),
      );
  }
  private async activityView(
    row: LessonActivity,
    replay?: LessonWorkFiling,
  ): Promise<LessonActivityView> {
    const { head, placement } = await this.placement(row, replay);
    // Visibility comes from the exact-tenant enrollment, which may name a
    // global or ancestor catalog course; the course row is display only.
    const courseRow = placement
      ? await this.db.get('courses', { id: placement.courseId })
      : null;
    if (placement && !courseRow) throw new LearnerAuthorizationError();
    const course = courseRow
      ? {
          id: String(courseRow.id),
          title: String(courseRow.title ?? ''),
          bookKey: String(courseRow.book_key ?? ''),
          bookEdition: String(courseRow.book_edition ?? ''),
          workReviewRequired: ![false, 0, '0', 'f', 'false'].includes(
            courseRow.work_review_required as never,
          ),
          workPolicyVersion: Number(courseRow.work_policy_version ?? 1) || 1,
        }
      : null;
    const lesson = placement
      ? await this.db.get('lessons', { id: placement.lessonId })
      : null;
    const pages = placement
      ? (await this.lessonPages(row.tenantId, placement.lessonId)).map(
          lessonPageView,
        )
      : [];
    const page = placement?.lessonPageId
      ? pages.find((p) => p.id === placement.lessonPageId)
      : undefined;
    const completion = await readWorkCompletion(this.db, {
      tenantId: row.tenantId,
      learnerId: row.learnerId,
      activityId: String(row.id),
    });
    return {
      currentAttemptId: completion.currentAttempt
        ? String(completion.currentAttempt.id)
        : null,
      latestSubmissionId: completion.currentAttempt?.submissionId ?? null,
      completion: completion.completion,
      id: String(row.id),
      learnerId: row.learnerId,
      enrollmentId: row.enrollmentId,
      lessonId: row.lessonId,
      courseId: course ? String(course.id) : '',
      courseTitle: course?.title ?? '',
      bookKey: course?.bookKey ?? '',
      bookEdition: course?.bookEdition ?? '',
      lessonTitle: lesson ? String(lesson.title ?? '') : '',
      pageKey: placement
        ? (page?.pageKey ?? '')
        : `receipt:${row.photoIntakeId}`,
      pageLabel: placement
        ? (page?.label ?? String(lesson?.title ?? ''))
        : 'Captured work',
      pages,
      reviewRequired: course?.workReviewRequired ?? true,
      policyVersion: course?.workPolicyVersion ?? 1,
      filing: {
        state:
          row.captureKind === 'unfiled'
            ? head
              ? 'filed'
              : 'unfiled'
            : 'identified',
        placement,
        revisionId: head ? String(head.id) : null,
      },
    };
  }
  async getLessonActivity(
    request: ActivityRequest,
  ): Promise<LessonActivityView> {
    const { row } = await this.activity(request);
    return this.activityView(row);
  }
  /** Receipt-bound technical routing only; the caller already owns the surrounding mutation. */
  protected async resolveUnfiledActivityInScope(
    request: LearnerRequest & { intakeId: string },
    action:
      | 'education.learner.submit'
      | 'education.learner.plan' = 'education.learner.submit',
  ): Promise<LessonActivityView> {
    const learner = await this.requireActor(request, action);
    await this.serialize(request);
    const receipt = await this.db.get('workbook_photo_intakes', {
      id: request.intakeId,
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
    });
    if (
      !receipt ||
      (learner.userId === request.actorUserId &&
        receipt.actor_user_id !== request.actorUserId)
    )
      throw new LearnerAuthorizationError();
    const activities = await LessonActivityCollection.create({ db: this.db });
    const existing = await activities.get(
      {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        captureKind: 'unfiled',
        photoIntakeId: request.intakeId,
      },
      { cache: false },
    );
    if (existing) {
      const found = await this.activity(
        { ...request, activityId: String(existing.id) },
        action,
      );
      return this.activityView(found.row);
    }
    const key = digest([request.tenantId, request.learnerId, request.intakeId]);
    const course = await (
      await CourseCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      slug: `captured-work-${key}`,
      tenantId: request.tenantId,
      title: 'Captured work',
      licenseKind: 'personal-use-copy',
      sourceKey: 'unfiled-work',
      sourceRef: request.intakeId,
      modality: 'printable',
    });
    const section = await (
      await CourseSectionCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      slug: `captured-section-${key}`,
      tenantId: request.tenantId,
      courseId: String(course.id),
      title: 'Captured work',
    });
    const curriculum = await (
      await CurriculumCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      slug: `captured-plan-${key}`,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      title: 'Captured work',
    });
    const enrollment = await (
      await EnrollmentCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      curriculumId: String(curriculum.id),
      courseId: String(course.id),
      status: 'active',
    });
    const lesson = await (
      await WorksheetCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      slug: `captured-sheet-${key}`,
      tenantId: request.tenantId,
      sectionId: String(section.id),
      title: 'Captured work',
      completionRule: 'submit',
    });
    const row = await activities.create({
      _insertOnly: true,
      slug: `captured-work-${key}`,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      captureKind: 'unfiled',
      photoIntakeId: request.intakeId,
      enrollmentId: String(enrollment.id),
      lessonId: String(lesson.id),
    });
    await this.requireEnrollment(
      { ...request, enrollmentId: row.enrollmentId },
      action,
    );
    return this.activityView(row);
  }
  /** The family's course for a book key, created on first use. */
  protected async bookCourse(
    request: LearnerRequest,
    book: {
      bookKey: string;
      title: string;
      edition?: string;
      subject?: string;
    },
    create = true,
  ): Promise<Course | null> {
    nonempty(book.bookKey, 'book key');
    nonempty(book.title, 'book title');
    if (
      book.edition !== undefined &&
      (typeof book.edition !== 'string' || book.edition.length > 200)
    )
      throw new Error('Invalid edition');
    const courses = await CourseCollection.create({ db: this.db });
    const found = await courses.get(
      { tenantId: request.tenantId, bookKey: book.bookKey },
      { cache: false },
    );
    if (found) {
      if (
        found.title !== book.title ||
        found.bookEdition !== (book.edition ?? '')
      )
        throw new Error('Book key already names another title or edition');
      return found;
    }
    if (!create) return null;
    // A deterministic id makes a concurrent first use of the same key collide.
    return courses.create({
      _insertOnly: true,
      id: deterministicId(['book-course', request.tenantId, book.bookKey]),
      slug: `book-${digest([request.tenantId, book.bookKey])}`,
      tenantId: request.tenantId,
      title: book.title,
      licenseKind: 'personal-use-copy',
      sourceKey: 'book',
      sourceRef: book.bookKey,
      modality: 'printable',
      bookKey: book.bookKey,
      bookEdition: book.edition ?? '',
      // Applies to a new book only; an existing book keeps its subject.
      subject: courseSubject(book.subject),
    });
  }
  /** The learner's enrollment in a course; book courses enroll on first use. */
  protected async courseEnrollment(
    request: LearnerRequest,
    course: Course,
    action: Parameters<LearnerAuthorizer>[0]['action'],
  ): Promise<string> {
    const rows = (
      await (
        await EnrollmentCollection.create({ db: this.db })
      ).list({
        where: {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          courseId: String(course.id),
        },
      })
    )
      .filter((r) => r.status !== 'dropped')
      .sort(
        (a, b) =>
          createdTime(a) - createdTime(b) ||
          String(a.id).localeCompare(String(b.id)),
      );
    if (rows[0]) {
      await this.requireEnrollment(
        { ...request, enrollmentId: String(rows[0].id) },
        action,
      );
      return String(rows[0].id);
    }
    // Only the family's own courses can be seen without an enrollment, and
    // only its own book courses enroll on first use.
    if (course.tenantId !== request.tenantId)
      throw new LearnerAuthorizationError();
    if (!course.bookKey) throw new LessonWorkPlacementError('not-enrolled');
    const key = digest([request.tenantId, request.learnerId, course.id]);
    const curriculum = await (
      await CurriculumCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      slug: `book-plan-${key}`,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      title: course.title,
    });
    const enrollment = await (
      await EnrollmentCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      curriculumId: String(curriculum.id),
      courseId: String(course.id),
      status: 'active',
    });
    return String(enrollment.id);
  }
  /** Append a one-page Worksheet lesson to a family book or plain course. */
  protected async appendPageLesson(
    request: LearnerRequest,
    course: Course,
    page: { pageKey?: string; pageLabel: string },
  ): Promise<{ lessonId: string; lessonPageId: string | null }> {
    if (
      course.tenantId !== request.tenantId ||
      ['authored', 'authored-release'].includes(course.sourceKey)
    )
      throw new LessonWorkPlacementError('lesson-required');
    const sections = (
      await (
        await CourseSectionCollection.create({ db: this.db })
      ).list({
        where: { tenantId: request.tenantId, courseId: String(course.id) },
      })
    ).sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        createdTime(a) - createdTime(b) ||
        String(a.id).localeCompare(String(b.id)),
    );
    const section =
      sections[0] ??
      (await (
        await CourseSectionCollection.create({ db: this.db })
      ).create({
        _insertOnly: true,
        slug: `book-pages-${course.id}`,
        tenantId: request.tenantId,
        courseId: String(course.id),
        title: 'Pages',
      }));
    const identity = page.pageKey ?? `label:${page.pageLabel}`;
    const lessons = await this.db.list('lessons', {
      tenant_id: request.tenantId,
      section_id: String(section.id),
    });
    const lesson = await (
      await WorksheetCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      slug: `book-page-${digest([course.id, identity])}`,
      tenantId: request.tenantId,
      sectionId: String(section.id),
      title: page.pageLabel,
      sortOrder: lessons.length,
      completionRule: 'submit',
    });
    if (!page.pageKey)
      return { lessonId: String(lesson.id), lessonPageId: null };
    const created = await (
      await LessonPageCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      tenantId: request.tenantId,
      courseId: String(course.id),
      lessonId: String(lesson.id),
      pageKey: page.pageKey,
      label: page.pageLabel,
    });
    return { lessonId: String(lesson.id), lessonPageId: String(created.id) };
  }
  /** Pages with this key across the course, earliest first. */
  private async coursePages(courseId: string, pageKey: string) {
    if (!(await this.db.tableExists('lesson_pages'))) return [];
    return (
      await (
        await LessonPageCollection.create({ db: this.db })
      ).list({
        where: { courseId, pageKey },
      })
    ).sort(
      (a, b) =>
        createdTime(a) - createdTime(b) ||
        String(a.id).localeCompare(String(b.id)),
    );
  }
  /**
   * Place unfiled work in a course: an existing lesson (and page), the page
   * with that key, or a newly appended page lesson in a family book/plain
   * course. Authored courses need the lesson first (`appendLesson`). Append-only;
   * the work keeps its IDs, attempts and captured review policy.
   */
  async fileLessonWork(
    request: ActivityRequest & {
      courseId?: string;
      newBook?: {
        title: string;
        edition?: string;
        bookKey?: string;
        subject?: string;
      };
      lessonId?: string;
      pageKey?: string;
      pageLabel?: string;
      expectedRevisionId: string | null;
      requestKey: string;
      reason: string;
    },
  ): Promise<LessonActivityView> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.plan');
      await service.serialize(request);
      const { row } = await service.activity(request, 'education.learner.plan');
      if (row.captureKind !== 'unfiled')
        throw new Error('Only unfiled captured work can be filed');
      nonempty(request.requestKey, 'filing request key');
      nonempty(request.reason, 'filing reason');
      const createsBook = request.newBook !== undefined;
      if ((request.courseId !== undefined) === createsBook)
        throw new Error('Choose exactly one existing course or new book');
      let newBook: {
        bookKey: string;
        title: string;
        edition: string;
        subject?: string;
      } | null = null;
      if (createsBook) {
        const metadata = request.newBook;
        if (
          !metadata ||
          typeof metadata !== 'object' ||
          Array.isArray(metadata)
        )
          throw new Error('Invalid new book metadata');
        nonempty(metadata.title, 'new book title');
        if (
          metadata.edition !== undefined &&
          (typeof metadata.edition !== 'string' ||
            metadata.edition.length > 200)
        )
          throw new Error('Invalid new book edition');
        if (metadata.bookKey !== undefined)
          nonempty(metadata.bookKey, 'new book key');
        if (request.lessonId !== undefined)
          throw new Error('A new book has no existing lesson');
        newBook = {
          bookKey:
            metadata.bookKey ??
            `manual:${digest([request.tenantId, request.learnerId, request.activityId, request.requestKey])}`,
          title: metadata.title,
          edition: metadata.edition ?? '',
          ...(metadata.subject !== undefined
            ? { subject: courseSubject(metadata.subject) }
            : {}),
        };
      } else nonempty(request.courseId as string, 'filing course');
      if (request.lessonId !== undefined)
        nonempty(request.lessonId, 'filing lesson');
      if (request.pageKey !== undefined && !validLessonPageKey(request.pageKey))
        throw new Error('Invalid filing page key');
      if (request.pageLabel !== undefined)
        nonempty(request.pageLabel, 'filing page label');
      if (
        request.expectedRevisionId !== null &&
        (typeof request.expectedRevisionId !== 'string' ||
          !request.expectedRevisionId)
      )
        throw new Error('Invalid expected filing revision');
      const hash = digest({
        courseId: request.courseId ?? null,
        newBook,
        lessonId: request.lessonId ?? null,
        pageKey: request.pageKey ?? null,
        pageLabel: request.pageLabel ?? null,
        previousRevisionId: request.expectedRevisionId,
        actorUserId: request.actorUserId,
        reason: request.reason,
      });
      const filings = await LessonWorkFilingCollection.create({
        db: service.db,
      });
      const prior = await filings.get(
        {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          sourceActivityId: request.activityId,
          requestKey: request.requestKey,
        },
        { cache: false },
      );
      if (prior) {
        if (prior.digest !== hash)
          throw new Error('Lesson work filing retry changed');
        return service.activityView(row, prior);
      }
      const head = await service.filingHead(row);
      if ((head ? String(head.id) : null) !== request.expectedRevisionId)
        throw new Error('Lesson work filing head changed');
      const course = newBook
        ? await service.bookCourse(request, newBook)
        : await (await CourseCollection.create({ db: service.db })).get(
            { id: request.courseId },
            { cache: false },
          );
      if (
        !course ||
        course.sourceKey === 'unfiled-work' ||
        course.status === 'archived'
      )
        throw new LearnerAuthorizationError();
      const enrollmentId = await service.courseEnrollment(
        request,
        course,
        'education.learner.plan',
      );
      const label = request.pageLabel ?? request.pageKey ?? 'Captured work';
      let lessonId: string;
      let lessonPageId: string | null = null;
      if (request.lessonId) {
        const scope = await service.lessonScope(
          request,
          await service.requireEnrollment(
            { ...request, enrollmentId },
            'education.learner.plan',
          ),
        );
        if (
          !scope.entries.some(
            ({ lesson }) => String(lesson.id) === request.lessonId,
          )
        )
          throw new LessonWorkPlacementError('lesson-outside-course');
        lessonId = request.lessonId;
        if (request.pageKey) {
          const pages = await LessonPageCollection.create({ db: service.db });
          const lesson = await service.db.get('lessons', { id: lessonId });
          const existing = await pages.get(
            { lessonId, pageKey: request.pageKey },
            { cache: false },
          );
          // A family may add pages only to its own lessons; shared or
          // global catalog structure is never written by a family filing.
          if (!existing && lesson?.tenant_id !== request.tenantId)
            throw new LessonWorkPlacementError('shared-lesson-page');
          lessonPageId = existing
            ? String(existing.id)
            : String(
                (
                  await pages.create({
                    _insertOnly: true,
                    tenantId: request.tenantId,
                    courseId: String(
                      (
                        await service.db.get('course_sections', {
                          id: lesson?.section_id,
                        })
                      )?.course_id,
                    ),
                    lessonId,
                    pageKey: request.pageKey,
                    label,
                    sortOrder: (
                      await service.lessonPages(request.tenantId, lessonId)
                    ).length,
                  })
                ).id,
              );
        }
      } else {
        const match = request.pageKey
          ? (await service.coursePages(String(course.id), request.pageKey))[0]
          : undefined;
        if (match) {
          lessonId = match.lessonId;
          lessonPageId = String(match.id);
        } else {
          const appended = await service.appendPageLesson(request, course, {
            pageKey: request.pageKey,
            pageLabel: label,
          });
          lessonId = appended.lessonId;
          lessonPageId = appended.lessonPageId;
        }
      }
      const filing = await filings.create({
        _insertOnly: true,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        sourceActivityId: request.activityId,
        courseId: String(course.id),
        enrollmentId,
        lessonId,
        lessonPageId,
        previousRevisionId: request.expectedRevisionId,
        actorUserId: request.actorUserId,
        requestKey: request.requestKey,
        reason: request.reason,
        digest: hash,
      });
      await service.syncPlacedProgress(
        request,
        row,
        { enrollmentId, lessonId },
        'filing',
      );
      return service.activityView(row, filing);
    });
  }
  /**
   * Mirror placed work onto the target lesson's progress: Done when the work's
   * current attempt is complete, otherwise Doing. A projection, not evidence.
   */
  protected async syncPlacedProgress(
    request: LearnerRequest,
    row: LessonActivity,
    target: { enrollmentId: string; lessonId: string },
    mode: 'filing' | 'change' = 'change',
  ): Promise<void> {
    const state = await readWorkCompletion(this.db, {
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      activityId: String(row.id),
    });
    // The work's first capture, not the moment it was filed.
    const firstCapture = state.attempts.length
      ? new Date(
          Math.min(
            ...state.attempts.map((a) => new Date(a.capturedAt).getTime()),
          ),
        )
      : new Date();
    const progress = await LessonProgressCollection.create({ db: this.db });
    const existing = await progress.get(
      {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        enrollmentId: target.enrollmentId,
        lessonId: target.lessonId,
      },
      { cache: false },
    );
    const complete = state.completion.status === 'complete';
    if (existing) {
      if (complete && existing.status !== 'complete') {
        existing.status = 'complete';
        existing.completedAt = state.completion.completedAt;
        existing.startedAt ??= firstCapture;
        await existing.save();
      } else if (!complete && existing.status === 'not_started') {
        existing.status = 'submitted';
        existing.startedAt ??= firstCapture;
        await existing.save();
      } else if (
        mode === 'change' &&
        !complete &&
        existing.status === 'complete' &&
        existing.completedAt &&
        // Provenance: reopen only a completion this placed work produced,
        // i.e. one stamped with one of its own completion decisions. Filing
        // never lowers progress, and attestation, legacy or other sources'
        // completions are never undone here.
        state.decisions.some(
          (decision) =>
            new Date(decision.recordedAt).getTime() ===
            new Date(existing.completedAt as Date).getTime(),
        )
      ) {
        existing.status = 'submitted';
        existing.completedAt = null;
        await existing.save();
      }
      return;
    }
    await progress.create({
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      enrollmentId: target.enrollmentId,
      lessonId: target.lessonId,
      status: complete ? 'complete' : 'submitted',
      startedAt: firstCapture,
      completedAt: complete ? state.completion.completedAt : null,
      attempts: state.attempts.length,
    });
  }
  /**
   * Keep a filed activity's placement progress in step after its completion
   * changes (a decision, a new capture or a correction). Same transaction.
   */
  protected async syncPlacement(
    request: LearnerRequest,
    row: LessonActivity,
  ): Promise<void> {
    const head = await this.filingHead(row);
    if (head)
      await this.syncPlacedProgress(request, row, {
        enrollmentId: head.enrollmentId,
        lessonId: head.lessonId,
      });
  }
  /** Explicit keys distinguish editions, repeated printed labels and page sides. */
  async resolveBookPageActivity(
    request: LearnerRequest & {
      bookKey: string;
      title: string;
      edition?: string;
      pageKey: string;
      pageLabel: string;
    },
  ): Promise<LessonActivityView> {
    return this.composeMutation((service) =>
      service.resolveBookPageActivityInScope(request, 'education.learner.plan'),
    );
  }
  /** Owning intake extension: caller validates evidence before upload-authorized creation. */
  protected async resolveBookPageActivityInScope(
    request: LearnerRequest & {
      bookKey: string;
      title: string;
      edition?: string;
      pageKey: string;
      pageLabel: string;
    },
    action: 'education.learner.plan' | 'education.learner.submit',
  ): Promise<LessonActivityView> {
    const service = this;
    await service.requireActor(request, action);
    await service.serialize(request);
    if (!validLessonPageKey(request.pageKey))
      throw new Error('Invalid pageKey');
    nonempty(request.pageLabel, 'pageLabel');
    const course = await service.bookCourse(request, request);
    if (!course) throw new LearnerAuthorizationError();
    const pages = await service.coursePages(String(course.id), request.pageKey);
    const activities = await LessonActivityCollection.create({
      db: service.db,
    });
    // A learner keeps the page lesson their earlier work used (merged books).
    for (const page of pages) {
      const existing = await activities.get(
        {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          lessonId: page.lessonId,
          captureKind: 'identified',
        },
        { cache: false },
      );
      if (existing) {
        if (page.label !== request.pageLabel)
          throw new Error('Page key already names another activity');
        await service.activity(
          { ...request, activityId: String(existing.id) },
          action,
        );
        return service.activityView(existing);
      }
    }
    if (pages[0] && pages[0].label !== request.pageLabel)
      throw new Error('Page key already names another activity');
    const enrollmentId = await service.courseEnrollment(
      request,
      course,
      action,
    );
    const lessonId =
      pages[0]?.lessonId ??
      (
        await service.appendPageLesson(request, course, {
          pageKey: request.pageKey,
          pageLabel: request.pageLabel,
        })
      ).lessonId;
    const row = await activities.create({
      _insertOnly: true,
      slug: `lesson-activity-${digest([request.learnerId, enrollmentId, lessonId])}`,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      enrollmentId,
      lessonId,
    });
    return service.activityView(row);
  }
  /** Every activity of the learner, optionally only those placed in one course. */
  async listLessonActivities(
    request: LearnerRequest & {
      courseId?: string;
      filing?: 'unfiled' | 'filed' | 'identified';
    },
  ): Promise<LessonActivityView[]> {
    await this.requireActor(request, 'education.learner.read');
    const rows = await (
      await LessonActivityCollection.create({ db: this.db })
    ).list({
      where: { tenantId: request.tenantId, learnerId: request.learnerId },
    });
    const result: LessonActivityView[] = [];
    for (const row of rows) {
      await this.activity({ ...request, activityId: String(row.id) });
      const view = await this.activityView(row);
      if (request.courseId !== undefined && view.courseId !== request.courseId)
        continue;
      if (request.filing !== undefined && view.filing.state !== request.filing)
        continue;
      result.push(view);
    }
    return result;
  }
  /**
   * Family course work policy. A guardian needs plan authority over every
   * learner enrolled in the course; captures keep their snapshot.
   */
  /**
   * Set or clear (`null` or '') a family book course's subject. A guardian
   * needs plan authority over the request learner and every learner enrolled
   * in it; shared catalog
   * courses and courses without book identity are refused.
   */
  async setBookCourseSubject(
    request: LearnerRequest & { courseId: string; subject: string | null },
  ): Promise<{ courseId: string; subject: string }> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.plan');
      await service.serialize(request);
      const subject = courseSubject(request.subject);
      const course = await (
        await CourseCollection.create({ db: service.db })
      ).get(
        { id: request.courseId, tenantId: request.tenantId },
        { cache: false },
      );
      if (!course || course.tenantId !== request.tenantId || !course.bookKey)
        throw new LearnerAuthorizationError();
      const enrollments = await service.db.list('enrollments', {
        tenant_id: request.tenantId,
        course_id: request.courseId,
      });
      // A book known only from a cover has no enrollments yet; the caller's
      // plan authority over its learner is then the gate.
      for (const learnerId of new Set(
        enrollments.map((e) => String(e.learner_id)),
      ))
        await service.requireActor(
          { ...request, learnerId },
          'education.learner.plan',
        );
      course.subject = subject;
      await course.save();
      return { courseId: String(course.id), subject };
    });
  }
  async setCourseWorkPolicy(
    request: LearnerRequest & {
      courseId: string;
      expectedPolicyVersion: number;
      reviewRequired: boolean;
    },
  ): Promise<{
    courseId: string;
    reviewRequired: boolean;
    policyVersion: number;
  }> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.plan');
      await service.serialize(request);
      const course = await (
        await CourseCollection.create({ db: service.db })
      ).get(
        { id: request.courseId, tenantId: request.tenantId },
        { cache: false },
      );
      if (!course) throw new LearnerAuthorizationError();
      const enrollments = await service.db.list('enrollments', {
        tenant_id: request.tenantId,
        course_id: request.courseId,
      });
      if (!enrollments.some((e) => String(e.learner_id) === request.learnerId))
        throw new LearnerAuthorizationError();
      for (const learnerId of new Set(
        enrollments.map((e) => String(e.learner_id)),
      ))
        await service.requireActor(
          { ...request, learnerId },
          'education.learner.plan',
        );
      if (
        typeof request.reviewRequired !== 'boolean' ||
        course.workPolicyVersion !== request.expectedPolicyVersion
      )
        throw new Error('Course work policy changed');
      course.workReviewRequired = request.reviewRequired;
      course.workPolicyVersion++;
      await course.save();
      return {
        courseId: String(course.id),
        reviewRequired: course.workReviewRequired,
        policyVersion: course.workPolicyVersion,
      };
    });
  }
  private async attempt(
    request: AttemptRequest,
    action: Parameters<LearnerAuthorizer>[0]['action'] = 'education.learner.read',
  ) {
    const found = await this.activity(request, action);
    const attempt = await (
      await WorkAttemptCollection.create({ db: this.db })
    ).get(
      {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: request.activityId,
        submissionId: request.submissionId,
      },
      { cache: false },
    );
    if (!attempt) throw new LearnerAuthorizationError();
    return { ...found, attempt };
  }
  private async attemptView(
    request: LearnerRequest,
    row: LessonActivity,
    attempt: WorkAttempt,
    // Per-call memo of each submission's projected pages (timeline reuse).
    pagesCache: Map<string, SubmissionView['pages']> = new Map(),
  ): Promise<WorkAttemptView> {
    const submission = await super.getSubmission({
      ...request,
      enrollmentId: row.enrollmentId,
      submissionId: attempt.submissionId,
    });
    pagesCache.set(attempt.submissionId, submission.pages);
    // Fold page versions over the correction chain, oldest first. Ancestors
    // belong to the same authorized learner and activity; their pages pass
    // through the same submission page privacy projection, read once each.
    const chain: Array<{
      attempt: WorkAttempt;
      pages: SubmissionView['pages'];
    }> = [{ attempt, pages: submission.pages }];
    if (attempt.previousAttemptId) {
      const episode = new Map(
        (
          await (
            await WorkAttemptCollection.create({ db: this.db })
          ).list({
            where: {
              tenantId: request.tenantId,
              learnerId: request.learnerId,
              activityId: attempt.activityId,
              episodeId: attempt.episodeId,
            },
          })
        ).map((a) => [String(a.id), a]),
      );
      const submissions = await SubmissionCollection.create({ db: this.db });
      const seen = new Set([String(attempt.id)]);
      for (
        let previousId: string | null = attempt.previousAttemptId;
        previousId;
        previousId = chain[0].attempt.previousAttemptId
      ) {
        if (seen.has(previousId))
          throw new Error('Lesson work attempt ancestry is cyclic');
        seen.add(previousId);
        const previous = episode.get(previousId);
        if (!previous)
          throw new Error('Lesson work attempt ancestry is incomplete');
        let pages = pagesCache.get(previous.submissionId);
        if (!pages) {
          const submissionRow = await submissions.get(
            {
              id: previous.submissionId,
              tenantId: request.tenantId,
              learnerId: request.learnerId,
            },
            { cache: false },
          );
          if (!submissionRow) throw new LearnerAuthorizationError();
          pages = (
            await this.submissionPages(submissionRow, request.actorUserId, true)
          ).pages;
          pagesCache.set(previous.submissionId, pages);
        }
        chain.unshift({ attempt: previous, pages });
      }
    }
    const pages = new Map<string, WorkAttemptPage>();
    for (const link of chain)
      for (const page of [...link.pages].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      )) {
        const version = {
          attemptId: String(link.attempt.id),
          submissionId: link.attempt.submissionId,
          assetId: page.assetId,
        };
        const entry = pages.get(page.pageKey);
        if (entry) {
          entry.versions.push(version);
          entry.current = version;
        } else
          pages.set(page.pageKey, {
            pageKey: page.pageKey,
            current: version,
            versions: [version],
          });
      }
    // Lesson work feedback always travels through the revision policy, never Grade.
    return {
      id: String(attempt.id),
      submissionId: attempt.submissionId,
      activityId: attempt.activityId,
      previousAttemptId: attempt.previousAttemptId,
      episodeId: attempt.episodeId,
      reviewRequired: attempt.reviewRequired,
      policyVersion: attempt.policyVersion,
      assistance: attempt.assistance as WorkAssistance,
      submission: { ...submission, grade: null },
      pages: [...pages.values()],
    };
  }
  async captureLessonWork(
    request: ActivityRequest & {
      requestKey: string;
      pages: readonly SubmissionPage[];
      notes?: string;
      previousSubmissionId?: string;
      assistance?: WorkAssistance;
      intakeItemId?: string;
    },
  ): Promise<WorkAttemptView> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.submit');
      await service.serialize(request);
      const { row } = await service.activity(
        request,
        'education.learner.submit',
      );
      if (row.captureKind === 'unfiled' && !request.previousSubmissionId) {
        const receipt = await service.db.get('workbook_photo_intakes', {
          id: row.photoIntakeId,
          tenant_id: request.tenantId,
          learner_id: request.learnerId,
        });
        if (!receipt || request.intakeItemId !== receipt.item_id)
          throw new Error(
            'Unfiled capture requires its original photo receipt',
          );
      }
      const assistance = request.assistance ?? 'unknown';
      if (!['independent', 'assisted', 'unknown'].includes(assistance))
        throw new Error('Invalid assistance');
      const attempts = await WorkAttemptCollection.create({
        db: service.db,
      });
      let previous: WorkAttempt | null = null;
      if (request.previousSubmissionId) {
        const predecessor = await service.attempt(
          { ...request, submissionId: request.previousSubmissionId },
          'education.learner.submit',
        );
        previous = predecessor.attempt;
        if (
          predecessor.learner.userId === request.actorUserId &&
          !(await service.questionIdentityVisible(
            request,
            previous,
            await service.identityRevision(request, previous),
          ))
        )
          throw new LearnerAuthorizationError();
      }
      if (request.previousSubmissionId) {
        const current = await readWorkCompletion(service.db, {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          activityId: request.activityId,
        });
        if (
          current.currentAttempt?.submissionId !== request.previousSubmissionId
        ) {
          const priorSubmissions = await (
            await SubmissionCollection.create({ db: service.db })
          ).list({
            where: {
              tenantId: request.tenantId,
              learnerId: request.learnerId,
              lessonId: row.lessonId,
              captureKey: request.requestKey,
            },
          });
          if (
            !priorSubmissions.some((submission) =>
              current.attempts.some(
                (attempt) => attempt.submissionId === submission.id,
              ),
            )
          )
            throw new WorkCompletionConflictError('stale_attempt');
        }
      }
      const capture = {
        ...request,
        enrollmentId: row.enrollmentId,
        lessonId: row.lessonId,
      };
      const intakeItemId =
        request.intakeItemId ??
        (request.previousSubmissionId
          ? `workbook:${digest([request.activityId, request.requestKey])}`
          : undefined);
      const submission = await service.captureActivitySubmission(
        {
          ...capture,
          intake: intakeItemId
            ? {
                intakeItemId,
                kind: 'completed_work',
                ...(request.previousSubmissionId
                  ? { previousSubmissionId: request.previousSubmissionId }
                  : {}),
              }
            : undefined,
        },
        { activityId: request.activityId, assistance },
      );
      // The base capture recorded the attempt with the submission; a retry
      // returns that same attempt and must not change its help claim.
      const attempt = await attempts.get(
        { tenantId: request.tenantId, submissionId: submission.id },
        { cache: false },
      );
      if (
        !attempt ||
        attempt.activityId !== request.activityId ||
        attempt.assistance !== assistance
      )
        throw new Error('Lesson work capture retry changed');
      await service.syncPlacement(request, row);
      return service.attemptView(request, row, attempt);
    });
  }
  /** Trusted host lookup, preserving exact enrollment and actor authorization. */
  async getWorkAttemptBySubmission(
    request: LearnerRequest & { enrollmentId: string; submissionId: string },
  ): Promise<WorkAttemptView | null> {
    await this.requireEnrollment(request, 'education.learner.read');
    const attempt = await (
      await WorkAttemptCollection.create({ db: this.db })
    ).get(
      {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        submissionId: request.submissionId,
      },
      { cache: false },
    );
    if (!attempt) return null;
    const { row } = await this.activity({
      ...request,
      activityId: attempt.activityId,
    });
    if (row.enrollmentId !== request.enrollmentId)
      throw new LearnerAuthorizationError();
    return this.attemptView(request, row, attempt);
  }
  /** Authorized content-free preservation status; never exposes withheld marks. */
  async getWorkPreservationState(
    request: AttemptRequest,
  ): Promise<WorkPreservationState> {
    const { attempt, row } = await this.attempt(request);
    const submission = await super.getSubmission({
      ...request,
      enrollmentId: row.enrollmentId,
    });
    const revisions = await this.revisions(request, String(attempt.id));
    return {
      activityId: attempt.activityId,
      submissionId: attempt.submissionId,
      intakeItemId: submission.intakeItemId,
      retainedAnalyses: revisions
        .filter((r) => r.kind === 'ai')
        .map((r) => {
          const provenance = revisionView(r).assessment.provenance;
          return {
            assessmentRevisionId: String(r.id),
            analysisAttemptId: provenance.analysisId,
            analysisRevision: provenance.analysisRevision ?? null,
          };
        }),
    };
  }
  /** Public data-only digest map used to preserve ingestion source anchors. */
  async getWorkSourceAnchors(
    request: AttemptRequest,
  ): Promise<{ assetId: string; sha256: string; pageCount: number }[]> {
    const { attempt } = await this.attempt(request);
    return JSON.parse(attempt.sourceHashes);
  }
  /** Stable IDs only: historical prompts may themselves contain learner answers. */
  async getWorkQuestionIdentity(
    request: AttemptRequest,
  ): Promise<{ id: string }[]> {
    const { attempt, learner } = await this.attempt(
      request,
      'education.learner.submit',
    );
    const sourceId = attempt.previousAttemptId ?? String(attempt.id);
    const source = await (
      await WorkAttemptCollection.create({ db: this.db })
    ).get(
      {
        id: sourceId,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: request.activityId,
      },
      { cache: false },
    );
    if (!source || source.episodeId !== attempt.episodeId)
      throw new LearnerAuthorizationError();
    const revision = await this.identityRevision(request, source);
    if (
      revision &&
      learner.userId === request.actorUserId &&
      !(await this.questionIdentityVisible(request, source, revision))
    )
      throw new LearnerAuthorizationError();
    return revision
      ? revisionView(revision).assessment.questions.map((q) => ({
          id: q.id,
        }))
      : [];
  }
  /** Canonical transcriptions only for this exact capture, never its predecessor.
   * A correction without its own revision receives IDs only. Both paths retain
   * the same source/revision and full ancestry visibility checks as identity. */
  async getWorkQuestionContext(
    request: AttemptRequest & { analysisRevision?: number },
  ): Promise<
    | { kind: 'same_capture'; questions: { id: string; prompt: string }[] }
    | { kind: 'identity_only'; questions: { id: string }[] }
  > {
    const { attempt, learner } = await this.attempt(
      request,
      'education.learner.submit',
    );
    // A generation's own materialization must not change its input context.
    // Only this attempt's AI from that exact item revision is excluded; never
    // guardian decisions, predecessor AI or unrelated later interpretations.
    const revision = await this.identityRevision(
      request,
      attempt,
      request.analysisRevision,
    );
    if (revision) {
      if (
        learner.userId === request.actorUserId &&
        !(await this.revisionPayloadVisible(request, attempt, revision))
      )
        throw new LearnerAuthorizationError();
      return {
        kind: 'same_capture',
        questions: revisionView(revision).assessment.questions.map(
          ({ id, prompt }) => ({ id, prompt }),
        ),
      };
    }
    if (!attempt.previousAttemptId)
      return { kind: 'identity_only', questions: [] };
    const questions = await this.getWorkQuestionIdentity(request);
    return { kind: 'identity_only', questions };
  }
  private async revisionPayloadVisible(
    request: LearnerRequest,
    attempt: WorkAttempt,
    revision: WorkAssessmentRevision,
  ): Promise<boolean> {
    const photo = await this.workbookPhotoSource(request, {
      submissionId: attempt.submissionId,
    });
    const release = await (
      await WorkFeedbackReleaseCollection.create({ db: this.db })
    ).get(
      {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        attemptId: String(attempt.id),
        revisionId: String(revision.id),
      },
      { cache: false },
    );
    return (
      !!(
        release ||
        (!photo.guardianOrigin &&
          !attempt.reviewRequired &&
          revision.kind === 'ai')
      ) && (await this.questionIdentityVisible(request, attempt, revision))
    );
  }
  private async revisions(request: LearnerRequest, attemptId: string) {
    return (
      await WorkAssessmentRevisionCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        attemptId,
      },
      orderBy: 'recordedAt',
    });
  }
  private async identityRevision(
    request: LearnerRequest,
    attempt: WorkAttempt,
    excludeAnalysisRevision?: number,
  ): Promise<WorkAssessmentRevision | undefined> {
    const rows = (await this.revisions(request, String(attempt.id))).filter(
      (row) =>
        row.kind !== 'ai' ||
        excludeAnalysisRevision === undefined ||
        revisionView(row).assessment.provenance.analysisRevision !==
          excludeAnalysisRevision,
    );
    return (
      rows.filter((r) => r.kind === 'guardian').at(-1) ??
      rows.filter((r) => r.kind === 'ai')[0]
    );
  }
  /** Call after actor/resource authorization, only for own-learner projections.
   * Semantic IDs are source content. A descendant release cannot publish a
   * hidden ancestor; exact published ID sets keep old public snapshots usable. */
  private async questionIdentityVisible(
    request: LearnerRequest,
    attempt: WorkAttempt,
    revision: WorkAssessmentRevision | undefined,
    proposedIds?: readonly string[],
  ): Promise<boolean> {
    if (revision && revision.attemptId !== String(attempt.id)) return false;
    const identity = (row: WorkAssessmentRevision) =>
      JSON.stringify(
        revisionView(row)
          .assessment.questions.map((q) => q.id)
          .sort(),
      );
    const ids = revision
      ? identity(revision)
      : proposedIds
        ? JSON.stringify([...proposedIds].sort())
        : null;
    const released = async (source: WorkAttempt, row: WorkAssessmentRevision) =>
      !!(await (
        await WorkFeedbackReleaseCollection.create({ db: this.db })
      ).get(
        {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          attemptId: String(source.id),
          revisionId: String(row.id),
        },
        { cache: false },
      ));
    const attempts = await WorkAttemptCollection.create({ db: this.db });
    const seen = new Set<string>();
    let current: WorkAttempt | null = attempt;
    while (current) {
      if (
        seen.has(String(current.id)) ||
        current.tenantId !== request.tenantId ||
        current.learnerId !== request.learnerId ||
        current.activityId !== attempt.activityId ||
        current.episodeId !== attempt.episodeId
      )
        return false;
      seen.add(String(current.id));
      const photo = await this.workbookPhotoSource(request, {
        submissionId: current.submissionId,
      });
      if (photo.guardianOrigin) {
        if (current.id === attempt.id) {
          if (!revision || !(await released(current, revision))) return false;
        } else {
          if (ids === null) return false;
          let published = false;
          for (const ancestor of await this.revisions(
            request,
            String(current.id),
          )) {
            if (
              identity(ancestor) === ids &&
              (await released(current, ancestor))
            ) {
              published = true;
              break;
            }
          }
          if (!published) return false;
        }
      }
      if (!current.previousAttemptId) return true;
      current = await attempts.get(
        {
          id: current.previousAttemptId,
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          activityId: attempt.activityId,
        },
        { cache: false },
      );
      if (!current) return false;
    }
    return false;
  }
  private async validateAssessment(
    request: AttemptRequest,
    attempt: WorkAttempt,
    assessment: WorkAssessment,
  ) {
    validateWorkAssessment(assessment);
    if (
      JSON.stringify(assessment.vocabulary) !==
      JSON.stringify(this.workOptions.workVocabulary ?? WORK_MATH_VOCABULARY)
    )
      throw new WorkAssessmentValidationError(
        'Assessment must use configured curated vocabulary',
      );
    const sources: { assetId: string; sha256: string; pageCount: number }[] =
      JSON.parse(attempt.sourceHashes);
    for (const q of assessment.questions)
      for (const anchor of q.anchors)
        if (
          !sources.some(
            (s) =>
              s.assetId === anchor.assetId &&
              s.sha256 === anchor.sha256 &&
              (anchor.page === null || anchor.page <= s.pageCount),
          )
        )
          throw new WorkAssessmentValidationError(
            'Assessment source does not belong to capture',
            'ungrounded_source',
          );
    // IDs span captures; transcriptions belong to each capture's own evidence.
    // Pin prompts within a capture only: historical prompts can include old
    // learner answers and must never force those answers onto a correction.
    // Reviewed vocabulary still cannot be replaced by free-text labels.
    const activities = await (
      await WorkAttemptCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: request.activityId,
      },
    });
    for (const prior of activities) {
      const priorRevisions = await this.revisions(request, String(prior.id));
      const reviewed =
        priorRevisions.filter((r) => r.kind === 'guardian').at(-1) ??
        priorRevisions.filter((r) => r.kind === 'ai')[0];
      if (!reviewed) continue;
      const previous = revisionView(reviewed).assessment;
      if (
        reviewed.kind === 'guardian' &&
        JSON.stringify(previous.vocabulary) !==
          JSON.stringify(assessment.vocabulary)
      )
        throw new WorkAssessmentValidationError(
          'Reviewed concept vocabulary requires explicit guardian remapping',
          'ambiguous_proposal',
        );
      const ids = new Set(previous.questions.map((q) => q.id));
      if (
        assessment.questions.length !== ids.size ||
        assessment.questions.some(
          (q) =>
            !ids.has(q.id) ||
            (String(prior.id) === String(attempt.id) &&
              previous.questions.find((p) => p.id === q.id)?.prompt !==
                q.prompt),
        )
      )
        throw new WorkAssessmentValidationError(
          'Unconfirmed question identity or changed prompt',
          'ambiguous_proposal',
        );
    }
  }
  private async appendRevision(
    request: AttemptRequest & { requestKey: string },
    attempt: WorkAttempt,
    kind: 'ai' | 'guardian',
    assessment: WorkAssessment,
    supersedesId: string | null,
    sourceRevisionId: string | null = null,
    decisionReason = '',
  ) {
    nonempty(request.requestKey, 'revision request key');
    const rows = await WorkAssessmentRevisionCollection.create({
      db: this.db,
    });
    const requestDigest = digest({
      assessment,
      supersedesId,
      sourceRevisionId,
      decisionReason,
      kind,
    });
    const prior = await rows.get(
      {
        tenantId: request.tenantId,
        attemptId: String(attempt.id),
        requestKey: request.requestKey,
      },
      { cache: false },
    );
    if (prior) {
      if (prior.requestDigest !== requestDigest)
        throw new Error('Revision retry changed');
      return { row: prior, fresh: false };
    }
    const all = await this.revisions(request, String(attempt.id));
    const recordedAt = new Date(
      Math.max(
        Date.now(),
        ...all.map((r) => new Date(r.recordedAt).getTime() + 1),
      ),
    );
    return {
      row: await rows.create({
        _insertOnly: true,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        attemptId: String(attempt.id),
        kind,
        requestKey: request.requestKey,
        requestDigest,
        supersedesId,
        sourceRevisionId,
        decisionReason,
        actorUserId: request.actorUserId,
        assessmentJson: JSON.stringify(assessment),
        recordedAt,
      }),
      fresh: true,
    };
  }
  async recordWorkAnalysis(
    request: AttemptRequest & {
      requestKey: string;
      assessment: WorkAssessment;
    },
  ): Promise<WorkRevisionView> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.submit');
      await service.serialize(request);
      const { attempt, learner } = await service.attempt(
        request,
        'education.learner.submit',
      );
      const assessment: WorkAssessment = {
        ...request.assessment,
        aggregate: undefined,
        questions: request.assessment.questions?.map((q) => ({
          ...q,
          markingCertainty: q.markingCertainty ?? ('unknown' as const),
          mappingCertainty: q.mappingCertainty ?? ('unknown' as const),
          mappingProvenance: 'proposed' as const,
          evidenceLimitations: q.evidenceLimitations ?? [],
        })),
      };
      validateWorkAssessment(assessment);
      const normalizedLayout = normalizeWorkObservedLayout(
        assessment.layout,
        assessment.questions,
        JSON.parse(attempt.sourceHashes),
      );
      delete assessment.layout;
      // Retain only the safe omission code on a default guardian copy.
      const omitted = assessment.layoutOmission === 'invalid';
      delete assessment.layoutOmission;
      Object.assign(assessment, normalizedLayout);
      if (!assessment.layout && omitted) assessment.layoutOmission = 'invalid';
      const regionOmitted = assessment.answerRegionsOmission === 'invalid';
      const normalizedRegions = normalizeWorkAnswerRegions(
        assessment.answerRegions,
        assessment.questions,
        JSON.parse(attempt.sourceHashes),
      );
      delete assessment.answerRegions;
      delete assessment.answerRegionsOmission;
      Object.assign(assessment, normalizedRegions);
      if (!assessment.answerRegions && regionOmitted)
        assessment.answerRegionsOmission = 'invalid';
      // This method returns its raw revision to the caller. A learner cannot
      // use it to probe hidden identities or obtain a new guardian-source body.
      if (
        learner.userId === request.actorUserId &&
        !(await service.questionIdentityVisible(
          request,
          attempt,
          undefined,
          assessment.questions.map((q) => q.id),
        ))
      )
        throw new LearnerAuthorizationError();
      const aggregate = aggregateWorkQuestions(assessment.questions);
      assessment.aggregate = aggregate;
      assessment.feedback = workAggregateFeedback(aggregate);
      const prior = (await service.revisions(request, String(attempt.id))).find(
        (r) => r.requestKey === request.requestKey,
      );
      if (prior)
        return revisionView(
          (
            await service.appendRevision(
              request,
              attempt,
              'ai',
              assessment,
              null,
            )
          ).row,
        );
      await service.validateAssessment(request, attempt, assessment);
      return revisionView(
        (await service.appendRevision(request, attempt, 'ai', assessment, null))
          .row,
      );
    });
  }
  async reviewWorkAssessment(
    request: AttemptRequest & {
      revisionId: string;
      expectedHeadId: string | null;
      requestKey: string;
      assessment?: WorkAssessment;
      decisionReason?: string;
    },
  ): Promise<WorkRevisionView> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.grade');
      await service.serialize(request);
      const { row, attempt } = await service.attempt(
        request,
        'education.learner.grade',
      );
      const revisions = await service.revisions(request, String(attempt.id));
      const source = revisions.find((r) => r.id === request.revisionId);
      if (!source) throw new Error('Assessment revision unavailable');
      const originalAssessment =
        request.assessment ?? revisionView(source).assessment;
      const assessment: WorkAssessment = {
        ...originalAssessment,
        aggregate: undefined,
        questions: originalAssessment.questions.map((q) => ({
          ...q,
          markingCertainty: q.markingCertainty ?? ('unknown' as const),
          mappingCertainty: q.mappingCertainty ?? ('unknown' as const),
          mappingProvenance: 'guardian-reviewed' as const,
          evidenceLimitations: q.evidenceLimitations ?? [],
        })),
      };
      const decisionReason =
        request.decisionReason ??
        (request.assessment
          ? 'Guardian corrected assessment'
          : 'Guardian confirmed proposal');
      nonempty(decisionReason, 'guardian decision reason');
      // Guardian may explicitly correct transcription, result or mapping.
      validateWorkAssessment(assessment);
      const normalizedLayout = normalizeWorkObservedLayout(
        assessment.layout,
        assessment.questions,
        JSON.parse(attempt.sourceHashes),
      );
      delete assessment.layout;
      // Retain only the safe omission code on a default guardian copy.
      const omitted = assessment.layoutOmission === 'invalid';
      delete assessment.layoutOmission;
      Object.assign(assessment, normalizedLayout);
      if (!assessment.layout && omitted) assessment.layoutOmission = 'invalid';
      const regionOmitted = assessment.answerRegionsOmission === 'invalid';
      const normalizedRegions = normalizeWorkAnswerRegions(
        assessment.answerRegions,
        assessment.questions,
        JSON.parse(attempt.sourceHashes),
      );
      delete assessment.answerRegions;
      delete assessment.answerRegionsOmission;
      Object.assign(assessment, normalizedRegions);
      if (!assessment.answerRegions && regionOmitted)
        assessment.answerRegionsOmission = 'invalid';
      assessment.aggregate = aggregateWorkQuestions(assessment.questions);
      if (
        JSON.stringify(assessment.vocabulary) !==
        JSON.stringify(
          service.workOptions.workVocabulary ?? WORK_MATH_VOCABULARY,
        )
      )
        throw new Error('Review must use configured curated vocabulary');
      const sources: { assetId: string; sha256: string; pageCount: number }[] =
        JSON.parse(attempt.sourceHashes);
      for (const q of assessment.questions)
        for (const a of q.anchors)
          if (
            !sources.some(
              (s) =>
                s.assetId === a.assetId &&
                s.sha256 === a.sha256 &&
                (a.page === null || a.page <= s.pageCount),
            )
          )
            throw new Error('Foreign review source');
      const retry = revisions.find((r) => r.requestKey === request.requestKey);
      if (
        !retry &&
        (revisions.filter((r) => r.kind === 'guardian').at(-1)?.id ?? null) !==
          request.expectedHeadId
      )
        throw new Error('Assessment head changed');
      const result = await service.appendRevision(
        request,
        attempt,
        'guardian',
        assessment,
        request.expectedHeadId,
        request.revisionId,
        decisionReason,
      );
      if (result.fresh) {
        const successors = await (
          await WorkAttemptCollection.create({ db: service.db })
        ).list({
          where: {
            tenantId: request.tenantId,
            previousAttemptId: String(attempt.id),
          },
        });
        if (!successors.length) {
          const score = aggregateWorkQuestions(assessment.questions).score;
          await service.reviewSubmission({
            ...request,
            enrollmentId: row.enrollmentId,
            score,
            feedback: assessment.feedback,
          });
        }
      }
      return revisionView(result.row);
    });
  }
  async completeLessonActivity(
    request: AttemptRequest & {
      expectedAttemptId: string;
      expectedHeadId: string | null;
      requestKey: string;
    },
  ): Promise<WorkCompletionDecisionView> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.complete');
      await service.serialize(request);
      const { row } = await service.activity(
        request,
        'education.learner.complete',
      );
      nonempty(request.requestKey, 'completion request key');
      nonempty(request.expectedAttemptId, 'completion attempt');
      nonempty(request.submissionId, 'completion submission');
      if (request.expectedHeadId !== null)
        nonempty(request.expectedHeadId, 'completion feedback head');
      const decisions = await WorkCompletionDecisionCollection.create({
        db: service.db,
      });
      const prior = await decisions.get(
        {
          tenantId: request.tenantId,
          activityId: request.activityId,
          requestKey: request.requestKey,
        },
        { cache: false },
      );
      if (prior) {
        if (
          prior.learnerId !== request.learnerId ||
          prior.actorUserId !== request.actorUserId ||
          prior.attemptId !== request.expectedAttemptId ||
          prior.submissionId !== request.submissionId ||
          prior.feedbackHeadId !== request.expectedHeadId
        )
          throw new WorkCompletionConflictError('changed_retry');
        return completionDecisionView(prior);
      }
      const current = await readWorkCompletion(service.db, {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: request.activityId,
      });
      if (
        !current.currentAttempt ||
        current.currentAttempt.id !== request.expectedAttemptId ||
        current.currentAttempt.submissionId !== request.submissionId
      )
        throw new WorkCompletionConflictError('stale_attempt');
      if (current.feedbackHeadId !== request.expectedHeadId)
        throw new WorkCompletionConflictError('stale_head');
      if (current.decision)
        throw new WorkCompletionConflictError('already_complete');
      const decision = await decisions.create({
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: request.activityId,
        attemptId: request.expectedAttemptId,
        submissionId: request.submissionId,
        feedbackHeadId: request.expectedHeadId,
        actorUserId: request.actorUserId,
        requestKey: request.requestKey,
        _insertOnly: true,
      });
      const progress = await (
        await LessonProgressCollection.create({ db: service.db })
      ).get(
        {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          enrollmentId: row.enrollmentId,
          lessonId: row.lessonId,
        },
        { cache: false },
      );
      if (!progress) throw new LearnerAuthorizationError();
      progress.status = 'complete';
      progress.completedAt = new Date(decision.recordedAt);
      await progress.save();
      await service.syncPlacement(request, row);
      return completionDecisionView(decision);
    });
  }
  async releaseWorkFeedback(
    request: AttemptRequest & {
      revisionId: string;
      requestKey: string;
      expectedHeadId: string | null;
    },
  ) {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.grade');
      await service.serialize(request);
      const { attempt } = await service.attempt(
        request,
        'education.learner.grade',
      );
      nonempty(request.requestKey, 'release request key');
      const revisions = await service.revisions(request, String(attempt.id));
      if (!revisions.some((r) => r.id === request.revisionId))
        throw new Error('Feedback revision unavailable');
      const releases = await WorkFeedbackReleaseCollection.create({
        db: service.db,
      });
      let release = await releases.get(
        {
          tenantId: request.tenantId,
          attemptId: String(attempt.id),
          requestKey: request.requestKey,
        },
        { cache: false },
      );
      if (
        release &&
        (release.revisionId !== request.revisionId ||
          release.expectedHeadId !== request.expectedHeadId)
      )
        throw new Error('Feedback release retry changed');
      const currentHead =
        revisions.filter((r) => r.kind === 'guardian').at(-1)?.id ?? null;
      if (
        !release &&
        (currentHead !== request.expectedHeadId ||
          (currentHead && request.revisionId !== currentHead))
      )
        throw new Error('Feedback head changed');
      release ??= await releases.create({
        _insertOnly: true,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        attemptId: String(attempt.id),
        revisionId: request.revisionId,
        expectedHeadId: request.expectedHeadId,
        requestKey: request.requestKey,
        actorUserId: request.actorUserId,
      });
      return {
        id: String(release.id),
        revisionId: release.revisionId,
        createdAt: release.recordedAt,
        actorUserId: release.actorUserId,
      };
    });
  }
  /** Record an authenticated own-learner render acknowledgment, never 'read'. */
  async acknowledgeWorkFeedbackDelivery(
    request: AttemptRequest & { revisionId: string; requestKey: string },
  ) {
    return this.composeMutation(async (service) => {
      const learner = await service.requireActor(
        request,
        'education.learner.read',
      );
      if (learner.userId !== request.actorUserId)
        throw new LearnerAuthorizationError();
      await service.serialize(request);
      const { attempt } = await service.attempt(request);
      nonempty(request.requestKey, 'delivery request key');
      const revisions = await service.revisions(request, String(attempt.id));
      const revision = revisions.find((r) => r.id === request.revisionId);
      const releases = await (
        await WorkFeedbackReleaseCollection.create({ db: service.db })
      ).list({
        where: {
          tenantId: request.tenantId,
          attemptId: String(attempt.id),
          revisionId: request.revisionId,
        },
      });
      const photo = await service.workbookPhotoSource(request, {
        submissionId: attempt.submissionId,
      });
      if (
        !revision ||
        ((attempt.reviewRequired || photo.guardianOrigin) &&
          !releases.length) ||
        (revision.kind !== 'ai' && !releases.length) ||
        !(await service.questionIdentityVisible(request, attempt, revision))
      )
        throw new LearnerAuthorizationError();
      const deliveries = await WorkFeedbackDeliveryCollection.create({
        db: service.db,
      });
      const byKey = await deliveries.get(
        {
          tenantId: request.tenantId,
          attemptId: String(attempt.id),
          actorUserId: request.actorUserId,
          requestKey: request.requestKey,
        },
        { cache: false },
      );
      if (byKey && byKey.revisionId !== request.revisionId)
        throw new Error('Delivery retry changed');
      let delivery =
        byKey ??
        (await deliveries.get(
          {
            tenantId: request.tenantId,
            attemptId: String(attempt.id),
            actorUserId: request.actorUserId,
            revisionId: request.revisionId,
          },
          { cache: false },
        ));
      delivery ??= await deliveries.create({
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        attemptId: String(attempt.id),
        revisionId: request.revisionId,
        actorUserId: request.actorUserId,
        requestKey: request.requestKey,
      });
      return {
        id: String(delivery.id),
        revisionId: delivery.revisionId,
        actorUserId: delivery.actorUserId,
        createdAt: delivery.recordedAt,
      };
    });
  }
  async getWorkTimeline(
    request: ActivityRequest & {
      cursor?: string;
      limit?: number;
      revisionId?: string;
    },
  ): Promise<WorkTimeline> {
    const { row, learner } = await this.activity(request);
    const own = learner.userId === request.actorUserId;
    const pagesCache = new Map<string, SubmissionView['pages']>();
    const completion = await readWorkCompletion(this.db, {
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      activityId: request.activityId,
    });
    const limit = request.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid timeline limit');
    const all = await (
      await WorkAttemptCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: request.activityId,
      },
      orderBy: 'capturedAt',
    });
    all.sort(
      (a, b) =>
        new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime() ||
        String(b.id).localeCompare(String(a.id)),
    );
    let start = request.cursor
      ? all.findIndex((a) => a.id === request.cursor) + 1
      : 0;
    if (request.revisionId) {
      if (own || request.cursor) throw new LearnerAuthorizationError();
      const revision = await (
        await WorkAssessmentRevisionCollection.create({ db: this.db })
      ).get(
        {
          id: request.revisionId,
          tenantId: request.tenantId,
          learnerId: request.learnerId,
        },
        { cache: false },
      );
      const index = revision
        ? all.findIndex((a) => a.id === revision.attemptId)
        : -1;
      if (index < 0) throw new LearnerAuthorizationError();
      start = index;
    }
    if (request.cursor && start === 0)
      throw new Error('Invalid timeline cursor');
    const attempts: WorkTimeline['attempts'] = [];
    for (const attempt of all.slice(start, start + limit)) {
      const revisions = await this.revisions(request, String(attempt.id));
      const releases = await (
        await WorkFeedbackReleaseCollection.create({ db: this.db })
      ).list({
        where: {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          attemptId: String(attempt.id),
        },
      });
      const photo = await this.workbookPhotoSource(request, {
        submissionId: attempt.submissionId,
      });
      const visible: WorkAssessmentRevision[] = [];
      for (const revision of revisions) {
        if (
          !own ||
          ((releases.some((rel) => rel.revisionId === revision.id) ||
            (!photo.guardianOrigin &&
              !attempt.reviewRequired &&
              revision.kind === 'ai')) &&
            (await this.questionIdentityVisible(request, attempt, revision)))
        )
          visible.push(revision);
      }
      const deliveries = await (
        await WorkFeedbackDeliveryCollection.create({ db: this.db })
      ).list({
        where: {
          tenantId: request.tenantId,
          learnerId: request.learnerId,
          attemptId: String(attempt.id),
        },
      });
      const headId =
        revisions.filter((r) => r.kind === 'guardian').at(-1)?.id ?? null;
      attempts.push({
        ...(await this.attemptView(request, row, attempt, pagesCache)),
        revisions: [...visible].reverse().map(revisionView),
        releases: releases
          .filter((r) => !own || visible.some((v) => v.id === r.revisionId))
          .map((r) => ({
            id: String(r.id),
            revisionId: r.revisionId,
            createdAt: r.recordedAt,
            actorUserId: r.actorUserId,
          })),
        deliveries: deliveries
          .filter((d) => !own || visible.some((v) => v.id === d.revisionId))
          .map((d) => ({
            id: String(d.id),
            revisionId: d.revisionId,
            actorUserId: d.actorUserId,
            createdAt: d.recordedAt,
          })),
        headId: own ? null : headId ? String(headId) : null,
        completionDecision: own
          ? null
          : (() => {
              const decision = completion.decisions.find(
                (value) => value.attemptId === attempt.id,
              );
              return decision ? completionDecisionView(decision) : null;
            })(),
      });
    }
    return {
      currentAttemptId: completion.currentAttempt
        ? String(completion.currentAttempt.id)
        : null,
      latestSubmissionId: completion.currentAttempt?.submissionId ?? null,
      completion: completion.completion,
      completionContext:
        own || !completion.currentAttempt
          ? null
          : {
              attemptId: String(completion.currentAttempt.id),
              submissionId: completion.currentAttempt.submissionId,
              expectedHeadId: completion.feedbackHeadId,
            },
      activity: await this.activityView(row),
      attempts,
      nextCursor:
        start + limit < all.length ? String(all[start + limit - 1].id) : null,
    };
  }
  /** Descriptive guardian projection; corrections stay within one practice episode. */
  async getConceptEvidenceSummary(request: ActivityRequest): Promise<{
    algorithmVersion: 'workbook-descriptive-v1';
    concepts: WorkConceptSummary[];
  }> {
    await this.activity(request, 'education.learner.grade');
    const attempts = await (
      await WorkAttemptCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: request.activityId,
      },
    });
    const evidence: WorkEvidenceInput[] = [];
    // Parent captures always precede corrections regardless of random UUID order.
    const ordered = [...attempts].sort(
      (a, b) =>
        Number(Boolean(a.previousAttemptId)) -
          Number(Boolean(b.previousAttemptId)) ||
        String(a.id).localeCompare(String(b.id)),
    );
    for (const attempt of ordered) {
      const revisions = await this.revisions(request, String(attempt.id));
      const confirmed = revisions.filter((r) => r.kind === 'guardian').at(-1);
      const effective =
        confirmed ?? revisions.filter((r) => r.kind === 'ai').at(-1);
      if (!effective) continue;
      const assessment = revisionView(effective).assessment;
      evidence.push({
        attempt,
        revisionId: String(effective.id),
        assessment,
        confirmed: Boolean(confirmed),
      });
    }
    return {
      algorithmVersion: 'workbook-descriptive-v1',
      concepts: summarizeWorkEvidence(evidence),
    };
  }
}
