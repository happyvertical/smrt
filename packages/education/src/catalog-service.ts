import type { TenantCollection } from '@happyvertical/smrt-users';
import type { Course, CourseSection, Lesson } from './catalog.js';
import type {
  CourseCollection,
  CourseSectionCollection,
  LessonAssetCollection,
  LessonCollection,
} from './collections.js';
import type { LessonAsset } from './lesson-assets.js';

/** The application-owned decision that permits a catalog view for one tenant. */
export type TenantCatalogReadScope =
  TenantCollection['withTenantCatalogReadScope'];
export type CatalogActorContext = Parameters<
  Parameters<TenantCatalogReadScope>[0]['authorize']
>[0];

export type CatalogAuthorizer = (
  request: Omit<CatalogActorContext, 'mode'> & {
    action:
      | 'education.catalog.read'
      | 'education.catalog.read-private'
      | 'education.catalog.answer-key.read'
      | 'education.catalog.manage';
  },
) => boolean | Promise<boolean>;

export interface CatalogReadRequest {
  tenantId: string;
  actorUserId: string;
  includePrivate?: boolean;
  options?: Omit<Parameters<CourseCollection['list']>[0], 'where'>;
}

export interface CatalogProjection {
  course: Course;
  sections: Array<{
    section: CourseSection;
    lessons: Array<{ lesson: Lesson; assets: LessonAsset[] }>;
  }>;
}

export class CatalogAuthorizationError extends Error {
  constructor() {
    super('Education catalog access is not authorized.');
    this.name = 'CatalogAuthorizationError';
  }
}

/** Copy a lesson for a learner-facing projection without mutating the stored row. */
function projectLesson(lesson: Lesson, includeAnswerKeys: boolean): Lesson {
  if (includeAnswerKeys || !('answerUrl' in lesson)) return lesson;
  return Object.assign(Object.create(Object.getPrototypeOf(lesson)), lesson, {
    answerUrl: '',
  }) as Lesson;
}

/**
 * The only package-level family → group → global catalog read boundary.
 * Generated surfaces are closed; callers must supply both an application
 * authorization decision and the narrowly-scoped tenancy capability.
 */
export class CatalogService {
  constructor(
    private readonly courses: CourseCollection,
    private readonly sections: CourseSectionCollection,
    private readonly lessons: LessonCollection,
    private readonly assets: LessonAssetCollection,
    private readonly tenants: Pick<
      TenantCollection,
      'withTenantCatalogReadScope'
    >,
    private readonly authorize: CatalogAuthorizer,
  ) {}
  async findVisible(request: CatalogReadRequest): Promise<Course[]> {
    const {
      tenantId,
      actorUserId,
      includePrivate = false,
      options = {},
    } = request;
    if (!tenantId.trim() || !actorUserId.trim())
      throw new CatalogAuthorizationError();
    const actor = {
      actorTenantId: tenantId,
      actorUserId,
      rootTenantId: tenantId,
    };
    const allowed = await this.authorize({
      ...actor,
      action: 'education.catalog.read',
    });
    if (allowed !== true) throw new CatalogAuthorizationError();
    if (
      includePrivate &&
      (await this.authorize({
        ...actor,
        action: 'education.catalog.read-private',
      })) !== true
    )
      throw new CatalogAuthorizationError();
    const scope: Parameters<TenantCatalogReadScope>[0] = {
      collections: [
        '@happyvertical/smrt-education:Course',
        '@happyvertical/smrt-education:CourseSection',
        '@happyvertical/smrt-education:Lesson',
        '@happyvertical/smrt-education:LessonAsset',
      ],
      authorize: async (scope) =>
        scope.mode === 'catalog' &&
        scope.actorTenantId === tenantId &&
        scope.actorUserId === actorUserId &&
        scope.rootTenantId === tenantId,
    };
    const visible = await this.tenants.withTenantCatalogReadScope(
      scope,
      async () => this.courses.list(options),
    );
    return visible.filter(
      (course) =>
        course.licenseKind !== 'personal-use-copy' ||
        (includePrivate && course.tenantId === tenantId),
    );
  }

  /** Project one already-visible course without exposing answer-key assets by default. */
  async projectCourse(
    request: CatalogReadRequest & {
      courseId: string;
      includeAnswerKeys?: boolean;
    },
  ): Promise<CatalogProjection | null> {
    const courses = await this.findVisible(request);
    const course = courses.find((item) => item.id === request.courseId);
    if (!course?.id) return null;
    const includeAnswerKeys = request.includeAnswerKeys === true;
    const actor = {
      actorTenantId: request.tenantId,
      actorUserId: request.actorUserId,
      rootTenantId: request.tenantId,
    };
    if (
      includeAnswerKeys &&
      (await this.authorize({
        ...actor,
        action: 'education.catalog.answer-key.read',
      })) !== true
    )
      throw new CatalogAuthorizationError();
    return this.tenants.withTenantCatalogReadScope(
      {
        collections: [
          '@happyvertical/smrt-education:CourseSection',
          '@happyvertical/smrt-education:Lesson',
          '@happyvertical/smrt-education:LessonAsset',
        ],
        authorize: async (scope) =>
          scope.mode === 'catalog' &&
          scope.actorTenantId === request.tenantId &&
          scope.actorUserId === request.actorUserId,
      },
      async () => {
        const sections = await this.sections.list({
          where: { courseId: course.id },
          orderBy: ['sortOrder ASC', 'id ASC'],
        });
        const result = [];
        for (const section of sections) {
          if (section.tenantId !== course.tenantId) continue;
          const lessons = await this.lessons.list({
            where: { sectionId: section.id },
            orderBy: ['sortOrder ASC', 'id ASC'],
          });
          result.push({
            section,
            lessons: await Promise.all(
              lessons
                .filter((lesson) => lesson.tenantId === course.tenantId)
                .map(async (lesson) => ({
                  lesson: projectLesson(lesson, includeAnswerKeys),
                  assets: (await this.assets.byLeft(String(lesson.id))).filter(
                    (asset) =>
                      asset.tenantId === course.tenantId &&
                      (includeAnswerKeys ||
                        asset.relationship !== 'answer-key'),
                  ),
                })),
            ),
          });
        }
        return { course, sections: result };
      },
    );
  }
}
