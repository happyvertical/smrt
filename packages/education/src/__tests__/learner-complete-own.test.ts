import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LessonProgressCollection,
  SubmissionCollection,
} from '../collections.js';
import {
  EnrollmentNotActiveError,
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  LearnerHistoryUnavailableError,
  LearnerService,
  LearnerValidationError,
  LessonAlreadyCompleteError,
  LessonSkippedError,
} from '../learner-service.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

const classes = [
  ...learnerClasses,
  'Submission',
  'LessonProgressTransition',
  'LessonCompletionRecord',
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

async function withFixture(
  run: (
    f: Awaited<ReturnType<typeof learnerFixture>> & {
      actions: Array<{ action: string; own: boolean }>;
      tracked: LearnerService;
      request: {
        tenantId: string;
        actorUserId: string;
        learnerId: string;
        enrollmentId: string;
        lessonId: string;
        policyBasis: string;
      };
    },
  ) => Promise<void>,
  extraClasses: string[] = classes,
) {
  const db: DatabaseInterface = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: extraClasses,
  });
  try {
    const f = await learnerFixture(db);
    await db.update(
      'enrollments',
      { id: String(f.enrollment.id) },
      { status: 'active' },
    );
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
    const request = {
      ...f.own,
      enrollmentId: String(f.enrollment.id),
      lessonId: String(f.lesson.id),
      policyBasis: 'can-mark-done:any-time',
    };
    await run({ ...f, actions, tracked, request });
  } finally {
    await db.close?.();
  }
}

describe('LearnerService.completeOwnLesson', () => {
  it('completes without prior progress and records actor and basis', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, request, db } = f;
      const result = await as(own, () =>
        service.completeOwnLesson({
          ...request,
          status: 'in_progress',
          attempts: 9,
        } as typeof request),
      );
      expect(f.actions).toEqual([
        { action: 'education.progress.complete-own', own: true },
      ]);
      expect(result.changed).toBe(true);
      expect(result.progress).toMatchObject({
        status: 'complete',
        attempts: 0,
        bestScore: null,
        startedAt: null,
      });
      expect(result.progress.completedAt).toBeInstanceOf(Date);
      const records = await db.list('lesson_completion_records', {});
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        progress_id: result.progress.id,
        actor_user_id: own.actorUserId,
        policy_basis: 'can-mark-done:any-time',
        from_status: 'not_started',
      });
      expect(records[0].submission_id ?? null).toBeNull();
      expect(
        await db.list('lesson_progress_transitions', {
          progress_id: result.progress.id,
        }),
      ).toMatchObject([
        { from_status: 'not_started', to_status: 'complete', kind: 'complete' },
      ]);
    });
  });

  it('keeps counters and score of started work and is idempotent on repeat', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, request, db } = f;
      const started = await as(own, () => service.startLesson(request));
      await as(own, async () => {
        const row = await (await LessonProgressCollection.create({ db })).get(
          started.id,
        );
        if (!row) throw new Error('missing');
        row.attempts = 2;
        row.timeSpentSeconds = 60;
        row.bestScore = 0.5;
        await row.save();
      });
      const done = await as(own, () => service.completeOwnLesson(request));
      expect(done.changed).toBe(true);
      expect(done.progress).toMatchObject({
        id: started.id,
        status: 'complete',
        attempts: 2,
        timeSpentSeconds: 60,
        bestScore: 0.5,
      });
      expect(done.progress.startedAt).toEqual(started.startedAt);
      const again = await as(own, () => service.completeOwnLesson(request));
      expect(again.changed).toBe(false);
      expect(again.progress).toEqual(done.progress);
      expect(await db.list('lesson_completion_records', {})).toHaveLength(1);
      expect(
        await db.list('lesson_progress', {
          enrollment_id: request.enrollmentId,
        }),
      ).toHaveLength(1);
    });
  });

  it('lets the host decide for a guardian and records that actor', async () => {
    await withFixture(async (f) => {
      const { tracked: service, parent, as, request, db } = f;
      f.actions.length = 0;
      const result = await as(parent, () =>
        service.completeOwnLesson({ ...request, ...parent }),
      );
      expect(result.changed).toBe(true);
      expect(f.actions).toEqual([
        { action: 'education.progress.complete-own', own: false },
      ]);
      expect(
        (await db.list('lesson_completion_records', {}))[0].actor_user_id,
      ).toBe(parent.actorUserId);
    });
  });

  it('accepts evidence from the same learner and lesson only', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, request, db } = f;
      const started = await as(own, () => service.startLesson(request));
      const make = async (
        lessonId: string,
        progressId: string,
        status = 'captured',
      ) =>
        as(own, async () =>
          String(
            (
              await (
                await SubmissionCollection.create({ db })
              ).create({
                tenantId: own.tenantId,
                learnerId: own.learnerId,
                lessonId,
                progressId,
                status,
              })
            ).id,
          ),
        );
      const good = await make(request.lessonId, started.id);
      const other = await as(own, () =>
        service.startLesson({
          ...request,
          lessonId: String(f.secondLesson.id),
        }),
      );
      const wrongLesson = await make(String(f.secondLesson.id), other.id);
      const rejected = await make(request.lessonId, started.id, 'rejected');
      for (const submissionId of [
        wrongLesson,
        rejected,
        '00000000-0000-4000-8000-000000000000',
      ])
        await expect(
          as(own, () =>
            service.completeOwnLesson({
              ...request,
              evidence: { submissionId },
            }),
          ),
        ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      await expect(
        as(own, () =>
          service.completeOwnLesson({
            ...request,
            evidence: { submissionId: '' },
          }),
        ),
      ).rejects.toBeInstanceOf(LearnerValidationError);
      expect(await db.list('lesson_completion_records', {})).toHaveLength(0);
      const result = await as(own, () =>
        service.completeOwnLesson({
          ...request,
          evidence: { submissionId: good },
        }),
      );
      expect(result.changed).toBe(true);
      expect(
        (await db.list('lesson_completion_records', {}))[0].submission_id,
      ).toBe(good);
    });
  });

  it('refuses lessons complete through another path', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, request, db } = f;
      const started = await as(own, () => service.startLesson(request));
      await db.update(
        'lesson_progress',
        { id: started.id },
        { status: 'complete', completed_at: new Date() },
      );
      const failure = await as(own, () =>
        service.completeOwnLesson(request),
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(LessonAlreadyCompleteError);
      expect(failure).toBeInstanceOf(LearnerValidationError);
      expect(await db.list('lesson_completion_records', {})).toHaveLength(0);
    });
  });

  it('refuses skipped lessons and inactive enrollments', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, request, db } = f;
      const started = await as(own, () => service.startLesson(request));
      await db.update(
        'lesson_progress',
        { id: started.id },
        { status: 'skipped' },
      );
      await expect(
        as(own, () => service.completeOwnLesson(request)),
      ).rejects.toBeInstanceOf(LessonSkippedError);
      for (const status of ['planned', 'paused', 'completed', 'dropped']) {
        await db.update(
          'enrollments',
          { id: request.enrollmentId },
          { status },
        );
        const failure = await as(own, () =>
          service.completeOwnLesson(request),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(EnrollmentNotActiveError);
        expect((failure as EnrollmentNotActiveError).status).toBe(status);
      }
    });
  });

  it('enforces actor, tenant, lesson scope, basis and host denial', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, request, db } = f;
      for (const actor of [
        { ...request, actorUserId: String(f.bob.user.id) },
        { ...request, learnerId: String(f.sibling.id) },
        { ...request, actorUserId: String(f.stranger.user.id) },
        { ...request, learnerId: String(f.foreign.id) },
      ])
        await expect(
          as(actor, () => service.completeOwnLesson(actor)),
        ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      await expect(
        as(own, () =>
          service.completeOwnLesson({
            ...request,
            lessonId: String(f.wrongLesson.id),
          }),
        ),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      for (const authorize of [
        () => false,
        () => {
          throw new Error('Host unavailable');
        },
      ])
        await expect(
          as(own, () =>
            new LearnerService(db, authorize, () => true).completeOwnLesson(
              request,
            ),
          ),
        ).rejects.toThrow();
      for (const policyBasis of ['', '   ', 'x'.repeat(201), 'a\nb', 7]) {
        const failure = await as(own, () =>
          service.completeOwnLesson({
            ...request,
            policyBasis: policyBasis as string,
          }),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(LearnerValidationError);
      }
      expect(await db.list('lesson_progress', {})).toHaveLength(0);
      expect(await db.list('lesson_completion_records', {})).toHaveLength(0);
    });
  });

  it('fails with a typed error when the history table is not migrated', async () => {
    await withFixture(async (f) => {
      const { tracked: service, own, as, request, db } = f;
      const started = await as(own, () => service.startLesson(request));
      await expect(
        as(own, () => service.completeOwnLesson(request)),
      ).rejects.toBeInstanceOf(LearnerHistoryUnavailableError);
      expect(
        (await db.get('lesson_progress', { id: started.id }))?.status,
      ).toBe('in_progress');
    }, learnerClasses);
  });

  it('works without the optional transitions table', async () => {
    await withFixture(
      async (f) => {
        const { tracked: service, own, as, request } = f;
        const result = await as(own, () => service.completeOwnLesson(request));
        expect(result.changed).toBe(true);
      },
      [...learnerClasses, 'LessonCompletionRecord'],
    );
  });
});
