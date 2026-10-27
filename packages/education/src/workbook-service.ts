import type { DatabaseInterface } from '@happyvertical/sql';
import { PDFDocument } from 'pdf-lib';
import type { CatalogAuthorizer } from './catalog-service.js';
import {
  CourseCollection,
  CourseSectionCollection,
  CurriculumCollection,
  EnrollmentCollection,
  WorksheetCollection,
} from './collections.js';
import {
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  type LearnerRequest,
} from './learner-service.js';
import {
  type SubmissionPage,
  SubmissionService,
  type SubmissionServiceOptions,
} from './submission-service.js';
import {
  aggregateWorkbookQuestions,
  validateWorkbookAssessment,
  WORKBOOK_MATH_VOCABULARY,
  type WorkbookActivityView,
  type WorkbookAssessment,
  WorkbookAssessmentValidationError,
  type WorkbookAssistance,
  type WorkbookAttemptView,
  type WorkbookConceptSummary,
  type WorkbookPreservationState,
  type WorkbookRevisionView,
  type WorkbookTimeline,
  workbookAggregateFeedback,
} from './workbook-contracts.js';
import {
  type Workbook,
  type WorkbookActivity,
  WorkbookActivityCollection,
  type WorkbookAssessmentRevision,
  WorkbookAssessmentRevisionCollection,
  type WorkbookAttempt,
  WorkbookAttemptCollection,
  WorkbookCollection,
  WorkbookFeedbackDeliveryCollection,
  WorkbookFeedbackReleaseCollection,
  type WorkbookWorkFiling,
  WorkbookWorkFilingCollection,
} from './workbook-models.js';

type ActivityRequest = LearnerRequest & { activityId: string };
type AttemptRequest = ActivityRequest & { submissionId: string };
function createHash(algorithm: 'sha256') {
  const crypto =
    typeof process !== 'undefined' && process.getBuiltinModule?.('node:crypto');
  if (!crypto)
    throw new Error('Workbook capture and revisions require a Node server');
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
function nonempty(value: string, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new Error(`Invalid ${label}`);
}
function revisionView(row: WorkbookAssessmentRevision): WorkbookRevisionView {
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

/** Actor-bound durable physical workbook workflow. No generated write surface. */
export class WorkbookService extends SubmissionService {
  constructor(
    db: DatabaseInterface,
    authorize: LearnerAuthorizer,
    authorizeCatalog: CatalogAuthorizer,
    private readonly workbookOptions: SubmissionServiceOptions & {
      workbookVocabulary?: WorkbookAssessment['vocabulary'];
    },
  ) {
    super(db, authorize, authorizeCatalog, workbookOptions);
  }
  protected override createTransactionService(db: DatabaseInterface): this {
    return new WorkbookService(
      db,
      this.authorize,
      this.authorizeCatalog,
      this.workbookOptions,
    ) as this;
  }
  private async serialize(request: LearnerRequest) {
    // One lock order for workbook identities, policies, captures and decisions.
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
      await WorkbookActivityCollection.create({ db: this.db })
    ).get(
      {
        id: request.activityId,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
      },
      { cache: false },
    );
    if (!row) throw new LearnerAuthorizationError();
    const workbook = row.workbookId
      ? await (await WorkbookCollection.create({ db: this.db })).get(
          {
            id: row.workbookId,
            tenantId: request.tenantId,
            learnerId: request.learnerId,
          },
          { cache: false },
        )
      : null;
    if (row.captureKind === 'unfiled') {
      if (
        row.workbookId !== null ||
        !row.photoIntakeId ||
        !(await this.db.get('workbook_photo_intakes', {
          id: row.photoIntakeId,
          tenant_id: request.tenantId,
          learner_id: request.learnerId,
        }))
      )
        throw new LearnerAuthorizationError();
    } else if (!workbook) throw new LearnerAuthorizationError();
    await this.requireEnrollment(
      { ...request, enrollmentId: row.enrollmentId },
      action,
    );
    return { row, workbook, learner };
  }
  private async filingHead(
    row: WorkbookActivity,
  ): Promise<WorkbookWorkFiling | null> {
    if (row.captureKind !== 'unfiled') return null;
    const rows = await (
      await WorkbookWorkFilingCollection.create({ db: this.db })
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
      throw new Error('Workbook filing history has conflicting heads');
    return heads[0] ?? null;
  }
  private async activityView(
    row: WorkbookActivity,
    book: Workbook | null,
    replay?: WorkbookWorkFiling,
  ): Promise<WorkbookActivityView> {
    const head = replay ?? (await this.filingHead(row));
    const projectedBook = head
      ? await (await WorkbookCollection.create({ db: this.db })).get(
          {
            id: head.workbookId,
            tenantId: row.tenantId,
            learnerId: row.learnerId,
          },
          { cache: false },
        )
      : book;
    const target = head?.canonicalActivityId
      ? await (await WorkbookActivityCollection.create({ db: this.db })).get(
          {
            id: head.canonicalActivityId,
            tenantId: row.tenantId,
            learnerId: row.learnerId,
            workbookId: head.workbookId,
          },
          { cache: false },
        )
      : null;
    if (head && (!projectedBook || (head.canonicalActivityId && !target)))
      throw new LearnerAuthorizationError();
    return {
      id: String(row.id),
      learnerId: row.learnerId,
      workbookKey: projectedBook?.workbookKey ?? '',
      title: projectedBook?.title ?? '',
      edition: projectedBook?.edition ?? '',
      pageKey: target?.pageKey ?? row.pageKey,
      pageLabel: target?.pageLabel ?? row.pageLabel,
      enrollmentId: row.enrollmentId,
      lessonId: row.lessonId,
      reviewRequired: book?.reviewRequired ?? true,
      policyVersion: book?.policyVersion ?? 1,
      filing: {
        state:
          row.captureKind === 'unfiled'
            ? head
              ? 'filed'
              : 'unfiled'
            : 'identified',
        workbookId: projectedBook ? String(projectedBook.id) : null,
        canonicalActivityId: target ? String(target.id) : null,
        revisionId: head ? String(head.id) : null,
      },
    };
  }
  async getWorkbookActivity(
    request: ActivityRequest,
  ): Promise<WorkbookActivityView> {
    const { row, workbook } = await this.activity(request);
    return this.activityView(row, workbook);
  }
  /** Receipt-bound technical routing only; the caller already owns the surrounding mutation. */
  protected async resolveUnfiledWorkbookActivityInScope(
    request: LearnerRequest & { intakeId: string },
    action:
      | 'education.learner.submit'
      | 'education.learner.plan' = 'education.learner.submit',
  ): Promise<WorkbookActivityView> {
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
    const activities = await WorkbookActivityCollection.create({ db: this.db });
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
      return this.activityView(found.row, found.workbook);
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
      workbookId: null,
      enrollmentId: String(enrollment.id),
      lessonId: String(lesson.id),
      pageKey: `receipt:${request.intakeId}`,
      pageLabel: 'Captured work',
    });
    await this.requireEnrollment(
      { ...request, enrollmentId: row.enrollmentId },
      action,
    );
    return this.activityView(row, null);
  }
  /** Append a filing association without modifying capture policy or learning history. */
  async fileWorkbookWork(
    request: ActivityRequest & {
      workbookId: string;
      canonicalActivityId?: string;
      expectedRevisionId: string | null;
      requestKey: string;
      reason: string;
    },
  ): Promise<WorkbookActivityView> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.plan');
      await service.serialize(request);
      const { row, workbook } = await service.activity(
        request,
        'education.learner.plan',
      );
      if (row.captureKind !== 'unfiled')
        throw new Error('Only unfiled captured work can be filed');
      nonempty(request.requestKey, 'filing request key');
      nonempty(request.reason, 'filing reason');
      nonempty(request.workbookId, 'filing workbook');
      if (request.canonicalActivityId !== undefined)
        nonempty(request.canonicalActivityId, 'filing activity');
      if (
        request.expectedRevisionId !== null &&
        (typeof request.expectedRevisionId !== 'string' ||
          !request.expectedRevisionId)
      )
        throw new Error('Invalid expected filing revision');
      const payload = {
        workbookId: request.workbookId,
        canonicalActivityId: request.canonicalActivityId ?? null,
        previousRevisionId: request.expectedRevisionId,
        actorUserId: request.actorUserId,
        reason: request.reason,
      };
      const hash = digest(payload);
      const filings = await WorkbookWorkFilingCollection.create({
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
          throw new Error('Workbook filing retry changed');
        return service.activityView(row, workbook, prior);
      }
      const head = await service.filingHead(row);
      if ((head ? String(head.id) : null) !== request.expectedRevisionId)
        throw new Error('Workbook filing head changed');
      if (
        !(await (
          await WorkbookCollection.create({ db: service.db })
        ).get(
          {
            id: request.workbookId,
            tenantId: request.tenantId,
            learnerId: request.learnerId,
          },
          { cache: false },
        ))
      )
        throw new LearnerAuthorizationError();
      if (request.canonicalActivityId) {
        const target = await service.activity(
          { ...request, activityId: request.canonicalActivityId },
          'education.learner.plan',
        );
        if (
          target.row.captureKind !== 'identified' ||
          target.row.workbookId !== request.workbookId ||
          target.row.id === row.id
        )
          throw new Error('Workbook filing target mismatch');
      }
      await filings.create({
        _insertOnly: true,
        ...payload,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        sourceActivityId: request.activityId,
        requestKey: request.requestKey,
        digest: hash,
      });
      return service.activityView(row, workbook);
    });
  }
  /** Explicit keys distinguish editions, repeated printed labels and page sides. */
  async resolveWorkbookActivity(
    request: LearnerRequest & {
      workbookKey: string;
      title: string;
      edition?: string;
      pageKey: string;
      pageLabel: string;
    },
  ): Promise<WorkbookActivityView> {
    return this.composeMutation((service) =>
      service.resolveWorkbookActivityInScope(request, 'education.learner.plan'),
    );
  }
  /** Owning intake extension: caller validates evidence before upload-authorized creation. */
  protected async resolveWorkbookActivityInScope(
    request: LearnerRequest & {
      workbookKey: string;
      title: string;
      edition?: string;
      pageKey: string;
      pageLabel: string;
    },
    action: 'education.learner.plan' | 'education.learner.submit',
  ): Promise<WorkbookActivityView> {
    const service = this;
    await service.requireActor(request, action);
    await service.serialize(request);
    for (const [label, value] of Object.entries({
      workbookKey: request.workbookKey,
      title: request.title,
      pageKey: request.pageKey,
      pageLabel: request.pageLabel,
    }))
      nonempty(value, label);
    if (
      request.edition !== undefined &&
      (typeof request.edition !== 'string' || request.edition.length > 200)
    )
      throw new Error('Invalid edition');
    const books = await WorkbookCollection.create({ db: service.db });
    let book = await books.get(
      {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        workbookKey: request.workbookKey,
      },
      { cache: false },
    );
    if (
      book &&
      (book.title !== request.title || book.edition !== (request.edition ?? ''))
    )
      throw new Error('Workbook key already names another title or edition');
    book ??= await books.create({
      _insertOnly: true,
      slug: `workbook-${digest([request.tenantId, request.learnerId, request.workbookKey])}`,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      workbookKey: request.workbookKey,
      title: request.title,
      edition: request.edition ?? '',
    });
    const activities = await WorkbookActivityCollection.create({
      db: service.db,
    });
    const existing = await activities.get(
      {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        workbookId: String(book.id),
        pageKey: request.pageKey,
      },
      { cache: false },
    );
    if (existing) {
      if (existing.pageLabel !== request.pageLabel)
        throw new Error('Page key already names another activity');
      return service.activityView(existing, book);
    }
    // One private enrollment per family learner/workbook, with explicit pages.
    const siblings = await activities.list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        workbookId: String(book.id),
      },
      limit: 1,
    });
    let enrollmentId: string;
    let sectionId: string;
    if (siblings[0]) {
      const enrollment = await service.requireEnrollment(
        { ...request, enrollmentId: siblings[0].enrollmentId },
        action,
      );
      const lesson = await (
        await WorksheetCollection.create({ db: service.db })
      ).get(
        { id: siblings[0].lessonId, tenantId: request.tenantId },
        { cache: false },
      );
      if (!lesson) throw new LearnerAuthorizationError();
      enrollmentId = String(enrollment.id);
      sectionId = lesson.sectionId;
    } else {
      const course = await (
        await CourseCollection.create({ db: service.db })
      ).create({
        _insertOnly: true,
        slug: `workbook-${book.id}`,
        tenantId: request.tenantId,
        title: request.title,
        licenseKind: 'personal-use-copy',
        sourceKey: 'physical-workbook',
        sourceRef: String(book.id),
        modality: 'printable',
      });
      const section = await (
        await CourseSectionCollection.create({ db: service.db })
      ).create({
        _insertOnly: true,
        slug: `workbook-pages-${book.id}`,
        tenantId: request.tenantId,
        courseId: String(course.id),
        title: 'Workbook pages',
      });
      const curriculum = await (
        await CurriculumCollection.create({ db: service.db })
      ).create({
        _insertOnly: true,
        slug: `workbook-plan-${book.id}`,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        title: request.title,
      });
      const enrollment = await (
        await EnrollmentCollection.create({ db: service.db })
      ).create({
        _insertOnly: true,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        curriculumId: String(curriculum.id),
        courseId: String(course.id),
        status: 'active',
      });
      enrollmentId = String(enrollment.id);
      sectionId = String(section.id);
    }
    const lesson = await (
      await WorksheetCollection.create({ db: service.db })
    ).create({
      _insertOnly: true,
      slug: `workbook-page-${digest([book.id, request.pageKey])}`,
      tenantId: request.tenantId,
      sectionId,
      title: request.pageLabel,
      completionRule: 'submit',
    });
    const row = await activities.create({
      _insertOnly: true,
      slug: `workbook-activity-${digest([book.id, request.pageKey])}`,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      workbookId: String(book.id),
      enrollmentId,
      lessonId: String(lesson.id),
      pageKey: request.pageKey,
      pageLabel: request.pageLabel,
    });
    return service.activityView(row, book);
  }
  async listWorkbookActivities(
    request: LearnerRequest,
  ): Promise<WorkbookActivityView[]> {
    await this.requireActor(request, 'education.learner.read');
    const rows = await (
      await WorkbookActivityCollection.create({ db: this.db })
    ).list({
      where: { tenantId: request.tenantId, learnerId: request.learnerId },
    });
    const result: WorkbookActivityView[] = [];
    for (const row of rows) {
      const found = await this.activity({
        ...request,
        activityId: String(row.id),
      });
      result.push(await this.activityView(row, found.workbook));
    }
    return result;
  }
  async setWorkbookFeedbackPolicy(
    request: ActivityRequest & {
      expectedPolicyVersion: number;
      reviewRequired: boolean;
    },
  ): Promise<WorkbookActivityView> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.plan');
      await service.serialize(request);
      const { row, workbook } = await service.activity(
        request,
        'education.learner.plan',
      );
      if (!workbook || row.captureKind === 'unfiled')
        throw new Error('Unfiled work has no workbook policy');
      if (
        typeof request.reviewRequired !== 'boolean' ||
        workbook.policyVersion !== request.expectedPolicyVersion
      )
        throw new Error('Workbook policy changed');
      workbook.reviewRequired = request.reviewRequired;
      workbook.policyVersion++;
      await workbook.save();
      return service.activityView(row, workbook);
    });
  }
  private async attempt(
    request: AttemptRequest,
    action: Parameters<LearnerAuthorizer>[0]['action'] = 'education.learner.read',
  ) {
    const found = await this.activity(request, action);
    const attempt = await (
      await WorkbookAttemptCollection.create({ db: this.db })
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
    row: WorkbookActivity,
    attempt: WorkbookAttempt,
  ): Promise<WorkbookAttemptView> {
    const submission = await super.getSubmission({
      ...request,
      enrollmentId: row.enrollmentId,
      submissionId: attempt.submissionId,
    });
    // Workbook feedback always travels through the revision policy, never Grade.
    return {
      id: String(attempt.id),
      submissionId: attempt.submissionId,
      activityId: attempt.activityId,
      previousAttemptId: attempt.previousAttemptId,
      episodeId: attempt.episodeId,
      reviewRequired: attempt.reviewRequired,
      policyVersion: attempt.policyVersion,
      assistance: attempt.assistance as WorkbookAssistance,
      submission: { ...submission, grade: null },
    };
  }
  async captureWorkbookWork(
    request: ActivityRequest & {
      requestKey: string;
      pages: readonly SubmissionPage[];
      notes?: string;
      previousSubmissionId?: string;
      assistance?: WorkbookAssistance;
      intakeItemId?: string;
    },
  ): Promise<WorkbookAttemptView> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.submit');
      await service.serialize(request);
      const { row, workbook } = await service.activity(
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
      const attempts = await WorkbookAttemptCollection.create({
        db: service.db,
      });
      let previous: WorkbookAttempt | null = null;
      if (request.previousSubmissionId)
        previous = (
          await service.attempt(
            { ...request, submissionId: request.previousSubmissionId },
            'education.learner.submit',
          )
        ).attempt;
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
      const submission = await service.captureWorkbookSubmission(
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
        request.activityId,
      );
      const prior = await attempts.get(
        { tenantId: request.tenantId, submissionId: submission.id },
        { cache: false },
      );
      if (prior) {
        if (
          prior.activityId !== request.activityId ||
          prior.assistance !== assistance
        )
          throw new Error('Workbook capture retry changed');
        return service.attemptView(request, row, prior);
      }
      const id = globalThis.crypto.randomUUID();
      const sourceHashes = [];
      for (const [i, page] of request.pages.entries())
        sourceHashes.push({
          assetId: submission.pages[i].assetId,
          sha256: createHash('sha256').update(page.data).digest('hex'),
          pageCount:
            page.mimeType === 'application/pdf'
              ? (await PDFDocument.load(page.data)).getPageCount()
              : 1,
        });
      const attempt = await attempts.create({
        _insertOnly: true,
        id,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: request.activityId,
        submissionId: submission.id,
        previousAttemptId: previous ? String(previous.id) : null,
        episodeId: previous?.episodeId ?? id,
        reviewRequired: workbook?.reviewRequired ?? true,
        policyVersion: workbook?.policyVersion ?? 1,
        assistance,
        actorUserId: request.actorUserId,
        capturedAt: submission.submittedAt,
        sourceHashes: JSON.stringify(sourceHashes),
      });
      return service.attemptView(request, row, attempt);
    });
  }
  /** Trusted host lookup, preserving exact enrollment and actor authorization. */
  async getWorkbookAttemptBySubmission(
    request: LearnerRequest & { enrollmentId: string; submissionId: string },
  ): Promise<WorkbookAttemptView | null> {
    await this.requireEnrollment(request, 'education.learner.read');
    const attempt = await (
      await WorkbookAttemptCollection.create({ db: this.db })
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
  async getWorkbookPreservationState(
    request: AttemptRequest,
  ): Promise<WorkbookPreservationState> {
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
  async getWorkbookSourceAnchors(
    request: AttemptRequest,
  ): Promise<{ assetId: string; sha256: string; pageCount: number }[]> {
    const { attempt } = await this.attempt(request);
    return JSON.parse(attempt.sourceHashes);
  }
  /** Stable IDs only: historical prompts may themselves contain learner answers. */
  async getWorkbookQuestionIdentity(
    request: AttemptRequest,
  ): Promise<{ id: string }[]> {
    const { attempt } = await this.attempt(request, 'education.learner.submit');
    const sourceId = attempt.previousAttemptId ?? String(attempt.id);
    const source = await (
      await WorkbookAttemptCollection.create({ db: this.db })
    ).get(
      {
        id: sourceId,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: request.activityId,
      },
      { cache: false },
    );
    if (!source) throw new LearnerAuthorizationError();
    const rows = await this.revisions(request, String(source.id));
    const revision =
      rows.filter((r) => r.kind === 'guardian').at(-1) ??
      rows.filter((r) => r.kind === 'ai')[0];
    return revision
      ? revisionView(revision).assessment.questions.map((q) => ({
          id: q.id,
        }))
      : [];
  }
  private async revisions(request: LearnerRequest, attemptId: string) {
    return (
      await WorkbookAssessmentRevisionCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        attemptId,
      },
      orderBy: 'recordedAt',
    });
  }
  private async validateAssessment(
    request: AttemptRequest,
    attempt: WorkbookAttempt,
    assessment: WorkbookAssessment,
  ) {
    validateWorkbookAssessment(assessment);
    if (
      JSON.stringify(assessment.vocabulary) !==
      JSON.stringify(
        this.workbookOptions.workbookVocabulary ?? WORKBOOK_MATH_VOCABULARY,
      )
    )
      throw new WorkbookAssessmentValidationError(
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
          throw new WorkbookAssessmentValidationError(
            'Assessment source does not belong to capture',
            'ungrounded_source',
          );
    // IDs span captures; transcriptions belong to each capture's own evidence.
    // Pin prompts within a capture only: historical prompts can include old
    // learner answers and must never force those answers onto a correction.
    // Reviewed vocabulary still cannot be replaced by free-text labels.
    const activities = await (
      await WorkbookAttemptCollection.create({ db: this.db })
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
        throw new WorkbookAssessmentValidationError(
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
        throw new WorkbookAssessmentValidationError(
          'Unconfirmed question identity or changed prompt',
          'ambiguous_proposal',
        );
    }
  }
  private async appendRevision(
    request: AttemptRequest & { requestKey: string },
    attempt: WorkbookAttempt,
    kind: 'ai' | 'guardian',
    assessment: WorkbookAssessment,
    supersedesId: string | null,
    sourceRevisionId: string | null = null,
    decisionReason = '',
  ) {
    nonempty(request.requestKey, 'revision request key');
    const rows = await WorkbookAssessmentRevisionCollection.create({
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
  async recordWorkbookAnalysis(
    request: AttemptRequest & {
      requestKey: string;
      assessment: WorkbookAssessment;
    },
  ): Promise<WorkbookRevisionView> {
    return this.composeMutation(async (service) => {
      await service.requireActor(request, 'education.learner.submit');
      await service.serialize(request);
      const { attempt } = await service.attempt(
        request,
        'education.learner.submit',
      );
      const assessment: WorkbookAssessment = {
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
      validateWorkbookAssessment(assessment);
      const aggregate = aggregateWorkbookQuestions(assessment.questions);
      assessment.aggregate = aggregate;
      assessment.feedback = workbookAggregateFeedback(aggregate);
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
  async reviewWorkbookAssessment(
    request: AttemptRequest & {
      revisionId: string;
      expectedHeadId: string | null;
      requestKey: string;
      assessment?: WorkbookAssessment;
      decisionReason?: string;
    },
  ): Promise<WorkbookRevisionView> {
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
      const assessment: WorkbookAssessment = {
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
      validateWorkbookAssessment(assessment);
      assessment.aggregate = aggregateWorkbookQuestions(assessment.questions);
      if (
        JSON.stringify(assessment.vocabulary) !==
        JSON.stringify(
          service.workbookOptions.workbookVocabulary ??
            WORKBOOK_MATH_VOCABULARY,
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
          await WorkbookAttemptCollection.create({ db: service.db })
        ).list({
          where: {
            tenantId: request.tenantId,
            previousAttemptId: String(attempt.id),
          },
        });
        if (!successors.length) {
          const score = aggregateWorkbookQuestions(assessment.questions).score;
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
  async releaseWorkbookFeedback(
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
      const releases = await WorkbookFeedbackReleaseCollection.create({
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
  async acknowledgeWorkbookFeedbackDelivery(
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
        await WorkbookFeedbackReleaseCollection.create({ db: service.db })
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
        (revision.kind !== 'ai' && !releases.length)
      )
        throw new LearnerAuthorizationError();
      const deliveries = await WorkbookFeedbackDeliveryCollection.create({
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
  async getWorkbookTimeline(
    request: ActivityRequest & {
      cursor?: string;
      limit?: number;
      revisionId?: string;
    },
  ): Promise<WorkbookTimeline> {
    const { row, workbook, learner } = await this.activity(request);
    const own = learner.userId === request.actorUserId;
    const limit = request.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid timeline limit');
    const all = await (
      await WorkbookAttemptCollection.create({ db: this.db })
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
        await WorkbookAssessmentRevisionCollection.create({ db: this.db })
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
    const attempts: WorkbookTimeline['attempts'] = [];
    for (const attempt of all.slice(start, start + limit)) {
      const revisions = await this.revisions(request, String(attempt.id));
      const releases = await (
        await WorkbookFeedbackReleaseCollection.create({ db: this.db })
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
      const visible = revisions.filter(
        (r) =>
          !own ||
          releases.some((rel) => rel.revisionId === r.id) ||
          (!photo.guardianOrigin && !attempt.reviewRequired && r.kind === 'ai'),
      );
      const deliveries = await (
        await WorkbookFeedbackDeliveryCollection.create({ db: this.db })
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
        ...(await this.attemptView(request, row, attempt)),
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
      });
    }
    return {
      activity: await this.activityView(row, workbook),
      attempts,
      nextCursor:
        start + limit < all.length ? String(all[start + limit - 1].id) : null,
    };
  }
  /** Descriptive guardian projection; corrections stay within one practice episode. */
  async getConceptEvidenceSummary(request: ActivityRequest): Promise<{
    algorithmVersion: 'workbook-descriptive-v1';
    concepts: WorkbookConceptSummary[];
  }> {
    await this.activity(request, 'education.learner.grade');
    const attempts = await (
      await WorkbookAttemptCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: request.activityId,
      },
    });
    const summaries = new Map<string, WorkbookConceptSummary>();
    const independentSeen = new Set<string>();
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
      for (const q of assessment.questions)
        for (const conceptId of q.conceptIds) {
          const key = `${assessment.vocabulary.namespace}:${assessment.vocabulary.version}:${conceptId}`;
          let summary = summaries.get(key);
          if (!summary) {
            summary = {
              namespace: assessment.vocabulary.namespace,
              version: assessment.vocabulary.version,
              conceptId,
              label: assessment.vocabulary.concepts.find(
                (c) => c.id === conceptId,
              )!.label,
              confirmed: {
                independent: 0,
                assisted: 0,
                unknown: 0,
                correct: 0,
                needsCorrection: 0,
                unassessed: 0,
              },
              provisional: 0,
              episodes: [],
              revisionIds: [],
              cues: [],
              observations: [],
            };
            summaries.set(key, summary);
          }
          if (!summary.episodes.includes(attempt.episodeId))
            summary.episodes.push(attempt.episodeId);
          if (!summary.revisionIds.includes(String(effective.id)))
            summary.revisionIds.push(String(effective.id));
          const observationAssistance =
            attempt.previousAttemptId && attempt.assistance === 'independent'
              ? 'unknown'
              : (attempt.assistance as WorkbookAssistance);
          summary.observations.push({
            submissionId: attempt.submissionId,
            revisionId: String(effective.id),
            questionId: q.id,
            episodeId: attempt.episodeId,
            result: q.result,
            assistance: observationAssistance,
            isCorrection: Boolean(attempt.previousAttemptId),
            capturedAt: attempt.capturedAt,
            confirmed: Boolean(confirmed),
          });
          if (!confirmed) {
            summary.provisional++;
            continue;
          }
          if (q.result === 'unassessed') {
            summary.confirmed.unassessed++;
            continue;
          }
          const episodeQuestion = `${key}:${attempt.episodeId}:${q.id}`;
          const assistance =
            attempt.previousAttemptId && attempt.assistance === 'independent'
              ? 'unknown'
              : (attempt.assistance as WorkbookAssistance);
          if (
            assistance !== 'independent' ||
            !independentSeen.has(episodeQuestion)
          )
            summary.confirmed[assistance]++;
          if (assistance === 'independent')
            independentSeen.add(episodeQuestion);
          if (q.result === 'correct') summary.confirmed.correct++;
          else summary.confirmed.needsCorrection++;
          if (
            attempt.previousAttemptId &&
            q.result === 'correct' &&
            !summary.cues.includes('improving on this item')
          )
            summary.cues.push('improving on this item');
        }
    }
    for (const summary of summaries.values()) {
      if (!summary.confirmed.independent)
        summary.cues.push('needs a fresh independent check');
      if (summary.confirmed.needsCorrection)
        summary.cues.push('needs practice');
      if (!summary.confirmed.correct && !summary.confirmed.needsCorrection)
        summary.cues.push('not enough evidence');
    }
    return {
      algorithmVersion: 'workbook-descriptive-v1',
      concepts: [...summaries.values()],
    };
  }
}
