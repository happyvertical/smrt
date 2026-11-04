import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadingCollection, VideoCollection } from '../collections.js';
import {
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  LearnerValidationError,
} from '../learner-service.js';
import {
  OwnAttestationConflictError,
  OwnAttestationLessonKindError,
  SubmissionService,
} from '../submission-service.js';
import { learnerFixture } from './learner-workflows.js';
import { submissionClasses } from './submission-workflows.js';

const classes = [
  ...submissionClasses,
  'Reading',
  'Video',
  'LessonSelfAttestation',
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

async function setup(
  run: (context: {
    f: Awaited<ReturnType<typeof learnerFixture>>;
    service: SubmissionService;
    withKinds: (kinds: '*' | readonly string[]) => SubmissionService;
    actions: Array<{ action: string; own: boolean }>;
    reading: string;
    video: string;
  }) => Promise<void>,
) {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes,
  });
  const storage = await mkdtemp(join(tmpdir(), 'education-self-attest-'));
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
    const options = {
      storage,
      signAsset: async () => 'https://school.test/signed',
    };
    const service = new SubmissionService(db, authorize, () => true, options);
    const withKinds = (selfAttestableKinds: '*' | readonly string[]) =>
      new SubmissionService(db, authorize, () => true, {
        ...options,
        selfAttestableKinds,
      });
    const sectionId = f.lesson.sectionId;
    const reading = await f.as(f.parent, async () =>
      (await ReadingCollection.create({ db })).create({
        tenantId: f.own.tenantId,
        sectionId,
        title: 'Read chapter one',
      }),
    );
    const video = await f.as(f.parent, async () =>
      (await VideoCollection.create({ db })).create({
        tenantId: f.own.tenantId,
        sectionId,
        title: 'Watch the river video',
        videoUrl: 'https://video.test/river',
      }),
    );
    await run({
      f,
      service,
      withKinds,
      actions,
      reading: String(reading.id),
      video: String(video.id),
    });
  } finally {
    await rm(storage, { recursive: true, force: true });
    await db.close?.();
  }
}

describe('SubmissionService.attestOwnLesson', () => {
  it('records an ungraded self-reported attestation awaiting confirmation', async () => {
    await setup(async ({ f, service, actions, reading }) => {
      const request = {
        ...f.own,
        enrollmentId: String(f.enrollment.id),
        lessonId: reading,
        policyBasis: 'learner-can-mark-done',
      };
      actions.length = 0;
      const attested = await f.as(f.own, () =>
        service.attestOwnLesson({
          ...request,
          notes: 'I read it',
          score: 1,
          status: 'graded',
        } as typeof request),
      );
      expect(actions).toEqual([
        { action: 'education.learner.attest-own', own: true },
      ]);
      expect(attested).toMatchObject({
        status: 'captured',
        notes: 'I read it',
        selfReported: true,
        grade: null,
        pages: [],
      });
      const progress = await f.db.get('lesson_progress', {
        id: attested.progressId,
      });
      expect(progress?.status).toBe('submitted');
      expect(Number(progress?.attempts)).toBe(1);
      expect(progress?.best_score).toBeNull();
      expect(progress?.completed_at).toBeNull();
      expect(await f.db.list('grades', {})).toHaveLength(0);
      const mark = await f.db.get('lesson_self_attestations', {
        submission_id: attested.id,
      });
      expect(mark).toMatchObject({
        actor_user_id: f.own.actorUserId,
        policy_basis: 'learner-can-mark-done',
        progress_id: attested.progressId,
      });
      expect(
        (await f.db.get('submissions', { id: attested.id }))?._meta_type,
      ).toBe('@happyvertical/smrt-education:Attestation');
      // A repeat is the same statement, with no second attempt.
      const again = await f.as(f.own, () => service.attestOwnLesson(request));
      expect(again.id).toBe(attested.id);
      expect(
        Number(
          (await f.db.get('lesson_progress', { id: attested.progressId }))
            ?.attempts,
        ),
      ).toBe(1);
      // Evidence reads keep it apart from guardian-confirmed completion.
      const latest = await f.as(f.parent, () =>
        service.getLatestLessonSubmission({
          ...f.parent,
          enrollmentId: String(f.enrollment.id),
          lessonId: reading,
        }),
      );
      expect(latest).toMatchObject({
        id: attested.id,
        selfReported: true,
        grade: null,
      });
      // The guardian confirms through the existing attestation path.
      const confirmed = await f.as(f.parent, () =>
        service.attestLesson({
          ...f.parent,
          enrollmentId: String(f.enrollment.id),
          lessonId: reading,
        }),
      );
      expect(confirmed).toMatchObject({
        id: attested.id,
        status: 'graded',
        selfReported: true,
        grade: { graderKind: 'guardian' },
      });
      expect(
        (await f.db.get('lesson_progress', { id: attested.progressId }))
          ?.status,
      ).toBe('complete');
      // A guardian's own attestation is not marked self-reported.
      const guardian = await f.as(f.parent, () =>
        service.attestLesson({
          ...f.parent,
          enrollmentId: String(f.enrollment.id),
          lessonId: String(f.secondLesson.id),
        }),
      );
      expect(guardian.selfReported).toBeUndefined();
    });
  });

  it('allows only the learner, Reading/Video lessons and open progress', async () => {
    await setup(async ({ f, service, actions, video }) => {
      const base = {
        ...f.own,
        enrollmentId: String(f.enrollment.id),
        policyBasis: 'learner-can-mark-done',
      };
      // Guardians use attestLesson; the host is never asked.
      actions.length = 0;
      await expect(
        f.as(f.parent, () =>
          service.attestOwnLesson({ ...base, ...f.parent, lessonId: video }),
        ),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      expect(actions).toEqual([]);
      const sibling = { ...base, actorUserId: String(f.bob.user.id) };
      await expect(
        f.as(sibling, () =>
          service.attestOwnLesson({ ...sibling, lessonId: video }),
        ),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      await expect(
        f.as(f.own, () =>
          service.attestOwnLesson({
            ...base,
            lessonId: String(f.wrongLesson.id),
          }),
        ),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
      const worksheet = await f.as(f.own, () =>
        service
          .attestOwnLesson({ ...base, lessonId: String(f.lesson.id) })
          .catch((error: unknown) => error),
      );
      expect(worksheet).toBeInstanceOf(OwnAttestationLessonKindError);
      // The rejected request left no progress behind.
      expect(
        await f.db.list('lesson_progress', { lesson_id: f.lesson.id }),
      ).toHaveLength(0);
      for (const policyBasis of ['', 'a\u0000b'])
        await expect(
          f.as(f.own, () =>
            service.attestOwnLesson({ ...base, lessonId: video, policyBasis }),
          ),
        ).rejects.toBeInstanceOf(LearnerValidationError);
      // Finished work is not re-attested.
      const started = await f.as(f.own, () =>
        service.startLesson({ ...base, lessonId: video }),
      );
      await f.db.update(
        'lesson_progress',
        { id: started.id },
        { status: 'complete' },
      );
      const finished = await f.as(f.own, () =>
        service
          .attestOwnLesson({ ...base, lessonId: video })
          .catch((error: unknown) => error),
      );
      expect(finished).toBeInstanceOf(OwnAttestationConflictError);
      expect(finished).toMatchObject({ status: 'complete' });
      expect(await f.db.list('lesson_self_attestations', {})).toHaveLength(0);
    });
  });

  it('lets the host choose self-attestable kinds', async () => {
    await setup(async ({ f, service, withKinds }) => {
      const base = {
        ...f.own,
        enrollmentId: String(f.enrollment.id),
        policyBasis: 'learner-can-mark-done',
      };
      const worksheet = String(f.lesson.id);
      const kindOf = (e: unknown) => e as OwnAttestationLessonKindError;
      // Default: a worksheet-kind lesson is refused.
      const refused = await f.as(f.own, () =>
        service
          .attestOwnLesson({ ...base, lessonId: worksheet })
          .catch((e: unknown) => e),
      );
      expect(refused).toBeInstanceOf(OwnAttestationLessonKindError);
      // A list allows only the listed kinds.
      const listed = withKinds(['Video']);
      const stillRefused = await f.as(f.own, () =>
        listed
          .attestOwnLesson({ ...base, lessonId: worksheet })
          .catch((e: unknown) => e),
      );
      expect(stillRefused).toBeInstanceOf(OwnAttestationLessonKindError);
      expect(kindOf(stillRefused).kind).toBe(kindOf(refused).kind);
      const readingRefused = await f.as(f.own, () =>
        listed
          .attestOwnLesson({ ...base, lessonId: String(f.lesson.id) })
          .catch((e: unknown) => e),
      );
      expect(readingRefused).toBeInstanceOf(OwnAttestationLessonKindError);
      const kind = kindOf(refused).kind;
      const named = withKinds([kind]);
      const allowed = await f.as(f.own, () =>
        named.attestOwnLesson({ ...base, lessonId: worksheet }),
      );
      expect(allowed.selfReported).toBe(true);
      // '*' allows it too, idempotently.
      const all = withKinds('*');
      const again = await f.as(f.own, () =>
        all.attestOwnLesson({ ...base, lessonId: worksheet }),
      );
      expect(again.id).toBe(allowed.id);
      // The guardian is still refused.
      await expect(
        f.as(f.parent, () =>
          all.attestOwnLesson({ ...base, ...f.parent, lessonId: worksheet }),
        ),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    });
  });
});
