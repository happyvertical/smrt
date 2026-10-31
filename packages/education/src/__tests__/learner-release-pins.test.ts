import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LessonProgressCollection } from '../collections.js';
import { resolveEnrollmentLessons } from '../course-release-scope.js';
import {
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringActor,
  CourseAuthoringService,
  type CourseDraftInput,
  LearnerAuthorizationError,
  LearnerPlanService,
  SubmissionService,
} from '../index.js';
import { learnerFixture } from './learner-workflows.js';
import { submissionClasses } from './submission-workflows.js';

/*
 * Behavior-to-test matrix (learner projections consume release pins):
 *  unpinned enrollment unchanged ............................ 'unpinned'
 *  pinned initial release projections + assertions .......... 'pinned initial'
 *  explicit upgrade: unstarted follow, started stays ........ 'explicit upgrade'
 *  automatic upgrade: same rule ............................. 'automatic upgrade'
 *  in-progress submissions stay valid on original rows ...... 'submissions'
 *  start on an upgraded lesson uses the new row ............. 'explicit upgrade'
 *  assertions reject lessons outside the effective set ...... 'pinned initial', 'explicit upgrade'
 *  plan reads reflect the effective set ..................... 'plan'
 *  cross-tenant isolation and pin ownership ................. 'isolation'
 *  every lesson listed once, progress never duplicated ...... 'explicit upgrade', 'automatic upgrade'
 */
const classes = [
  ...new Set([
    ...submissionClasses,
    'EnrollmentParentNote',
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
  ]),
];
const page = {
  name: 'page.png',
  mimeType: 'image/png' as const,
  data: Buffer.from('uploaded page'),
};

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
const storages: string[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
  for (const dir of storages.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes,
  });
  opened.push(db);
  const f = await learnerFixture(db);
  const guardianOnly = ({
    own,
    relationshipTypeId,
  }: {
    own: boolean;
    relationshipTypeId?: string;
  }) => own || relationshipTypeId === f.guardianType.id;
  const storage = await mkdtemp(join(tmpdir(), 'education-pins-'));
  storages.push(storage);
  const submissions = new SubmissionService(db, guardianOnly, () => true, {
    storage,
    signAsset: async (claim) => `https://school.test/${claim.assetId}`,
  });
  const plans = new LearnerPlanService(db, guardianOnly, () => true);
  const guardian: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: f.parent.actorUserId,
  };
  const authoring = new CourseAuthoringService(
    db,
    (call) =>
      call.actorUserId === guardian.actorUserId &&
      COURSE_AUTHORING_ACTIONS.includes(call.action),
    { releaseReviewGate: () => ({ current: true, reviewId: 'review-1' }) },
  );
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  let counter = 0;
  const key = (label = 'k') => `${label}-${++counter}`;
  const sections = (
    ...titles: Array<[string, string]>
  ): CourseDraftInput['sections'] => [
    {
      sectionKey: 'unit-1',
      title: 'Unit 1',
      lessons: titles.map(([lessonKey, title]) => ({ lessonKey, title })),
    },
  ];
  const head = await as(guardian, () =>
    authoring.createCourse({
      ...guardian,
      requestKey: key('create'),
      title: 'Fractions',
      levelMin: 3,
      levelMax: 4,
    }),
  );
  let expected = head.headRevisionId;
  /** Saves and releases one revision of the course. */
  async function publish(...titles: Array<[string, string]>) {
    const saved = await as(guardian, () =>
      authoring.saveDraft({
        ...guardian,
        courseId: head.courseId,
        expectedHeadRevisionId: expected,
        requestKey: key('save'),
        draft: {
          title: 'Fractions',
          objectives: ['Add fractions'],
          levelMin: 3,
          levelMax: 4,
          sections: sections(...titles),
          provenance: 'supplied',
        },
      }),
    );
    expected = saved.headRevisionId;
    return as(guardian, () =>
      authoring.release({
        ...guardian,
        courseId: head.courseId,
        revisionId: saved.revisionId,
        requestKey: key('rel'),
      }),
    );
  }
  const rel1 = await publish(['a', 'A'], ['b', 'B'], ['c', 'C']);
  const enrollment = await f.as(f.parent, () =>
    f.service.enroll({
      ...f.parent,
      curriculumId: String(f.curriculum.id),
      courseId: rel1.releaseCourseId,
    }),
  );
  const enrollmentId = String(enrollment.id);
  const pin = () =>
    as(guardian, () =>
      authoring.pinEnrollment({
        ...guardian,
        enrollmentId,
        releaseId: rel1.id,
        requestKey: key('pin'),
      }),
    );
  const upgrade = (releaseId: string) =>
    as(guardian, () =>
      authoring.upgradeEnrollment({
        ...guardian,
        enrollmentId,
        releaseId,
        requestKey: key('up'),
      }),
    );
  const autoUpgrade = () =>
    as(guardian, () =>
      authoring.setAutoUpgrade({
        ...guardian,
        courseId: head.courseId,
        enrollmentId,
        enabled: true,
        requestKey: key('auto'),
      }),
    );
  const ids = (release: {
    lessons: Array<{ lessonKey: string; lessonId: string }>;
  }) =>
    Object.fromEntries(release.lessons.map((l) => [l.lessonKey, l.lessonId]));
  const lessonRequest = (lessonId: string) => ({
    ...f.own,
    enrollmentId,
    lessonId,
  });
  const start = (lessonId: string) =>
    f.as(f.own, () => f.service.startLesson(lessonRequest(lessonId)));
  const assignment = () =>
    f.as(f.own, () => f.service.assignmentLessons({ ...f.own, enrollmentId }));
  const assignmentIds = async () =>
    (await assignment()).map((entry) => entry.lesson.id);
  const assertion = (lessonId: string) =>
    f.as(f.own, () =>
      submissions.assertLessonAssignment(lessonRequest(lessonId)),
    );
  const progressRows = () => db.list('lesson_progress', {});
  return {
    db,
    f,
    submissions,
    plans,
    authoring,
    guardian,
    as,
    key,
    publish,
    rel1,
    enrollmentId,
    pin,
    upgrade,
    autoUpgrade,
    ids,
    start,
    assignment,
    assignmentIds,
    assertion,
    lessonRequest,
    progressRows,
  };
}

describe('LearnerService release pins', () => {
  it('unpinned: enrollments on a plain course behave as before', async () => {
    const s = await setup();
    const { f } = s;
    const plain = String(f.enrollment.id);
    const rows = await f.as(f.own, () =>
      f.service.assignmentLessons({ ...f.own, enrollmentId: plain }),
    );
    expect(rows.map((r) => r.lesson.id).sort()).toEqual(
      [String(f.lesson.id), String(f.secondLesson.id)].sort(),
    );
    await f.as(f.own, () =>
      f.service.startLesson({
        ...f.own,
        enrollmentId: plain,
        lessonId: String(f.lesson.id),
      }),
    );
    await expect(
      f.as(f.own, () =>
        f.service.startLesson({
          ...f.own,
          enrollmentId: plain,
          lessonId: String(f.wrongLesson.id),
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      f.as(f.own, () =>
        s.submissions.assertLessonAssignment({
          ...f.own,
          enrollmentId: plain,
          lessonId: String(f.wrongLesson.id),
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    expect(
      await f.as(f.own, () =>
        resolveEnrollmentLessons(f.db, f.own.tenantId, plain),
      ),
    ).toBeNull();
  });

  it('pinned initial: projections use the release rows and reject others', async () => {
    const s = await setup();
    await s.pin();
    const r1 = s.ids(s.rel1);
    expect(await s.assignmentIds()).toEqual([r1.a, r1.b, r1.c]);
    const next = await s.f.as(s.f.own, () =>
      s.f.service.nextLessons({ ...s.f.own, enrollmentId: s.enrollmentId }),
    );
    expect(next.map((n) => n.lesson.id)).toEqual([r1.a]);
    await s.start(r1.a);
    const listed = await s.f.as(s.f.own, () =>
      s.f.service.listProgress({ ...s.f.own, enrollmentId: s.enrollmentId }),
    );
    expect(listed.map((p) => p.lessonId)).toEqual([r1.a]);
    await s.assertion(r1.b);
    // A lesson from another course, or a later release, is outside the set.
    await expect(
      s.assertion(String(s.f.wrongLesson.id)),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    const rel2 = await s.publish(['a', 'A'], ['b', 'B'], ['c', 'C']);
    await expect(s.assertion(s.ids(rel2).b)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    await expect(s.start(s.ids(rel2).b)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
  });

  it('explicit upgrade: unstarted lessons follow, started stay on original rows', async () => {
    const s = await setup();
    await s.pin();
    const r1 = s.ids(s.rel1);
    const started = await s.start(r1.a);
    const rel2 = await s.publish(
      ['c', 'C2'],
      ['a', 'A2'],
      ['b', 'B2'],
      ['d', 'D2'],
    );
    const r2 = s.ids(rel2);
    await s.upgrade(rel2.id);
    // Release 2's order wins; the started lesson keeps its release 1 row.
    expect(await s.assignmentIds()).toEqual([r2.c, r1.a, r2.b, r2.d]);
    const rows = await s.assignment();
    expect(rows.find((r) => r.lesson.id === r1.a)?.progress?.id).toBe(
      started.id,
    );
    expect(rows.filter((r) => r.progress)).toHaveLength(1);
    expect(rows.find((r) => r.lesson.id === r2.c)?.lesson.title).toBe('C2');
    // Progress is untouched: same single row, same lesson id, nothing duplicated.
    const before = await s.progressRows();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ id: started.id, lesson_id: r1.a });
    const listed = await s.f.as(s.f.own, () =>
      s.f.service.listProgress({ ...s.f.own, enrollmentId: s.enrollmentId }),
    );
    expect(listed.map((p) => p.lessonId)).toEqual([r1.a]);
    // Assertions accept the effective set and reject everything else.
    await s.assertion(r1.a);
    await s.assertion(r2.b);
    await s.assertion(r2.d);
    await expect(s.assertion(r2.a)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    await expect(s.assertion(r1.b)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    // Starting an unstarted lesson creates progress on the new release's row.
    const second = await s.start(r2.b);
    expect(second.lessonId).toBe(r2.b);
    expect(await s.start(r1.a)).toMatchObject({ id: started.id });
    await expect(s.start(r2.a)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    await expect(s.start(r1.b)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    const after = await s.progressRows();
    expect(after.map((r) => r.lesson_id).sort()).toEqual([r1.a, r2.b].sort());
    // The first lesson is unfinished, so it is still the next lesson shown.
    const next = await s.f.as(s.f.own, () =>
      s.f.service.nextLessons({ ...s.f.own, enrollmentId: s.enrollmentId }),
    );
    expect(next.map((n) => n.lesson.id)).toEqual([r2.c]);
  });

  it('automatic upgrade: the same effective set after an opted-in release', async () => {
    const s = await setup();
    await s.pin();
    await s.autoUpgrade();
    const r1 = s.ids(s.rel1);
    await s.start(r1.b);
    const rel2 = await s.publish(['a', 'A2'], ['b', 'B2'], ['c', 'C2']);
    const r2 = s.ids(rel2);
    const effective = await s.as(s.guardian, () =>
      s.authoring.getEnrollmentRelease({
        ...s.guardian,
        enrollmentId: s.enrollmentId,
      }),
    );
    expect(effective.pin.kind).toBe('auto');
    expect(await s.assignmentIds()).toEqual([r2.a, r1.b, r2.c]);
    // The authoring view and the learner view agree on the set.
    expect(effective.lessons.map((l) => l.lessonId).sort()).toEqual(
      [r2.a, r1.b, r2.c].sort(),
    );
    await s.assertion(r1.b);
    await expect(s.assertion(r2.b)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    expect(await s.progressRows()).toHaveLength(1);
    // A later release layers on: lessons started on release 2 stay there.
    await s.start(r2.a);
    const rel3 = await s.publish(['a', 'A3'], ['b', 'B3'], ['c', 'C3']);
    const r3 = s.ids(rel3);
    expect(await s.assignmentIds()).toEqual([r2.a, r1.b, r3.c]);
    expect(await s.progressRows()).toHaveLength(2);
  });

  it('submissions: in-progress work stays valid on its original row', async () => {
    const s = await setup();
    await s.pin();
    const r1 = s.ids(s.rel1);
    const send = (lessonId: string, requestKey: string) =>
      s.f.as(s.f.own, () =>
        s.submissions.captureSubmission({
          ...s.lessonRequest(lessonId),
          requestKey,
          pages: [page],
        }),
      );
    const first = await send(r1.a, 'one');
    const rel2 = await s.publish(['a', 'A2'], ['b', 'B2'], ['c', 'C2']);
    const r2 = s.ids(rel2);
    await s.upgrade(rel2.id);
    const latest = await s.f.as(s.f.own, () =>
      s.submissions.getLatestLessonSubmission(s.lessonRequest(r1.a)),
    );
    expect(latest?.id).toBe(first.id);
    // The original row still passes the assignment check; only the capture
    // state (already submitted) refuses another page set.
    await expect(send(r1.a, 'two')).rejects.toThrow(
      'not accepting another capture',
    );
    await expect(send(r2.a, 'three')).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    const fresh = await send(r2.b, 'four');
    expect(fresh.progressId).not.toBe(first.progressId);
    expect((await s.progressRows()).map((r) => r.lesson_id).sort()).toEqual(
      [r1.a, r2.b].sort(),
    );
  });

  it('plan: reads reflect the effective lessons of the current release', async () => {
    const s = await setup();
    await s.pin();
    const r1 = s.ids(s.rel1);
    await s.start(r1.a);
    const rel2 = await s.publish(['a', 'A2'], ['b', 'B2'], ['d', 'D2']);
    const r2 = s.ids(rel2);
    await s.upgrade(rel2.id);
    const plan = await s.f.as(s.f.own, () =>
      s.plans.getEnrollmentPlan({ ...s.f.own, enrollmentId: s.enrollmentId }),
    );
    expect(plan.availability).toBe('available');
    expect(plan.course?.id).toBe(rel2.releaseCourseId);
    expect(plan.lessons.map((l) => l.lesson.id)).toEqual([r1.a, r2.b, r2.d]);
    expect(plan.lessons[0].progress?.lessonId).toBe(r1.a);
    expect(plan.lessons[1].progress).toBeNull();
  });

  it('isolation: other tenants and mismatched pins see nothing', async () => {
    const s = await setup();
    await s.pin();
    const { f } = s;
    const foreign = {
      tenantId: String(f.foreign.tenantId),
      actorUserId: String(f.stranger.user.id),
      learnerId: String(f.foreign.id),
    };
    expect(
      await f.as(foreign, () =>
        resolveEnrollmentLessons(f.db, foreign.tenantId, s.enrollmentId),
      ),
    ).toBeNull();
    await expect(
      f.as(foreign, () =>
        f.service.assignmentLessons({
          ...foreign,
          enrollmentId: s.enrollmentId,
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      f.as(foreign, () =>
        s.plans.getEnrollmentPlan({ ...foreign, enrollmentId: s.enrollmentId }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // A sibling cannot read or start the learner's pinned enrollment.
    const sibling = {
      ...f.own,
      actorUserId: String(f.bob.user.id),
      learnerId: String(f.sibling.id),
    };
    await expect(
      f.as(sibling, () =>
        f.service.assignmentLessons({
          ...sibling,
          enrollmentId: s.enrollmentId,
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // The model still refuses progress on a lesson outside every pinned course.
    await expect(
      f.as(f.own, async () =>
        (await LessonProgressCollection.create({ db: f.db })).create({
          tenantId: f.own.tenantId,
          learnerId: f.own.learnerId,
          enrollmentId: s.enrollmentId,
          lessonId: String(f.wrongLesson.id),
          status: 'in_progress',
        }),
      ),
    ).rejects.toThrow('Progress requires its enrollment learner');
    // A pin recorded for a different learner fails closed.
    await f.db.query(
      'UPDATE enrollment_release_pins SET learner_id = ? WHERE enrollment_id = ?',
      [String(f.sibling.id), s.enrollmentId],
    );
    await expect(s.assignment()).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
  });
});
