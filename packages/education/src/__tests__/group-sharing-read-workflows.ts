import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssetRuntime,
  withPrivateAssetAccess,
} from '@happyvertical/smrt-assets';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  SessionCollection,
  TenantCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it } from 'vitest';
import {
  CourseCollection,
  CourseSectionCollection,
  LessonAssetCollection,
  LessonCollection,
  SubmissionAssetCollection,
} from '../collections.js';
import { GroupSharingBoundary } from '../group-sharing-authorization.js';
import { GroupSharingCommentService } from '../group-sharing-comments.js';
import {
  canonicalGroupSharingPolicy,
  type GroupSharingPolicyV1,
} from '../group-sharing-contracts.js';
import {
  EducationGroupCollection,
  GroupLearnerMembershipCollection,
  GroupSharingPolicyCollection,
} from '../group-sharing-models.js';
import { GroupSharingReader } from '../group-sharing-reader.js';
import {
  WORKBOOK_MATH_VOCABULARY,
  type WorkbookAssessment,
} from '../workbook-contracts.js';
import {
  WorkbookActivityCollection,
  WorkbookCollection,
} from '../workbook-models.js';
import { WorkbookPhotoService } from '../workbook-photo-service.js';
import { WorkbookService } from '../workbook-service.js';
import { learnerFixture } from './learner-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

export const groupSharingReadClasses = [
  ...workbookClasses,
  'Session',
  'EducationGroup',
  'GroupLearnerMembership',
  'GroupSharingPolicy',
  'GroupRevisionComment',
  'WorkbookPhotoDecision',
  'WorkbookContextRevision',
];
export const sharingPolicy = (): GroupSharingPolicyV1 => ({
  schemaVersion: 1,
  shareWork: true,
  shareMedia: true,
  shareFeedback: true,
  shareProgress: true,
  parentReviewedOnly: false,
  historyFrom: '2000-01-01T00:00:00.000Z',
  subjects: { mode: 'all' },
  courseIds: { mode: 'all' },
  commentVisibility: 'parent-only',
});
export async function sharingReadFixture(db: DatabaseInterface) {
  const f = await learnerFixture(db);
  const storage = await mkdtemp(join(tmpdir(), 'group-sharing-reader-'));
  const workbook = new WorkbookService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
    { storage },
  );
  const activity = await f.as(f.parent, () =>
    workbook.resolveWorkbookActivity({
      ...f.parent,
      workbookKey: 'synthetic-share',
      title: 'Synthetic',
      pageKey: 'p1',
      pageLabel: '1',
    }),
  );
  const attempt = await f.as(f.own, () =>
    workbook.captureWorkbookWork({
      ...f.own,
      activityId: activity.id,
      requestKey: 'capture',
      intakeItemId: 'synthetic-capture',
      pages: [
        {
          name: 'work.png',
          mimeType: 'image/png',
          data: Buffer.from('synthetic completed child work'),
        },
      ],
      assistance: 'independent',
    }),
  );
  const request = {
    ...f.parent,
    activityId: activity.id,
    submissionId: attempt.submissionId,
  };
  const sources = await f.as(f.parent, () =>
    workbook.getWorkbookSourceAnchors(request),
  );
  const assessment: WorkbookAssessment = {
    version: 1,
    feedback: 'Withheld feedback',
    provenance: {
      provider: 'synthetic',
      model: 'test',
      configurationVersion: '1',
      rubricVersion: '1',
      inputHash: sources[0].sha256,
      analysisId: 'share-test',
    },
    vocabulary: structuredClone(WORKBOOK_MATH_VOCABULARY),
    questions: [
      {
        id: 'q1',
        prompt: '1+1',
        answer: '3',
        result: 'incorrect',
        reason: 'none',
        feedback: 'Withheld answer',
        points: 0,
        possiblePoints: 1,
        anchors: [{ ...sources[0], page: 1, rect: [0, 0, 1, 1] }],
        conceptIds: ['math.addition'],
      },
    ],
  };
  const proposal = await f.as(f.parent, () =>
    workbook.recordWorkbookAnalysis({
      ...request,
      requestKey: 'ai',
      assessment,
    }),
  );
  const revision = await f.as(f.parent, () =>
    workbook.reviewWorkbookAssessment({
      ...request,
      revisionId: proposal.id,
      expectedHeadId: null,
      requestKey: 'review',
    }),
  );
  const groupTenant = await (await TenantCollection.create({ db })).create({
    name: `Synthetic group ${randomUUID()}`,
  });
  const groupTenantId = String(groupTenant.id);
  const familyMembership = await (
    await MembershipCollection.create({ db })
  ).get(
    { tenantId: f.parent.tenantId, userId: f.parent.actorUserId },
    { cache: false },
  );
  if (!familyMembership) throw new Error('Missing family fixture membership');
  await (await MembershipCollection.create({ db })).create({
    tenantId: groupTenantId,
    userId: f.parent.actorUserId,
    roleId: familyMembership.roleId,
    status: MembershipStatus.ACTIVE,
  });
  const group = await withTenant(
    { tenantId: groupTenantId, userId: f.parent.actorUserId },
    async () =>
      (await EducationGroupCollection.create({ db })).create({
        tenantId: groupTenantId,
        name: `Group ${randomUUID()}`,
        creatorUserId: f.parent.actorUserId,
        creatorProfileId: String(f.guardian.profile.id),
      }),
  );
  const edge = await f.as(f.parent, async () =>
    (await GroupLearnerMembershipCollection.create({ db })).create({
      tenantId: f.parent.tenantId,
      learnerId: f.parent.learnerId,
      groupId: String(group.id),
      consentParentUserId: f.parent.actorUserId,
    }),
  );
  let version = 0;
  const setPolicy = async (policy: GroupSharingPolicyV1) =>
    f.as(f.parent, async () => {
      version++;
      await (await GroupSharingPolicyCollection.create({ db })).create({
        tenantId: f.parent.tenantId,
        membershipId: String(edge.id),
        version,
        policyJson: canonicalGroupSharingPolicy(policy),
        actorUserId: f.parent.actorUserId,
      });
      edge.policyVersion = version;
      await edge.save();
    });
  await setPolicy(sharingPolicy());
  const session = await (await SessionCollection.create({ db })).createSession({
    userId: f.parent.actorUserId,
  });
  const scope = {
    actorUserId: f.parent.actorUserId,
    sessionId: String(session.id),
    groupId: String(group.id),
    familyTenantId: f.parent.tenantId,
    learnerId: f.parent.learnerId,
  };
  const selector = { ...scope, activityId: activity.id, attemptId: attempt.id };
  let allow = true;
  let rejectAt = Infinity;
  const executors: DatabaseInterface[] = [];
  const reader = new GroupSharingReader(
    db,
    (request) => {
      executors.push(request.executor);
      return (
        allow &&
        executors.length !== rejectAt &&
        request.actorUserId === f.parent.actorUserId
      );
    },
    { storage },
  );
  const asSupervisor = <T>(fn: () => Promise<T>) =>
    withTenant({ tenantId: groupTenantId, userId: f.parent.actorUserId }, fn);
  return {
    ...f,
    storage,
    workbook,
    activity,
    attempt,
    revision,
    sources,
    reader,
    scope,
    selector,
    edge,
    setPolicy,
    asSupervisor,
    executors,
    rejectAtCall: (call: number) => {
      rejectAt = call;
    },
    deny: () => {
      allow = false;
    },
    cleanup: () => rm(storage, { recursive: true, force: true }),
  };
}
export function groupSharingReadContractTests(
  make: () => Promise<{ db: DatabaseInterface; cleanup: () => Promise<void> }>,
) {
  it('uses offered global and ancestor course metadata for restricted work, preview and progress', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    const catalogCourseIds: string[] = [];
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      const tenants = await TenantCollection.create({ db: handle.db });
      const ancestor = await tenants.create({
        name: `Catalog provider ${randomUUID()}`,
      });
      await tenants.moveToParent(x.parent.tenantId, String(ancestor.id));
      for (const tenantId of [null, String(ancestor.id)]) {
        const tag = tenantId ? 'ancestor' : 'global';
        const course = await (
          await CourseCollection.create({ db: handle.db })
        ).create({
          tenantId,
          title: `Offered ${tag} ${randomUUID()}`,
          subject: `${tag} subject`,
          licenseKind: 'open-license',
        });
        catalogCourseIds.push(String(course.id));
        const section = await (
          await CourseSectionCollection.create({ db: handle.db })
        ).create({
          tenantId,
          courseId: String(course.id),
          title: `${tag} section`,
        });
        const lesson = await (
          await LessonCollection.create({ db: handle.db })
        ).create({
          tenantId,
          sectionId: String(section.id),
          title: `${tag} lesson`,
        });
        const enrollment = await x.as(x.parent, () =>
          x.service.enroll({
            ...x.parent,
            curriculumId: String(x.curriculum.id),
            courseId: String(course.id),
          }),
        );
        const activity = await x.as(x.parent, async () => {
          const workbook = await (
            await WorkbookCollection.create({ db: handle.db })
          ).create({
            tenantId: x.parent.tenantId,
            learnerId: x.parent.learnerId,
            workbookKey: `catalog-${tag}`,
            title: `Synthetic ${tag} workbook`,
          });
          return (
            await WorkbookActivityCollection.create({ db: handle.db })
          ).create({
            tenantId: x.parent.tenantId,
            learnerId: x.parent.learnerId,
            workbookId: String(workbook.id),
            enrollmentId: enrollment.id,
            lessonId: String(lesson.id),
            pageKey: 'p1',
            pageLabel: '1',
          });
        });
        const attempt = await x.as(x.parent, () =>
          x.workbook.captureWorkbookWork({
            ...x.parent,
            activityId: String(activity.id),
            requestKey: `catalog-${tag}-capture`,
            intakeItemId: `catalog-${tag}-capture`,
            pages: [
              {
                name: 'work.png',
                mimeType: 'image/png',
                data: Buffer.from(`synthetic ${tag} work`),
              },
            ],
          }),
        );
        const options = await x.as(x.parent, () =>
          x.reader.getSharingPolicyOptions({ ...x.scope }),
        );
        expect(options.courses).toContainEqual({
          id: String(course.id),
          label: course.title,
          subject: course.subject,
        });
        const supervisor = new GroupSharingReader(
          handle.db,
          (context) => context.action === 'education.group.review',
          { storage: x.storage },
        );
        for (const policy of [
          {
            ...sharingPolicy(),
            courseIds: {
              mode: 'include' as const,
              values: [String(course.id)],
            },
          },
          {
            ...sharingPolicy(),
            subjects: { mode: 'include' as const, values: [course.subject] },
          },
        ]) {
          await x.setPolicy(policy);
          const listed = await x.asSupervisor(() =>
            supervisor.listSharedWork(x.scope),
          );
          expect(listed.works.map((w) => w.attemptId)).toEqual([attempt.id]);
          expect(listed.works[0]).toMatchObject({
            courseId: String(course.id),
            subject: course.subject,
          });
          const preview = await x.as(x.parent, () =>
            x.reader.previewSharing({ ...x.scope, policy }),
          );
          expect(
            preview.works.find((w) => w.attemptId === attempt.id)?.decision
              .eligible,
          ).toBe(true);
          expect(
            (await x.asSupervisor(() => supervisor.getSharedProgress(x.scope)))
              .counts.attempts,
          ).toBe(1);
        }
      }
    } finally {
      try {
        // Exact cleanup: these globally/ancestor-visible rows must not survive a
        // committed PG fixture and pollute later catalog pagination tests.
        for (const courseId of catalogCourseIds) {
          const enrollments = await handle.db.list('enrollments', {
            course_id: courseId,
          });
          for (const enrollment of enrollments) {
            const activities = await handle.db.list('workbook_activities', {
              enrollment_id: enrollment.id,
              tenant_id: enrollment.tenant_id,
            });
            for (const activity of activities) {
              const attempts = await handle.db.list('workbook_attempts', {
                activity_id: activity.id,
                tenant_id: enrollment.tenant_id,
              });
              for (const attempt of attempts) {
                await handle.db.delete('workbook_feedback_deliveries', {
                  attempt_id: attempt.id,
                });
                await handle.db.delete('workbook_feedback_releases', {
                  attempt_id: attempt.id,
                });
                await handle.db.delete('workbook_assessment_revisions', {
                  attempt_id: attempt.id,
                });
                await handle.db.delete('workbook_attempts', { id: attempt.id });
              }
              await handle.db.delete('workbook_activities', {
                id: activity.id,
              });
            }
            const progresses = await handle.db.list('lesson_progress', {
              enrollment_id: enrollment.id,
              tenant_id: enrollment.tenant_id,
            });
            for (const progress of progresses) {
              const submissions = await handle.db.list('submissions', {
                progress_id: progress.id,
                tenant_id: enrollment.tenant_id,
              });
              for (const submission of submissions) {
                await handle.db.delete('submission_intake_bindings', {
                  submission_id: submission.id,
                });
                await handle.db.delete('submission_assets', {
                  submission_id: submission.id,
                });
                await handle.db.delete('grades', {
                  submission_id: submission.id,
                });
                await handle.db.delete('submissions', { id: submission.id });
              }
              await handle.db.delete('lesson_progress', { id: progress.id });
            }
            await handle.db.delete('enrollments', { id: enrollment.id });
          }
          const sections = await handle.db.list('course_sections', {
            course_id: courseId,
          });
          for (const section of sections)
            await handle.db.delete('lessons', { section_id: section.id });
          await handle.db.delete('course_sections', { course_id: courseId });
          await handle.db.delete('courses', { id: courseId });
          expect(await handle.db.get('courses', { id: courseId })).toBeNull();
        }
      } finally {
        await f?.cleanup();
        await handle.cleanup();
      }
    }
  });
  it('treats real unfiled capture routing as unknown metadata and excludes its placeholder from consent options', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      const photos = new WorkbookPhotoService(
        handle.db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === x.guardianType.id,
        () => true,
        { storage: x.storage },
      );
      const receipt = await x.as(x.parent, () =>
        photos.retainWorkbookPhotoIntake({
          ...x.parent,
          itemId: 'unfiled-sharing-policy',
          pages: [
            {
              name: 'unfiled.png',
              mimeType: 'image/png',
              data: Buffer.from('synthetic unfiled completed work'),
            },
          ],
        }),
      );
      const request = { ...x.parent, intakeId: receipt.id };
      const resolved = await x.as(x.parent, () =>
        photos.resolveWorkbookPhotoIntake({
          ...request,
          requestKey: 'unfiled-work',
          identification: { kind: 'work', workState: 'completed' },
        }),
      );
      if (!resolved.activity) throw new Error('Missing unfiled activity');
      const activity = resolved.activity;
      const attempt = await x.as(x.parent, () =>
        photos.captureWorkbookPhotoIntake({
          ...request,
          requestKey: 'capture-unfiled',
        }),
      );
      const [capturedSource] = await x.as(x.parent, () =>
        photos.getWorkbookSourceAnchors({
          ...x.parent,
          activityId: activity.id,
          submissionId: attempt.submissionId,
        }),
      );
      const enrollment = await handle.db.get('enrollments', {
        id: activity.enrollmentId,
        tenant_id: x.parent.tenantId,
        learner_id: x.parent.learnerId,
      });
      if (!enrollment) throw new Error('Missing unfiled enrollment');
      const course = await x.as(x.parent, async () =>
        (await CourseCollection.create({ db: handle.db })).get(
          { id: enrollment.course_id, tenantId: x.parent.tenantId },
          { cache: false },
        ),
      );
      if (!course) throw new Error('Missing technical routing course');
      course.subject = 'Synthetic placeholder subject';
      await x.as(x.parent, () => course.save());
      const options = await x.as(x.parent, () =>
        x.reader.getSharingPolicyOptions({ ...x.scope }),
      );
      expect(options.courses.map((c) => c.id)).not.toContain(String(course.id));
      expect(options.subjects).not.toContain(course.subject);
      expect(options.courses.map((c) => c.id)).toContain(String(x.course.id));
      const selector = {
        ...x.scope,
        activityId: activity.id,
        attemptId: attempt.id,
      };
      for (const policy of [
        {
          ...sharingPolicy(),
          courseIds: { mode: 'include' as const, values: [String(course.id)] },
        },
        {
          ...sharingPolicy(),
          subjects: { mode: 'include' as const, values: [course.subject] },
        },
      ]) {
        await x.setPolicy(policy);
        expect(
          (
            await x.asSupervisor(() => x.reader.listSharedWork(x.scope))
          ).works.map((w) => w.attemptId),
        ).not.toContain(attempt.id);
        expect(
          (
            await x.as(x.parent, () =>
              x.reader.previewSharing({ ...x.scope, policy }),
            )
          ).works.find((w) => w.attemptId === attempt.id)?.decision.eligible,
        ).toBe(false);
        await expect(
          x.asSupervisor(() =>
            x.reader.readSharedMedia({
              ...selector,
              assetId: capturedSource.assetId,
            }),
          ),
        ).rejects.toThrow();
        expect(
          (await x.asSupervisor(() => x.reader.getSharedProgress(x.scope)))
            .counts.attempts,
        ).toBe(0);
      }
      await x.setPolicy(sharingPolicy());
      expect(
        await x.asSupervisor(() => x.reader.getSharedWork(selector)),
      ).toMatchObject({ courseId: null, subject: null });
      expect(
        (await x.asSupervisor(() => x.reader.getSharedProgress(x.scope))).counts
          .attempts,
      ).toBe(2);
      expect(
        (
          await x.asSupervisor(() =>
            x.reader.readSharedMedia({
              ...selector,
              assetId: capturedSource.assetId,
            }),
          )
        ).data.toString(),
      ).toBe('synthetic unfiled completed work');
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });
  it('offers guardian-only enrolled course metadata before any group consent, including future/private and global catalog courses', async () => {
    const handle = await make();
    let globalCourseId: string | undefined;
    try {
      const f = await learnerFixture(handle.db);
      const courses = await CourseCollection.create({ db: handle.db });
      const global = await courses.create({
        title: `Global choice ${randomUUID()}`,
        subject: 'Science',
        licenseKind: 'open-license',
      });
      globalCourseId = String(global.id);
      const privateCourse = await courses.create({
        tenantId: f.parent.tenantId,
        title: `Private choice ${randomUUID()}`,
        licenseKind: 'personal-use-copy',
      });
      const unrelated = await courses.create({
        tenantId: f.parent.tenantId,
        title: `Unenrolled ${randomUUID()}`,
        subject: 'Hidden subject',
      });
      for (const course of [global, privateCourse])
        await f.as(f.parent, () =>
          f.service.enroll({
            ...f.parent,
            curriculumId: String(f.curriculum.id),
            courseId: String(course.id),
          }),
        );
      const sessions = await SessionCollection.create({ db: handle.db });
      const session = await sessions.createSession({
        userId: f.parent.actorUserId,
      });
      const request = {
        actorUserId: f.parent.actorUserId,
        sessionId: String(session.id),
        familyTenantId: f.parent.tenantId,
        learnerId: f.parent.learnerId,
      };
      const executors: DatabaseInterface[] = [];
      const reader = new GroupSharingReader(handle.db, (context) => {
        executors.push(context.executor);
        return (
          context.actorUserId === f.parent.actorUserId &&
          context.guardianRelationships?.some(
            (r) => r.typeId === f.guardianType.id,
          ) === true
        );
      });
      const options = await f.as(f.parent, () =>
        reader.getSharingPolicyOptions(request),
      );
      expect(options.courses).toEqual(
        expect.arrayContaining([
          { id: String(f.course.id), label: f.course.title, subject: null },
          { id: String(global.id), label: global.title, subject: 'Science' },
          {
            id: String(privateCourse.id),
            label: privateCourse.title,
            subject: null,
          },
        ]),
      );
      expect(options.courses.map((c) => c.id)).not.toContain(
        String(unrelated.id),
      );
      expect(options.subjects).toEqual(['Science']);
      expect(new Set(executors).size).toBe(1);
      expect(JSON.stringify(options)).not.toMatch(
        /sourceUri|assessment|assetId|grade|score/,
      );
      const childSession = await sessions.createSession({
        userId: f.own.actorUserId,
      });
      const wrongSession = await sessions.createSession({
        userId: String(f.bob.user.id),
      });
      await expect(
        f.as(f.own, () =>
          reader.getSharingPolicyOptions({
            ...request,
            actorUserId: f.own.actorUserId,
            sessionId: String(childSession.id),
          }),
        ),
      ).rejects.toThrow();
      await expect(
        withTenant(
          { tenantId: f.parent.tenantId, userId: String(f.bob.user.id) },
          () =>
            reader.getSharingPolicyOptions({
              ...request,
              actorUserId: String(f.bob.user.id),
              sessionId: String(wrongSession.id),
            }),
        ),
      ).rejects.toThrow();
      await expect(
        f.as(f.parent, () =>
          reader.getSharingPolicyOptions({
            ...request,
            learnerId: String(f.sibling.id),
          }),
        ),
      ).rejects.toThrow();
      await expect(
        f.as(f.parent, () =>
          reader.getSharingPolicyOptions({
            ...request,
            learnerId: String(f.foreign.id),
          }),
        ),
      ).rejects.toThrow();
    } finally {
      try {
        // The PG concurrency harness commits through baseDb. Remove only this
        // test's global catalog row so later catalog pagination sees its own data.
        if (globalCourseId) {
          await handle.db.delete('enrollments', { course_id: globalCourseId });
          await handle.db.delete('courses', { id: globalCourseId });
          expect(
            await handle.db.get('courses', { id: globalCourseId }),
          ).toBeNull();
        }
      } finally {
        await handle.cleanup();
      }
    }
  });
  it('offers policy-withheld work courses to the guardian while metadata-only group members cannot read child data', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      await x.setPolicy({
        ...sharingPolicy(),
        courseIds: { mode: 'include', values: [] },
      });
      const options = await x.as(x.parent, () =>
        x.reader.getSharingPolicyOptions({
          actorUserId: x.scope.actorUserId,
          sessionId: x.scope.sessionId,
          familyTenantId: x.scope.familyTenantId,
          learnerId: x.scope.learnerId,
        }),
      );
      expect(options.courses.map((c) => c.label)).toEqual(
        expect.arrayContaining(['Course', 'Synthetic']),
      );
      await x.setPolicy(sharingPolicy());
      const metadataOnly = (
        context: Parameters<
          ConstructorParameters<typeof GroupSharingReader>[1]
        >[0],
      ) => context.action === 'education.group.read';
      const boundary = new GroupSharingBoundary(handle.db, metadataOnly);
      expect(
        (
          await x.asSupervisor(() =>
            boundary.requireGroup(x.scope, 'education.group.read'),
          )
        ).id,
      ).toBe(x.scope.groupId);
      const reader = new GroupSharingReader(handle.db, metadataOnly, {
        storage: x.storage,
      });
      const operations: Array<() => Promise<unknown>> = [
        () => reader.listSharedWork(x.scope),
        () => reader.getSharedWork(x.selector),
        () => reader.getSharedRevision(x.selector),
        () => reader.getSharedProgress(x.scope),
        () =>
          reader.readSharedMedia({
            ...x.selector,
            assetId: x.sources[0].assetId,
          }),
      ];
      for (const operation of operations)
        await expect(x.asSupervisor(operation)).rejects.toThrow();
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });
  it('counts eligible captures before review and preserves scoped episode and assistance counts after review', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      const capture = (
        activityId: string,
        key: string,
        assistance: 'independent' | 'assisted',
        previousSubmissionId?: string,
      ) =>
        x.as(x.parent, () =>
          x.workbook.captureWorkbookWork({
            ...x.parent,
            activityId,
            requestKey: key,
            intakeItemId: key,
            assistance,
            previousSubmissionId,
            pages: [
              {
                name: 'synthetic.png',
                mimeType: 'image/png',
                data: Buffer.from(key),
              },
            ],
          }),
        );
      const practiceActivity = await x.as(x.parent, () =>
        x.workbook.resolveWorkbookActivity({
          ...x.parent,
          workbookKey: 'synthetic-share',
          title: 'Synthetic',
          pageKey: 'p2',
          pageLabel: '2',
        }),
      );
      const unreviewed = await capture(
        practiceActivity.id,
        'unreviewed-progress',
        'assisted',
      );
      const correction = await capture(
        practiceActivity.id,
        'correction-progress',
        'independent',
        unreviewed.submissionId,
      );
      const hiddenActivity = await x.as(x.parent, () =>
        x.workbook.resolveWorkbookActivity({
          ...x.parent,
          workbookKey: 'withheld-progress-book',
          title: 'Withheld book',
          pageKey: 'hidden',
          pageLabel: 'Hidden',
        }),
      );
      const hidden = await capture(
        hiddenActivity.id,
        'withheld-progress',
        'independent',
      );
      const selected = await x.asSupervisor(() =>
        x.reader.getSharedWork(x.selector),
      );
      if (!selected.courseId) throw new Error('Missing synthetic course');
      const policy = {
        ...sharingPolicy(),
        shareFeedback: false,
        courseIds: { mode: 'include' as const, values: [selected.courseId] },
      };
      await x.setPolicy(policy);
      const before = await x.asSupervisor(() =>
        x.reader.getSharedProgress(x.scope),
      );
      expect(before.counts).toEqual({
        attempts: 3,
        episodes: 2,
        assistance: { independent: 1, assisted: 1, unknown: 1 },
      });
      expect(before.concepts).toEqual([]);
      const request = {
        ...x.parent,
        activityId: practiceActivity.id,
        submissionId: unreviewed.submissionId,
      };
      const sources = await x.as(x.parent, () =>
        x.workbook.getWorkbookSourceAnchors(request),
      );
      const assessment = structuredClone(x.revision.assessment);
      assessment.provenance.inputHash = sources[0].sha256;
      assessment.provenance.analysisId = 'progress-unreviewed';
      assessment.questions[0].anchors = [
        { ...sources[0], page: 1, rect: [0, 0, 1, 1] },
      ];
      const proposal = await x.as(x.parent, () =>
        x.workbook.recordWorkbookAnalysis({
          ...request,
          requestKey: 'progress-ai',
          assessment,
        }),
      );
      await x.as(x.parent, () =>
        x.workbook.reviewWorkbookAssessment({
          ...request,
          requestKey: 'progress-guardian',
          revisionId: proposal.id,
          expectedHeadId: null,
        }),
      );
      const after = await x.asSupervisor(() =>
        x.reader.getSharedProgress(x.scope),
      );
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).not.toMatch(
        /q1|incorrect|Withheld|math.addition/,
      );
      const listed = await x.asSupervisor(() =>
        x.reader.listSharedWork(x.scope),
      );
      expect(listed.works.map((w) => w.attemptId)).toEqual(
        expect.arrayContaining([x.attempt.id, unreviewed.id, correction.id]),
      );
      expect(listed.works.map((w) => w.attemptId)).not.toContain(hidden.id);
      await x.setPolicy({ ...policy, shareFeedback: true });
      const descriptive = await x.asSupervisor(() =>
        x.reader.getSharedProgress(x.scope),
      );
      expect(descriptive.counts).toEqual(before.counts);
      expect(
        descriptive.concepts
          .flatMap((c) => c.observations)
          .map((o) => o.submissionId),
      ).not.toContain(correction.submissionId);
      expect(JSON.stringify(descriptive)).not.toContain(hidden.submissionId);
      await x.setPolicy({ ...policy, parentReviewedOnly: true });
      expect(
        (await x.asSupervisor(() => x.reader.getSharedProgress(x.scope))).counts
          .attempts,
      ).toBe(2);
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });
  it('never promotes real cover or reference receipts into shared original work', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      const photos = new WorkbookPhotoService(
        handle.db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === x.guardianType.id,
        () => true,
        { storage: x.storage },
      );
      for (const kind of ['cover', 'reference'] as const) {
        const photo = await x.as(x.parent, () =>
          photos.retainWorkbookPhotoIntake({
            ...x.parent,
            itemId: `share-${kind}`,
            pages: [
              {
                name: `${kind}.png`,
                mimeType: 'image/png',
                data: Buffer.from(`synthetic ${kind}`),
              },
            ],
          }),
        );
        const request = { ...x.parent, intakeId: photo.id };
        const resolved = await x.as(x.parent, () =>
          photos.resolveWorkbookPhotoIntake({
            ...request,
            requestKey: `classify-${kind}`,
            identification: {
              kind,
              workbook: {
                workbookKey: `context-${kind}`,
                title: `Synthetic ${kind}`,
              },
              workState: 'unknown',
            },
          }),
        );
        expect(resolved.activity).toBeNull();
        expect(resolved.submissionId).toBeNull();
        await expect(
          x.as(x.parent, () =>
            photos.captureWorkbookPhotoIntake({
              ...request,
              requestKey: `capture-${kind}`,
              completedWork: true,
            }),
          ),
        ).rejects.toThrow('no captured-work classification');
        await expect(
          x.asSupervisor(() =>
            x.reader.readSharedMedia({
              ...x.selector,
              assetId: photo.originals[0].assetId,
            }),
          ),
        ).rejects.toThrow();
      }
      expect(
        (
          await x.asSupervisor(() => x.reader.listSharedWork(x.scope))
        ).works.map((w) => w.attemptId),
      ).toEqual([x.attempt.id]);
      expect(
        (await x.asSupervisor(() => x.reader.getSharedProgress(x.scope))).counts
          .attempts,
      ).toBe(1);
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });
  it('denies foreign submission, answer-key and public assets through retained-source and private ownership gates', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      const otherActivity = await x.as(x.parent, () =>
        x.workbook.resolveWorkbookActivity({
          ...x.parent,
          workbookKey: 'synthetic-share',
          title: 'Synthetic',
          pageKey: 'p-other',
          pageLabel: 'Other',
        }),
      );
      const other = await x.as(x.parent, () =>
        x.workbook.captureWorkbookWork({
          ...x.parent,
          activityId: otherActivity.id,
          requestKey: 'other-private-submission',
          intakeItemId: 'other-private-submission',
          pages: [
            {
              name: 'other.png',
              mimeType: 'image/png',
              data: Buffer.from('other synthetic child submission'),
            },
          ],
        }),
      );
      const [foreign] = await x.as(x.parent, () =>
        x.workbook.getWorkbookSourceAnchors({
          ...x.parent,
          activityId: otherActivity.id,
          submissionId: other.submissionId,
        }),
      );
      await expect(
        x.asSupervisor(() =>
          x.reader.readSharedMedia({ ...x.selector, assetId: foreign.assetId }),
        ),
      ).rejects.toThrow();
      const runtime = await createAssetRuntime({
        db: handle.db,
        storage: x.storage,
      });
      const keyId = randomUUID();
      const privateScope = {
        tenantId: x.parent.tenantId,
        actorUserId: x.parent.actorUserId,
        ownerProfileId: String(x.alice.profile.id),
        assetIds: [keyId],
      };
      await x.as(x.parent, () =>
        withPrivateAssetAccess(privateScope, async () => {
          const key = await runtime.collection.create({
            id: keyId,
            tenantId: x.parent.tenantId,
            ownerProfileId: privateScope.ownerProfileId,
            accessMode: 'private',
            name: 'Synthetic private answer key',
            mimeType: 'image/png',
            typeSlug: 'education-page',
            statusSlug: 'active',
          });
          const options = { mimeType: 'image/png', typeSlug: 'education-page' };
          key.sourceUri = await runtime.store.planFile(key, options);
          await key.save();
          await runtime.store.preserveFile(
            key,
            Buffer.from('synthetic private answer key'),
            options,
          );
          await (await LessonAssetCollection.create({ db: handle.db })).create({
            tenantId: x.parent.tenantId,
            lessonId: String(x.lesson.id),
            assetId: keyId,
            relationship: 'answer-key',
          });
          await (
            await SubmissionAssetCollection.create({ db: handle.db })
          ).create({
            tenantId: x.parent.tenantId,
            submissionId: other.submissionId,
            assetId: keyId,
            relationship: 'attachment',
          });
        }),
      );
      for (const selector of [
        x.selector,
        { ...x.selector, activityId: otherActivity.id, attemptId: other.id },
      ])
        await expect(
          x.asSupervisor(() =>
            x.reader.readSharedMedia({ ...selector, assetId: keyId }),
          ),
        ).rejects.toThrow();
      const publicAsset = await x.as(x.parent, async () => {
        const asset = await runtime.collection.create({
          tenantId: x.parent.tenantId,
          ownerProfileId: privateScope.ownerProfileId,
          name: `Synthetic public ${randomUUID()}`,
          accessMode: 'public',
          mimeType: 'image/png',
          typeSlug: 'education-page',
          statusSlug: 'active',
        });
        asset.sourceUri = await runtime.store.storeFile(
          asset,
          Buffer.from('synthetic public source'),
          { mimeType: 'image/png', typeSlug: 'education-page' },
        );
        await asset.save();
        await (
          await SubmissionAssetCollection.create({ db: handle.db })
        ).create({
          tenantId: x.parent.tenantId,
          submissionId: x.attempt.submissionId,
          assetId: String(asset.id),
          relationship: 'attachment',
        });
        return asset;
      });
      await expect(
        x.asSupervisor(() =>
          x.reader.readSharedMedia({
            ...x.selector,
            assetId: String(publicAsset.id),
          }),
        ),
      ).rejects.toThrow();
      await x.as(x.parent, () =>
        withPrivateAssetAccess(
          { ...privateScope, assetIds: [x.sources[0].assetId] },
          async () => {
            const original = await runtime.collection.get(
              x.sources[0].assetId,
              { cache: false },
            );
            if (!original) throw new Error('Missing private captured source');
            original.accessMode = 'public';
            await expect(original.save()).rejects.toThrow();
            expect(
              await handle.db.get('assets', {
                id: x.sources[0].assetId,
                tenant_id: x.parent.tenantId,
                access_mode: 'private',
              }),
            ).toBeTruthy();
          },
        ),
      );
      expect(
        (
          await x.asSupervisor(() =>
            x.reader.readSharedMedia({
              ...x.selector,
              assetId: x.sources[0].assetId,
            }),
          )
        ).data.toString(),
      ).toBe('synthetic completed child work');
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });
  it('uses one executor and denies a final authority check or a tampered retained source', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      x.rejectAtCall(5);
      await expect(
        x.asSupervisor(() => x.reader.getSharedWork(x.selector)),
      ).rejects.toThrow();
      expect(x.executors).toHaveLength(5);
      expect(new Set(x.executors).size).toBe(1);
      x.rejectAtCall(Infinity);
      const sources = x.sources.map((source) => ({
        ...source,
        sha256: '0'.repeat(64),
      }));
      await handle.db.query(
        'UPDATE workbook_attempts SET source_hashes=? WHERE id=? AND tenant_id=?',
        [JSON.stringify(sources), x.attempt.id, x.parent.tenantId],
      );
      await expect(
        x.asSupervisor(() =>
          x.reader.readSharedMedia({
            ...x.selector,
            assetId: x.sources[0].assetId,
          }),
        ),
      ).rejects.toThrow();
      await expect(
        x.asSupervisor(() =>
          x.reader.getSharedWork({
            ...x.selector,
            learnerId: String(x.sibling.id),
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });
  it('retains opaque comment binding without feedback across a newer guardian revision', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      await x.setPolicy({ ...sharingPolicy(), shareFeedback: false });
      const shown = await x.asSupervisor(() =>
        x.reader.getSharedWork(x.selector),
      );
      expect(shown.revisionId).toBeNull();
      expect(shown.commentRevisionId).toBe(x.revision.id);
      expect(shown).not.toHaveProperty('assessment');
      const request = {
        ...x.parent,
        activityId: x.activity.id,
        submissionId: x.attempt.submissionId,
      };
      const assessment = structuredClone(x.revision.assessment);
      assessment.feedback = 'New guardian correction';
      assessment.questions[0].answer = '2';
      assessment.questions[0].result = 'correct';
      assessment.questions[0].points = 1;
      const proposal = await x.as(x.parent, () =>
        x.workbook.recordWorkbookAnalysis({
          ...request,
          requestKey: 'opaque-binding-ai',
          assessment,
        }),
      );
      const next = await x.as(x.parent, () =>
        x.workbook.reviewWorkbookAssessment({
          ...request,
          revisionId: proposal.id,
          expectedHeadId: x.revision.id,
          requestKey: 'opaque-binding-review',
          assessment,
        }),
      );
      expect(
        (await x.asSupervisor(() => x.reader.getSharedWork(x.selector)))
          .commentRevisionId,
      ).toBe(next.id);
      const comments = new GroupSharingCommentService(
        handle.db,
        (request) => request.actorUserId === x.parent.actorUserId,
      );
      const comment = await x.asSupervisor(() =>
        comments.addRevisionComment({
          ...x.selector,
          revisionId: shown.commentRevisionId as string,
          body: 'Comment on the original shared revision',
        }),
      );
      expect(comment.revisionId).toBe(x.revision.id);
      expect(comment).not.toHaveProperty('assessment');
      await expect(
        x.asSupervisor(() =>
          x.reader.getSharedRevision({
            ...x.selector,
            revisionId: x.revision.id,
          }),
        ),
      ).rejects.toThrow();
      await x.setPolicy({ ...sharingPolicy(), parentReviewedOnly: true });
      await expect(
        x.asSupervisor(() =>
          x.reader.getSharedRevision({
            ...x.selector,
            revisionId: proposal.id,
          }),
        ),
      ).rejects.toThrow();
      expect(
        (
          await x.asSupervisor(() =>
            x.reader.getSharedRevision({ ...x.selector, revisionId: next.id }),
          )
        ).revisionId,
      ).toBe(next.id);
      expect(
        (
          await x.asSupervisor(() =>
            x.reader.getSharedWork({ ...x.selector, revisionId: proposal.id }),
          )
        ).attemptId,
      ).toBe(x.attempt.id);
      expect(
        (
          await x.asSupervisor(() =>
            x.reader.readSharedMedia({
              ...x.selector,
              revisionId: proposal.id,
              assetId: x.sources[0].assetId,
            }),
          )
        ).data.length,
      ).toBeGreaterThan(0);
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });
  it('projects exact immutable work and media then denies reused identifiers after consent narrowing', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      expect(
        (
          await x.asSupervisor(() => x.reader.listSharedWork(x.scope))
        ).works.map((w) => w.attemptId),
      ).toEqual([x.attempt.id]);
      expect(
        (
          await x.asSupervisor(() =>
            x.reader.readSharedMedia({
              ...x.selector,
              assetId: x.sources[0].assetId,
            }),
          )
        ).data.toString(),
      ).toBe('synthetic completed child work');
      await expect(
        x.asSupervisor(() =>
          x.reader.getSharedRevision({ ...x.selector, revisionId: 'foreign' }),
        ),
      ).rejects.toThrow();
      await x.setPolicy({
        ...sharingPolicy(),
        shareWork: false,
        shareMedia: false,
      });
      await expect(
        x.asSupervisor(() => x.reader.getSharedWork(x.selector)),
      ).rejects.toThrow();
      await expect(
        x.asSupervisor(() =>
          x.reader.readSharedMedia({
            ...x.selector,
            assetId: x.sources[0].assetId,
          }),
        ),
      ).rejects.toThrow();
      expect(
        (await x.asSupervisor(() => x.reader.getSharedRevision(x.selector)))
          .revisionId,
      ).toBe(x.revision.id);
      x.deny();
      await expect(
        x.asSupervisor(() => x.reader.getSharedRevision(x.selector)),
      ).rejects.toThrow();
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });
  it('uses identical preview gates and withholds single-attempt outcomes from progress without feedback', async () => {
    const handle = await make();
    let f: Awaited<ReturnType<typeof sharingReadFixture>> | undefined;
    try {
      f = await sharingReadFixture(handle.db);
      const x = f;
      const policy = { ...sharingPolicy(), shareFeedback: false };
      await x.setPolicy(policy);
      const progress = await x.asSupervisor(() =>
        x.reader.getSharedProgress(x.scope),
      );
      expect(progress.concepts).toEqual([]);
      expect(progress.counts).toEqual({
        attempts: 1,
        episodes: 1,
        assistance: { independent: 1, assisted: 0, unknown: 0 },
      });
      expect(JSON.stringify(progress)).not.toMatch(
        /incorrect|Withheld|math.addition|q1|score|points/,
      );
      expect(
        (await x.asSupervisor(() => x.reader.getSharedWork(x.selector)))
          .revisionId,
      ).toBeNull();
      await expect(
        x.asSupervisor(() => x.reader.getSharedRevision(x.selector)),
      ).rejects.toThrow();
      const preview = await x.as(x.parent, () =>
        x.reader.previewSharing({
          ...x.scope,
          policy: {
            ...policy,
            subjects: { mode: 'include', values: ['missing-subject'] },
          },
        }),
      );
      expect(preview.works[0].decision.eligible).toBe(false);
      await x.setPolicy({
        ...policy,
        subjects: { mode: 'include', values: ['missing-subject'] },
      });
      expect(
        (await x.asSupervisor(() => x.reader.listSharedWork(x.scope))).works,
      ).toEqual([]);
      expect(
        (await x.asSupervisor(() => x.reader.getSharedProgress(x.scope))).counts
          .attempts,
      ).toBe(0);
    } finally {
      await f?.cleanup();
      await handle.cleanup();
    }
  });
}
