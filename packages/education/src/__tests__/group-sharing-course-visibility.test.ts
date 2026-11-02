import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { SessionCollection } from '@happyvertical/smrt-users';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CourseVisibility } from '../catalog.js';
import { EnrollmentReleasePinCollection } from '../course-authoring-models.js';
import { CourseAuthoringService } from '../course-authoring-service.js';
import { GroupSharingReader } from '../group-sharing-reader.js';
import {
  groupSharingReadClasses,
  sharingReadFixture,
} from './group-sharing-read-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

/**
 * Visibility only ever narrows what group sharing already authorizes: an
 * authored release recorded as `family` is never shared, while `groups`,
 * `public` and a never-recorded visibility leave the existing rules unchanged.
 */
describe('group sharing honours authored course visibility', () => {
  async function scenario(visibility: CourseVisibility | null) {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        ...groupSharingReadClasses,
        'CourseVisibilityChange',
        'CourseCoverChange',
      ],
    });
    const x = await sharingReadFixture(db);
    const authoring = new CourseAuthoringService(db, () => true, {
      releaseReviewGate: () => ({ current: true, reviewId: 'review' }),
    });
    const actor = {
      tenantId: x.parent.tenantId,
      actorUserId: x.parent.actorUserId,
    };
    let n = 0;
    const key = () => `vis-${++n}`;
    const head = await x.as(x.parent, () =>
      authoring.createCourse({
        ...actor,
        requestKey: key(),
        title: 'Shared',
        levelMin: 3,
        levelMax: 4,
      }),
    );
    const saved = await x.as(x.parent, () =>
      authoring.saveDraft({
        ...actor,
        courseId: head.courseId,
        expectedHeadRevisionId: head.headRevisionId,
        requestKey: key(),
        draft: {
          title: 'Shared',
          objectives: ['o'],
          levelMin: 3,
          levelMax: 4,
          sections: [
            {
              sectionKey: 'u',
              title: 'U',
              lessons: [{ lessonKey: 'a', title: 'A' }],
            },
          ],
          provenance: 'supplied',
        },
      }),
    );
    if (visibility)
      await x.as(x.parent, () =>
        authoring.setVisibility({
          ...actor,
          courseId: head.courseId,
          visibility,
          requestKey: key(),
        }),
      );
    const rel = await x.as(x.parent, () =>
      authoring.release({
        ...actor,
        courseId: head.courseId,
        revisionId: saved.revisionId,
        requestKey: key(),
      }),
    );
    const enrollment = await x.as(x.parent, () =>
      x.service.enroll({
        ...x.parent,
        curriculumId: String(x.curriculum.id),
        courseId: rel.releaseCourseId,
      }),
    );
    const session = await (
      await SessionCollection.create({ db })
    ).createSession({ userId: x.parent.actorUserId });
    const reader = new GroupSharingReader(
      db,
      (c) => c.actorUserId === x.parent.actorUserId,
    );
    const offered = async () =>
      (
        await x.as(x.parent, () =>
          reader.getSharingPolicyOptions({
            actorUserId: x.parent.actorUserId,
            sessionId: String(session.id),
            familyTenantId: x.parent.tenantId,
            learnerId: x.parent.learnerId,
          }),
        )
      ).courses.map((c) => c.id);
    const shared = async () => {
      // The workbook enrollment follows the released course through a pin.
      await x.as(x.parent, async () =>
        (await EnrollmentReleasePinCollection.create({ db })).create({
          _insertOnly: true,
          tenantId: x.parent.tenantId,
          enrollmentId: String(x.activity.enrollmentId),
          learnerId: String(x.learner.id),
          courseId: head.courseId,
          releaseId: rel.id,
          kind: 'initial',
          sequence: 1,
          actorUserId: x.parent.actorUserId,
          policyBasis: 'guardians-only',
          requestKey: key(),
          recordedAt: new Date(),
        }),
      );
      return (
        await x.asSupervisor(() => x.reader.listSharedWork(x.scope))
      ).works
        .map((w) => w.attemptId)
        .includes(x.attempt.id);
    };
    return { db, x, rel, enrollment, offered, shared };
  }

  it.each([
    ['family', false],
    ['groups', true],
    ['public', true],
    [null, true],
  ] as const)('visibility %s: group sharing available = %s', async (visibility, allowed) => {
    const s = await scenario(visibility);
    try {
      expect(await s.offered()).toEqual(
        allowed
          ? expect.arrayContaining([s.rel.releaseCourseId])
          : expect.not.arrayContaining([s.rel.releaseCourseId]),
      );
      expect(await s.shared()).toBe(allowed);
    } finally {
      await s.x.cleanup();
      await s.db.close?.();
    }
  });

  it('narrowing groups back to family removes sharing at once', async () => {
    const s = await scenario('groups');
    try {
      const authoring = new CourseAuthoringService(s.db, () => true);
      const actor = {
        tenantId: s.x.parent.tenantId,
        actorUserId: s.x.parent.actorUserId,
      };
      const courseId = (await s.db.get('course_releases', { id: s.rel.id }))
        ?.course_id as string;
      await s.x.as(s.x.parent, () =>
        authoring.setVisibility({
          ...actor,
          courseId,
          visibility: 'family',
          requestKey: 'narrow-1',
        }),
      );
      expect(await s.offered()).not.toContain(s.rel.releaseCourseId);
      expect(await s.shared()).toBe(false);
    } finally {
      await s.x.cleanup();
      await s.db.close?.();
    }
  });
});
