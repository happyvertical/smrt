import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { type CatalogAuthorizer, CatalogService } from './catalog-service.js';
import {
  CourseCollection,
  CourseSectionCollection,
  CurriculumCollection,
  EnrollmentCollection,
  LearnerCollection,
  LessonAssetCollection,
  LessonCollection,
  LessonProgressCollection,
} from './collections.js';
import type {
  Curriculum,
  Enrollment,
  Learner,
  LessonProgress,
} from './learners.js';

/** Inputs are identifiers, never an authority claim or model patch. */
export interface LearnerRequest {
  tenantId: string;
  actorUserId: string;
  learnerId: string;
  guardianRelationshipId?: string;
}

/** The host validates relationship type/terms and its own permission policy. */
export type LearnerAuthorizer = (
  request: LearnerRequest & {
    action:
      | 'education.learner.read'
      | 'education.learner.plan'
      | 'education.learner.start';
    own: boolean;
    relationshipTypeId?: string;
  },
) => boolean | Promise<boolean>;

export class LearnerAuthorizationError extends Error {
  constructor() {
    super('Education learner access is not authorized.');
    this.name = 'LearnerAuthorizationError';
  }
}

/** Service results contain data only, with no transaction-bound model handle. */
export type LearnerView = Readonly<{
  id: string;
  tenantId: string;
  userId: string;
  profileId: string;
  displayName: string;
  level: number;
  settings: Record<string, unknown>;
}>;
export type CurriculumView = Readonly<{
  id: string;
  learnerId: string;
  title: string;
  status: Curriculum['status'];
}>;
export type EnrollmentView = Readonly<{
  id: string;
  learnerId: string;
  curriculumId: string;
  courseId: string;
  status: Enrollment['status'];
}>;
export type LessonProgressView = Readonly<{
  id: string;
  learnerId: string;
  enrollmentId: string;
  lessonId: string;
  status: LessonProgress['status'];
  bestScore: number | null;
  attempts: number;
  timeSpentSeconds: number;
  startedAt: Date | null;
  completedAt: Date | null;
}>;
function curriculumView(row: Curriculum): CurriculumView {
  return {
    id: String(row.id),
    learnerId: row.learnerId,
    title: row.title,
    status: row.status,
  };
}
function enrollmentView(row: Enrollment): EnrollmentView {
  return {
    id: String(row.id),
    learnerId: row.learnerId,
    curriculumId: row.curriculumId,
    courseId: row.courseId,
    status: row.status,
  };
}
function progressView(row: LessonProgress): LessonProgressView {
  return {
    id: String(row.id),
    learnerId: row.learnerId,
    enrollmentId: row.enrollmentId,
    lessonId: row.lessonId,
    status: row.status,
    bestScore: row.bestScore,
    attempts: row.attempts,
    timeSpentSeconds: row.timeSpentSeconds,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

/** Closed models are exposed only through this actor-bound resource boundary. */
export class LearnerService {
  private inTransaction = false;
  private writeTail: Promise<void> = Promise.resolve();
  private postgres: boolean;
  constructor(
    private readonly db: DatabaseInterface,
    private readonly authorize: LearnerAuthorizer,
    private readonly authorizeCatalog: CatalogAuthorizer,
  ) {
    this.postgres = isPostgresDatabase(db);
  }

  /** Compose planning/start operations atomically using the callback's service. */
  async withTransaction<T>(
    operation: (service: LearnerService) => Promise<T>,
  ): Promise<T> {
    if (this.inTransaction) return operation(this);
    return withEmbeddedWriteTransaction(
      this.db,
      isEmbeddedDatabase(this.db),
      async (db) => {
        const service = new LearnerService(
          db,
          this.authorize,
          this.authorizeCatalog,
        );
        service.inTransaction = true;
        service.postgres = this.postgres;
        return operation(service);
      },
    );
  }

  // Concurrent calls on one connection must observe earlier writes in that same
  // transaction. Cross-transaction arbitration still uses database row locks.
  private mutate<T>(
    operation: (service: LearnerService) => Promise<T>,
  ): Promise<T> {
    if (!this.inTransaction) return this.withTransaction(operation);
    const result = this.writeTail.then(() => operation(this));
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async requireActor(
    request: LearnerRequest,
    action: Parameters<LearnerAuthorizer>[0]['action'],
  ): Promise<Learner> {
    const context = getCurrentTenant();
    if (
      !context ||
      !request.tenantId ||
      !request.actorUserId ||
      !request.learnerId ||
      context.tenantId !== request.tenantId ||
      context.userId !== request.actorUserId ||
      context.superAdminBypass
    )
      throw new LearnerAuthorizationError();
    const learners = await LearnerCollection.create({ db: this.db });
    const learner = await learners.get(
      { id: request.learnerId, tenantId: request.tenantId },
      { cache: false },
    );
    if (
      !learner ||
      !(await this.db.get('memberships', {
        tenant_id: request.tenantId,
        user_id: request.actorUserId,
        status: 'active',
      })) ||
      !(await this.db.get('memberships', {
        tenant_id: request.tenantId,
        user_id: learner.userId,
        status: 'active',
      })) ||
      !(await this.db.get('users', {
        id: learner.userId,
        profile_id: learner.profileId,
      })) ||
      !(await this.db.get('profiles', {
        id: learner.profileId,
        _meta_type: '@happyvertical/smrt-profiles:Person',
      }))
    )
      throw new LearnerAuthorizationError();
    const own = learner.userId === request.actorUserId;
    let relationshipTypeId: string | undefined;
    if (!own) {
      const user = await this.db.get('users', { id: request.actorUserId });
      const relationship =
        user && request.guardianRelationshipId
          ? await this.db.get('profile_relationships', {
              id: request.guardianRelationshipId,
              tenant_id: request.tenantId,
              from_profile_id: user.profile_id,
              to_profile_id: learner.profileId,
            })
          : null;
      if (!relationship) throw new LearnerAuthorizationError();
      relationshipTypeId = String(relationship.type_id);
    }
    // A learner cannot turn their own grant into a planning/guardian capability.
    if (action === 'education.learner.plan' && own)
      throw new LearnerAuthorizationError();
    if (
      (await this.authorize({
        ...request,
        action,
        own,
        relationshipTypeId,
      })) !== true
    )
      throw new LearnerAuthorizationError();
    return learner;
  }

  async getLearner(request: LearnerRequest): Promise<LearnerView> {
    const row = await this.requireActor(request, 'education.learner.read');
    return {
      id: String(row.id),
      tenantId: row.tenantId,
      userId: row.userId,
      profileId: row.profileId,
      displayName: row.displayName,
      level: row.level,
      settings: row.getSettings(),
    };
  }

  async createCurriculum(
    request: LearnerRequest & { title: string },
  ): Promise<CurriculumView> {
    return this.mutate(async (service) => {
      const learner = await service.requireActor(
        request,
        'education.learner.plan',
      );
      if (typeof request.title !== 'string' || !request.title.trim())
        throw new Error('Curriculum title is required');
      return curriculumView(
        await (await CurriculumCollection.create({ db: service.db })).create({
          tenantId: request.tenantId,
          learnerId: String(learner.id),
          title: request.title,
        }),
      );
    });
  }

  private async catalog(request: LearnerRequest, courseId: string) {
    const service = new CatalogService(
      await CourseCollection.create({ db: this.db }),
      await CourseSectionCollection.create({ db: this.db }),
      await LessonCollection.create({ db: this.db }),
      await LessonAssetCollection.create({ db: this.db }),
      await TenantCollection.create({ db: this.db }),
      this.authorizeCatalog,
    );
    const projection = await service.projectCourse({
      ...request,
      courseId,
      includePrivate: true,
    });
    if (!projection) throw new LearnerAuthorizationError();
    return projection;
  }

  private async lock(
    table: 'curricula' | 'enrollments',
    id: string,
    tenant: string,
  ): Promise<void> {
    if (this.postgres)
      await this.db.query(
        `SELECT id FROM ${table} WHERE id = ? AND tenant_id = ? FOR UPDATE`,
        [id, tenant],
      );
  }

  async enroll(
    request: LearnerRequest & { curriculumId: string; courseId: string },
  ): Promise<EnrollmentView> {
    return this.mutate(async (service) => {
      const learner = await service.requireActor(
        request,
        'education.learner.plan',
      );
      await service.lock('curricula', request.curriculumId, request.tenantId);
      const curriculum = await (
        await CurriculumCollection.create({ db: service.db })
      ).get(
        {
          id: request.curriculumId,
          learnerId: String(learner.id),
          tenantId: request.tenantId,
        },
        { cache: false },
      );
      if (!curriculum) throw new LearnerAuthorizationError();
      await service.catalog(request, request.courseId);
      const enrollments = await EnrollmentCollection.create({ db: service.db });
      const existing = await enrollments.get(
        {
          curriculumId: String(curriculum.id),
          courseId: request.courseId,
          tenantId: request.tenantId,
        },
        { cache: false },
      );
      if (existing) {
        if (existing.learnerId !== learner.id)
          throw new LearnerAuthorizationError();
        return enrollmentView(existing);
      }
      return enrollmentView(
        await enrollments.create({
          tenantId: request.tenantId,
          curriculumId: String(curriculum.id),
          learnerId: String(learner.id),
          courseId: request.courseId,
          _insertOnly: true,
        }),
      );
    });
  }

  private async requireEnrollment(
    request: LearnerRequest & { enrollmentId: string },
    action: Parameters<LearnerAuthorizer>[0]['action'],
  ): Promise<Enrollment> {
    const learner = await this.requireActor(request, action);
    const enrollment = await (
      await EnrollmentCollection.create({ db: this.db })
    ).get(
      {
        id: request.enrollmentId,
        learnerId: String(learner.id),
        tenantId: request.tenantId,
      },
      { cache: false },
    );
    if (
      !enrollment ||
      !(await this.db.get('curricula', {
        id: enrollment.curriculumId,
        learner_id: String(learner.id),
        tenant_id: request.tenantId,
      }))
    )
      throw new LearnerAuthorizationError();
    return enrollment;
  }

  async listProgress(
    request: LearnerRequest & { enrollmentId: string },
  ): Promise<LessonProgressView[]> {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.read',
    );
    const catalog = await this.catalog(request, enrollment.courseId);
    const lessons = new Set(
      catalog.sections.flatMap((section) =>
        section.lessons.map(({ lesson }) => lesson.id),
      ),
    );
    return (
      await (
        await LessonProgressCollection.create({ db: this.db })
      ).list({
        where: {
          enrollmentId: String(enrollment.id),
          learnerId: request.learnerId,
          tenantId: request.tenantId,
        },
      })
    )
      .filter((progress) => lessons.has(progress.lessonId))
      .map(progressView);
  }

  /** Start once. Caller-supplied learner/status/score/counter patches are never applied. */
  async startLesson(
    request: LearnerRequest & { enrollmentId: string; lessonId: string },
  ): Promise<LessonProgressView> {
    return this.mutate(async (service) => {
      const enrollment = await service.requireEnrollment(
        request,
        'education.learner.start',
      );
      await service.lock('enrollments', request.enrollmentId, request.tenantId);
      const catalog = await service.catalog(request, enrollment.courseId);
      if (
        !catalog.sections.some((section) =>
          section.lessons.some(({ lesson }) => lesson.id === request.lessonId),
        )
      )
        throw new LearnerAuthorizationError();
      const progress = await LessonProgressCollection.create({
        db: service.db,
      });
      const existing = await progress.get(
        {
          enrollmentId: String(enrollment.id),
          lessonId: request.lessonId,
          tenantId: request.tenantId,
        },
        { cache: false },
      );
      if (existing) {
        if (existing.learnerId !== enrollment.learnerId)
          throw new LearnerAuthorizationError();
        return progressView(existing);
      }
      return progressView(
        await progress.create({
          tenantId: request.tenantId,
          enrollmentId: String(enrollment.id),
          learnerId: enrollment.learnerId,
          lessonId: request.lessonId,
          status: 'in_progress',
          startedAt: new Date(),
          _insertOnly: true,
        }),
      );
    });
  }
}
