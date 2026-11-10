import { ProfileRelationshipCollection } from '@happyvertical/smrt-profiles';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { type CourseAuthoringActor, CourseAuthoringService } from '../index.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

export const autoUpgradeClasses = [
  ...learnerClasses,
  'AuthoredCourse',
  'Reading',
  'Video',
  'Worksheet',
  'Exercise',
  'CourseRevision',
  'LessonRevision',
  'CourseDraftHead',
  'CourseRelease',
  'ReleasedLesson',
  'CourseArchiveDecision',
  'CourseDiscardTombstone',
  'EnrollmentReleasePin',
  'CourseUpgradeChoice',
  'EnrollmentAutoUpgradeSkip',
];

/**
 * A host authorizer whose own statement on the supplied executor fails must be
 * isolated (SAVEPOINT): the release, the other enrollment's move and the skip
 * record all still commit, including on PostgreSQL.
 */
export async function assertFailingAutoUpgradeAuthorizerIsIsolated(
  db: DatabaseInterface,
) {
  const f = await learnerFixture(db);
  const tenantId = f.own.tenantId;
  const guardian: CourseAuthoringActor = {
    tenantId,
    actorUserId: f.parent.actorUserId,
  };
  let failFor = '';
  const service = new CourseAuthoringService(
    db,
    async (call) => {
      if (call.operation === 'auto-upgrade' && call.enrollmentId === failFor)
        await call.executor.query('SELECT 1 FROM table_that_does_not_exist');
      return true;
    },
    { releaseReviewGate: () => ({ current: true, reviewId: 'review' }) },
  );
  let n = 0;
  const key = () => `iso-${++n}`;
  const as = <T>(fn: () => Promise<T>) =>
    withTenant({ tenantId, userId: guardian.actorUserId }, fn);
  const head = await as(() =>
    service.createCourse({
      ...guardian,
      requestKey: key(),
      title: 'Isolation',
      levelMin: 3,
      levelMax: 4,
    }),
  );
  const save = (expected: string, title: string) =>
    as(() =>
      service.saveDraft({
        ...guardian,
        courseId: head.courseId,
        expectedHeadRevisionId: expected,
        requestKey: key(),
        draft: {
          title: 'Isolation',
          objectives: ['o'],
          levelMin: 3,
          levelMax: 4,
          sections: [
            {
              sectionKey: 'u',
              title: 'U',
              lessons: [{ lessonKey: 'a', title }],
            },
          ],
          provenance: 'supplied',
        },
      }),
    );
  const release = (revisionId: string) =>
    as(() =>
      service.release({
        ...guardian,
        courseId: head.courseId,
        revisionId,
        requestKey: key(),
      }),
    );
  const one = await save(head.headRevisionId, 'A');
  const rel1 = await release(one.revisionId);

  const relB = await withTenant({ tenantId }, async () =>
    (await ProfileRelationshipCollection.create({ db })).create({
      tenantId,
      fromProfileId: String(f.guardian.profile.id),
      toProfileId: String(f.bob.profile.id),
      typeId: String(f.guardianType.id),
    }),
  );
  const bobReq = {
    ...f.parent,
    learnerId: String(f.sibling.id),
    guardianRelationshipId: String(relB.id),
  };
  const enroll = async (request: typeof bobReq | typeof f.parent) => {
    const curriculum =
      request === f.parent
        ? f.curriculum
        : await f.as(request, () =>
            f.service.createCurriculum({ ...request, title: 'B' }),
          );
    return String(
      (
        await f.as(request, () =>
          f.service.enroll({
            ...request,
            curriculumId: String(curriculum.id),
            courseId: rel1.releaseCourseId,
          }),
        )
      ).id,
    );
  };
  const a = await enroll(f.parent);
  const b = await enroll(bobReq);
  for (const enrollmentId of [a, b]) {
    await as(() =>
      service.pinEnrollment({
        ...guardian,
        enrollmentId,
        releaseId: rel1.id,
        requestKey: key(),
        policyBasis: 'guardians-only',
      }),
    );
    await as(() =>
      service.setAutoUpgrade({
        ...guardian,
        courseId: head.courseId,
        enrollmentId,
        enabled: true,
        requestKey: key(),
        policyBasis: 'guardians-only',
      }),
    );
  }
  failFor = a;
  const two = await save(one.headRevisionId, 'A2');
  const rel2 = await release(two.revisionId);
  const pinOf = async (enrollmentId: string) =>
    (
      await as(() =>
        service.getEnrollmentRelease({ ...guardian, enrollmentId }),
      )
    ).pin;
  expect((await pinOf(a)).releaseId).toBe(rel1.id);
  expect((await pinOf(b)).releaseId).toBe(rel2.id);
  const skips = await db.list('enrollment_auto_upgrade_skips', {});
  expect(skips).toHaveLength(1);
  expect(skips[0]).toMatchObject({
    enrollment_id: a,
    release_id: rel2.id,
    reason: 'not-authorized',
  });
}
