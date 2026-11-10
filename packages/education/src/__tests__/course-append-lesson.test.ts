import { randomUUID } from 'node:crypto';
import {
  AssetCollection,
  withPrivateAssetAccess,
} from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COURSE_AUTHORING_ACTIONS,
  CourseAppendRefusedError,
  CourseArchivedError,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseLessonInput,
  type CourseMaterialCopyPort,
  CourseNotFoundError,
  CourseRequestKeyConflictError,
  CourseStaleHeadError,
  QuestionAuthoringService,
  ReviewNotCurrentError,
} from '../index.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

const classes = [
  ...learnerClasses,
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
  'EnrollmentAutoUpgradeSkip',
  'EnrollmentAssignmentRecord',
  'CurriculumCreationRecord',
  'LearningObjective',
  'LearningObjectiveRevision',
  'Question',
  'QuestionRevision',
  'QuestionResponse',
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

const copyPort: CourseMaterialCopyPort = {
  async copy(executor, request) {
    const user = (await executor.get('users', {
      id: request.actorUserId,
    })) as Record<string, string>;
    const id = randomUUID();
    await withPrivateAssetAccess(
      {
        tenantId: request.tenantId,
        actorUserId: request.actorUserId,
        ownerProfileId: user.profile_id,
        assetIds: [id],
      },
      async () =>
        (await AssetCollection.create({ db: executor })).create({
          id,
          tenantId: request.tenantId,
          name: 'copy',
          accessMode: 'private',
          ownerProfileId: user.profile_id,
          sourceUri: `file:///education/${id}.pdf`,
        }),
    );
    return { assetId: id };
  },
};

async function setup() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes,
  });
  opened.push(db);
  const f = await learnerFixture(db);
  const guardian: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: f.parent.actorUserId,
  };
  const outsider: CourseAuthoringActor = {
    tenantId: String(f.foreign.tenantId),
    actorUserId: String(f.stranger.user.id),
  };
  const denied = new Set<CourseAuthoringAction>();
  const gate = { current: true };
  const service = new QuestionAuthoringService(
    db,
    (call) =>
      !denied.has(call.action) &&
      [guardian.actorUserId, outsider.actorUserId].includes(call.actorUserId) &&
      COURSE_AUTHORING_ACTIONS.includes(call.action),
    {
      releaseReviewGate: () =>
        gate.current
          ? { current: true, reviewId: 'review-1' }
          : { current: false, reason: 'no-review' },
      verifyDelegation: () => true,
      materialCopy: copyPort,
    },
  );
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  let counter = 0;
  const key = (label = 'k') => `${label}-${++counter}`;
  const create = (actor = guardian) =>
    as(actor, () =>
      service.createCourse({
        ...actor,
        requestKey: key('create'),
        title: 'Requested lessons',
        levelMin: 3,
        levelMax: 4,
      }),
    );
  const save = (
    courseId: string,
    expected: string,
    titles: Array<[string, string]>,
    actor = guardian,
  ) =>
    as(actor, () =>
      service.saveDraft({
        ...actor,
        courseId,
        expectedHeadRevisionId: expected,
        requestKey: key('save'),
        draft: {
          title: 'Requested lessons',
          objectives: ['Practise'],
          levelMin: 3,
          levelMax: 4,
          provenance: 'supplied',
          sections: [
            {
              sectionKey: 'unit-1',
              title: 'Unit 1',
              lessons: titles.map(([lessonKey, title]) => ({
                lessonKey,
                title,
              })),
            },
          ],
        },
      }),
    );
  const release = (courseId: string, revisionId: string, actor = guardian) =>
    as(actor, () =>
      service.release({
        ...actor,
        courseId,
        revisionId,
        requestKey: key('rel'),
      }),
    );
  const released = async () => {
    const head = await create();
    const saved = await save(head.courseId, head.headRevisionId, [
      ['a', 'Lesson A'],
      ['b', 'Lesson B'],
    ]);
    const rel = await release(head.courseId, saved.revisionId);
    return { courseId: head.courseId, head: saved.revisionId, rel };
  };
  const question = async (prompt: string) =>
    (
      await as(guardian, () =>
        service.createQuestion({
          ...guardian,
          requestKey: key('q'),
          content: {
            prompt,
            responseType: 'numeric',
            answerKey: { numeric: { value: 4 }, explanation: 'Because.' },
            provenance: 'supplied',
          },
        }),
      )
    ).headRevisionId;
  const append = (
    courseId: string,
    expected: string,
    lesson: CourseLessonInput & { lessonKey: string },
    extra: Record<string, unknown> = {},
    actor = guardian,
  ) =>
    as(actor, () =>
      service.appendLesson({
        ...actor,
        courseId,
        expectedHeadRevisionId: expected,
        requestKey: 'append-1',
        sectionKey: 'unit-1',
        lesson,
        ...extra,
      }),
    );
  const count = async (table: string) => (await db.list(table, {})).length;
  const enrollOn = (releaseCourseId: string) =>
    f.as(f.parent, () =>
      f.service.enroll({
        ...f.parent,
        curriculumId: String(f.curriculum.id),
        courseId: releaseCourseId,
      }),
    );
  return {
    db,
    f,
    service,
    guardian,
    outsider,
    denied,
    gate,
    as,
    key,
    create,
    save,
    release,
    released,
    question,
    append,
    count,
    enrollOn,
  };
}

describe('CourseAuthoringService.appendLesson', () => {
  it('appends one lesson with a worksheet and a material as a new released revision', async () => {
    const s = await setup();
    const { courseId, head, rel } = await s.released();
    const q = await s.question('2 + 2');
    const result = await s.append(courseId, head, {
      lessonKey: 'req-1',
      title: 'Requested: add',
      body: 'Story',
      lessonType: 'worksheet',
      materials: [
        {
          source: { kind: 'ingestion-item', ref: 'i-1' },
          relationship: 'printable',
          licenseKind: 'own-work',
        },
      ],
      questions: [{ questionRevisionId: q }],
    } as never);
    expect(result.lessonKey).toBe('req-1');
    expect(result.version).toBe(3);
    expect(result.release).toMatchObject({
      courseId,
      revisionId: result.revisionId,
      releaseNumber: 2,
    });
    expect(result.release?.lessons.map((l) => l.lessonKey)).toEqual([
      'a',
      'b',
      'req-1',
    ]);
    // Append-only: the first release and every earlier revision are untouched.
    expect(await s.count('course_releases')).toBe(2);
    const first = await s.db.get('course_releases', { id: rel.id });
    expect(first?.revision_id).toBe(rel.revisionId);
    const revisions = await s.db.list('course_revisions', {
      course_id: courseId,
    });
    expect(revisions.map((r) => Number(r.sequence)).sort()).toEqual([1, 2, 3]);
    const stored = revisions.find((r) => String(r.id) === result.revisionId);
    expect(stored?.parent_revision_id).toBe(head);
    // The new head is the appended revision; a second append needs it.
    const read = await s.as(s.guardian, () =>
      s.service.readDraft({ ...s.guardian, courseId }),
    );
    expect(read.head.headRevisionId).toBe(result.revisionId);
    const lesson = read.revision.sections[0].lessons.find(
      (l) => l.lessonKey === 'req-1',
    );
    expect(lesson?.questions).toHaveLength(1);
    expect(lesson?.materials).toHaveLength(1);
    // The worksheet and the material reach the released lesson.
    const bundle = await s.as(s.guardian, () =>
      s.service.readReleasedLesson({
        ...s.guardian,
        releaseId: String(result.release?.id),
        lessonKey: 'req-1',
      }),
    );
    expect(JSON.stringify(bundle)).toContain('2 + 2');
  });

  it('can append without releasing and release later through the usual call', async () => {
    const s = await setup();
    const { courseId, head } = await s.released();
    const result = await s.append(
      courseId,
      head,
      { lessonKey: 'req-1', title: 'One' },
      { release: false },
    );
    expect(result.release).toBeNull();
    expect(await s.count('course_releases')).toBe(1);
    // The unreleased revision blocks a second append until it is released.
    await expect(
      s.append(
        courseId,
        result.revisionId,
        { lessonKey: 'req-2', title: 'Two' },
        { requestKey: 'append-2' },
      ),
    ).rejects.toMatchObject({ reason: 'unreleased-changes' });
    await s.release(courseId, result.revisionId);
    const next = await s.append(
      courseId,
      result.revisionId,
      { lessonKey: 'req-2', title: 'Two' },
      { requestKey: 'append-2' },
    );
    expect(next.release?.lessons.map((l) => l.lessonKey)).toEqual([
      'a',
      'b',
      'req-1',
      'req-2',
    ]);
  });

  it('is idempotent by request key and refuses a changed replay', async () => {
    const s = await setup();
    const { courseId, head } = await s.released();
    const lesson = { lessonKey: 'req-1', title: 'One', body: 'x' };
    const first = await s.append(courseId, head, lesson);
    const revisions = await s.count('course_revisions');
    const releases = await s.count('course_releases');
    const lessons = await s.count('lessons');
    // Same request, even though the head has moved on: a no-op returning the same result.
    expect(await s.append(courseId, head, lesson)).toEqual(first);
    expect(await s.append(courseId, first.revisionId, lesson)).toEqual(first);
    expect(await s.count('course_revisions')).toBe(revisions);
    expect(await s.count('course_releases')).toBe(releases);
    expect(await s.count('lessons')).toBe(lessons);
    // Changed lesson, section, or delegation under the same key.
    await expect(
      s.append(courseId, head, { ...lesson, title: 'Other' }),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    await expect(
      s.append(courseId, head, lesson, {
        sectionKey: 'unit-2',
        sectionTitle: 'U2',
      }),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    expect(await s.count('course_revisions')).toBe(revisions);
  });

  it('treats release intent as part of the request', async () => {
    const s = await setup();
    const { courseId, head } = await s.released();
    const lesson = { lessonKey: 'req-1', title: 'One' };
    const first = await s.append(courseId, head, lesson, { release: false });
    await expect(
      s.append(courseId, head, lesson, { release: true }),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    expect(await s.count('course_releases')).toBe(1);
    expect(await s.append(courseId, head, lesson, { release: false })).toEqual(
      first,
    );
    const other = await s
      .append(
        courseId,
        first.revisionId,
        { lessonKey: 'req-2', title: 'Two' },
        { requestKey: 'append-2', release: false },
      )
      .catch((e) => e);
    // The unreleased head blocks it; release intent is irrelevant to that refusal.
    expect(other).toBeInstanceOf(CourseAppendRefusedError);
    const { courseId: c2, head: h2 } = await s.released();
    const done = await s.append(c2, h2, lesson, { requestKey: 'a-3' });
    await expect(
      s.append(c2, h2, lesson, { requestKey: 'a-3', release: false }),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    expect(await s.append(c2, h2, lesson, { requestKey: 'a-3' })).toEqual(done);
  });

  it('refuses archived, draft-only, unreleased-head, foreign, discarded and duplicate cases', async () => {
    const s = await setup();
    const { courseId, head } = await s.released();
    const lesson = { lessonKey: 'req-1', title: 'One' };
    const before = [
      await s.count('course_revisions'),
      await s.count('course_releases'),
    ];

    // Draft-only: no release yet.
    const draftOnly = await s.create();
    const draftSaved = await s.save(
      draftOnly.courseId,
      draftOnly.headRevisionId,
      [['a', 'A']],
    );
    await expect(
      s.append(draftOnly.courseId, draftSaved.revisionId, lesson, {
        requestKey: 'k-draft',
      }),
    ).rejects.toMatchObject({ reason: 'not-released' });

    // Released, then edited and not released again.
    const edited = await s.save(courseId, head, [
      ['a', 'A edited'],
      ['b', 'B'],
    ]);
    await expect(
      s.append(courseId, edited.revisionId, lesson, { requestKey: 'k-edit' }),
    ).rejects.toBeInstanceOf(CourseAppendRefusedError);
    await s.release(courseId, edited.revisionId);

    // Duplicate lesson key.
    await expect(
      s.append(
        courseId,
        edited.revisionId,
        { lessonKey: 'a', title: 'Again' },
        { requestKey: 'k-dup' },
      ),
    ).rejects.toMatchObject({ reason: 'duplicate-lesson' });

    // Stale head.
    await expect(
      s.append(courseId, head, lesson, { requestKey: 'k-stale' }),
    ).rejects.toBeInstanceOf(CourseStaleHeadError);

    // A new section needs a title.
    await expect(
      s.append(courseId, edited.revisionId, lesson, {
        requestKey: 'k-sec',
        sectionKey: 'unit-9',
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });

    // Foreign tenant: the course does not exist for the other tenant, and the
    // other tenant cannot reach ours.
    await expect(
      s.append(
        courseId,
        edited.revisionId,
        lesson,
        { requestKey: 'k-f1' },
        s.outsider,
      ),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    const theirs = await s.create(s.outsider);
    await expect(
      s.append(theirs.courseId, theirs.headRevisionId, lesson, {
        requestKey: 'k-f2',
      }),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof CourseNotFoundError ||
        e instanceof CourseAuthoringAuthorizationError,
    );

    // Archived.
    await s.as(s.guardian, () =>
      s.service.archive({ ...s.guardian, courseId, requestKey: s.key() }),
    );
    await expect(
      s.append(courseId, edited.revisionId, lesson, { requestKey: 'k-arch' }),
    ).rejects.toBeInstanceOf(CourseArchivedError);

    // Nothing but the two setup releases and the edit was written by any refusal.
    expect(await s.count('course_releases')).toBe(before[1] + 1);
    expect(await s.count('course_revisions')).toBe(before[0] + 4);
  });

  it('needs the author grant, and the release grant only when releasing', async () => {
    const s = await setup();
    const { courseId, head } = await s.released();
    s.denied.add('education.course.author');
    await expect(
      s.append(courseId, head, { lessonKey: 'r', title: 'R' }),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    s.denied.clear();
    s.denied.add('education.course.release');
    await expect(
      s.append(
        courseId,
        head,
        { lessonKey: 'r', title: 'R' },
        { requestKey: 'k2' },
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect(await s.count('course_revisions')).toBe(2);
    const noRelease = await s.append(
      courseId,
      head,
      { lessonKey: 'r', title: 'R' },
      { requestKey: 'k3', release: false },
    );
    expect(noRelease.release).toBeNull();
  });

  it('goes through the review gate and rolls the whole append back when it is not current', async () => {
    const s = await setup();
    const { courseId, head } = await s.released();
    s.gate.current = false;
    await expect(
      s.append(courseId, head, { lessonKey: 'r', title: 'R' }),
    ).rejects.toBeInstanceOf(ReviewNotCurrentError);
    expect(await s.count('course_revisions')).toBe(2);
    expect(await s.count('course_releases')).toBe(1);
    const read = await s.as(s.guardian, () =>
      s.service.readDraft({ ...s.guardian, courseId }),
    );
    expect(read.head.headRevisionId).toBe(head);
  });

  it('records a policy basis on the release it makes', async () => {
    const s = await setup();
    const { courseId, head } = await s.released();
    const result = await s.append(
      courseId,
      head,
      { lessonKey: 'r', title: 'R' },
      { policyBasis: 'auto-approve-requested-lessons' },
    );
    expect(result.release?.policyBasis).toBe('auto-approve-requested-lessons');
  });
});

describe('appendLesson and enrollment pins', () => {
  it('keeps an enrollment on its pinned release until the host upgrades it', async () => {
    const s = await setup();
    const { courseId, head, rel } = await s.released();
    const enrollment = await s.enrollOn(rel.releaseCourseId);
    const enrollmentId = String(enrollment.id);
    await s.as(s.guardian, () =>
      s.service.pinEnrollment({
        ...s.guardian,
        enrollmentId,
        releaseId: rel.id,
        requestKey: s.key(),
        policyBasis: 'guardians-only',
      }),
    );
    const result = await s.append(courseId, head, {
      lessonKey: 'req-1',
      title: 'Requested',
    });
    const view = () =>
      s.as(s.guardian, () =>
        s.service.getEnrollmentRelease({ ...s.guardian, enrollmentId }),
      );
    let current = await view();
    expect(current.pin.releaseId).toBe(rel.id);
    expect(current.lessons.map((l) => l.lessonKey).sort()).toEqual(['a', 'b']);
    // The host advances it through the published call.
    await s.as(s.guardian, () =>
      s.service.upgradeEnrollment({
        ...s.guardian,
        enrollmentId,
        releaseId: String(result.release?.id),
        requestKey: s.key(),
        policyBasis: 'guardians-only',
      }),
    );
    current = await view();
    expect(current.pin).toMatchObject({ releaseNumber: 2, kind: 'explicit' });
    expect(current.lessons.map((l) => l.lessonKey).sort()).toEqual([
      'a',
      'b',
      'req-1',
    ]);
  });

  it('moves only enrollments that opted in to automatic upgrades', async () => {
    const s = await setup();
    const { courseId, head, rel } = await s.released();
    const enrollment = await s.enrollOn(rel.releaseCourseId);
    const enrollmentId = String(enrollment.id);
    await s.as(s.guardian, () =>
      s.service.pinEnrollment({
        ...s.guardian,
        enrollmentId,
        releaseId: rel.id,
        requestKey: s.key(),
        policyBasis: 'guardians-only',
      }),
    );
    await s.as(s.guardian, () =>
      s.service.setAutoUpgrade({
        ...s.guardian,
        courseId,
        enrollmentId,
        enabled: true,
        requestKey: s.key(),
        policyBasis: 'guardians-only',
      }),
    );
    const result = await s.append(courseId, head, {
      lessonKey: 'req-1',
      title: 'Requested',
    });
    const current = await s.as(s.guardian, () =>
      s.service.getEnrollmentRelease({ ...s.guardian, enrollmentId }),
    );
    expect(current.pin).toMatchObject({
      releaseId: result.release?.id,
      kind: 'auto',
    });
    expect(current.lessons.map((l) => l.lessonKey).sort()).toEqual([
      'a',
      'b',
      'req-1',
    ]);
  });
});
