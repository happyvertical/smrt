import type { DatabaseInterface } from '@happyvertical/sql';
import type { CourseModality } from './catalog.js';
import { CatalogAuthorizationError } from './catalog-service.js';
import {
  EnrollmentCollection,
  LessonProgressCollection,
} from './collections.js';
import { EnrollmentNoteService } from './enrollment-note-service.js';
import {
  type EnrollmentLessonScope,
  type EnrollmentView,
  enrollmentView,
  LearnerAuthorizationError,
  type LearnerRequest,
  type LessonProgressView,
} from './learner-service.js';
import { LessonActivityCollection } from './lesson-work-models.js';

export type PlanLessonView = Readonly<{
  lesson: Readonly<{
    id: string;
    title: string;
    kind: string;
    requiresOnlineResource: boolean;
    sourceUrl?: string;
    /**
     * Set only on a lesson whose work runs the release-gated workflow (book
     * and loose-page work), by the work's effective placement: filed work
     * belongs to the lesson it was filed into, not the one it was captured on.
     */
    lessonActivityId?: string;
  }>;
  progress: LessonProgressView | null;
}>;
/** Course data is deliberately limited to authorized display metadata, without source/asset locators. */
export type EnrollmentPlanView = Readonly<{
  enrollment: EnrollmentView;
  availability: 'available' | 'unavailable';
  course: Readonly<{
    id: string;
    title: string;
    subject: string;
    summary: string;
    modality: CourseModality;
    sourceKey: string;
  }> | null;
  lessons: ReadonlyArray<PlanLessonView>;
  nextActionableLessonId: string | null;
  awaitingReviewLessonIds: ReadonlyArray<string>;
  /** Most recent recorded start/completion, NOT most recent work or an update timestamp. */
  progressEvidence: Readonly<{
    kind: 'started' | 'completed';
    at: Date;
    lessonId: string;
  }> | null;
}>;

function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Actor-bound display reads and private parent notes for an exact enrollment. */
export class LearnerPlanService extends EnrollmentNoteService {
  protected override createTransactionService(db: DatabaseInterface): this {
    return new LearnerPlanService(
      db,
      this.authorize,
      this.authorizeCatalog,
    ) as this;
  }

  async listPlan(request: LearnerRequest): Promise<EnrollmentPlanView[]> {
    const learner = await this.requireActor(request, 'education.learner.read');
    const enrollments = await (
      await EnrollmentCollection.create({ db: this.db })
    ).list({
      where: { tenantId: request.tenantId, learnerId: String(learner.id) },
      orderBy: ['sortOrder ASC', 'id ASC'],
    });
    return Promise.all(
      enrollments.map((row) =>
        this.getEnrollmentPlan({ ...request, enrollmentId: String(row.id) }),
      ),
    );
  }

  /**
   * The learner's release-gated activities by the lesson of this enrollment
   * they are effectively placed in: the filing head for filed work, else the
   * activity's own routing. Reads stay on the request's tenant and learner and
   * on the already-authorized enrollment, so no other enrollment's work leaks.
   */
  private async placedReleaseGatedWork(
    request: LearnerRequest,
    enrollmentId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const placed = new Map<string, string>();
    if (!(await this.db.tableExists('workbook_activities'))) return placed;
    const heads = new Map<
      string,
      { enrollmentId: string; lessonId: string }[]
    >();
    if (await this.db.tableExists('lesson_work_filings')) {
      const filings = await this.db.list('lesson_work_filings', {
        tenant_id: request.tenantId,
        learner_id: request.learnerId,
      });
      const superseded = new Set(
        filings.map((filing) => String(filing.previous_revision_id ?? '')),
      );
      for (const filing of filings) {
        if (superseded.has(String(filing.id))) continue;
        const key = String(filing.source_activity_id);
        heads.set(key, [
          ...(heads.get(key) ?? []),
          {
            enrollmentId: String(filing.enrollment_id),
            lessonId: String(filing.lesson_id),
          },
        ]);
      }
    }
    const activities = await (
      await LessonActivityCollection.create({ db: this.db })
    ).list({
      where: { tenantId: request.tenantId, learnerId: request.learnerId },
    });
    for (const activity of activities.sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    )) {
      const filed = heads.get(String(activity.id)) ?? [];
      // Conflicting filing heads place the work nowhere rather than guessing.
      if (filed.length > 1) continue;
      const at = filed[0] ?? {
        enrollmentId: activity.enrollmentId,
        lessonId: activity.lessonId,
      };
      if (at.enrollmentId !== enrollmentId || placed.has(at.lessonId)) continue;
      if (activity.captureKind === 'unfiled' && !activity.photoIntakeId)
        continue;
      if (await this.isReleaseGatedWork(activity))
        placed.set(at.lessonId, String(activity.id));
    }
    return placed;
  }

  async getEnrollmentPlan(
    request: LearnerRequest & { enrollmentId: string },
  ): Promise<EnrollmentPlanView> {
    const row = await this.requireEnrollment(request, 'education.learner.read');
    const enrollment: EnrollmentView = enrollmentView(row);
    const unavailable: EnrollmentPlanView = {
      enrollment,
      availability: 'unavailable',
      course: null,
      lessons: [],
      nextActionableLessonId: null,
      awaitingReviewLessonIds: [],
      progressEvidence: null,
    };
    let scope: EnrollmentLessonScope;
    try {
      scope = await this.lessonScope(request, row);
    } catch (error) {
      if (
        error instanceof LearnerAuthorizationError ||
        error instanceof CatalogAuthorizationError
      )
        return unavailable;
      throw error;
    }
    const progress = await (
      await LessonProgressCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        enrollmentId: String(row.id),
      },
    });
    const byLesson = new Map(progress.map((value) => [value.lessonId, value]));
    const placedWork = await this.placedReleaseGatedWork(
      request,
      String(row.id),
    );
    const lessons = await Promise.all(
      scope.entries.map(async ({ lesson, course }): Promise<PlanLessonView> => {
        const lessonId = String(lesson.id);
        const activityId = placedWork.get(lessonId);
        const current = byLesson.get(lessonId);
        const requiresOnlineResource =
          course.modality === 'online' || lesson.constructor.name === 'Video';
        const sourceUrl = requiresOnlineResource
          ? safeSourceUrl(lesson.externalUrl)
          : undefined;
        return {
          lesson: {
            id: lessonId,
            title: lesson.title,
            kind: lesson.constructor.name,
            requiresOnlineResource,
            ...(sourceUrl ? { sourceUrl } : {}),
            ...(activityId ? { lessonActivityId: activityId } : {}),
          },
          progress: current
            ? await this.projectProgress(request, current)
            : null,
        };
      }),
    );
    let evidence: EnrollmentPlanView['progressEvidence'] = null;
    for (const { lesson, progress: current } of lessons)
      for (const [kind, at] of [
        ['started', current?.startedAt],
        ['completed', current?.completedAt],
      ] as const) {
        if (
          at instanceof Date &&
          Number.isFinite(at.getTime()) &&
          (!evidence || at.getTime() > evidence.at.getTime())
        )
          evidence = { kind, at: new Date(at), lessonId: lesson.id };
      }
    const actionable = ['active', 'planned'].includes(row.status)
      ? lessons.find(
          (value) =>
            (!value.lesson.requiresOnlineResource ||
              Boolean(value.lesson.sourceUrl)) &&
            (!value.progress ||
              ['not_started', 'in_progress'].includes(value.progress.status)),
        )
      : undefined;
    return {
      enrollment,
      availability: 'available',
      course: {
        id: String(scope.course.id),
        title: scope.course.title,
        subject: scope.course.subject,
        summary: scope.course.summary,
        modality: scope.course.modality,
        sourceKey: scope.course.sourceKey,
      },
      lessons,
      nextActionableLessonId: actionable?.lesson.id ?? null,
      awaitingReviewLessonIds: lessons
        .filter(
          (value) =>
            value.progress &&
            ['submitted', 'needs_review'].includes(value.progress.status),
        )
        .map((value) => value.lesson.id),
      progressEvidence: evidence,
    };
  }
}
