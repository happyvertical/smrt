import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnrollmentPaceChangeCollection } from '../learner-history.js';
import {
  EnrollmentPaceError,
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  LearnerHistoryUnavailableError,
  LearnerService,
  LearnerValidationError,
} from '../learner-service.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

const classes = [...learnerClasses, 'EnrollmentPaceChange'];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

async function withFixture(
  run: (
    f: Awaited<ReturnType<typeof learnerFixture>> & {
      actions: Array<{ action: string; own: boolean }>;
      tracked: LearnerService;
    },
  ) => Promise<void>,
  useClasses: string[] = classes,
) {
  const db: DatabaseInterface = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: useClasses,
  });
  try {
    const f = await learnerFixture(db);
    const actions: Array<{ action: string; own: boolean }> = [];
    const authorize: LearnerAuthorizer = ({
      action,
      own,
      relationshipTypeId,
    }) => {
      actions.push({ action, own });
      return own || relationshipTypeId === f.guardianType.id;
    };
    await run({
      ...f,
      actions,
      tracked: new LearnerService(db, authorize, () => true),
    });
  } finally {
    await db.close?.();
  }
}

describe('LearnerService.setEnrollmentPace', () => {
  it('sets, changes and clears pace with an immutable audit trail', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, parent, as, enrollment, db } = f;
      const base = { ...parent, enrollmentId: String(enrollment.id) };
      const [unset] = await as(parent, () => service.listEnrollments(parent));
      expect(unset.pace).toBeNull();
      f.actions.length = 0;
      const set = await as(parent, () =>
        service.setEnrollmentPace({
          ...base,
          pace: { lessonsPerWeek: 5 },
          policyBasis: 'guardian',
        }),
      );
      expect(f.actions).toEqual([
        { action: 'education.enrollment.set-pace', own: false },
      ]);
      expect(set).toEqual({
        changed: true,
        enrollment: expect.objectContaining({ pace: { lessonsPerWeek: 5 } }),
      });
      // Replay of the same pace is a no-op and records nothing.
      const replay = await as(parent, () =>
        service.setEnrollmentPace({
          ...base,
          pace: { lessonsPerWeek: 5 },
          policyBasis: 'guardian',
        }),
      );
      expect(replay.changed).toBe(false);
      // The host may let a learner change their own pace.
      const ownBase = { ...own, enrollmentId: String(enrollment.id) };
      await as(own, () =>
        service.setEnrollmentPace({
          ...ownBase,
          pace: { lessonsPerWeek: 14 },
          policyBasis: 'learner-sets-pace',
        }),
      );
      const cleared = await as(own, () =>
        service.setEnrollmentPace({
          ...ownBase,
          pace: null,
          policyBasis: 'learner-sets-pace',
        }),
      );
      expect(cleared.enrollment.pace).toBeNull();
      expect(
        (await as(parent, () => service.listEnrollments(parent)))[0].pace,
      ).toBeNull();
      const history = await db.list('enrollment_pace_changes', {
        enrollment_id: enrollment.id,
      });
      expect(
        history
          .sort(
            (a, b) =>
              new Date(String(a.recorded_at)).getTime() -
              new Date(String(b.recorded_at)).getTime(),
          )
          .map((row) => [
            row.previous_lessons_per_week,
            row.new_lessons_per_week,
            row.actor_user_id,
            row.policy_basis,
          ]),
      ).toEqual([
        [0, 5, parent.actorUserId, 'guardian'],
        [5, 14, own.actorUserId, 'learner-sets-pace'],
        [14, 0, own.actorUserId, 'learner-sets-pace'],
      ]);
      // Status and progress are not touched.
      expect((await db.get('enrollments', { id: enrollment.id }))?.status).toBe(
        'planned',
      );
      // History rows are immutable.
      await as(parent, async () => {
        const row = await (
          await EnrollmentPaceChangeCollection.create({ db })
        ).get(String(history[0].id));
        await expect(row?.delete()).rejects.toThrow('immutable');
        await expect(row?.save()).rejects.toThrow('immutable');
      });
    });
  });

  it('rejects out-of-range, fractional and malformed pace', async () => {
    await withFixture(async (f) => {
      const { tracked: service, parent, as, enrollment, db } = f;
      const base = {
        ...parent,
        enrollmentId: String(enrollment.id),
        policyBasis: 'guardian',
      };
      for (const pace of [
        { lessonsPerWeek: 0 },
        { lessonsPerWeek: 15 },
        { lessonsPerWeek: 2.5 },
        { lessonsPerWeek: -1 },
        { lessonsPerWeek: '3' },
        { lessonsPerWeek: Number.NaN },
        {},
        3,
        undefined,
      ]) {
        const failure = await as(parent, () =>
          service.setEnrollmentPace({ ...base, pace: pace as never }),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(EnrollmentPaceError);
        expect(failure).toBeInstanceOf(LearnerValidationError);
      }
      for (const policyBasis of ['', '  ', 'x'.repeat(201), 'a\nb', 4]) {
        await expect(
          as(parent, () =>
            service.setEnrollmentPace({
              ...base,
              pace: { lessonsPerWeek: 3 },
              policyBasis: policyBasis as string,
            }),
          ),
        ).rejects.toBeInstanceOf(LearnerValidationError);
      }
      expect(await db.list('enrollment_pace_changes', {})).toHaveLength(0);
    });
  });

  it('enforces actor, tenant and host decisions', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, enrollment, db } = f;
      const request = {
        ...own,
        enrollmentId: String(enrollment.id),
        pace: { lessonsPerWeek: 3 },
        policyBasis: 'learner',
      };
      for (const actor of [
        { ...request, actorUserId: String(f.bob.user.id) },
        { ...request, learnerId: String(f.sibling.id) },
        { ...request, actorUserId: String(f.stranger.user.id) },
        { ...request, learnerId: String(f.foreign.id) },
      ])
        await expect(
          as(actor, () => service.setEnrollmentPace(actor)),
        ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      for (const authorize of [
        () => false,
        () => {
          throw new Error('Host unavailable');
        },
      ])
        await expect(
          as(own, () =>
            new LearnerService(db, authorize, () => true).setEnrollmentPace(
              request,
            ),
          ),
        ).rejects.toThrow();
      expect(
        (await db.get('enrollments', { id: enrollment.id }))
          ?.pace_lessons_per_week,
      ).toBe(0);
      expect(await db.list('enrollment_pace_changes', {})).toHaveLength(0);
    });
  });

  it('fails with a typed error when the history table is not migrated', async () => {
    await withFixture(async (f) => {
      const { tracked: service, parent, as, enrollment, db } = f;
      await expect(
        as(parent, () =>
          service.setEnrollmentPace({
            ...parent,
            enrollmentId: String(enrollment.id),
            pace: { lessonsPerWeek: 2 },
            policyBasis: 'guardian',
          }),
        ),
      ).rejects.toBeInstanceOf(LearnerHistoryUnavailableError);
      expect(
        (await db.get('enrollments', { id: enrollment.id }))
          ?.pace_lessons_per_week,
      ).toBe(0);
      // Clearing an unset pace is still an idempotent no-op.
      expect(
        (
          await as(parent, () =>
            service.setEnrollmentPace({
              ...parent,
              enrollmentId: String(enrollment.id),
              pace: null,
              policyBasis: 'guardian',
            }),
          )
        ).changed,
      ).toBe(false);
    }, learnerClasses);
  });
});

describe('LearnerService.nextLessons count', () => {
  it('returns one lesson by default and up to count in order', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, enrollment } = f;
      const request = { ...own, enrollmentId: String(enrollment.id) };
      // Pin the order: equal sort orders tie-break on random ids.
      f.secondLesson.sortOrder = 1;
      await f.secondLesson.save();
      const single = await as(own, () => service.nextLessons(request));
      expect(single).toHaveLength(1);
      expect(single[0].lesson.id).toBe(String(f.lesson.id));
      expect(
        await as(own, () => service.nextLessons({ ...request, count: 1 })),
      ).toEqual(single);
      const both = await as(own, () =>
        service.nextLessons({ ...request, count: 5 }),
      );
      expect(both.map((row) => row.lesson.id)).toEqual([
        String(f.lesson.id),
        String(f.secondLesson.id),
      ]);
      expect(both.every((row) => row.progress === null)).toBe(true);
      // A finished lesson drops out of the set.
      await as(own, () =>
        service.startLesson({ ...request, lessonId: String(f.lesson.id) }),
      );
      await f.db.update(
        'lesson_progress',
        { lesson_id: String(f.lesson.id) },
        { status: 'complete' },
      );
      const rest = await as(own, () =>
        service.nextLessons({ ...request, count: 14 }),
      );
      expect(rest.map((row) => row.lesson.id)).toEqual([
        String(f.secondLesson.id),
      ]);
      // Without an enrollment filter, count applies per enrollment.
      const all = await as(own, () =>
        service.nextLessons({ ...own, count: 2 }),
      );
      expect(all).toHaveLength(1);
      expect(all[0].enrollment.pace).toBeNull();
    });
  });

  it('rejects an invalid count', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, enrollment } = f;
      for (const count of [0, 15, 1.5, -1, Number.NaN, '2', null]) {
        await expect(
          as(own, () =>
            service.nextLessons({
              ...own,
              enrollmentId: String(enrollment.id),
              count: count as number,
            }),
          ),
        ).rejects.toBeInstanceOf(LearnerValidationError);
      }
    });
  });
});
