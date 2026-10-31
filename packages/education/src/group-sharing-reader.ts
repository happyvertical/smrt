import {
  createAssetRuntime,
  withPrivateAssetAccess,
} from '@happyvertical/smrt-assets';
import {
  isEmbeddedDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { CatalogService } from './catalog-service.js';
import {
  CourseCollection,
  CourseSectionCollection,
  EnrollmentCollection,
  LessonAssetCollection,
  LessonCollection,
  LessonProgressCollection,
  SubmissionAssetCollection,
  SubmissionCollection,
} from './collections.js';
import { isAuthoredReleaseGroupShareable } from './course-authoring-licence.js';
import {
  type GroupSharingAction,
  type GroupSharingAuthorizer,
  GroupSharingBoundary,
  lockGroupSharingScope,
} from './group-sharing-authorization.js';
import {
  type GroupSharedProgressView,
  type GroupSharedRevisionView,
  type GroupSharedWorkSelector,
  type GroupSharedWorkView,
  GroupSharingAuthorizationError,
  type GroupSharingPolicyOptionsView,
  type GroupSharingPolicyV1,
  type GroupSharingPreview,
  type GroupSharingScope,
  validateGroupSharingPolicy,
} from './group-sharing-contracts.js';
import { groupSharingDigest } from './group-sharing-hash.js';
import {
  evaluateGroupSharingPolicy,
  summarizeWorkbookEvidence,
  type WorkbookEvidenceInput,
} from './group-sharing-policy.js';
import type { SubmissionServiceOptions } from './submission-service.js';
import {
  validateWorkbookAssessment,
  type WorkbookAssessment,
} from './workbook-contracts.js';
import {
  WorkbookActivityCollection,
  WorkbookAssessmentRevisionCollection,
  WorkbookAttemptCollection,
  WorkbookCollection,
} from './workbook-models.js';

const denied = () => new GroupSharingAuthorizationError();
const iso = (date: Date | string) => new Date(date).toISOString();
async function authorizedCatalogCourses(
  db: DatabaseInterface,
  request: Omit<GroupSharingScope, 'groupId'>,
  proveMetadataAuthority: () => Promise<unknown>,
) {
  const catalog = new CatalogService(
    await CourseCollection.create({ db }),
    await CourseSectionCollection.create({ db }),
    await LessonCollection.create({ db }),
    await LessonAssetCollection.create({ db }),
    await TenantCollection.create({ db }),
    async (context) => {
      if (
        context.executor !== db ||
        context.actorTenantId !== request.familyTenantId ||
        context.actorUserId !== request.actorUserId ||
        !['education.catalog.read', 'education.catalog.read-private'].includes(
          context.action,
        )
      )
        return false;
      await proveMetadataAuthority();
      return true;
    },
  );
  return catalog.findVisible({
    tenantId: request.familyTenantId,
    actorUserId: request.actorUserId,
    includePrivate: true,
  });
}
async function load(
  db: DatabaseInterface,
  request: GroupSharedWorkSelector,
  policy: GroupSharingPolicyV1,
  authorize: GroupSharingAuthorizer,
  action: GroupSharingAction = 'education.group.review',
  mode: 'supervisor' | 'guardian' = 'supervisor',
) {
  const caller = getCurrentTenant();
  if (!caller) throw denied();
  const proveMetadataAuthority = () =>
    withTenant({ tenantId: caller.tenantId, userId: request.actorUserId }, () =>
      new GroupSharingBoundary(db, authorize).requireScope(
        request,
        action,
        mode,
      ),
    );
  return withTenant(
    { tenantId: request.familyTenantId, userId: request.actorUserId },
    async () => {
      const where = {
        tenantId: request.familyTenantId,
        learnerId: request.learnerId,
      };
      const activity = await (
        await WorkbookActivityCollection.create({ db })
      ).get({ ...where, id: request.activityId }, { cache: false });
      const attempt = await (
        await WorkbookAttemptCollection.create({ db })
      ).get(
        { ...where, id: request.attemptId, activityId: request.activityId },
        { cache: false },
      );
      if (!activity || !attempt) throw denied();
      const submission = await (await SubmissionCollection.create({ db })).get(
        { ...where, id: attempt.submissionId, lessonId: activity.lessonId },
        { cache: false },
      );
      const enrollment = await (await EnrollmentCollection.create({ db })).get(
        { ...where, id: activity.enrollmentId },
        { cache: false },
      );
      if (!submission || !enrollment) throw denied();
      const progress = await (
        await LessonProgressCollection.create({ db })
      ).get(
        {
          ...where,
          id: submission.progressId,
          enrollmentId: activity.enrollmentId,
          lessonId: activity.lessonId,
        },
        { cache: false },
      );
      if (!progress) throw denied();
      if (activity.captureKind === 'unfiled') {
        if (
          activity.workbookId !== null ||
          !activity.photoIntakeId ||
          !(await db.get('workbook_photo_intakes', {
            id: activity.photoIntakeId,
            tenant_id: request.familyTenantId,
            learner_id: request.learnerId,
          }))
        )
          throw denied();
      } else if (
        activity.captureKind !== 'identified' ||
        !activity.workbookId ||
        !(await (
          await WorkbookCollection.create({ db })
        ).get({ ...where, id: activity.workbookId }, { cache: false }))
      )
        throw denied();
      if (
        attempt.previousAttemptId &&
        !(await (
          await WorkbookAttemptCollection.create({ db })
        ).get(
          {
            ...where,
            id: attempt.previousAttemptId,
            activityId: request.activityId,
            episodeId: attempt.episodeId,
          },
          { cache: false },
        ))
      )
        throw denied();

      // Catalog ownership may be self, ancestor or global; the child enrollment
      // remains exact-family-owned, and the sharing proof never becomes guardian authority.
      // Work is attributed to the course its own lesson belongs to (a pinned
      // enrollment may work on a later release); the enrollment's course is the
      // fallback. Privacy additionally spans the whole pin lineage.
      let course:
        | Awaited<ReturnType<typeof authorizedCatalogCourses>>[number]
        | null = null;
      let lineagePrivate = false;
      if (activity.captureKind !== 'unfiled') {
        const visible = await authorizedCatalogCourses(
          db,
          request,
          proveMetadataAuthority,
        );
        const lesson = await db.get('lessons', {
          id: activity.lessonId,
          tenant_id: request.familyTenantId,
        });
        const section = lesson
          ? await db.get('course_sections', {
              id: lesson.section_id,
              tenant_id: request.familyTenantId,
            })
          : null;
        const lessonCourseId = section ? String(section.course_id) : null;
        course =
          (lessonCourseId
            ? visible.find((row) => String(row.id) === lessonCourseId)
            : undefined) ??
          visible.find((row) => String(row.id) === enrollment.courseId) ??
          null;
        lineagePrivate = await enrollmentLineagePrivate(
          db,
          request.familyTenantId,
          String(enrollment.id),
        );
      }
      const revisions = await (
        await WorkbookAssessmentRevisionCollection.create({ db })
      ).list({ where: { ...where, attemptId: request.attemptId } });
      revisions.sort(
        (a, b) =>
          new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime() ||
          String(a.id).localeCompare(String(b.id)),
      );
      const guardian = revisions.filter((r) => r.kind === 'guardian');
      const superseded = new Set(guardian.map((r) => r.supersedesId));
      const heads = guardian.filter((r) => !superseded.has(String(r.id)));
      if (heads.length > 1) throw denied();
      const current =
        heads[0] ?? revisions.filter((r) => r.kind === 'ai').at(-1);
      const revision = request.revisionId
        ? revisions.find((r) => String(r.id) === request.revisionId)
        : current;
      if (request.revisionId && !revision) throw denied();
      for (const r of revisions)
        if (
          (r.supersedesId &&
            !revisions.some((x) => String(x.id) === r.supersedesId)) ||
          (r.sourceRevisionId &&
            !revisions.some((x) => String(x.id) === r.sourceRevisionId))
        )
          throw denied();
      const decision = evaluateGroupSharingPolicy(policy, {
        capturedAt: iso(attempt.capturedAt),
        courseId: course ? String(course.id) : null,
        subject: course?.subject?.trim() || null,
        parentReviewed: heads.length === 1,
        courseShareable:
          !lineagePrivate &&
          (course ? isAuthoredReleaseGroupShareable(course) : true),
      });
      const revisionPermitted =
        Boolean(revision) &&
        (!policy.parentReviewedOnly || revision?.kind === 'guardian');
      decision.feedback = decision.feedback && revisionPermitted;
      const sources: { assetId: string; sha256: string; pageCount: number }[] =
        JSON.parse(attempt.sourceHashes);
      if (
        !Array.isArray(sources) ||
        !sources.length ||
        sources.some(
          (s) =>
            !/^[a-f0-9]{64}$/.test(s.sha256) ||
            !Number.isSafeInteger(s.pageCount) ||
            s.pageCount < 1,
        )
      )
        throw denied();
      const learner = await db.get('learners', {
        id: request.learnerId,
        tenant_id: request.familyTenantId,
      });
      if (!learner) throw denied();
      for (const source of sources) {
        if (
          !(await db.get('submission_assets', {
            tenant_id: request.familyTenantId,
            submission_id: attempt.submissionId,
            asset_id: source.assetId,
          })) ||
          !(await db.get('assets', {
            id: source.assetId,
            tenant_id: request.familyTenantId,
            owner_profile_id: learner.profile_id,
            access_mode: 'private',
          }))
        )
          throw denied();
      }
      return {
        activity,
        attempt,
        revision,
        currentGuardian: heads[0],
        revisionPermitted,
        decision,
        sources,
        course,
      };
    },
  );
}
/** True when any release in the enrollment's pin lineage is personal-use. */
async function enrollmentLineagePrivate(
  db: DatabaseInterface,
  tenantId: string,
  enrollmentId: string,
): Promise<boolean> {
  const pins = await db.list('enrollment_release_pins', {
    tenant_id: tenantId,
    enrollment_id: enrollmentId,
  });
  for (const pin of pins) {
    const release = await db.get('course_releases', {
      id: pin.release_id,
      tenant_id: tenantId,
    });
    const course = release
      ? await db.get('courses', {
          id: release.release_course_id,
          tenant_id: tenantId,
        })
      : null;
    if (
      !course ||
      !isAuthoredReleaseGroupShareable({
        sourceKey: String(course.source_key),
        licenseKind: course.license_kind as never,
      })
    )
      return true;
  }
  return false;
}
function assessmentFrom(
  row: Awaited<ReturnType<typeof load>>,
  json: string,
): WorkbookAssessment {
  const assessment: WorkbookAssessment = JSON.parse(json);
  validateWorkbookAssessment(assessment);
  for (const question of assessment.questions)
    for (const anchor of question.anchors) {
      if (
        !row.sources.some(
          (source) =>
            source.assetId === anchor.assetId &&
            source.sha256 === anchor.sha256 &&
            (anchor.page === null ||
              (anchor.page >= 1 && anchor.page <= source.pageCount)),
        )
      )
        throw denied();
    }
  return assessment;
}
/** Exact immutable binding seam for comments already executing inside the owning transaction. */
export async function readSharedRevisionInScope(
  db: DatabaseInterface,
  authorize: GroupSharingAuthorizer,
  request: GroupSharedWorkSelector,
  action: GroupSharingAction = 'education.group.comment',
) {
  const boundary = new GroupSharingBoundary(db, authorize);
  const scope = await boundary.requireScope(request, action);
  const found = await load(db, request, scope.policy, authorize, action);
  if (!found.decision.work || !found.revision || !found.revisionPermitted)
    throw denied();
  await boundary.requireScope(request, action);
  return {
    activityId: request.activityId,
    attemptId: request.attemptId,
    submissionId: found.attempt.submissionId,
    revisionId: String(found.revision.id),
  };
}
/** Read-only owning boundary. Every method revalidates current authority on its active executor. */
export class GroupSharingReader {
  constructor(
    private readonly db: DatabaseInterface,
    private readonly authorize: GroupSharingAuthorizer,
    private readonly options?: SubmissionServiceOptions,
    private readonly executorBound = false,
  ) {}
  private run<T>(
    request: GroupSharingScope,
    operation: (
      reader: GroupSharingReader,
      policy: GroupSharingPolicyV1,
    ) => Promise<T>,
    mode: 'supervisor' | 'guardian' = 'supervisor',
  ): Promise<T> {
    const operationInScope = async (db: DatabaseInterface) => {
      const reader = new GroupSharingReader(db, this.authorize, this.options);
      const boundary = new GroupSharingBoundary(db, this.authorize);
      await boundary.requireScope(
        request,
        mode === 'guardian'
          ? 'education.group.share'
          : 'education.group.review',
        mode,
      );
      // Same lock order as capture/policy mutations. PG row locks serialize consent.
      await lockGroupSharingScope(db, request);
      const current = await boundary.requireScope(
        request,
        mode === 'guardian'
          ? 'education.group.share'
          : 'education.group.review',
        mode,
      );
      const result = await operation(reader, current.policy);
      const final = await boundary.requireScope(
        request,
        mode === 'guardian'
          ? 'education.group.share'
          : 'education.group.review',
        mode,
      );
      if (final.membership.policyVersion !== current.membership.policyVersion)
        throw denied();
      return result;
    };
    return this.executorBound
      ? operationInScope(this.db)
      : withEmbeddedWriteTransaction(
          this.db,
          isEmbeddedDatabase(this.db),
          operationInScope,
        );
  }
  /** Guardian-owned choices before invitation acceptance; never enumerates another child's courses. */
  async getSharingPolicyOptions(
    request: Omit<GroupSharingScope, 'groupId'>,
  ): Promise<GroupSharingPolicyOptionsView> {
    const operation = async (
      db: DatabaseInterface,
    ): Promise<GroupSharingPolicyOptionsView> => {
      const boundary = new GroupSharingBoundary(db, this.authorize);
      await boundary.requireGuardian(request, 'education.group.share');
      const result = await withTenant(
        { tenantId: request.familyTenantId, userId: request.actorUserId },
        async () => {
          const enrollments = await (
            await EnrollmentCollection.create({ db })
          ).list({
            where: {
              tenantId: request.familyTenantId,
              learnerId: request.learnerId,
            },
          });
          const unfiled = await (
            await WorkbookActivityCollection.create({ db })
          ).list({
            where: {
              tenantId: request.familyTenantId,
              learnerId: request.learnerId,
              captureKind: 'unfiled',
            },
          });
          const unfiledEnrollments = new Set(
            unfiled.map((row) => row.enrollmentId),
          );
          const enrolled = new Set<string>();
          for (const row of enrollments) {
            if (unfiledEnrollments.has(String(row.id))) continue;
            if (
              await enrollmentLineagePrivate(
                db,
                request.familyTenantId,
                String(row.id),
              )
            )
              continue;
            enrolled.add(row.courseId);
          }
          const visible = await authorizedCatalogCourses(db, request, () =>
            boundary.requireGuardian(request, 'education.group.share'),
          );
          const courses = visible
            .filter(
              (course) =>
                course.id &&
                course.sourceKey !== 'unfiled-work' &&
                isAuthoredReleaseGroupShareable(course) &&
                enrolled.has(String(course.id)),
            )
            .map((course) => ({
              id: String(course.id),
              label: course.title,
              subject: course.subject?.trim() || null,
            }))
            .sort(
              (a, b) =>
                a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
            );
          return {
            courses,
            subjects: [
              ...new Set(
                courses.flatMap((course) =>
                  course.subject ? [course.subject] : [],
                ),
              ),
            ].sort(),
          };
        },
      );
      await boundary.requireGuardian(request, 'education.group.share');
      return result;
    };
    return this.executorBound
      ? operation(this.db)
      : withEmbeddedWriteTransaction(
          this.db,
          isEmbeddedDatabase(this.db),
          operation,
        );
  }
  private async enumerate(
    request: GroupSharingScope,
    policy: GroupSharingPolicyV1,
    mode: 'supervisor' | 'guardian' = 'supervisor',
  ) {
    const attempts = await withTenant(
      { tenantId: request.familyTenantId, userId: request.actorUserId },
      async () =>
        (await WorkbookAttemptCollection.create({ db: this.db })).list({
          where: {
            tenantId: request.familyTenantId,
            learnerId: request.learnerId,
          },
        }),
    );
    attempts.sort(
      (a, b) =>
        new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime() ||
        String(a.id).localeCompare(String(b.id)),
    );
    const rows = [];
    for (const attempt of attempts)
      rows.push(
        await load(
          this.db,
          {
            ...request,
            activityId: attempt.activityId,
            attemptId: String(attempt.id),
          },
          policy,
          this.authorize,
          mode === 'guardian'
            ? 'education.group.share'
            : 'education.group.review',
          mode,
        ),
      );
    return rows;
  }
  async previewSharing(
    request: GroupSharingScope & { policy?: GroupSharingPolicyV1 },
  ): Promise<GroupSharingPreview> {
    return this.run(
      request,
      async (reader, saved) => {
        const policy = request.policy ?? saved;
        validateGroupSharingPolicy(policy);
        return {
          policy: structuredClone(policy),
          works: (await reader.enumerate(request, policy, 'guardian')).map(
            (r) => ({
              activityId: String(r.activity.id),
              attemptId: String(r.attempt.id),
              submissionId: r.attempt.submissionId,
              decision: r.decision,
            }),
          ),
        };
      },
      'guardian',
    );
  }
  private project(row: Awaited<ReturnType<typeof load>>): GroupSharedWorkView {
    return {
      activityId: String(row.activity.id),
      attemptId: String(row.attempt.id),
      submissionId: row.attempt.submissionId,
      capturedAt: iso(row.attempt.capturedAt),
      courseId: row.course ? String(row.course.id) : null,
      subject: row.course?.subject?.trim() || null,
      facets: row.decision,
      revisionId:
        row.decision.feedback && row.revision ? String(row.revision.id) : null,
      commentRevisionId:
        row.decision.work && row.revisionPermitted && row.revision
          ? String(row.revision.id)
          : null,
      media: row.decision.media ? row.sources.map((s) => ({ ...s })) : [],
    };
  }
  async listSharedWork(
    request: GroupSharingScope & { cursor?: string; limit?: number },
  ): Promise<{ works: GroupSharedWorkView[]; nextCursor: string | null }> {
    return this.run(request, async (reader, policy) => {
      const limit = request.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Invalid shared work limit');
      const rows = (await reader.enumerate(request, policy)).filter(
        (r) => r.decision.work,
      );
      const start = request.cursor
        ? rows.findIndex((r) => String(r.attempt.id) === request.cursor) + 1
        : 0;
      if (request.cursor && !start) throw denied();
      return {
        works: rows.slice(start, start + limit).map((r) => reader.project(r)),
        nextCursor:
          start + limit < rows.length
            ? String(rows[start + limit - 1].attempt.id)
            : null,
      };
    });
  }
  async getSharedWork(
    request: GroupSharedWorkSelector,
  ): Promise<GroupSharedWorkView> {
    return this.run(request, async (reader, policy) => {
      const row = await load(reader.db, request, policy, reader.authorize);
      if (!row.decision.work) throw denied();
      return reader.project(row);
    });
  }
  async getSharedRevision(
    request: GroupSharedWorkSelector,
  ): Promise<GroupSharedRevisionView> {
    return this.run(request, async (reader, policy) => {
      const row = await load(reader.db, request, policy, reader.authorize);
      if (!row.decision.feedback || !row.revision) throw denied();
      const assessment = assessmentFrom(row, row.revision.assessmentJson);
      // Assessment anchors are capabilities only when original media is explicitly shared.
      if (!row.decision.media) {
        for (const q of assessment.questions) q.anchors = [];
        delete assessment.answerRegions;
        delete assessment.layout;
      }
      return {
        activityId: request.activityId,
        attemptId: request.attemptId,
        submissionId: row.attempt.submissionId,
        revisionId: String(row.revision.id),
        createdAt: iso(row.revision.recordedAt),
        kind: row.revision.kind as 'ai' | 'guardian',
        assessment,
      };
    });
  }
  async getSharedProgress(
    request: GroupSharingScope,
  ): Promise<GroupSharedProgressView> {
    return this.run(request, async (reader, policy) => {
      if (!policy.shareProgress) throw denied();
      const rows = (await reader.enumerate(request, policy)).filter(
        (r) => r.decision.progress,
      );
      const evidence: WorkbookEvidenceInput[] = [];
      const counts = {
        attempts: rows.length,
        episodes: new Set(rows.map((r) => r.attempt.episodeId)).size,
        assistance: { independent: 0, assisted: 0, unknown: 0 },
      };
      for (const row of rows) {
        const assistance =
          row.attempt.previousAttemptId &&
          row.attempt.assistance === 'independent'
            ? 'unknown'
            : row.attempt.assistance;
        if (!['independent', 'assisted', 'unknown'].includes(assistance))
          throw denied();
        counts.assistance[assistance as keyof typeof counts.assistance]++;
        if (row.decision.feedback && row.currentGuardian) {
          const assessment = assessmentFrom(
            row,
            row.currentGuardian.assessmentJson,
          );
          evidence.push({
            attempt: row.attempt,
            revisionId: String(row.currentGuardian.id),
            assessment,
            confirmed: true,
          });
        }
      }
      return {
        algorithmVersion: 'workbook-descriptive-v1',
        counts,
        concepts: summarizeWorkbookEvidence(
          evidence.sort(
            (a, b) =>
              Number(Boolean(a.attempt.previousAttemptId)) -
              Number(Boolean(b.attempt.previousAttemptId)),
          ),
        ),
      };
    });
  }
  async readSharedMedia(
    request: GroupSharedWorkSelector & { assetId: string },
  ): Promise<{
    data: Buffer;
    mimeType: string;
    cacheControl: 'private, no-store';
  }> {
    return this.run(request, async (reader, policy) => {
      const row = await load(reader.db, request, policy, reader.authorize);
      const source = row.sources.find((s) => s.assetId === request.assetId);
      if (!row.decision.media || !source || !reader.options) throw denied();
      const options = reader.options;
      const boundary = new GroupSharingBoundary(reader.db, reader.authorize);
      const scope = await boundary.requireScope(
        request,
        'education.group.review',
      );
      return withTenant(
        { tenantId: request.familyTenantId, userId: request.actorUserId },
        () =>
          withPrivateAssetAccess(
            {
              tenantId: request.familyTenantId,
              actorUserId: request.actorUserId,
              ownerProfileId: scope.learner.profileId,
              assetIds: [request.assetId],
            },
            async () => {
              const link = await (
                await SubmissionAssetCollection.create({ db: reader.db })
              ).get(
                {
                  tenantId: request.familyTenantId,
                  submissionId: row.attempt.submissionId,
                  assetId: request.assetId,
                },
                { cache: false },
              );
              if (!link) throw denied();
              const runtime = await createAssetRuntime({
                db: reader.db,
                storage: options.storage,
                storeOptions: options.storeOptions,
              });
              const asset = await runtime.collection.get(
                {
                  id: request.assetId,
                  tenantId: request.familyTenantId,
                  ownerProfileId: scope.learner.profileId,
                },
                { cache: false },
              );
              if (asset?.accessMode !== 'private') throw denied();
              const data = await runtime.store.read(asset);
              if (groupSharingDigest(data) !== source.sha256) throw denied();
              return {
                data,
                mimeType: asset.mimeType,
                cacheControl: 'private, no-store' as const,
              };
            },
          ),
      );
    });
  }
}
