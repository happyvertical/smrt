import { randomUUID } from 'node:crypto';
import {
  Person,
  ProfileRelationshipCollection,
  ProfileRelationshipTypeCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import {
  CourseCollection,
  CourseSectionCollection,
  CurriculumCollection,
  EnrollmentCollection,
  LearnerCollection,
  LessonCollection,
  LessonProgressCollection,
} from '../collections.js';
import {
  LearnerAuthorizationError,
  type LearnerRequest,
  LearnerService,
} from '../learner-service.js';

export const learnerClasses = [
  'Learner',
  'Curriculum',
  'Enrollment',
  'LessonProgress',
  'Course',
  'CourseSection',
  'Lesson',
  'LessonAsset',
  'Asset',
  'Tenant',
  'User',
  'Membership',
  'Role',
  'Profile',
  'ProfileType',
  'Person',
  'ProfileRelationship',
  'ProfileRelationshipType',
];

export async function learnerFixture(db: DatabaseInterface) {
  const tenants = await TenantCollection.create({ db });
  const family = await tenants.create({ name: `Family ${randomUUID()}` });
  const other = await tenants.create({ name: `Other ${randomUUID()}` });
  const tenantId = String(family.id);
  const role = await (await RoleCollection.create({ db })).create({
    name: `Member ${randomUUID()}`,
  });
  const profileType = await (await ProfileTypeCollection.create({ db })).create(
    { name: 'Person', slug: 'person' },
  );
  const users = await UserCollection.create({ db });
  const memberships = await MembershipCollection.create({ db });
  const learners = await LearnerCollection.create({ db });
  async function identity(name: string, owner: string) {
    const profile = new Person({
      db,
      name: `${name} ${randomUUID()}`,
      typeId: String(profileType.id),
    });
    await profile.initialize();
    await profile.save();
    const user = await users.create({
      profileId: String(profile.id),
      email: '',
    });
    await memberships.create({
      userId: String(user.id),
      tenantId: owner,
      roleId: String(role.id),
      status: MembershipStatus.ACTIVE,
    });
    return { user, profile };
  }
  const alice = await identity('Alice', tenantId);
  const bob = await identity('Bob', tenantId);
  const stranger = await identity('Stranger', String(other.id));
  const guardian = await identity('Guardian', tenantId);
  const learner = await withTenant(
    { tenantId, userId: String(alice.user.id) },
    () =>
      learners.create({
        tenantId,
        userId: String(alice.user.id),
        profileId: String(alice.profile.id),
        displayName: 'Alice',
      }),
  );
  const sibling = await withTenant(
    { tenantId, userId: String(bob.user.id) },
    () =>
      learners.create({
        tenantId,
        userId: String(bob.user.id),
        profileId: String(bob.profile.id),
        displayName: 'Bob',
      }),
  );
  const foreign = await withTenant(
    { tenantId: String(other.id), userId: String(stranger.user.id) },
    () =>
      learners.create({
        tenantId: String(other.id),
        userId: String(stranger.user.id),
        profileId: String(stranger.profile.id),
      }),
  );
  const guardianType = await (
    await ProfileRelationshipTypeCollection.create({ db })
  ).create({ name: `Guardian ${randomUUID()}`, reciprocal: false });
  const relationship = await withTenant({ tenantId }, () =>
    (async () =>
      (await ProfileRelationshipCollection.create({ db })).create({
        tenantId,
        fromProfileId: String(guardian.profile.id),
        toProfileId: String(alice.profile.id),
        typeId: String(guardianType.id),
      }))(),
  );
  const courses = await CourseCollection.create({ db });
  const sections = await CourseSectionCollection.create({ db });
  const lessons = await LessonCollection.create({ db });
  const course = await courses.create({ tenantId, title: 'Course' });
  const section = await sections.create({
    tenantId,
    courseId: String(course.id),
    title: 'Section',
  });
  const lesson = await lessons.create({
    tenantId,
    sectionId: String(section.id),
    title: 'Lesson',
  });
  const secondLesson = await lessons.create({
    tenantId,
    sectionId: String(section.id),
    title: 'Second lesson',
  });
  const otherCourse = await courses.create({
    tenantId,
    title: `Other course ${randomUUID()}`,
  });
  const otherSection = await sections.create({
    tenantId,
    courseId: String(otherCourse.id),
    title: 'Other section',
  });
  const wrongLesson = await lessons.create({
    tenantId,
    sectionId: String(otherSection.id),
    title: 'Wrong lesson',
  });
  const service = new LearnerService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === guardianType.id,
    () => true,
  );
  const own: LearnerRequest = {
    tenantId,
    actorUserId: String(alice.user.id),
    learnerId: String(learner.id),
  };
  const parent: LearnerRequest = {
    ...own,
    actorUserId: String(guardian.user.id),
    guardianRelationshipId: String(relationship.id),
  };
  const as = <T>(request: LearnerRequest, fn: () => Promise<T>) =>
    withTenant({ tenantId: request.tenantId, userId: request.actorUserId }, fn);
  const curriculum = await as(parent, () =>
    service.createCurriculum({ ...parent, title: '2026' }),
  );
  const enrollment = await as(parent, () =>
    service.enroll({
      ...parent,
      curriculumId: String(curriculum.id),
      courseId: String(course.id),
    }),
  );
  return {
    db,
    service,
    own,
    parent,
    as,
    learner,
    sibling,
    foreign,
    alice,
    bob,
    stranger,
    guardian,
    learners,
    memberships,
    relationship,
    guardianType,
    curriculum,
    enrollment,
    course,
    lesson,
    secondLesson,
    wrongLesson,
  };
}

type Fixture = Awaited<ReturnType<typeof learnerFixture>>;

export async function assertLearnerAuthorization(f: Fixture) {
  const { service, own, parent, as, enrollment, lesson } = f;
  const start = {
    ...own,
    enrollmentId: String(enrollment.id),
    lessonId: String(lesson.id),
  };
  expect((await as(own, () => service.getLearner(own))).id).toBe(f.learner.id);
  expect((await as(parent, () => service.getLearner(parent))).id).toBe(
    f.learner.id,
  );
  await as(own, () => service.startLesson(start));
  expect(await as(own, () => service.listProgress(start))).toHaveLength(1);
  for (const request of [
    { ...own, actorUserId: String(f.bob.user.id) },
    { ...own, learnerId: String(f.sibling.id) },
    { ...own, actorUserId: String(f.stranger.user.id) },
    { ...own, learnerId: String(f.foreign.id) },
    { ...parent, guardianRelationshipId: randomUUID() },
    { ...parent, actorUserId: String(f.bob.user.id) },
    { ...parent, guardianRelationshipId: undefined },
  ]) {
    await expect(
      as(request, () => service.getLearner(request)),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      as(request, () => service.listProgress({ ...start, ...request })),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      as(request, () => service.startLesson({ ...start, ...request })),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  }
  await expect(service.getLearner(own)).rejects.toBeInstanceOf(
    LearnerAuthorizationError,
  );
  await expect(
    withTenant({ tenantId: own.tenantId, userId: parent.actorUserId }, () =>
      service.startLesson(start),
    ),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  await expect(
    withTenant(
      { tenantId: String(f.foreign.tenantId), userId: own.actorUserId },
      () => service.startLesson(start),
    ),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  await expect(
    withTenant(
      {
        tenantId: own.tenantId,
        userId: own.actorUserId,
        superAdminBypass: true,
      },
      () => service.getLearner(own),
    ),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  await expect(
    as(own, () => service.createCurriculum({ ...own, title: 'Learner plan' })),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  for (const authorize of [
    () => false,
    () => {
      throw new Error('Host unavailable');
    },
  ]) {
    const denied = new LearnerService(f.db, authorize, () => true);
    await expect(as(parent, () => denied.getLearner(parent))).rejects.toThrow();
    await expect(as(own, () => denied.startLesson(start))).rejects.toThrow();
  }
  await f.db.update(
    'memberships',
    { user_id: own.actorUserId, tenant_id: own.tenantId },
    { status: 'inactive' },
  );
  await expect(
    as(own, () => service.startLesson(start)),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  await expect(
    as(parent, () => service.getLearner(parent)),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
}

export async function assertProgressHistory(f: Fixture) {
  const { service, own, parent, as, enrollment, lesson, db } = f;
  const request = {
    ...own,
    enrollmentId: String(enrollment.id),
    lessonId: String(lesson.id),
  };
  const results = await as(own, () =>
    Promise.all(Array.from({ length: 5 }, () => service.startLesson(request))),
  );
  expect(new Set(results.map((row) => row.id)).size).toBe(1);
  // A corrupt other-tenant row must not reserve this tenant's logical key.
  const hostile = await as(own, async () =>
    (await LessonProgressCollection.create({ db })).create({
      tenantId: own.tenantId,
      learnerId: own.learnerId,
      enrollmentId: enrollment.id,
      lessonId: String(f.secondLesson.id),
      attempts: 9,
    }),
  );
  await db.update(
    'lesson_progress',
    { id: hostile.id },
    { tenant_id: f.foreign.tenantId },
  );
  const composed = await as(own, () =>
    service.withTransaction((transaction) =>
      Promise.all(
        Array.from({ length: 4 }, () =>
          transaction.startLesson({
            ...request,
            lessonId: String(f.secondLesson.id),
          }),
        ),
      ),
    ),
  );
  expect(new Set(composed.map((row) => row.id)).size).toBe(1);
  expect(composed[0].id).not.toBe(hostile.id);
  expect(composed[0].attempts).toBe(0);
  expect(
    await db.get('lesson_progress', {
      id: hostile.id,
      tenant_id: f.foreign.tenantId,
      attempts: 9,
    }),
  ).toBeTruthy();

  const first = await as(
    own,
    async () =>
      (await (
        await LessonProgressCollection.create({ db })
      ).get(results[0].id))!,
  );
  expect(first.bestScore).toBeNull();
  // Trusted grading pipeline state is preserved by learner retries.
  await as(own, async () => {
    first.bestScore = 0;
    first.attempts = 3;
    first.status = 'complete';
    await first.save();
  });
  const repeat = await as(own, () =>
    service.startLesson({
      ...request,
      bestScore: 1,
      status: 'complete',
      attempts: 100,
    } as typeof request),
  );
  expect(repeat.id).toBe(first.id);
  expect(repeat.bestScore).toBe(0);
  expect(repeat.attempts).toBe(3);
  expect(repeat.status).toBe('complete');
  const fresh = await as(parent, async () => {
    const curriculum = await service.createCurriculum({
      ...parent,
      title: '2027',
    });
    return service.enroll({
      ...parent,
      curriculumId: String(curriculum.id),
      courseId: String(f.course.id),
    });
  });
  const newProgress = await as(own, () =>
    service.startLesson({ ...request, enrollmentId: String(fresh.id) }),
  );
  expect(newProgress.id).not.toBe(first.id);
  expect(newProgress.attempts).toBe(0);
  expect(newProgress.bestScore).toBeNull();
  expect(newProgress.status).toBe('in_progress');
  expect(await as(own, () => service.listProgress(request))).toHaveLength(2);
  await expect(
    as(own, () =>
      service.startLesson({ ...request, learnerId: String(f.sibling.id) }),
    ),
  ).rejects.toThrow();
  await expect(
    as(own, () =>
      service.startLesson({ ...request, lessonId: String(f.wrongLesson.id) }),
    ),
  ).rejects.toThrow();
  const progresses = await LessonProgressCollection.create({ db });
  await expect(
    as(own, () =>
      progresses.create({
        tenantId: own.tenantId,
        enrollmentId: String(enrollment.id),
        learnerId: String(f.sibling.id),
        lessonId: String(lesson.id),
      }),
    ),
  ).rejects.toThrow('enrollment learner');
  await expect(
    as(own, () =>
      progresses.create({
        tenantId: own.tenantId,
        enrollmentId: String(enrollment.id),
        learnerId: own.learnerId,
        lessonId: String(f.wrongLesson.id),
      }),
    ),
  ).rejects.toThrow('course lesson');
  for (const bad of [NaN, Infinity, -0.1, 1.1]) {
    first.bestScore = bad;
    await expect(as(own, () => first.save())).rejects.toThrow('Score');
  }
  first.bestScore = null;
  await as(own, () => first.save());
  expect(
    (await as(own, () => service.listProgress(request)))[0].bestScore,
  ).toBeNull();
  const parallelCurriculum = await as(parent, () =>
    service.createCurriculum({ ...parent, title: 'Concurrent enrollment' }),
  );
  const enrollmentResults = await as(parent, () =>
    Promise.all(
      Array.from({ length: 4 }, () =>
        service.enroll({
          ...parent,
          curriculumId: parallelCurriculum.id,
          courseId: String(f.course.id),
        }),
      ),
    ),
  );
  expect(new Set(enrollmentResults.map((row) => row.id)).size).toBe(1);
  const row = await db.get('lesson_progress', { id: first.id });
  await expect(
    db.insert('lesson_progress', {
      ...row,
      id: randomUUID(),
      slug: randomUUID(),
    }),
  ).rejects.toThrow();
  const enrolled = await db.get('enrollments', { id: enrollment.id });
  await expect(
    db.insert('enrollments', {
      ...enrolled,
      id: randomUUID(),
      slug: randomUUID(),
    }),
  ).rejects.toThrow();
}

export async function assertLearnerRollback(f: Fixture) {
  const { service, own, parent, as } = f;
  const start = {
    ...own,
    enrollmentId: String(f.enrollment.id),
    lessonId: String(f.secondLesson.id),
  };
  await expect(
    as(parent, () =>
      service.withTransaction(async (transaction) => {
        const curriculum = await transaction.createCurriculum({
          ...parent,
          title: 'Rolled back',
        });
        await transaction.enroll({
          ...parent,
          curriculumId: String(curriculum.id),
          courseId: String(f.course.id),
        });
        await withTenant(
          { tenantId: own.tenantId, userId: own.actorUserId },
          () => transaction.startLesson(start),
        );
        throw new Error('Abort composite workflow');
      }),
    ),
  ).rejects.toThrow('Abort composite workflow');
  const curricula = await CurriculumCollection.create({ db: f.db });
  expect(
    await as(parent, () => curricula.list({ where: { title: 'Rolled back' } })),
  ).toHaveLength(0);
  expect(await as(own, () => service.listProgress(start))).toHaveLength(0);
  expect((await as(own, () => service.startLesson(start))).lessonId).toBe(
    f.secondLesson.id,
  );
  expect(await as(own, () => service.listProgress(start))).toHaveLength(1);
}

export async function assertLearnerModels(f: Fixture) {
  const { learners, own, as } = f;
  await expect(
    as(own, () =>
      learners.create({
        tenantId: own.tenantId,
        userId: String(f.alice.user.id),
        profileId: String(f.bob.profile.id),
      }),
    ),
  ).rejects.toThrow('linked user/profile');
  await expect(
    as(own, () =>
      learners.create({
        tenantId: own.tenantId,
        profileId: String(f.alice.profile.id),
      }),
    ),
  ).rejects.toThrow('linked user/profile');
  await expect(
    as(own, () =>
      learners.create({
        tenantId: own.tenantId,
        userId: String(f.stranger.user.id),
        profileId: String(f.stranger.profile.id),
      }),
    ),
  ).rejects.toThrow('membership');
  f.learner.setSettings({ tutor: { hints: true } });
  await as(own, () => f.learner.save());
  expect((await as(own, () => f.service.getLearner(own))).settings).toEqual({
    tutor: { hints: true },
  });
  for (const malformed of ['bad json', 'null', '[]', '1']) {
    f.learner.settings = malformed;
    expect(f.learner.getSettings()).toEqual({});
  }
  expect(() => f.learner.setSettings([] as never)).toThrow('object');
  const enrollments = await EnrollmentCollection.create({ db: f.db });
  await expect(
    as(own, () =>
      enrollments.create({
        tenantId: own.tenantId,
        curriculumId: String(f.curriculum.id),
        learnerId: String(f.sibling.id),
        courseId: String(f.course.id),
      }),
    ),
  ).rejects.toThrow('match');
  const persistedEnrollment = await as(
    own,
    async () => (await enrollments.get(f.enrollment.id))!,
  );
  persistedEnrollment.status = 'unknown' as never;
  await expect(as(own, () => persistedEnrollment.save())).rejects.toThrow(
    'status',
  );
  await expect(
    withTenant(
      { tenantId: f.foreign.tenantId, userId: String(f.stranger.user.id) },
      () =>
        enrollments.create({
          tenantId: f.foreign.tenantId,
          curriculumId: f.curriculum.id,
          learnerId: own.learnerId,
          courseId: String(f.course.id),
        }),
    ),
  ).rejects.toThrow('match');
  f.learner.userId = String(f.bob.user.id);
  await expect(as(own, () => f.learner.save())).rejects.toThrow(
    'identity cannot change',
  );
}

export async function assertHostileLearnerLinks(f: Fixture) {
  const { service, own, parent, as, db } = f;
  const request = {
    ...own,
    enrollmentId: f.enrollment.id,
    lessonId: String(f.lesson.id),
  };
  const progress = await as(own, () => service.startLesson(request));
  // Simulate corrupt persisted links; reads cannot rely solely on save guards.
  await db.update(
    'lesson_progress',
    { id: progress.id },
    { learner_id: f.sibling.id },
  );
  expect(await as(own, () => service.listProgress(request))).toEqual([]);
  await expect(
    as(own, () => service.startLesson(request)),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  await db.update(
    'lesson_progress',
    { id: progress.id },
    { learner_id: own.learnerId, lesson_id: f.wrongLesson.id },
  );
  expect(await as(own, () => service.listProgress(request))).toEqual([]);
  await db.update(
    'enrollments',
    { id: f.enrollment.id },
    { learner_id: f.sibling.id },
  );
  await expect(
    as(own, () => service.listProgress(request)),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  await expect(
    as(parent, () =>
      service.enroll({
        ...parent,
        curriculumId: f.curriculum.id,
        courseId: String(f.course.id),
      }),
    ),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  await db.update(
    'enrollments',
    { id: f.enrollment.id },
    { learner_id: own.learnerId },
  );
  await db.update(
    'curricula',
    { id: f.curriculum.id },
    { tenant_id: f.foreign.tenantId },
  );
  await expect(
    as(own, () => service.startLesson(request)),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  await db.update(
    'profile_relationships',
    { id: f.relationship.id },
    { tenant_id: f.foreign.tenantId },
  );
  await expect(
    as(parent, () => service.getLearner(parent)),
  ).rejects.toBeInstanceOf(LearnerAuthorizationError);
}

export async function assertQueuedRollbackAndClosure(f: Fixture) {
  const { service, parent, as, db } = f;
  const curricula = await CurriculumCollection.create({ db });
  let queued: Promise<unknown>[] = [];
  let retained: LearnerService | undefined;
  await expect(
    as(parent, () =>
      service.withTransaction(async (transaction) => {
        retained = transaction;
        queued = [
          transaction.createCurriculum({ ...parent, title: '' }),
          transaction.createCurriculum({
            ...parent,
            title: 'Queued valid one',
          }),
          transaction.createCurriculum({
            ...parent,
            title: 'Queued valid two',
          }),
        ];
        return Promise.all(queued);
      }),
    ),
  ).rejects.toThrow('Curriculum title is required');
  const settled = await Promise.allSettled(queued);
  expect(settled.map((result) => result.status)).toEqual([
    'rejected',
    'rejected',
    'rejected',
  ]);
  const rows = await as(parent, () =>
    curricula.list({ where: { learnerId: parent.learnerId } }),
  );
  expect(rows.filter((row) => row.title.startsWith('Queued valid'))).toEqual(
    [],
  );
  await expect(
    as(parent, () =>
      retained!.createCurriculum({ ...parent, title: 'Escaped failure scope' }),
    ),
  ).rejects.toThrow('scope is closed');
  await expect(as(parent, () => retained!.getLearner(parent))).rejects.toThrow(
    'scope is closed',
  );
  await expect(
    as(parent, () => retained!.withTransaction(async () => true)),
  ).rejects.toThrow('scope is closed');
  const fresh = await as(parent, () =>
    service.withTransaction(async (transaction) => {
      retained = transaction;
      return transaction.createCurriculum({
        ...parent,
        title: 'Fresh after queued rollback',
      });
    }),
  );
  expect(
    (await as(parent, () => curricula.get(fresh.id, { cache: false })))?.title,
  ).toBe('Fresh after queued rollback');
  await expect(
    as(parent, () =>
      retained!.createCurriculum({ ...parent, title: 'Escaped success scope' }),
    ),
  ).rejects.toThrow('scope is closed');
  await expect(
    as(parent, () =>
      retained!.listProgress({ ...parent, enrollmentId: f.enrollment.id }),
    ),
  ).rejects.toThrow('scope is closed');
}

export async function assertTransactionDrain(f: Fixture) {
  const { service, parent, as, db } = f;
  let queued: Promise<unknown>[] = [];
  await as(parent, () =>
    service.withTransaction(async (transaction) => {
      queued = [
        transaction.createCurriculum({ ...parent, title: 'Drain valid one' }),
        transaction.createCurriculum({ ...parent, title: 'Drain valid two' }),
      ];
    }),
  );
  expect(
    (await Promise.allSettled(queued)).map((result) => result.status),
  ).toEqual(['fulfilled', 'fulfilled']);
  const curricula = await CurriculumCollection.create({ db });
  const rows = await as(parent, () =>
    curricula.list({ where: { learnerId: parent.learnerId } }),
  );
  expect(
    rows.filter((row) => row.title.startsWith('Drain valid')),
  ).toHaveLength(2);
  await expect(
    as(parent, () =>
      service.withTransaction(async (transaction) => {
        await transaction.createCurriculum({
          ...parent,
          title: 'Before swallowed failure',
        });
        await transaction
          .createCurriculum({ ...parent, title: '' })
          .catch(() => undefined);
      }),
    ),
  ).rejects.toThrow('Curriculum title is required');
  expect(
    await as(parent, () =>
      curricula.list({ where: { title: 'Before swallowed failure' } }),
    ),
  ).toEqual([]);
}

export async function assertInflightRollback(f: Fixture) {
  const { parent, as, db } = f;
  let entered!: () => void;
  const operationEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const authorizationGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let callbackFailed!: () => void;
  const callbackFailure = new Promise<void>((resolve) => {
    callbackFailed = resolve;
  });
  const events: string[] = [];
  const service = new LearnerService(
    db,
    async () => {
      entered();
      await authorizationGate;
      return true;
    },
    () => true,
  );
  let pending!: Promise<unknown>;
  const transaction = as(parent, () =>
    service.withTransaction(async (bound) => {
      pending = bound.createCurriculum({
        ...parent,
        title: 'In flight before rollback',
      });
      // Attach a rejection handler immediately; retain completion order for either dialect.
      void pending.then(
        () => events.push('operation-settled'),
        () => events.push('operation-settled'),
      );
      await operationEntered;
      callbackFailed();
      throw new Error('Abort while authorization is in flight');
    }),
  );
  const result = transaction.then(
    () => {
      events.push('transaction-committed');
      return null;
    },
    (error: unknown) => {
      events.push('transaction-rejected');
      return error;
    },
  );
  await callbackFailure;
  // Give the rejection path a turn while the authorized operation is deliberately blocked.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeRelease = events.includes('transaction-rejected');
  release();
  const error = await result;
  await Promise.allSettled([pending]);
  expect(settledBeforeRelease).toBe(false);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    'Abort while authorization is in flight',
  );
  expect(events).toEqual(['operation-settled', 'transaction-rejected']);
  const curricula = await CurriculumCollection.create({ db });
  expect(
    await as(parent, () =>
      curricula.list({ where: { title: 'In flight before rollback' } }),
    ),
  ).toEqual([]);
  const fresh = await as(parent, () =>
    service.createCurriculum({
      ...parent,
      title: 'Fresh after in-flight rollback',
    }),
  );
  expect(
    (await as(parent, () => curricula.get(fresh.id, { cache: false })))?.id,
  ).toBe(fresh.id);
}

export async function assertCatalogRequestWhitelist(f: Fixture) {
  const actions: string[] = [];
  const service = new LearnerService(
    f.db,
    () => true,
    ({ action }) => {
      actions.push(action);
      if (action === 'education.catalog.answer-key.read')
        throw new Error('Answer keys must never be requested');
      return true;
    },
  );
  const injected = {
    includeAnswerKeys: true,
    options: { limit: 0, offset: 999 },
  };
  const enrollment = await f.as(f.parent, () =>
    service.enroll({
      ...f.parent,
      curriculumId: f.curriculum.id,
      courseId: String(f.course.id),
      ...injected,
    }),
  );
  expect(enrollment.id).toBe(f.enrollment.id);
  const request = {
    ...f.own,
    enrollmentId: enrollment.id,
    lessonId: String(f.lesson.id),
    ...injected,
  };
  const progress = await f.as(f.own, () => service.startLesson(request));
  expect(progress.status).toBe('in_progress');
  expect(
    (await f.as(f.own, () => service.listProgress(request))).map(
      (row) => row.id,
    ),
  ).toEqual([progress.id]);
  expect(actions).not.toContain('education.catalog.answer-key.read');
  expect(
    actions.filter((action) => action === 'education.catalog.read'),
  ).toHaveLength(3);
}
