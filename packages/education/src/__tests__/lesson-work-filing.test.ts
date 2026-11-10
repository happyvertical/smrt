import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CourseCollection } from '../collections.js';
import type { LearnerRequest } from '../learner-service.js';
import {
  LessonWorkPlacementError,
  WORK_MATH_VOCABULARY,
} from '../lesson-work-contracts.js';
import {
  LessonActivityCollection,
  LessonWorkFiling,
  LessonWorkFilingCollection,
} from '../lesson-work-models.js';
import { LessonWorkService } from '../lesson-work-service.js';
import { WorkbookPhotoIntakeCollection } from '../workbook-photo-models.js';
import { learnerFixture } from './learner-workflows.js';
import { workbookClasses } from './lesson-work-workflows.js';

class UnfiledTestService extends LessonWorkService {
  resolveUnfiled(request: LearnerRequest & { intakeId: string }) {
    return this.withTransaction((service) =>
      service.resolveUnfiledActivityInScope(request),
    );
  }
}
beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
async function fixture() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: workbookClasses,
  });
  const f = await learnerFixture(db);
  const storage = await mkdtemp(join(tmpdir(), 'filed-work-'));
  const service = new UnfiledTestService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
    { storage },
  );
  const receipt = await f.as(f.parent, async () =>
    (await WorkbookPhotoIntakeCollection.create({ db })).create({
      tenantId: f.parent.tenantId,
      learnerId: f.parent.learnerId,
      itemId: 'unfiled-photo',
      actorUserId: f.parent.actorUserId,
      contentDigest: 'a'.repeat(64),
    }),
  );
  const request = { ...f.parent, intakeId: String(receipt.id) };
  const work = await f.as(f.parent, () => service.resolveUnfiled(request));
  const capture = {
    ...f.parent,
    activityId: work.id,
    requestKey: 'capture',
    intakeItemId: 'unfiled-photo',
    pages: [
      {
        name: 'p.png',
        mimeType: 'image/png' as const,
        data: Buffer.from('unfiled synthetic work'),
      },
    ],
  };
  return {
    ...f,
    db,
    service,
    receipt,
    request,
    work,
    capture,
    close: async () => {
      await db.close?.();
      await rm(storage, { recursive: true, force: true });
    },
  };
}
type F = Awaited<ReturnType<typeof fixture>>;
const filings = async (f: F) =>
  f.as(f.parent, async () =>
    (await LessonWorkFilingCollection.create({ db: f.db })).list({
      where: { sourceActivityId: f.work.id },
    }),
  );

it('binds one identity-free work unit to an exact receipt with no placement', async () => {
  const f = await fixture();
  try {
    expect(f.work).toMatchObject({
      courseId: '',
      courseTitle: '',
      bookKey: '',
      bookEdition: '',
      pageKey: `receipt:${f.receipt.id}`,
      pageLabel: 'Captured work',
      pages: [],
      reviewRequired: true,
      policyVersion: 1,
      filing: { state: 'unfiled', placement: null, revisionId: null },
    });
    expect(
      await f.as(f.parent, () => f.service.resolveUnfiled(f.request)),
    ).toEqual(f.work);
    await expect(
      f.as(f.own, () =>
        f.service.resolveUnfiled({ ...f.own, intakeId: String(f.receipt.id) }),
      ),
    ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        f.service.resolveUnfiled({
          ...f.request,
          learnerId: String(f.sibling.id),
        }),
      ),
    ).rejects.toThrow();
    await f.as(f.parent, async () => {
      const activities = await LessonActivityCollection.create({ db: f.db });
      const row = await activities.get({ id: f.work.id }, { cache: false });
      if (!row) throw new Error('Missing work unit');
      await expect(row.save()).rejects.toThrow('immutable');
      await expect(
        activities.create({
          tenantId: f.parent.tenantId,
          learnerId: f.parent.learnerId,
          enrollmentId: f.work.enrollmentId,
          lessonId: f.work.lessonId,
          captureKind: 'unfiled',
        }),
      ).rejects.toThrow('photo receipt');
    });
    expect(
      (
        await f.as(f.parent, () =>
          f.service.listLessonActivities({ ...f.parent, filing: 'unfiled' }),
        )
      ).map((a) => a.id),
    ).toEqual([f.work.id]);
  } finally {
    await f.close();
  }
});

it('places work on an existing book page exactly once and moves it out of unfiled', async () => {
  const f = await fixture();
  try {
    const canonical = await f.as(f.parent, () =>
      f.service.resolveBookPageActivity({
        ...f.parent,
        bookKey: 'real-copy',
        title: 'Real workbook',
        pageKey: 'p7',
        pageLabel: 'Page 7',
      }),
    );
    expect(canonical).toMatchObject({
      bookKey: 'real-copy',
      courseTitle: 'Real workbook',
      pageKey: 'p7',
      pageLabel: 'Page 7',
      filing: { state: 'identified' },
    });
    expect(canonical.pages.map((p) => p.pageKey)).toEqual(['p7']);
    await f.as(f.parent, () =>
      f.service.setCourseWorkPolicy({
        ...f.parent,
        courseId: canonical.courseId,
        expectedPolicyVersion: 1,
        reviewRequired: false,
      }),
    );
    await expect(
      f.as(f.parent, () =>
        f.service.captureLessonWork({ ...f.capture, intakeItemId: 'other' }),
      ),
    ).rejects.toThrow('original photo receipt');
    const attempt = await f.as(f.parent, () =>
      f.service.captureLessonWork(f.capture),
    );
    const evidence = {
      ...f.parent,
      activityId: f.work.id,
      submissionId: attempt.submissionId,
    };
    const anchors = await f.as(f.parent, () =>
      f.service.getWorkSourceAnchors(evidence),
    );
    const ai = await f.as(f.parent, () =>
      f.service.recordWorkAnalysis({
        ...evidence,
        requestKey: 'analysis',
        assessment: {
          version: 1,
          feedback: 'Correct',
          vocabulary: structuredClone(WORK_MATH_VOCABULARY),
          provenance: {
            provider: 'synthetic',
            model: 'test',
            configurationVersion: '1',
            rubricVersion: '1',
            inputHash: anchors[0].sha256,
            analysisId: 'unfiled-analysis',
          },
          questions: [
            {
              id: 'visible:q1',
              prompt: '1+1',
              answer: '2',
              result: 'correct',
              reason: 'none',
              feedback: 'Correct',
              points: null,
              possiblePoints: null,
              anchors: [{ ...anchors[0], page: 1, rect: [0, 0, 1, 1] }],
              conceptIds: ['math.addition'],
            },
          ],
        },
      }),
    );
    const approved = await f.as(f.parent, () =>
      f.service.reviewWorkAssessment({
        ...evidence,
        revisionId: ai.id,
        expectedHeadId: null,
        requestKey: 'review',
      }),
    );
    const originalTimeline = await f.as(f.parent, () =>
      f.service.getWorkTimeline({ ...f.parent, activityId: f.work.id }),
    );
    const original = await f.db.get('workbook_activities', { id: f.work.id });
    const filing = {
      ...f.parent,
      activityId: f.work.id,
      courseId: canonical.courseId,
      pageKey: 'p7',
      expectedRevisionId: null,
      requestKey: 'file-1',
      reason: 'Guardian identified this page',
    };
    // Authority and target guards.
    await expect(
      f.as(f.own, () => f.service.fileLessonWork({ ...filing, ...f.own })),
    ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        f.service.fileLessonWork({
          ...filing,
          learnerId: String(f.sibling.id),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        f.service.fileLessonWork({
          ...filing,
          activityId: canonical.id,
          requestKey: 'ordinary',
        }),
      ),
    ).rejects.toThrow('Only unfiled');
    const filed = await f.as(f.parent, () => f.service.fileLessonWork(filing));
    expect(filed).toMatchObject({
      id: f.work.id,
      enrollmentId: f.work.enrollmentId,
      lessonId: f.work.lessonId,
      courseId: canonical.courseId,
      courseTitle: 'Real workbook',
      bookKey: 'real-copy',
      pageKey: 'p7',
      pageLabel: 'Page 7',
      reviewRequired: false,
      policyVersion: 2,
      filing: {
        state: 'filed',
        placement: {
          courseId: canonical.courseId,
          enrollmentId: canonical.enrollmentId,
          lessonId: canonical.lessonId,
          lessonPageId: canonical.pages[0].id,
        },
      },
    });
    // Replays are no-ops; changed replays and stale heads conflict.
    expect(
      await f.as(f.parent, () => f.service.fileLessonWork(filing)),
    ).toEqual(filed);
    expect(await filings(f)).toHaveLength(1);
    await expect(
      f.as(f.parent, () =>
        f.service.fileLessonWork({ ...filing, reason: 'Changed retry' }),
      ),
    ).rejects.toThrow('retry changed');
    await expect(
      f.as(f.parent, () =>
        f.service.fileLessonWork({ ...filing, requestKey: 'stale' }),
      ),
    ).rejects.toThrow('head changed');
    expect(await filings(f)).toHaveLength(1);
    // Work leaves unfiled and appears in the course; routing never moved.
    expect(
      await f.as(f.parent, () =>
        f.service.listLessonActivities({ ...f.parent, filing: 'unfiled' }),
      ),
    ).toEqual([]);
    expect(
      (
        await f.as(f.parent, () =>
          f.service.listLessonActivities({
            ...f.parent,
            courseId: canonical.courseId,
          }),
        )
      )
        .map((a) => a.id)
        .sort(),
    ).toEqual([canonical.id, f.work.id].sort());
    expect(await f.db.get('workbook_activities', { id: f.work.id })).toEqual(
      original,
    );
    const progress = await f.db.list('lesson_progress', {
      enrollment_id: canonical.enrollmentId,
      lesson_id: canonical.lessonId,
    });
    expect(progress).toHaveLength(1);
    expect(progress[0].status).toBe('submitted');
    expect(
      (
        await f.as(f.parent, () =>
          f.service.getWorkTimeline({ ...f.parent, activityId: f.work.id }),
        )
      ).attempts,
    ).toEqual(originalTimeline.attempts);
    // A rolled-back refile leaves the head where it was.
    await expect(
      f.as(f.parent, () =>
        f.service.withTransaction(async (tx) => {
          await tx.fileLessonWork({
            ...filing,
            pageKey: 'p8',
            expectedRevisionId: filed.filing.revisionId,
            requestKey: 'rollback',
          });
          throw new Error('rollback');
        }),
      ),
    ).rejects.toThrow('rollback');
    expect(
      await f.as(f.parent, () =>
        f.service.getLessonActivity({ ...f.parent, activityId: f.work.id }),
      ),
    ).toEqual(filed);
    // Completion of the placed work completes the target lesson's progress.
    await f.as(f.parent, () =>
      f.service.completeLessonActivity({
        ...evidence,
        expectedAttemptId: attempt.id,
        expectedHeadId: approved.id,
        requestKey: 'complete',
      }),
    );
    // Read straight away: the destination follows the completion itself.
    const statusAt = async (lessonId: string | undefined) =>
      (
        await f.db.list('lesson_progress', {
          enrollment_id: canonical.enrollmentId,
          lesson_id: lessonId,
        })
      ).map((p) => p.status);
    expect(await statusAt(canonical.lessonId)).toEqual(['complete']);
    // The public projection agrees: the page's own activity is not complete,
    // but the work filed onto it is.
    const projected = async (lessonId: string | undefined) =>
      (
        await f.as(f.parent, () =>
          f.service.listProgress({
            ...f.parent,
            enrollmentId: canonical.enrollmentId,
          }),
        )
      ).find((p) => p.lessonId === lessonId);
    expect(await projected(canonical.lessonId)).toMatchObject({
      status: 'complete',
      completedAt: expect.any(Date),
    });
    const refiled = await f.as(f.parent, () =>
      f.service.fileLessonWork({
        ...filing,
        pageKey: 'p8',
        pageLabel: 'Page 8',
        expectedRevisionId: filed.filing.revisionId,
        requestKey: 'file-2',
      }),
    );
    expect(refiled.pageKey).toBe('p8');
    expect(refiled.filing.placement?.lessonId).not.toBe(canonical.lessonId);
    const done = await f.db.list('lesson_progress', {
      enrollment_id: canonical.enrollmentId,
      lesson_id: refiled.filing.placement?.lessonId,
    });
    expect(done.map((p) => p.status)).toEqual(['complete']);
    await f.as(f.parent, async () => {
      const rows = await filings(f);
      expect(rows).toHaveLength(2);
      await expect(rows[0].save()).rejects.toThrow('immutable');
      await expect(rows[0].delete()).rejects.toThrow('immutable');
    });
    // A correction keeps its episode and takes the placed course's policy.
    const correction = await f.as(f.parent, () =>
      f.service.captureLessonWork({
        ...f.capture,
        requestKey: 'correction',
        intakeItemId: 'correction-intake',
        previousSubmissionId: attempt.submissionId,
        pages: [{ ...f.capture.pages[0], data: Buffer.from('corrected') }],
      }),
    );
    // The correction reopens the work, and its destination with it.
    expect(await statusAt(refiled.filing.placement?.lessonId)).toEqual([
      'submitted',
    ]);
    expect(await projected(refiled.filing.placement?.lessonId)).toMatchObject({
      completedAt: null,
    });
    expect(
      (await projected(refiled.filing.placement?.lessonId))?.status,
    ).not.toBe('complete');
    expect(correction).toMatchObject({
      activityId: f.work.id,
      episodeId: attempt.episodeId,
      previousAttemptId: attempt.id,
      reviewRequired: false,
      policyVersion: 2,
    });
  } finally {
    await f.close();
  }
});

it('creates a new book and its page lesson atomically, never merging by title', async () => {
  const f = await fixture();
  try {
    const next = {
      ...f.parent,
      activityId: f.work.id,
      expectedRevisionId: null,
      requestKey: 'new-book',
      reason: 'No book record existed',
    };
    await expect(
      f.as(f.parent, () =>
        f.service.fileLessonWork({
          ...next,
          courseId: String(f.course.id),
          newBook: { title: 'Both' },
        }),
      ),
    ).rejects.toThrow('exactly one');
    await expect(
      f.as(f.parent, () =>
        f.service.fileLessonWork({
          ...next,
          newBook: { title: 'Has lesson' },
          lessonId: String(f.lesson.id),
        }),
      ),
    ).rejects.toThrow('no existing lesson');
    const failed = vi
      .spyOn(LessonWorkFiling.prototype, 'save')
      .mockRejectedValueOnce(new Error('injected filing failure'));
    try {
      await expect(
        f.as(f.parent, () =>
          f.service.fileLessonWork({
            ...next,
            requestKey: 'rollback-book',
            newBook: { title: 'Rolled back book' },
          }),
        ),
      ).rejects.toThrow('injected filing failure');
    } finally {
      failed.mockRestore();
    }
    expect(
      await f.db.get('courses', { title: 'Rolled back book' }),
    ).toBeFalsy();
    const filed = await f.as(f.parent, () =>
      f.service.fileLessonWork({
        ...next,
        newBook: {
          title: 'Manually named book',
          edition: '2026',
          subject: 'Mathematics',
        },
      }),
    );
    expect((await f.db.get('courses', { id: filed.courseId }))?.subject).toBe(
      'Mathematics',
    );
    expect(filed).toMatchObject({
      courseTitle: 'Manually named book',
      bookEdition: '2026',
      pageLabel: 'Captured work',
      filing: { state: 'filed' },
    });
    expect(filed.bookKey).toMatch(/^manual:/);
    expect(
      await f.as(f.parent, () =>
        f.service.fileLessonWork({
          ...next,
          newBook: {
            title: 'Manually named book',
            edition: '2026',
            subject: 'Mathematics',
          },
        }),
      ),
    ).toEqual(filed);
    await expect(
      f.as(f.parent, () =>
        f.service.fileLessonWork({
          ...next,
          requestKey: 'bad-subject',
          newBook: { title: 'Bad', subject: 'x'.repeat(201) },
        }),
      ),
    ).rejects.toThrow('subject');
    // Set and clear a family book's subject; never a shared or plain course.
    const setSubject = (
      request: typeof f.parent,
      courseId: string,
      subject: string | null,
    ) =>
      f.as(request, () =>
        f.service.setBookCourseSubject({ ...request, courseId, subject }),
      );
    expect(await setSubject(f.parent, filed.courseId, 'Arithmetic')).toEqual({
      courseId: filed.courseId,
      subject: 'Arithmetic',
    });
    expect((await setSubject(f.parent, filed.courseId, null)).subject).toBe('');
    expect((await f.db.get('courses', { id: filed.courseId }))?.subject).toBe(
      '',
    );
    await expect(setSubject(f.own, filed.courseId, 'Mine')).rejects.toThrow();
    await expect(
      setSubject(f.parent, String(f.course.id), 'Plain'),
    ).rejects.toThrow();
    await expect(
      setSubject(
        { ...f.parent, tenantId: String(f.foreign.tenantId) },
        filed.courseId,
        'Foreign',
      ),
    ).rejects.toThrow();
    // A shared catalog course is never a family's to change.
    const catalog = await (await CourseCollection.create({ db: f.db })).create({
      title: 'Shared catalog course',
      licenseKind: 'open-license',
    });
    await expect(
      setSubject(f.parent, String(catalog.id), 'Shared'),
    ).rejects.toThrow();
    const duplicateTitle = await f.as(f.parent, () =>
      f.service.fileLessonWork({
        ...next,
        expectedRevisionId: filed.filing.revisionId,
        requestKey: 'separate-copy',
        newBook: { title: 'Manually named book', edition: '2026' },
      }),
    );
    expect(duplicateTitle.courseId).not.toBe(filed.courseId);
    await expect(
      f.as(f.parent, () =>
        f.service.fileLessonWork({
          ...next,
          expectedRevisionId: duplicateTitle.filing.revisionId,
          requestKey: 'key-clash',
          newBook: { title: 'Other title', bookKey: filed.bookKey },
        }),
      ),
    ).rejects.toThrow('another title or edition');
  } finally {
    await f.close();
  }
});

it('places work only in enrolled courses and on lessons of that course', async () => {
  const f = await fixture();
  try {
    const base = {
      ...f.parent,
      activityId: f.work.id,
      expectedRevisionId: null,
      reason: 'Guardian files',
    };
    const otherCourseId = await courseOf(f, f.wrongLesson);
    const notEnrolled = f.as(f.parent, () =>
      f.service.fileLessonWork({
        ...base,
        courseId: otherCourseId,
        requestKey: 'not-enrolled',
      }),
    );
    await expect(notEnrolled).rejects.toBeInstanceOf(LessonWorkPlacementError);
    await expect(notEnrolled).rejects.toMatchObject({ code: 'not-enrolled' });
    await expect(
      f.as(f.parent, () =>
        f.service.fileLessonWork({
          ...base,
          courseId: String(f.course.id),
          lessonId: String(f.wrongLesson.id),
          requestKey: 'outside',
        }),
      ),
    ).rejects.toMatchObject({ code: 'lesson-outside-course' });
    // Work in a foreign family's course is never visible.
    const foreignCourse = await f.as(
      { ...f.parent, tenantId: String(f.foreign.tenantId) },
      async () =>
        (
          await f.db.list('courses', { tenant_id: String(f.foreign.tenantId) })
        )[0],
    );
    if (foreignCourse)
      await expect(
        f.as(f.parent, () =>
          f.service.fileLessonWork({
            ...base,
            courseId: String(foreignCourse.id),
            requestKey: 'foreign',
          }),
        ),
      ).rejects.toThrow();
    const placed = await f.as(f.parent, () =>
      f.service.fileLessonWork({
        ...base,
        courseId: String(f.course.id),
        lessonId: String(f.secondLesson.id),
        pageKey: 'p2',
        pageLabel: 'Second page',
        requestKey: 'enrolled',
      }),
    );
    expect(placed).toMatchObject({
      courseId: String(f.course.id),
      lessonTitle: 'Second lesson',
      pageKey: 'p2',
      pageLabel: 'Second page',
      filing: {
        placement: {
          enrollmentId: String(f.enrollment.id),
          lessonId: String(f.secondLesson.id),
        },
      },
    });
    expect(placed.pages.map((p) => [p.pageKey, p.label])).toEqual([
      ['p2', 'Second page'],
    ]);
    // A plain course lesson follows completion and a reopening correction.
    const progressOf = async () =>
      (
        await f.db.list('lesson_progress', {
          enrollment_id: String(f.enrollment.id),
          lesson_id: String(f.secondLesson.id),
        })
      ).map((p) => p.status);
    const attempt = await f.as(f.parent, () =>
      f.service.captureLessonWork(f.capture),
    );
    expect(await progressOf()).toEqual(['submitted']);
    await f.as(f.parent, () =>
      f.service.completeLessonActivity({
        ...f.parent,
        activityId: f.work.id,
        submissionId: attempt.submissionId,
        expectedAttemptId: attempt.id,
        expectedHeadId: null,
        requestKey: 'plain-complete',
      }),
    );
    expect(await progressOf()).toEqual(['complete']);
    await f.as(f.parent, () =>
      f.service.captureLessonWork({
        ...f.capture,
        requestKey: 'plain-correction',
        intakeItemId: 'plain-correction',
        previousSubmissionId: attempt.submissionId,
        pages: [{ ...f.capture.pages[0], data: Buffer.from('fixed') }],
      }),
    );
    expect(await progressOf()).toEqual(['submitted']);
    // A shared catalog lesson never gains family-written pages.
    const global = await f.db.get('lessons', { id: String(f.lesson.id) });
    for (const [table, column] of [
      ['courses', 'id'],
      ['course_sections', 'course_id'],
    ])
      await f.db.query(
        `UPDATE ${table} SET tenant_id = NULL WHERE ${column} = ?`,
        [String(f.course.id)],
      );
    await f.db.query('UPDATE lessons SET tenant_id = NULL WHERE id = ?', [
      String(f.lesson.id),
    ]);
    const shared = f.as(f.parent, () =>
      f.service.fileLessonWork({
        ...base,
        courseId: String(f.course.id),
        lessonId: String(f.lesson.id),
        pageKey: 'p9',
        expectedRevisionId: placed.filing.revisionId,
        requestKey: 'shared-page',
      }),
    );
    await expect(shared).rejects.toThrow();
    expect(await f.db.list('lesson_pages', { lesson_id: global?.id })).toEqual(
      [],
    );
  } finally {
    await f.close();
  }
});

async function courseOf(f: F, lesson: { sectionId: string }) {
  const section = await f.db.get('course_sections', { id: lesson.sectionId });
  return String(section?.course_id);
}

it('rechecks current actor membership and exact tenant context on receipt reuse', async () => {
  const f = await fixture();
  try {
    await expect(
      f.as(f.own, () => f.service.resolveUnfiled(f.request)),
    ).rejects.toThrow();
    await expect(
      f.as(f.parent, () =>
        f.service.resolveUnfiled({
          ...f.request,
          tenantId: String(f.foreign.tenantId),
        }),
      ),
    ).rejects.toThrow();
    await f.db.query(
      'UPDATE memberships SET status=? WHERE tenant_id=? AND user_id=?',
      ['inactive', f.parent.tenantId, f.parent.actorUserId],
    );
    await expect(
      f.as(f.parent, () => f.service.resolveUnfiled(f.request)),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it('defaults raw legacy inserts to identified work on a known lesson', async () => {
  const f = await fixture();
  try {
    const canonical = await f.as(f.parent, () =>
      f.service.resolveBookPageActivity({
        ...f.parent,
        bookKey: 'legacy-book',
        title: 'Legacy workbook',
        pageKey: 'page-1',
        pageLabel: 'Page 1',
      }),
    );
    const id = globalThis.crypto.randomUUID();
    await f.db.query(
      'INSERT INTO workbook_activities (id, slug, tenant_id, learner_id, enrollment_id, lesson_id) VALUES (?, ?, ?, ?, ?, ?)',
      [
        id,
        `legacy-${id}`,
        f.parent.tenantId,
        f.parent.learnerId,
        String(f.enrollment.id),
        String(f.lesson.id),
      ],
    );
    expect(await f.db.get('workbook_activities', { id })).toMatchObject({
      capture_kind: 'identified',
      photo_intake_id: null,
    });
    expect(
      await f.as(f.parent, () =>
        f.service.getLessonActivity({ ...f.parent, activityId: id }),
      ),
    ).toMatchObject({
      courseId: String(f.course.id),
      lessonTitle: 'Lesson',
      filing: { state: 'identified' },
    });
    expect(canonical.bookKey).toBe('legacy-book');
  } finally {
    await f.close();
  }
});

it('never lowers a completion the placed work did not produce', async () => {
  const f = await fixture();
  try {
    const target = {
      enrollmentId: String(f.enrollment.id),
      lessonId: String(f.lesson.id),
    };
    // A guardian attests the lesson before any loose work is filed onto it.
    await f.as(f.parent, () =>
      f.service.attestLesson({ ...f.parent, ...target, score: 1 }),
    );
    const row = async (lessonId: string) =>
      f.db.get('lesson_progress', {
        enrollment_id: target.enrollmentId,
        lesson_id: lessonId,
      });
    const attested = await row(target.lessonId);
    expect(attested?.status).toBe('complete');
    // A legacy completion with no activity at all on the second lesson.
    const legacyDone = new Date('2026-09-01T12:00:00Z');
    await f.as(f.parent, async () =>
      (
        await (
          await import('../collections.js')
        ).LessonProgressCollection.create({ db: f.db })
      ).create({
        tenantId: f.parent.tenantId,
        learnerId: f.parent.learnerId,
        enrollmentId: target.enrollmentId,
        lessonId: String(f.secondLesson.id),
        status: 'complete',
        startedAt: legacyDone,
        completedAt: legacyDone,
      }),
    );
    const attempt = await f.as(f.parent, () =>
      f.service.captureLessonWork(f.capture),
    );
    const base = {
      ...f.parent,
      activityId: f.work.id,
      courseId: String(f.course.id),
      reason: 'Extra practice',
    };
    const first = await f.as(f.parent, () =>
      f.service.fileLessonWork({
        ...base,
        lessonId: target.lessonId,
        expectedRevisionId: null,
        requestKey: 'onto-attested',
      }),
    );
    const unchanged = async (lessonId: string, completedAt: unknown) => {
      expect(await row(lessonId)).toMatchObject({ status: 'complete' });
      expect(
        new Date((await row(lessonId))?.completed_at as string).getTime(),
      ).toBe(new Date(completedAt as string).getTime());
    };
    await unchanged(target.lessonId, attested?.completed_at);
    // A correction of the placed work does not undo the attestation.
    const correction = await f.as(f.parent, () =>
      f.service.captureLessonWork({
        ...f.capture,
        requestKey: 'practice-fix',
        intakeItemId: 'practice-fix',
        previousSubmissionId: attempt.submissionId,
        pages: [{ ...f.capture.pages[0], data: Buffer.from('fix 1') }],
      }),
    );
    await unchanged(target.lessonId, attested?.completed_at);
    await f.as(f.parent, () =>
      f.service.fileLessonWork({
        ...base,
        lessonId: String(f.secondLesson.id),
        expectedRevisionId: first.filing.revisionId,
        requestKey: 'onto-legacy',
      }),
    );
    await unchanged(String(f.secondLesson.id), legacyDone);
    await f.as(f.parent, () =>
      f.service.captureLessonWork({
        ...f.capture,
        requestKey: 'practice-fix-2',
        intakeItemId: 'practice-fix-2',
        previousSubmissionId: correction.submissionId,
        pages: [{ ...f.capture.pages[0], data: Buffer.from('fix 2') }],
      }),
    );
    await unchanged(String(f.secondLesson.id), legacyDone);
    expect(
      (
        await f.as(f.parent, () =>
          f.service.listProgress({
            ...f.parent,
            enrollmentId: target.enrollmentId,
          }),
        )
      )
        .filter((p) =>
          [target.lessonId, String(f.secondLesson.id)].includes(p.lessonId),
        )
        .map((p) => p.status),
    ).toEqual(['complete', 'complete']);
  } finally {
    await f.close();
  }
});

it("starts a new destination at the work's first capture, not at filing", async () => {
  const f = await fixture();
  try {
    const attempt = await f.as(f.parent, () =>
      f.service.captureLessonWork(f.capture),
    );
    const placed = await f.as(f.parent, () =>
      f.service.fileLessonWork({
        ...f.parent,
        activityId: f.work.id,
        courseId: String(f.course.id),
        lessonId: String(f.secondLesson.id),
        expectedRevisionId: null,
        requestKey: 'start-date',
        reason: 'Placed later',
      }),
    );
    const attemptRow = await f.db.get('workbook_attempts', { id: attempt.id });
    const progress = await f.db.get('lesson_progress', {
      enrollment_id: placed.filing.placement?.enrollmentId,
      lesson_id: placed.filing.placement?.lessonId,
    });
    expect(new Date(progress?.started_at as string).getTime()).toBe(
      new Date(attemptRow?.captured_at as string).getTime(),
    );
  } finally {
    await f.close();
  }
});
