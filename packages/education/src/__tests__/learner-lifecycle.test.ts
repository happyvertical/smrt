import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LessonProgressCollection } from '../collections.js';
import {
  ENROLLMENT_STATUS_TRANSITIONS,
  EnrollmentStatusTransitionError,
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  LearnerService,
  LearnerValidationError,
  LessonPutBackError,
} from '../learner-service.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

const classes = [
  ...learnerClasses,
  'LessonProgressTransition',
  'EnrollmentStatusChange',
];

async function progressRow(db: DatabaseInterface, id: string) {
  const row = await (await LessonProgressCollection.create({ db })).get(id);
  if (!row) throw new Error('missing progress row');
  return row;
}

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

async function withFixture(
  run: (
    f: Awaited<ReturnType<typeof learnerFixture>> & {
      actions: Array<{ action: string; own: boolean }>;
      tracked: LearnerService;
    },
  ) => Promise<void>,
) {
  const db: DatabaseInterface = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes,
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
    const tracked = new LearnerService(db, authorize, () => true);
    await run({ ...f, actions, tracked });
  } finally {
    await db.close?.();
  }
}

describe('LearnerService.putBackLesson', () => {
  it('returns started work to not_started and keeps history', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, parent, as, enrollment, lesson, db } = f;
      const request = {
        ...own,
        enrollmentId: String(enrollment.id),
        lessonId: String(lesson.id),
      };
      // Never started: nothing to put back.
      expect(await as(own, () => service.putBackLesson(request))).toEqual({
        changed: false,
        progress: null,
      });
      const started = await as(own, () => service.startLesson(request));
      // Trusted pipeline state survives the round trip.
      await as(own, async () => {
        const row = await progressRow(db, started.id);
        row.attempts = 2;
        row.timeSpentSeconds = 90;
        row.bestScore = 0;
        await row.save();
      });
      f.actions.length = 0;
      const put = await as(own, () =>
        service.putBackLesson({
          ...request,
          status: 'complete',
          attempts: 0,
        } as typeof request),
      );
      expect(f.actions).toEqual([
        { action: 'education.progress.put-back', own: true },
      ]);
      expect(put.changed).toBe(true);
      expect(put.progress).toMatchObject({
        id: started.id,
        status: 'not_started',
        attempts: 2,
        timeSpentSeconds: 90,
        bestScore: 0,
      });
      expect(put.progress?.startedAt).toEqual(started.startedAt);
      // Idempotent replay records nothing.
      const again = await as(own, () => service.putBackLesson(request));
      expect(again.changed).toBe(false);
      expect(again.progress?.status).toBe('not_started');
      // A guardian may put back too; restart moves it forward again.
      const restarted = await as(own, () => service.startLesson(request));
      expect(restarted).toMatchObject({
        id: started.id,
        status: 'in_progress',
        attempts: 2,
      });
      expect(restarted.startedAt).toEqual(started.startedAt);
      const byParent = await as(parent, () =>
        service.putBackLesson({ ...request, ...parent }),
      );
      expect(byParent.changed).toBe(true);
      const history = await db.list('lesson_progress_transitions', {
        progress_id: started.id,
      });
      expect(
        history
          .sort(
            (a, b) =>
              new Date(String(a.recorded_at)).getTime() -
              new Date(String(b.recorded_at)).getTime(),
          )
          .map((row) => [
            row.from_status,
            row.to_status,
            row.kind,
            row.actor_user_id,
          ]),
      ).toEqual([
        ['in_progress', 'not_started', 'put-back', own.actorUserId],
        ['not_started', 'in_progress', 'start', own.actorUserId],
        ['in_progress', 'not_started', 'put-back', parent.actorUserId],
      ]);
      // Exactly one progress row remains for the enrollment lesson.
      expect(
        await db.list('lesson_progress', {
          enrollment_id: enrollment.id,
          lesson_id: lesson.id,
        }),
      ).toHaveLength(1);
    });
  });

  it('refuses finished or submitted work with a typed error', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, enrollment, lesson, db } = f;
      const request = {
        ...own,
        enrollmentId: String(enrollment.id),
        lessonId: String(lesson.id),
      };
      const started = await as(own, () => service.startLesson(request));
      for (const status of [
        'submitted',
        'needs_review',
        'complete',
        'skipped',
      ] as const) {
        await as(own, async () => {
          const row = await progressRow(db, started.id);
          row.status = status;
          await row.save();
        });
        const failure = await as(own, () =>
          service.putBackLesson(request),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(LessonPutBackError);
        expect((failure as LessonPutBackError).status).toBe(status);
        expect(
          (await db.get('lesson_progress', { id: started.id }))?.status,
        ).toBe(status);
      }
      expect(
        await db.list('lesson_progress_transitions', {
          progress_id: started.id,
        }),
      ).toHaveLength(0);
    });
  });

  it('enforces actor, enrollment and lesson scope', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, enrollment, lesson } = f;
      const request = {
        ...own,
        enrollmentId: String(enrollment.id),
        lessonId: String(lesson.id),
      };
      await as(own, () => service.startLesson(request));
      const sibling = {
        ...request,
        actorUserId: String(f.bob.user.id),
      };
      await expect(
        as(sibling, () => service.putBackLesson(sibling)),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      await expect(
        as(own, () =>
          service.putBackLesson({
            ...request,
            lessonId: String(f.wrongLesson.id),
          }),
        ),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      const denied = new LearnerService(
        f.db,
        () => false,
        () => true,
      );
      await expect(
        as(own, () => denied.putBackLesson(request)),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    });
  });
});

describe('LearnerService.setEnrollmentStatus', () => {
  it('follows the transition table and records actor and basis', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, parent, as, enrollment, lesson, db } = f;
      expect(ENROLLMENT_STATUS_TRANSITIONS).toEqual({
        planned: ['active'],
        active: ['paused', 'dropped'],
        paused: ['active', 'dropped'],
        completed: [],
        dropped: [],
      });
      const base = { ...parent, enrollmentId: String(enrollment.id) };
      // Progress exists before any change and must never be cascaded.
      const started = await as(own, () =>
        service.startLesson({
          ...own,
          enrollmentId: String(enrollment.id),
          lessonId: String(lesson.id),
        }),
      );
      expect(enrollment.status).toBe('planned');
      f.actions.length = 0;
      const activated = await as(parent, () =>
        service.setEnrollmentStatus({
          ...base,
          status: 'active',
          policyBasis: 'guardian',
        }),
      );
      expect(f.actions).toEqual([
        { action: 'education.enrollment.set-status', own: false },
      ]);
      expect(activated).toEqual({
        changed: true,
        enrollment: expect.objectContaining({ status: 'active' }),
      });
      const startedAt = (await db.get('enrollments', { id: enrollment.id }))
        ?.started_at;
      expect(startedAt).toBeTruthy();
      // The host may let a learner pause and resume their own enrollment.
      const ownBase = { ...own, enrollmentId: String(enrollment.id) };
      await as(own, () =>
        service.setEnrollmentStatus({
          ...ownBase,
          status: 'paused',
          policyBasis: 'learner-may-pause',
        }),
      );
      const replay = await as(own, () =>
        service.setEnrollmentStatus({
          ...ownBase,
          status: 'paused',
          policyBasis: 'learner-may-pause',
        }),
      );
      expect(replay.changed).toBe(false);
      await as(own, () =>
        service.setEnrollmentStatus({
          ...ownBase,
          status: 'active',
          policyBasis: 'learner-may-pause',
        }),
      );
      // Resuming keeps the first activation time.
      expect(
        (await db.get('enrollments', { id: enrollment.id }))?.started_at,
      ).toEqual(startedAt);
      for (const status of ['completed', 'planned', 'bogus'] as const) {
        const failure = await as(parent, () =>
          service.setEnrollmentStatus({
            ...base,
            status: status as 'completed',
            policyBasis: 'guardian',
          }),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(EnrollmentStatusTransitionError);
        expect(failure).toMatchObject({ from: 'active', to: status });
      }
      await as(parent, () =>
        service.setEnrollmentStatus({
          ...base,
          status: 'dropped',
          policyBasis: 'guardian',
        }),
      );
      await expect(
        as(parent, () =>
          service.setEnrollmentStatus({
            ...base,
            status: 'active',
            policyBasis: 'guardian',
          }),
        ),
      ).rejects.toBeInstanceOf(EnrollmentStatusTransitionError);
      const history = (
        await db.list('enrollment_status_changes', {
          enrollment_id: enrollment.id,
        })
      ).sort(
        (a, b) =>
          new Date(String(a.recorded_at)).getTime() -
          new Date(String(b.recorded_at)).getTime(),
      );
      expect(
        history.map((row) => [
          row.from_status,
          row.to_status,
          row.actor_user_id,
          row.policy_basis,
        ]),
      ).toEqual([
        ['planned', 'active', parent.actorUserId, 'guardian'],
        ['active', 'paused', own.actorUserId, 'learner-may-pause'],
        ['paused', 'active', own.actorUserId, 'learner-may-pause'],
        ['active', 'dropped', parent.actorUserId, 'guardian'],
      ]);
      // No cascade: progress is exactly as it was.
      expect(
        (await db.get('lesson_progress', { id: started.id }))?.status,
      ).toBe('in_progress');
    });
  });

  it('validates the basis and enforces authorization', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, parent, as, enrollment, db } = f;
      const base = { ...parent, enrollmentId: String(enrollment.id) };
      for (const policyBasis of ['', '   ', 'x'.repeat(201), 'a\u0001b', 7])
        await expect(
          as(parent, () =>
            service.setEnrollmentStatus({
              ...base,
              status: 'active',
              policyBasis: policyBasis as string,
            }),
          ),
        ).rejects.toBeInstanceOf(LearnerValidationError);
      const sibling = {
        ...own,
        actorUserId: String(f.bob.user.id),
        enrollmentId: String(enrollment.id),
      };
      await expect(
        as(sibling, () =>
          service.setEnrollmentStatus({
            ...sibling,
            status: 'active',
            policyBasis: 'x',
          }),
        ),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      const denied = new LearnerService(
        db,
        () => false,
        () => true,
      );
      await expect(
        as(parent, () =>
          denied.setEnrollmentStatus({
            ...base,
            status: 'active',
            policyBasis: 'guardian',
          }),
        ),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      expect((await db.get('enrollments', { id: enrollment.id }))?.status).toBe(
        'planned',
      );
      expect(await db.list('enrollment_status_changes', {})).toHaveLength(0);
    });
  });
});
