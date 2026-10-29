import type { DatabaseInterface } from '@happyvertical/sql';
import type { CourseModality } from './catalog.js';
import {
  CatalogAuthorizationError,
  type CatalogProjection,
} from './catalog-service.js';
import {
  EnrollmentCollection,
  LessonProgressCollection,
} from './collections.js';
import { EnrollmentNoteService } from './enrollment-note-service.js';
import {
  type EnrollmentView,
  LearnerAuthorizationError,
  type LearnerRequest,
  type LessonProgressView,
} from './learner-service.js';

export type PlanLessonView = Readonly<{
  lesson: Readonly<{
    id: string;
    title: string;
    kind: string;
    requiresOnlineResource: boolean;
    sourceUrl?: string;
    workbookActivityId?: string;
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

  async getEnrollmentPlan(
    request: LearnerRequest & { enrollmentId: string },
  ): Promise<EnrollmentPlanView> {
    const row = await this.requireEnrollment(request, 'education.learner.read');
    const enrollment: EnrollmentView = {
      id: String(row.id),
      learnerId: row.learnerId,
      curriculumId: row.curriculumId,
      courseId: row.courseId,
      status: row.status,
    };
    const unavailable: EnrollmentPlanView = {
      enrollment,
      availability: 'unavailable',
      course: null,
      lessons: [],
      nextActionableLessonId: null,
      awaitingReviewLessonIds: [],
      progressEvidence: null,
    };
    let catalog: CatalogProjection;
    try {
      catalog = await this.catalog(request, row.courseId);
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
    const lessons = await Promise.all(
      catalog.sections.flatMap((section) =>
        section.lessons.map(async ({ lesson }): Promise<PlanLessonView> => {
          const lessonId = String(lesson.id);
          const activity = await this.findWorkbookActivity(request, {
            enrollmentId: String(row.id),
            lessonId,
          });
          const current = byLesson.get(lessonId);
          const requiresOnlineResource =
            catalog.course.modality === 'online' ||
            lesson.constructor.name === 'Video';
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
              ...(activity?.id
                ? { workbookActivityId: String(activity.id) }
                : {}),
            },
            progress: current
              ? await this.projectProgress(request, current)
              : null,
          };
        }),
      ),
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
        id: String(catalog.course.id),
        title: catalog.course.title,
        subject: catalog.course.subject,
        summary: catalog.course.summary,
        modality: catalog.course.modality,
        sourceKey: catalog.course.sourceKey,
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
