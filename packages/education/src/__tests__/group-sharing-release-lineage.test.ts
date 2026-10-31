import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { SessionCollection } from '@happyvertical/smrt-users';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnrollmentReleasePinCollection } from '../course-authoring-models.js';
import { CourseAuthoringService } from '../course-authoring-service.js';
import { GroupSharingReader } from '../group-sharing-reader.js';
import {
  groupSharingReadClasses,
  sharingReadFixture,
} from './group-sharing-read-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

describe('group sharing and release pin lineage', () => {
  it('keeps work private once an enrollment lineage includes a personal-use release', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: groupSharingReadClasses,
    });
    const x = await sharingReadFixture(db);
    try {
      const authoring = new CourseAuthoringService(db, () => true, {
        releaseReviewGate: () => ({ current: true, reviewId: 'review' }),
      });
      const actor = {
        tenantId: x.parent.tenantId,
        actorUserId: x.parent.actorUserId,
      };
      let n = 0;
      const key = () => `lineage-${++n}`;
      const lessonsOf = (kind: 'own-work' | 'personal-use-copy') => [
        {
          sectionKey: 'u',
          title: 'U',
          lessons: [{ lessonKey: 'a', title: 'A', licenseKind: kind }],
        },
      ];
      const head = await x.as(x.parent, () =>
        authoring.createCourse({
          ...actor,
          requestKey: key(),
          title: 'Lineage',
          levelMin: 3,
          levelMax: 4,
        }),
      );
      const save = (expected: string, kind: 'own-work' | 'personal-use-copy') =>
        x.as(x.parent, () =>
          authoring.saveDraft({
            ...actor,
            courseId: head.courseId,
            expectedHeadRevisionId: expected,
            requestKey: key(),
            draft: {
              title: 'Lineage',
              objectives: ['o'],
              levelMin: 3,
              levelMax: 4,
              sections: lessonsOf(kind),
              provenance: 'supplied',
            },
          }),
        );
      const release = (revisionId: string) =>
        x.as(x.parent, () =>
          authoring.release({
            ...actor,
            courseId: head.courseId,
            revisionId,
            requestKey: key(),
          }),
        );
      const one = await save(head.headRevisionId, 'own-work');
      const rel1 = await release(one.revisionId);
      const two = await save(one.headRevisionId, 'personal-use-copy');
      const rel2 = await release(two.revisionId);

      const session = await (
        await SessionCollection.create({ db })
      ).createSession({ userId: x.parent.actorUserId });
      const optionsReader = new GroupSharingReader(
        db,
        (c) => c.actorUserId === x.parent.actorUserId,
      );
      const optionRequest = {
        actorUserId: x.parent.actorUserId,
        sessionId: String(session.id),
        familyTenantId: x.parent.tenantId,
        learnerId: x.parent.learnerId,
      };
      const lessonEnrollment = await x.as(x.parent, () =>
        x.service.enroll({
          ...x.parent,
          curriculumId: String(x.curriculum.id),
          courseId: rel1.releaseCourseId,
        }),
      );
      const offered = async () =>
        (
          await x.as(x.parent, () =>
            optionsReader.getSharingPolicyOptions(optionRequest),
          )
        ).courses.map((c) => c.id);

      // Unpinned enrollments behave exactly as before.
      expect(await offered()).toContain(rel1.releaseCourseId);
      const before = await x.asSupervisor(() =>
        x.reader.listSharedWork(x.scope),
      );
      expect(before.works.map((w) => w.attemptId)).toEqual([x.attempt.id]);

      // Pin on the own-work release, then move to the personal-use release.
      await x.as(x.parent, () =>
        authoring.pinEnrollment({
          ...actor,
          enrollmentId: String(lessonEnrollment.id),
          releaseId: rel1.id,
          requestKey: key(),
          policyBasis: 'guardians-only',
        }),
      );
      expect(await offered()).toContain(rel1.releaseCourseId);
      await x.as(x.parent, () =>
        authoring.upgradeEnrollment({
          ...actor,
          enrollmentId: String(lessonEnrollment.id),
          releaseId: rel2.id,
          requestKey: key(),
          policyBasis: 'guardians-only',
        }),
      );
      // Any personal-use release in the lineage removes the course from the options.
      expect(await offered()).not.toContain(rel1.releaseCourseId);

      // The workbook enrollment's own lineage now includes the personal-use release.
      await x.as(x.parent, async () =>
        (await EnrollmentReleasePinCollection.create({ db })).create({
          _insertOnly: true,
          tenantId: x.parent.tenantId,
          enrollmentId: String(x.activity.enrollmentId),
          learnerId: String(x.learner.id),
          courseId: head.courseId,
          releaseId: rel2.id,
          kind: 'initial',
          sequence: 1,
          actorUserId: x.parent.actorUserId,
          policyBasis: 'guardians-only',
          requestKey: key(),
          recordedAt: new Date(),
        }),
      );
      const after = await x.asSupervisor(() =>
        x.reader.listSharedWork(x.scope),
      );
      expect(after.works.map((w) => w.attemptId)).not.toContain(x.attempt.id);
      const preview = await x.as(x.parent, () =>
        x.reader.previewSharing(x.scope),
      );
      expect(
        preview.works.find((w) => w.attemptId === x.attempt.id)?.decision,
      ).toMatchObject({ eligible: false, reasons: ['course-private'] });
    } finally {
      await x.cleanup();
      await db.close?.();
    }
  });
});
