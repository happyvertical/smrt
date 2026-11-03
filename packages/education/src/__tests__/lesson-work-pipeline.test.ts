import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LessonWorkService } from '../lesson-work-service.js';
import {
  LessonWorkWorkflowRequiredError,
  SubmissionService,
} from '../submission-service.js';
import { learnerFixture } from './learner-workflows.js';
import { workbookClasses } from './lesson-work-workflows.js';
import { submissionClasses } from './submission-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const png = (text: string, pageKey?: string) => ({
  name: `${text}.png`,
  mimeType: 'image/png' as const,
  data: Buffer.from(text),
  ...(pageKey ? { pageKey } : {}),
});
async function fixture() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [...new Set([...submissionClasses, ...workbookClasses])],
  });
  const f = await learnerFixture(db);
  const storage = await mkdtemp(join(tmpdir(), 'lesson-work-pipeline-'));
  const authorize = ({
    own,
    relationshipTypeId,
  }: {
    own: boolean;
    relationshipTypeId?: string | null;
  }) => own || relationshipTypeId === f.guardianType.id;
  const plain = new SubmissionService(db, authorize, () => true, { storage });
  const work = new LessonWorkService(db, authorize, () => true, { storage });
  const target = {
    enrollmentId: String(f.enrollment.id),
    lessonId: String(f.lesson.id),
  };
  return {
    ...f,
    db,
    plain,
    work,
    target,
    close: async () => {
      await db.close?.();
      await rm(storage, { recursive: true, force: true });
    },
  };
}

it('records every ordinary hand-in as lesson work and completes it on the guardian grade', async () => {
  const f = await fixture();
  try {
    const capture = {
      ...f.own,
      ...f.target,
      requestKey: 'worksheet',
      pages: [png('front'), png('back')],
    };
    const submitted = await f.as(f.own, () =>
      f.plain.captureSubmission(capture),
    );
    expect(submitted.pages.map((p) => p.pageKey)).toEqual(['p1', 'p2']);
    // A replay is a no-op: same submission, one activity, one attempt.
    expect(
      (await f.as(f.own, () => f.plain.captureSubmission(capture))).id,
    ).toBe(submitted.id);
    const activities = await f.as(f.parent, () =>
      f.work.listLessonActivities({
        ...f.parent,
        courseId: String(f.course.id),
      }),
    );
    expect(activities).toHaveLength(1);
    const [activity] = activities;
    expect(activity).toMatchObject({
      lessonId: String(f.lesson.id),
      latestSubmissionId: submitted.id,
      filing: { state: 'identified' },
      completion: { status: 'doing' },
    });
    expect(await f.db.list('workbook_attempts', {})).toHaveLength(1);
    const timeline = await f.as(f.parent, () =>
      f.work.getWorkTimeline({ ...f.parent, activityId: activity.id }),
    );
    expect(timeline.attempts.map((a) => a.submissionId)).toEqual([
      submitted.id,
    ]);
    const graded = await f.as(f.parent, () =>
      f.plain.reviewSubmission({
        ...f.parent,
        enrollmentId: f.target.enrollmentId,
        submissionId: submitted.id,
        score: 0.75,
        feedback: 'Well done',
      }),
    );
    expect(graded.grade?.feedback).toBe('Well done');
    // The guardian grade is an ordinary learner's feedback.
    expect(
      (
        await f.as(f.own, () =>
          f.plain.getSubmission({
            ...f.own,
            enrollmentId: f.target.enrollmentId,
            submissionId: submitted.id,
          }),
        )
      ).grade?.score,
    ).toBe(0.75);
    const decisions = await f.db.list('workbook_completion_decisions', {});
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      activity_id: activity.id,
      submission_id: submitted.id,
      actor_user_id: f.parent.actorUserId,
    });
    expect(
      await f.as(f.parent, () =>
        f.work.getLessonActivity({ ...f.parent, activityId: activity.id }),
      ),
    ).toMatchObject({ completion: { status: 'complete' } });
    const progress = await f.as(f.own, () =>
      f.plain.listProgress({ ...f.own, enrollmentId: f.target.enrollmentId }),
    );
    expect(
      progress.find((p) => p.lessonId === String(f.lesson.id)),
    ).toMatchObject({ status: 'complete', bestScore: 0.75 });
    // A regrade keeps the one decision bound to the graded attempt.
    await f.as(f.parent, () =>
      f.plain.reviewSubmission({
        ...f.parent,
        enrollmentId: f.target.enrollmentId,
        submissionId: submitted.id,
        score: 1,
      }),
    );
    expect(await f.db.list('workbook_completion_decisions', {})).toHaveLength(
      1,
    );
    // A sibling's or another family's learner never sees this work.
    await expect(
      f.as(f.parent, () =>
        f.work.getLessonActivity({
          ...f.parent,
          learnerId: String(f.sibling.id),
          activityId: activity.id,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        f.work.getLessonActivity({
          ...f.parent,
          tenantId: String(f.foreign.tenantId),
          activityId: activity.id,
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it('lets a correction replace individual pages while grades stay on their submission (#4613)', async () => {
  const f = await fixture();
  try {
    const first = await f.as(f.own, () =>
      f.plain.captureSubmission({
        ...f.own,
        ...f.target,
        requestKey: 'three-pages',
        pages: [png('one v1'), png('two v1'), png('three v1')],
      }),
    );
    await f.as(f.parent, () =>
      f.plain.reviewSubmission({
        ...f.parent,
        enrollmentId: f.target.enrollmentId,
        submissionId: first.id,
        score: 0.5,
        feedback: 'Fix page 2',
      }),
    );
    await expect(
      f.as(f.own, () =>
        f.plain.resubmitSubmission({
          ...f.own,
          ...f.target,
          previousSubmissionId: first.id,
          requestKey: 'dupe',
          intakeItemId: 'dupe',
          pages: [png('a', 'p2'), png('b', 'p2')],
        }),
      ),
    ).rejects.toThrow('distinct page keys');
    await expect(
      f.as(f.own, () =>
        f.plain.resubmitSubmission({
          ...f.own,
          ...f.target,
          previousSubmissionId: first.id,
          requestKey: 'bad',
          intakeItemId: 'bad',
          pages: [{ ...png('a'), pageKey: '' }],
        }),
      ),
    ).rejects.toThrow('distinct page keys');
    const second = await f.as(f.own, () =>
      f.plain.resubmitSubmission({
        ...f.own,
        ...f.target,
        previousSubmissionId: first.id,
        requestKey: 'fix-page-2',
        intakeItemId: 'fix-page-2',
        pages: [png('two v2', 'p2')],
      }),
    );
    expect(second.pages.map((p) => p.pageKey)).toEqual(['p2']);
    // The first grade stays bound to the first submission.
    expect(
      (
        await f.as(f.parent, () =>
          f.plain.getSubmission({
            ...f.parent,
            enrollmentId: f.target.enrollmentId,
            submissionId: first.id,
          }),
        )
      ).grade?.feedback,
    ).toBe('Fix page 2');
    await expect(
      f.as(f.parent, () =>
        f.plain.reviewSubmission({
          ...f.parent,
          enrollmentId: f.target.enrollmentId,
          submissionId: first.id,
          score: 1,
        }),
      ),
    ).rejects.toThrow('current submission');
    const third = await f.as(f.own, () =>
      f.plain.resubmitSubmission({
        ...f.own,
        ...f.target,
        previousSubmissionId: second.id,
        requestKey: 'add-page-4',
        intakeItemId: 'add-page-4',
        pages: [png('two v3', 'p2'), png('four v1', 'p4')],
      }),
    );
    const [activity] = await f.as(f.parent, () =>
      f.work.listLessonActivities(f.parent),
    );
    const timeline = await f.as(f.parent, () =>
      f.work.getWorkTimeline({ ...f.parent, activityId: activity.id }),
    );
    const latest = timeline.attempts.find((a) => a.submissionId === third.id);
    if (!latest) throw new Error('Missing latest attempt');
    expect(new Set(timeline.attempts.map((a) => a.episodeId)).size).toBe(1);
    const asset = (submission: typeof first, key: string) =>
      submission.pages.find((p) => p.pageKey === key)?.assetId;
    expect(
      latest.pages.map((p) => [
        p.pageKey,
        p.current.assetId,
        p.versions.map((v) => v.submissionId),
      ]),
    ).toEqual([
      ['p1', asset(first, 'p1'), [first.id]],
      ['p2', asset(third, 'p2'), [first.id, second.id, third.id]],
      ['p3', asset(first, 'p3'), [first.id]],
      ['p4', asset(third, 'p4'), [third.id]],
    ]);
    // An older attempt folds only its own ancestry.
    const middle = timeline.attempts.find((a) => a.submissionId === second.id);
    expect(middle?.pages.map((p) => [p.pageKey, p.versions.length])).toEqual([
      ['p1', 1],
      ['p2', 2],
      ['p3', 1],
    ]);
  } finally {
    await f.close();
  }
});

it('keeps book and loose-page work on the lesson work workflow', async () => {
  const f = await fixture();
  try {
    const page = await f.as(f.parent, () =>
      f.work.resolveBookPageActivity({
        ...f.parent,
        bookKey: 'isbn:1',
        title: 'Book',
        pageKey: 'p1',
        pageLabel: 'Page 1',
      }),
    );
    const scope = {
      ...f.own,
      enrollmentId: page.enrollmentId,
      lessonId: page.lessonId,
    };
    await expect(
      f.as(f.own, () =>
        f.plain.captureSubmission({
          ...scope,
          requestKey: 'generic',
          pages: [png('x')],
        }),
      ),
    ).rejects.toBeInstanceOf(LessonWorkWorkflowRequiredError);
    await expect(
      f.as(f.own, () => f.plain.assertOrdinarySubmissionScope(scope)),
    ).rejects.toBeInstanceOf(LessonWorkWorkflowRequiredError);
    await f.as(f.own, () =>
      f.plain.assertOrdinarySubmissionScope({ ...f.own, ...f.target }),
    );
    // The course decides, not an existing activity: a book lesson without
    // any work yet is still book work, and so is the bare enrollment.
    const pageLesson = await f.db.get('lessons', { id: page.lessonId });
    const blank = {
      ...pageLesson,
      id: globalThis.crypto.randomUUID(),
      slug: globalThis.crypto.randomUUID(),
      title: 'Untouched page',
    };
    const columns = Object.keys(blank);
    await f.db.query(
      `INSERT INTO lessons (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(blank),
    );
    await expect(
      f.as(f.own, () =>
        f.plain.captureSubmission({
          ...scope,
          lessonId: blank.id,
          requestKey: 'untouched',
          pages: [png('y')],
        }),
      ),
    ).rejects.toBeInstanceOf(LessonWorkWorkflowRequiredError);
    await expect(
      f.as(f.own, () =>
        f.plain.assertOrdinarySubmissionScope({
          ...f.own,
          enrollmentId: page.enrollmentId,
        }),
      ),
    ).rejects.toBeInstanceOf(LessonWorkWorkflowRequiredError);
    const attempt = await f.as(f.own, () =>
      f.work.captureLessonWork({
        ...f.own,
        activityId: page.id,
        requestKey: 'book',
        pages: [png('book page', 'p1')],
      }),
    );
    expect(attempt.pages.map((p) => p.pageKey)).toEqual(['p1']);
    expect(attempt.reviewRequired).toBe(true);
    // Guardian grading of book work does not complete it.
    await f.as(f.parent, () =>
      f.plain.reviewSubmission({
        ...f.parent,
        enrollmentId: page.enrollmentId,
        submissionId: attempt.submissionId,
        score: 1,
      }),
    );
    expect(await f.db.list('workbook_completion_decisions', {})).toEqual([]);
    expect(
      (
        await f.as(f.own, () =>
          f.plain.getSubmission({
            ...f.own,
            enrollmentId: page.enrollmentId,
            submissionId: attempt.submissionId,
          }),
        )
      ).grade,
    ).toBeNull();
  } finally {
    await f.close();
  }
});
