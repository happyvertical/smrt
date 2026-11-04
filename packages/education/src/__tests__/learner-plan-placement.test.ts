import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LearnerPlanService } from '../learner-plan-service.js';
import type { LearnerRequest } from '../learner-service.js';
import { LessonActivityCollection } from '../lesson-work-models.js';
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
    classes: [...workbookClasses, 'EnrollmentParentNote'],
  });
  const f = await learnerFixture(db);
  const storage = await mkdtemp(join(tmpdir(), 'plan-placement-'));
  const authorize = ({
    own,
    relationshipTypeId,
  }: {
    own?: boolean;
    relationshipTypeId?: string;
  }) => own || relationshipTypeId === f.guardianType.id;
  const work = new UnfiledTestService(db, authorize as never, () => true, {
    storage,
  });
  const plan = new LearnerPlanService(db, authorize as never, () => true);
  const receipt = await f.as(f.parent, async () =>
    (await WorkbookPhotoIntakeCollection.create({ db })).create({
      tenantId: f.parent.tenantId,
      learnerId: f.parent.learnerId,
      itemId: 'plan-photo',
      actorUserId: f.parent.actorUserId,
      contentDigest: 'b'.repeat(64),
    }),
  );
  const captured = await f.as(f.parent, () =>
    work.resolveUnfiled({ ...f.parent, intakeId: String(receipt.id) }),
  );
  const planOf = (enrollmentId: string) =>
    f.as(f.own, () => plan.getEnrollmentPlan({ ...f.own, enrollmentId }));
  return {
    ...f,
    db,
    work,
    plan,
    captured,
    planOf,
    close: async () => {
      await db.close?.();
      await rm(storage, { recursive: true, force: true });
    },
  };
}
const activityIds = (
  p: Awaited<ReturnType<LearnerPlanService['getEnrollmentPlan']>>,
) => p.lessons.map((l) => l.lesson.lessonActivityId);

it('shows captured-only work on its routing lesson, and filed work on the lesson it was filed into', async () => {
  const f = await fixture();
  try {
    // Captured, not yet filed: the routing lesson is where the work sits.
    const routing = await f.planOf(f.captured.enrollmentId);
    expect(routing.availability).toBe('available');
    expect(
      routing.lessons
        .filter((l) => l.lesson.lessonActivityId)
        .map((l) => [l.lesson.id, l.lesson.lessonActivityId]),
    ).toEqual([[f.captured.lessonId, f.captured.id]]);

    // Filed into a new book: it leaves the routing lesson for the filed one.
    const filed = await f.as(f.parent, () =>
      f.work.fileLessonWork({
        ...f.parent,
        activityId: f.captured.id,
        newBook: { title: 'Arithmetic', edition: '1' },
        pageKey: 'p12',
        pageLabel: 'Page 12',
        expectedRevisionId: null,
        requestKey: 'file-plan',
        reason: 'Guardian files work',
      }),
    );
    const placement = filed.filing.placement;
    if (!placement) throw new Error('Expected a placement');
    expect(placement.lessonId).not.toBe(f.captured.lessonId);
    const after = await f.planOf(f.captured.enrollmentId);
    expect(activityIds(after).filter(Boolean)).toEqual([]);
    const into = await f.planOf(placement.enrollmentId);
    expect(
      into.lessons
        .filter((l) => l.lesson.lessonActivityId)
        .map((l) => [l.lesson.id, l.lesson.lessonActivityId]),
    ).toEqual([[placement.lessonId, f.captured.id]]);
    // listPlan reads through the same projection.
    const listed = await f.as(f.own, () => f.plan.listPlan(f.own));
    const filedPlan = listed.find(
      (p) => p.enrollment.id === placement.enrollmentId,
    );
    expect(
      filedPlan?.lessons.find((l) => l.lesson.id === placement.lessonId)?.lesson
        .lessonActivityId,
    ).toBe(f.captured.id);
    expect(listed.flatMap((p) => activityIds(p)).filter(Boolean)).toEqual([
      f.captured.id,
    ]);
  } finally {
    await f.close();
  }
});

it('leaves ordinary lessons without a lessonActivityId, even with an activity routed there', async () => {
  const f = await fixture();
  try {
    await f.as(f.parent, async () =>
      (await LessonActivityCollection.create({ db: f.db })).create({
        tenantId: f.parent.tenantId,
        learnerId: f.parent.learnerId,
        enrollmentId: f.enrollment.id,
        lessonId: String(f.lesson.id),
      }),
    );
    const ordinary = await f.planOf(f.enrollment.id);
    expect(ordinary.lessons.length).toBeGreaterThan(0);
    expect(activityIds(ordinary).filter(Boolean)).toEqual([]);
    // Making the course a book course turns the same activity into book work.
    await f.db.query('UPDATE courses SET book_key = ? WHERE id = ?', [
      'plan-book',
      String(f.course.id),
    ]);
    const book = await f.planOf(f.enrollment.id);
    expect(activityIds(book).filter(Boolean)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('never shows another learner or another enrollment the work', async () => {
  const f = await fixture();
  try {
    const bob = {
      ...f.own,
      actorUserId: String(f.bob.user.id),
      learnerId: String(f.sibling.id),
    };
    const siblingPlan = await f.as(bob, () => f.plan.listPlan(bob));
    expect(siblingPlan).toEqual([]);
    // The sibling cannot read the learner's enrollment, filed work included.
    await expect(
      f.as(bob, () =>
        f.plan.getEnrollmentPlan({ ...bob, enrollmentId: f.enrollment.id }),
      ),
    ).rejects.toThrow();
    // The learner's own other enrollment does not pick up the routing lesson's work.
    const other = await f.planOf(f.enrollment.id);
    expect(activityIds(other).filter(Boolean)).toEqual([]);
  } finally {
    await f.close();
  }
});
