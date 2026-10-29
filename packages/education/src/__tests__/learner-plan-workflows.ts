import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import {
  EnrollmentCollection,
  LessonProgressCollection,
} from '../collections.js';
import { LearnerPlanService } from '../learner-plan-service.js';
import { LearnerAuthorizationError } from '../learner-service.js';
import { learnerFixture } from './learner-workflows.js';

export async function planFixture(db: DatabaseInterface) {
  const f = await learnerFixture(db);
  const service = new LearnerPlanService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
  );
  await f.as(f.parent, async () => {
    f.course.modality = 'printable';
    await f.course.save();
    f.lesson.sortOrder = 0;
    await f.lesson.save();
    f.secondLesson.sortOrder = 1;
    await f.secondLesson.save();
  });
  return { ...f, service };
}
type Fixture = Awaited<ReturnType<typeof planFixture>>;

export async function assertPlanProjection(f: Fixture) {
  await f.as(f.parent, async () => {
    f.course.sourceKey = 'unfiled-work';
    f.course.title = 'Ordinary course';
    f.course.summary = 'Safe summary';
    f.course.subject = 'math';
    await f.course.save();
  });
  const plan = await f.as(f.own, () => f.service.listPlan(f.own));
  expect(plan).toHaveLength(1);
  expect(plan[0].course).toMatchObject({
    id: f.course.id,
    title: 'Ordinary course',
    sourceKey: 'unfiled-work',
    summary: 'Safe summary',
    subject: 'math',
  });
  expect(plan[0].lessons.map((x) => x.lesson.id)).toEqual([
    f.lesson.id,
    f.secondLesson.id,
  ]);
  expect(plan[0].nextActionableLessonId).toBe(f.lesson.id);
  expect(plan[0].progressEvidence).toBeNull();
  expect(plan[0].awaitingReviewLessonIds).toEqual([]);
  expect(Object.keys(plan[0].course ?? {}).sort()).toEqual([
    'id',
    'modality',
    'sourceKey',
    'subject',
    'summary',
    'title',
  ]);
  expect(plan[0].lessons[0].lesson).not.toHaveProperty('workbookActivityId');
  const unavailable = new LearnerPlanService(
    f.db,
    () => true,
    () => false,
  );
  const denied = await f.as(f.parent, () =>
    unavailable.getEnrollmentPlan({
      ...f.parent,
      enrollmentId: f.enrollment.id,
    }),
  );
  expect(denied).toMatchObject({
    availability: 'unavailable',
    course: null,
    lessons: [],
    nextActionableLessonId: null,
    progressEvidence: null,
  });
  expect(await f.as(f.parent, () => unavailable.listPlan(f.parent))).toEqual([
    denied,
  ]);
  for (const request of [
    { ...f.own, learnerId: String(f.sibling.id) },
    { ...f.parent, guardianRelationshipId: undefined },
    { ...f.own, actorUserId: String(f.bob.user.id) },
  ])
    await expect(
      f.as(request, () => f.service.listPlan(request)),
    ).rejects.toThrow(LearnerAuthorizationError);
  expect(
    await f.as(
      {
        ...f.own,
        learnerId: String(f.sibling.id),
        actorUserId: String(f.bob.user.id),
      },
      () =>
        f.service.listPlan({
          ...f.own,
          learnerId: String(f.sibling.id),
          actorUserId: String(f.bob.user.id),
        }),
    ),
  ).toEqual([]);
}

export async function assertPlanProgress(f: Fixture) {
  const input = { ...f.own, enrollmentId: f.enrollment.id };
  for (const lesson of [f.lesson, f.secondLesson])
    await f.as(f.own, () =>
      f.service.startLesson({ ...input, lessonId: String(lesson.id) }),
    );
  const rows = await LessonProgressCollection.create({ db: f.db });
  await f.as(f.parent, async () => {
    for (const [lesson, status] of [
      [f.lesson, 'submitted'],
      [f.secondLesson, 'needs_review'],
    ] as const) {
      const row = await rows.get({
        tenantId: f.own.tenantId,
        enrollmentId: f.enrollment.id,
        lessonId: String(lesson.id),
      });
      if (!row) throw Error('missing progress');
      row.status = status;
      row.startedAt = new Date('2020-01-01T00:00:00Z');
      await row.save();
    }
  });
  let plan = await f.as(f.own, () => f.service.getEnrollmentPlan(input));
  expect(plan.nextActionableLessonId).toBeNull();
  expect(plan.awaitingReviewLessonIds).toEqual([
    f.lesson.id,
    f.secondLesson.id,
  ]);
  expect(plan.progressEvidence).toMatchObject({
    kind: 'started',
    at: new Date('2020-01-01T00:00:00Z'),
  });
  await f.as(f.parent, async () => {
    for (const [lesson, status] of [
      [f.lesson, 'complete'],
      [f.secondLesson, 'skipped'],
    ] as const) {
      const row = await rows.get({
        tenantId: f.own.tenantId,
        enrollmentId: f.enrollment.id,
        lessonId: String(lesson.id),
      });
      if (!row) throw Error('missing');
      row.status = status;
      if (status === 'complete')
        row.completedAt = new Date('2020-02-01T00:00:00Z');
      await row.save();
    }
  });
  plan = await f.as(f.parent, () =>
    f.service.getEnrollmentPlan({ ...f.parent, enrollmentId: f.enrollment.id }),
  );
  expect(plan.nextActionableLessonId).toBeNull();
  expect(plan.awaitingReviewLessonIds).toEqual([]);
  expect(plan.progressEvidence).toEqual({
    kind: 'completed',
    at: new Date('2020-02-01T00:00:00Z'),
    lessonId: f.lesson.id,
  });
  const enrollment = await f.as(f.parent, async () =>
    (await EnrollmentCollection.create({ db: f.db })).get(f.enrollment.id),
  );
  if (!enrollment) throw Error('missing');
  await f.as(f.parent, async () => {
    const row = await rows.get({
      tenantId: f.own.tenantId,
      enrollmentId: f.enrollment.id,
      lessonId: String(f.lesson.id),
    });
    if (!row) throw Error('missing');
    row.status = 'in_progress';
    await row.save();
  });
  for (const status of ['paused', 'completed', 'dropped'] as const) {
    await f.as(f.parent, async () => {
      enrollment.status = status;
      await enrollment.save();
    });
    expect(
      (await f.as(f.own, () => f.service.getEnrollmentPlan(input)))
        .nextActionableLessonId,
    ).toBeNull();
  }
}

export async function assertPlanWorkbookBinding(f: Fixture) {
  const { WorkbookCollection, WorkbookActivityCollection } = await import(
    '../workbook-models.js'
  );
  const workbook = await f.as(f.parent, async () =>
    (await WorkbookCollection.create({ db: f.db })).create({
      tenantId: f.parent.tenantId,
      learnerId: f.parent.learnerId,
      workbookKey: 'plan-binding',
      title: 'Workbook',
    }),
  );
  const activity = await f.as(f.parent, async () =>
    (await WorkbookActivityCollection.create({ db: f.db })).create({
      tenantId: f.parent.tenantId,
      learnerId: f.parent.learnerId,
      workbookId: String(workbook.id),
      enrollmentId: f.enrollment.id,
      lessonId: String(f.lesson.id),
      pageKey: 'p1',
    }),
  );
  const laterCurriculum = await f.as(f.parent, () =>
    f.service.createCurriculum({ ...f.parent, title: 'Next year' }),
  );
  const laterEnrollment = await f.as(f.parent, () =>
    f.service.enroll({
      ...f.parent,
      curriculumId: laterCurriculum.id,
      courseId: String(f.course.id),
    }),
  );
  await f.as(f.parent, async () =>
    (await WorkbookActivityCollection.create({ db: f.db })).create({
      tenantId: f.parent.tenantId,
      learnerId: f.parent.learnerId,
      workbookId: String(workbook.id),
      enrollmentId: laterEnrollment.id,
      lessonId: String(f.lesson.id),
      pageKey: 'p2',
    }),
  );
  await f.as(f.parent, async () =>
    (await LessonProgressCollection.create({ db: f.db })).create({
      tenantId: f.parent.tenantId,
      learnerId: f.parent.learnerId,
      enrollmentId: f.enrollment.id,
      lessonId: String(f.lesson.id),
      status: 'complete',
      bestScore: 0.8,
      completedAt: new Date('2020-01-01T00:00:00Z'),
    }),
  );
  const request = { ...f.own, enrollmentId: f.enrollment.id };
  const own = await f.as(f.own, () =>
    f.service.withTransaction((service) => service.getEnrollmentPlan(request)),
  );
  expect(own.lessons[0].lesson.workbookActivityId).toBe(activity.id);
  expect(own.lessons[1].lesson.workbookActivityId).toBeUndefined();
  expect(own.lessons[0].progress).toMatchObject({
    status: 'submitted',
    bestScore: null,
    completedAt: null,
  });
  expect(own.awaitingReviewLessonIds).toEqual([f.lesson.id]);
  const parent = await f.as(f.parent, () =>
    f.service.getEnrollmentPlan({ ...f.parent, enrollmentId: f.enrollment.id }),
  );
  expect(parent.lessons[0].progress).toMatchObject({
    status: 'complete',
    bestScore: 0.8,
  });
  expect(parent.awaitingReviewLessonIds).toEqual([]);
}

export async function assertPlanUnavailableIsolation(f: Fixture) {
  const { CourseSectionCollection } = await import('../collections.js');
  const section = await f.as(f.parent, async () =>
    (await CourseSectionCollection.create({ db: f.db })).get(
      String(f.wrongLesson.sectionId),
    ),
  );
  if (!section) throw new Error('missing course section');
  const second = await f.as(f.parent, () =>
    f.service.enroll({
      ...f.parent,
      curriculumId: f.curriculum.id,
      courseId: section.courseId,
    }),
  );
  class PartiallyUnavailable extends LearnerPlanService {
    protected override createTransactionService(db: DatabaseInterface): this {
      return new PartiallyUnavailable(
        db,
        this.authorize,
        this.authorizeCatalog,
      ) as this;
    }
    protected override async catalog(request: typeof f.own, courseId: string) {
      if (courseId === f.course.id) throw new LearnerAuthorizationError();
      return super.catalog(request, courseId);
    }
  }
  const executors = new Set<DatabaseInterface>();
  const service = new PartiallyUnavailable(
    f.db,
    ({ executor }) => {
      executors.add(executor);
      return true;
    },
    ({ executor }) => {
      executors.add(executor);
      return true;
    },
  );
  const plans = await f.as(f.parent, () =>
    service.withTransaction((bound) => bound.listPlan(f.parent)),
  );
  expect(plans).toHaveLength(2);
  expect(
    plans.find((value) => value.enrollment.id === f.enrollment.id),
  ).toMatchObject({ availability: 'unavailable', course: null, lessons: [] });
  expect(
    plans.find((value) => value.enrollment.id === second.id),
  ).toMatchObject({
    availability: 'available',
    course: { id: section.courseId },
  });
  expect(executors.size).toBe(1);
  expect(executors.has(f.db)).toBe(false);
  expect(plans.map((value) => value.enrollment.id)).toEqual(
    [f.enrollment.id, second.id].sort(),
  );
}

export async function assertPlanOnlineSources(f: Fixture) {
  await f.as(f.parent, async () => {
    f.course.modality = 'online';
    await f.course.save();
    f.lesson.externalUrl = 'https://publisher.example/lesson';
    await f.lesson.save();
    f.secondLesson.externalUrl = 'https://publisher.example/next';
    await f.secondLesson.save();
  });
  const request = { ...f.own, enrollmentId: f.enrollment.id };
  let plan = await f.as(f.own, () => f.service.getEnrollmentPlan(request));
  expect(plan.lessons[0].lesson.sourceUrl).toBe(
    'https://publisher.example/lesson',
  );
  expect(plan.nextActionableLessonId).toBe(f.lesson.id);
  for (const unsafe of [
    '',
    'javascript:alert(1)',
    'http://publisher.example/lesson',
    'https://user:password@publisher.example/lesson',
  ]) {
    await f.as(f.parent, async () => {
      f.lesson.externalUrl = unsafe;
      await f.lesson.save();
    });
    plan = await f.as(f.own, () => f.service.getEnrollmentPlan(request));
    expect(plan.lessons[0].lesson.sourceUrl).toBeUndefined();
    expect(plan.nextActionableLessonId).toBe(f.secondLesson.id);
  }
}
