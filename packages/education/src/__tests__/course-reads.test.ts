import { randomUUID } from 'node:crypto';
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
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseAuthoringValidationError,
  type CourseAuthorizationDecision,
  CourseNotFoundError,
  CoursePolicyBasisMismatchError,
  CourseRequestKeyConflictError,
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  MAX_PAGE_SIZE,
  QuestionAuthoringService,
  type QuestionContentInput,
  QuestionNotFoundError,
  QuestionResponseScopeError,
  QuestionResponseService,
} from '../index.js';
import { learnerFixture } from './learner-workflows.js';
import { submissionClasses } from './submission-workflows.js';

/*
 * Behavior-to-test matrix (authorized reads, SMRT #4514/#4515 item D):
 *  tenancy isolation per read ............................ 'tenancy'
 *  read-draft required, executor+operation+delegation .... 'authorization'
 *  denied read returns nothing ........................... 'authorization'
 *  listCourses state combos / discarded flag ............. 'listCourses states'
 *  summary licence/shareability/releaseCount ............. 'listCourses summary licence'
 *  learner/course identity on pin, upgrade, history, release read  'enrollment identity fields'
 *  authorizer-supplied policy basis (pin/upgrade/opt-in/auto) . 'policy basis from the authorizer'
 *  pagination determinism, limit cap, bad cursor ......... 'pagination'
 *  upgrade choice history (course and enrollment) ........ 'upgrade choices'
 *  skips: reason+code, boolean compat, sanitizing, throws  'skips'
 *  readReleasedLesson authoring (keys) ................... 'authoring lesson'
 *  learner view keyless, effective set, after upgrade .... 'learner lesson'
 *  guardian reading for a learner ........................ 'learner lesson'
 *  personal-use body withheld ............................ 'learner lesson'
 *  additive diff ......... course-authoring.test.ts (unchanged: the skip table is new; 'code' round trip in 'skips')
 */
const classes = [
  ...new Set([
    ...submissionClasses,
    'EnrollmentParentNote',
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
  ]),
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

const SECRET = 'SECRET-KEY-7';
const mcq = (prompt: string): QuestionContentInput => ({
  prompt,
  responseType: 'multiple-choice',
  choices: [
    { id: 'a', label: 'One' },
    { id: 'b', label: 'Two' },
  ],
  answerKey: { correctChoiceIds: ['a'], explanation: SECRET },
  rubric: { criteria: [{ id: 'm', label: 'Method', maxPoints: 2 }] },
  provenance: 'supplied',
});

type Call = Parameters<CourseAuthoringAuthorizer>[0];
type Override = (
  call: Call,
) => boolean | CourseAuthorizationDecision | undefined;

async function setup() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes,
  });
  opened.push(db);
  const f = await learnerFixture(db);
  const learnerCalls: Array<Parameters<LearnerAuthorizer>[0]> = [];
  const responses = new QuestionResponseService(
    db,
    (call) => {
      learnerCalls.push(call);
      return call.own || call.relationshipTypeId === f.guardianType.id;
    },
    () => true,
  );
  const guardian: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: f.parent.actorUserId,
  };
  const agent: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: String(f.bob.user.id),
    delegatingGuardianUserId: guardian.actorUserId,
    delegationId: 'delegation-1',
  };
  const outsider: CourseAuthoringActor = {
    tenantId: String(f.foreign.tenantId),
    actorUserId: String(f.stranger.user.id),
  };
  const calls: Call[] = [];
  const state: { override: Override | null; denyAction: string | null } = {
    override: null,
    denyAction: null,
  };
  const granted = new Set([
    guardian.actorUserId,
    agent.actorUserId,
    outsider.actorUserId,
  ]);
  const authoring = new QuestionAuthoringService(
    db,
    (call) => {
      calls.push(call);
      const o = state.override?.(call);
      if (o !== undefined) return o;
      return (
        call.action !== state.denyAction &&
        granted.has(call.actorUserId) &&
        COURSE_AUTHORING_ACTIONS.includes(call.action)
      );
    },
    {
      releaseReviewGate: () => ({ current: true, reviewId: 'review-1' }),
      verifyDelegation: () => true,
    },
  );
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  let counter = 0;
  const key = (label = 'k') => `${label}-${++counter}`;
  const question = async (content: QuestionContentInput) =>
    (
      await as(guardian, () =>
        authoring.createQuestion({
          ...guardian,
          requestKey: key('q'),
          content,
        }),
      )
    ).headRevisionId;
  const newCourse = (actor = guardian, title = 'Fractions') =>
    as(actor, () =>
      authoring.createCourse({
        ...actor,
        requestKey: key('course'),
        title,
        levelMin: 3,
        levelMax: 4,
      }),
    );
  type LessonSpec = [string, string[], ('personal-use-copy' | undefined)?];
  const course = await newCourse();
  const state2 = { expected: course.headRevisionId };
  const publish = async (lessons: LessonSpec[]) => {
    const saved = await as(guardian, () =>
      authoring.saveDraft({
        ...guardian,
        courseId: course.courseId,
        expectedHeadRevisionId: state2.expected,
        requestKey: key('save'),
        draft: {
          title: 'Fractions',
          objectives: ['Add fractions'],
          levelMin: 3,
          levelMax: 4,
          provenance: 'supplied',
          sections: [
            {
              sectionKey: 'unit-1',
              title: 'Unit 1',
              lessons: lessons.map(([lessonKey, ids, licenseKind]) => ({
                lessonKey,
                title: lessonKey.toUpperCase(),
                body: `Body of ${lessonKey}`,
                lessonType: 'worksheet' as const,
                ...(licenseKind ? { licenseKind } : {}),
                questions: ids.map((questionRevisionId) => ({
                  questionRevisionId,
                })),
                layoutParams: { columns: 2 },
              })),
            },
          ],
        },
      }),
    );
    state2.expected = saved.headRevisionId;
    return as(guardian, () =>
      authoring.release({
        ...guardian,
        courseId: course.courseId,
        revisionId: saved.revisionId,
        requestKey: key('rel'),
      }),
    );
  };
  const q1 = await question(mcq('Q1'));
  const q2 = await question(mcq('Q2'));
  const rel1 = await publish([
    ['a', [q1, q2]],
    ['b', [q1], 'personal-use-copy'],
  ]);
  const enrollment = await f.as(f.parent, () =>
    f.service.enroll({
      ...f.parent,
      curriculumId: String(f.curriculum.id),
      courseId: rel1.releaseCourseId,
    }),
  );
  const enrollmentId = String(enrollment.id);
  await as(guardian, () =>
    authoring.pinEnrollment({
      ...guardian,
      enrollmentId,
      releaseId: rel1.id,
      requestKey: key('pin'),
      policyBasis: 'guardians-only',
    }),
  );
  const ids = (release: {
    lessons: ReadonlyArray<{ lessonKey: string; lessonId: string }>;
  }) =>
    Object.fromEntries(release.lessons.map((l) => [l.lessonKey, l.lessonId]));
  const optIn = (
    actor: CourseAuthoringActor,
    enabled = true,
    forEnrollment?: string,
  ) =>
    as(actor, () =>
      authoring.setAutoUpgrade({
        ...actor,
        courseId: course.courseId,
        ...(forEnrollment ? { enrollmentId: forEnrollment } : {}),
        enabled,
        requestKey: key('opt'),
        policyBasis: 'guardians-only',
      }),
    );
  return {
    db,
    f,
    calls,
    learnerCalls,
    state,
    responses,
    authoring,
    guardian,
    agent,
    outsider,
    as,
    key,
    question,
    newCourse,
    publish,
    course,
    q1,
    q2,
    rel1,
    enrollmentId,
    lessons1: ids(rel1),
    ids,
    optIn,
    upgrade: (releaseId: string) =>
      as(guardian, () =>
        authoring.upgradeEnrollment({
          ...guardian,
          enrollmentId,
          releaseId,
          requestKey: key('up'),
          policyBasis: 'guardians-only',
        }),
      ),
    readLearner: (
      actor: typeof f.own | typeof f.parent | typeof f.foreign,
      lessonId: string,
    ) =>
      f.as(actor as typeof f.own, () =>
        responses.readReleasedLesson({
          ...actor,
          enrollmentId,
          lessonId,
        } as never),
      ),
  };
}

const ALL_READS = (s: Awaited<ReturnType<typeof setup>>) => ({
  listCourses: (a: CourseAuthoringActor) =>
    s.as(a, () => s.authoring.listCourses({ ...a })),
  listUpgradeChoices: (a: CourseAuthoringActor) =>
    s.as(a, () =>
      s.authoring.listUpgradeChoices({ ...a, courseId: s.course.courseId }),
    ),
  listAutoUpgradeSkips: (a: CourseAuthoringActor) =>
    s.as(a, () =>
      s.authoring.listAutoUpgradeSkips({ ...a, courseId: s.course.courseId }),
    ),
  readReleasedLesson: (a: CourseAuthoringActor) =>
    s.as(a, () =>
      s.authoring.readReleasedLesson({
        ...a,
        releaseId: s.rel1.id,
        lessonKey: 'a',
      }),
    ),
});

describe('authorized course reads', () => {
  it('tenancy: a foreign tenant sees and reaches nothing', async () => {
    const s = await setup();
    const reads = ALL_READS(s);
    // Its own (empty) tenant: nothing from the family tenant leaks.
    expect((await reads.listCourses(s.outsider)).items).toEqual([]);
    await expect(reads.listUpgradeChoices(s.outsider)).rejects.toBeInstanceOf(
      CourseNotFoundError,
    );
    await expect(reads.listAutoUpgradeSkips(s.outsider)).rejects.toBeInstanceOf(
      CourseNotFoundError,
    );
    await expect(reads.readReleasedLesson(s.outsider)).rejects.toBeInstanceOf(
      QuestionNotFoundError,
    );
    // A foreign enrollment id is a denial, indistinguishable from a missing one.
    await expect(
      s.as(s.outsider, () =>
        s.authoring.listAutoUpgradeSkips({
          ...s.outsider,
          enrollmentId: s.enrollmentId,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    // The family sees its own course.
    expect((await reads.listCourses(s.guardian)).items).toHaveLength(1);
    // A spoofed tenant never passes the ambient context check.
    await expect(
      s.as(s.outsider, () =>
        s.authoring.listCourses({
          ...s.outsider,
          tenantId: s.guardian.tenantId,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    // Learner path: a foreign learner cannot read this enrollment's lesson.
    await expect(
      s.readLearner(s.f.foreign, s.lessons1.a),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  });

  it('authorization: read-draft is required and denial returns nothing', async () => {
    const s = await setup();
    const reads = ALL_READS(s);
    s.state.denyAction = 'education.course.read-draft';
    for (const [name, read] of Object.entries(reads)) {
      s.calls.length = 0;
      await expect(read(s.guardian), name).rejects.toBeInstanceOf(
        CourseAuthoringAuthorizationError,
      );
      expect(s.calls, name).toHaveLength(1);
    }
    // Another action never stands in for read-draft.
    s.state.denyAction = null;
    s.state.override = (call) => call.action !== 'education.course.read-draft';
    for (const read of Object.values(reads))
      await expect(read(s.guardian)).rejects.toBeInstanceOf(
        CourseAuthoringAuthorizationError,
      );
    // A decision object denies as well, and allows only with allowed:true.
    s.state.override = () => ({ allowed: false, reason: 'no', code: 'x' });
    await expect(reads.listCourses(s.guardian)).rejects.toBeInstanceOf(
      CourseAuthoringAuthorizationError,
    );
    s.state.override = () => ({ allowed: true });
    expect((await reads.listCourses(s.guardian)).items).toHaveLength(1);
    s.state.override = null;
    // Executor, operation and delegation are passed.
    s.calls.length = 0;
    await s.optIn(s.guardian, true, s.enrollmentId);
    s.calls.length = 0;
    const expected: Record<string, string> = {
      listCourses: 'list-courses',
      listUpgradeChoices: 'list-upgrade-choices',
      listAutoUpgradeSkips: 'list-auto-upgrade-skips',
      readReleasedLesson: 'read-released-lesson',
    };
    for (const [name, read] of Object.entries(reads)) {
      s.calls.length = 0;
      await read(s.agent);
      const call = s.calls.at(-1);
      expect(call, name).toMatchObject({
        action: 'education.course.read-draft',
        operation: expected[name],
        actorUserId: s.agent.actorUserId,
        delegatingGuardianUserId: s.guardian.actorUserId,
        delegationId: 'delegation-1',
      });
      expect(call?.executor).toBeDefined();
      expect(call?.executor).not.toBe(s.db);
    }
    // The enrollment-scoped forms pass the enrollment and learner.
    s.calls.length = 0;
    await s.as(s.guardian, () =>
      s.authoring.listUpgradeChoices({
        ...s.guardian,
        courseId: s.course.courseId,
        enrollmentId: s.enrollmentId,
      }),
    );
    expect(s.calls.at(-1)).toMatchObject({
      enrollmentId: s.enrollmentId,
      learnerId: String(s.f.learner.id),
    });
    // The learner path asks the learner authorizer with the executor.
    s.learnerCalls.length = 0;
    await s.readLearner(s.f.own, s.lessons1.a);
    expect(s.learnerCalls.at(-1)).toMatchObject({
      action: 'education.learner.read',
      own: true,
    });
    expect(s.learnerCalls.at(-1)?.executor).toBeDefined();
  });

  it('listCourses summary licence, shareability and release count', async () => {
    const s = await setup();
    const draftOnly = await s.newCourse(s.guardian, 'Draft only');
    const ownWork = await s.newCourse(s.guardian, 'Own work');
    const release = async (courseId: string, expected: string, n: number) => {
      const saved = await s.as(s.guardian, () =>
        s.authoring.saveDraft({
          ...s.guardian,
          courseId,
          expectedHeadRevisionId: expected,
          requestKey: s.key('save'),
          draft: {
            title: 'Own work',
            levelMin: 1,
            levelMax: 1,
            provenance: 'supplied',
            sections: [
              { sectionKey: 'u', title: 'U', lessons: [{ title: `L${n}` }] },
            ],
          },
        }),
      );
      await s.as(s.guardian, () =>
        s.authoring.release({
          ...s.guardian,
          courseId,
          revisionId: saved.revisionId,
          requestKey: s.key('rel'),
        }),
      );
      return saved.headRevisionId;
    };
    const head1 = await release(ownWork.courseId, ownWork.headRevisionId, 1);
    // A draft-only course so far has one release for ownWork.
    const page = async () =>
      Object.fromEntries(
        (
          await s.as(s.guardian, () =>
            s.authoring.listCourses({ ...s.guardian }),
          )
        ).items.map((c) => [c.courseId, c]),
      );
    let byId = await page();
    expect(byId[draftOnly.courseId]).toMatchObject({
      licenseKind: 'own-work',
      groupShareable: false,
      releaseCount: 0,
    });
    expect(byId[ownWork.courseId]).toMatchObject({
      licenseKind: 'own-work',
      groupShareable: true,
      releaseCount: 1,
    });
    // Personal-use material (released earlier by setup) is never shareable.
    expect(byId[s.course.courseId]).toMatchObject({
      licenseKind: 'personal-use-copy',
      groupShareable: false,
      releaseCount: 1,
    });
    // Multiple releases count and keep the licence.
    await release(ownWork.courseId, head1, 2);
    byId = await page();
    expect(byId[ownWork.courseId]).toMatchObject({
      licenseKind: 'own-work',
      groupShareable: true,
      releaseCount: 2,
    });
    const q3 = await s.question(mcq('Q3'));
    await s.publish([['a', [s.q1, q3]]]);
    byId = await page();
    expect(byId[s.course.courseId]).toMatchObject({
      releaseCount: 2,
      licenseKind: 'personal-use-copy',
      groupShareable: false,
    });
    // The head dropped the personal-use lesson, but release 1 still carries it: the
    // summary folds every release, so it stays private where the head alone would not.
    const headOnly = await s.as(s.guardian, () =>
      s.authoring.getCourse({ ...s.guardian, courseId: s.course.courseId }),
    );
    expect(headOnly.licenseKind).toBe('own-work');
    for (const id of [draftOnly.courseId, ownWork.courseId]) {
      const state = await s.as(s.guardian, () =>
        s.authoring.getCourse({ ...s.guardian, courseId: id }),
      );
      expect(byId[id].licenseKind).toBe(state.licenseKind);
    }
  });

  it('listCourses states: draft, released, archived, discarded excluded or included', async () => {
    const s = await setup();
    const draftOnly = await s.newCourse(s.guardian, 'Draft only');
    const toDiscard = await s.newCourse(s.guardian, 'To discard');
    await s.as(s.guardian, () =>
      s.authoring.discardDraft({
        ...s.guardian,
        courseId: toDiscard.courseId,
        requestKey: s.key('discard'),
      }),
    );
    const toArchive = await s.newCourse(s.guardian, 'To archive');
    const saved = await s.as(s.guardian, () =>
      s.authoring.saveDraft({
        ...s.guardian,
        courseId: toArchive.courseId,
        expectedHeadRevisionId: toArchive.headRevisionId,
        requestKey: s.key('save'),
        draft: {
          title: 'To archive',
          levelMin: 1,
          levelMax: 1,
          provenance: 'supplied',
          sections: [
            { sectionKey: 'u', title: 'U', lessons: [{ title: 'L' }] },
          ],
        },
      }),
    );
    await s.as(s.guardian, () =>
      s.authoring.release({
        ...s.guardian,
        courseId: toArchive.courseId,
        revisionId: saved.revisionId,
        requestKey: s.key('rel'),
      }),
    );
    await s.as(s.guardian, () =>
      s.authoring.archive({
        ...s.guardian,
        courseId: toArchive.courseId,
        requestKey: s.key('arch'),
      }),
    );
    const page = await s.as(s.guardian, () =>
      s.authoring.listCourses({ ...s.guardian }),
    );
    const byId = Object.fromEntries(page.items.map((c) => [c.courseId, c]));
    expect(Object.keys(byId).sort()).toEqual(
      [s.course.courseId, draftOnly.courseId, toArchive.courseId].sort(),
    );
    expect(byId[s.course.courseId]).toMatchObject({
      title: 'Fractions',
      state: 'released',
      latestRelease: { id: s.rel1.id, releaseNumber: 1 },
      archive: { archived: false, latestDecision: null },
    });
    expect(byId[s.course.courseId].head).toMatchObject({
      revisionId: s.rel1.revisionId,
      sequence: 2,
    });
    expect(byId[draftOnly.courseId]).toMatchObject({
      state: 'draft',
      latestRelease: null,
      head: { revisionId: draftOnly.headRevisionId, sequence: 1, version: 1 },
    });
    expect(byId[toArchive.courseId]).toMatchObject({
      state: 'archived',
      archive: { archived: true, latestDecision: { action: 'archive' } },
    });
    const withDiscarded = await s.as(s.guardian, () =>
      s.authoring.listCourses({ ...s.guardian, includeDiscarded: true }),
    );
    expect(withDiscarded.items).toHaveLength(4);
    expect(
      withDiscarded.items.find((c) => c.courseId === toDiscard.courseId),
    ).toMatchObject({ state: 'discarded', archive: { archived: false } });
    await s.as(s.guardian, () =>
      s.authoring.unarchive({
        ...s.guardian,
        courseId: toArchive.courseId,
        requestKey: s.key('unarch'),
      }),
    );
    const after = await s.as(s.guardian, () =>
      s.authoring.listCourses({ ...s.guardian }),
    );
    expect(
      after.items.find((c) => c.courseId === toArchive.courseId),
    ).toMatchObject({
      state: 'released',
      archive: { archived: false, latestDecision: { action: 'unarchive' } },
    });
    await expect(
      s.as(s.guardian, () =>
        s.authoring.listCourses({
          ...s.guardian,
          includeDiscarded: 'yes' as never,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
  });

  it('pagination: deterministic order, cursor walk, limit cap, bad input', async () => {
    const s = await setup();
    for (let i = 0; i < 4; i += 1) await s.newCourse(s.guardian, `C${i}`);
    const all = await s.as(s.guardian, () =>
      s.authoring.listCourses({ ...s.guardian }),
    );
    expect(all.items).toHaveLength(5);
    expect(all.nextCursor).toBeNull();
    const walked: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await s.as(s.guardian, () =>
        s.authoring.listCourses({ ...s.guardian, limit: 2, cursor }),
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      walked.push(...page.items.map((c) => c.courseId));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(walked).toEqual(all.items.map((c) => c.courseId));
    const again = await s.as(s.guardian, () =>
      s.authoring.listCourses({ ...s.guardian, limit: 2 }),
    );
    expect(again.items.map((c) => c.courseId)).toEqual(walked.slice(0, 2));
    // An oversized limit is capped, not an error.
    const big = await s.as(s.guardian, () =>
      s.authoring.listCourses({ ...s.guardian, limit: 100000 }),
    );
    expect(big.items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    for (const bad of [0, -1, 1.5, '3' as never])
      await expect(
        s.as(s.guardian, () =>
          s.authoring.listCourses({ ...s.guardian, limit: bad }),
        ),
      ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    for (const cursorValue of ['not-a-cursor', '@@@', 'x'.repeat(500)])
      await expect(
        s.as(s.guardian, () =>
          s.authoring.listCourses({ ...s.guardian, cursor: cursorValue }),
        ),
      ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
  });

  it('upgrade choices: course and enrollment history with actor and delegation', async () => {
    const s = await setup();
    await s.optIn(s.guardian, true);
    await s.optIn(s.agent, false, s.enrollmentId);
    await s.optIn(s.guardian, true, s.enrollmentId);
    const all = await s.as(s.guardian, () =>
      s.authoring.listUpgradeChoices({
        ...s.guardian,
        courseId: s.course.courseId,
      }),
    );
    expect(all.governing).toBeNull();
    expect(all.items.map((c) => [c.sequence, c.scope, c.kind])).toEqual([
      [1, 'course', 'opt-in'],
      [2, 'enrollment', 'opt-out'],
      [3, 'enrollment', 'opt-in'],
    ]);
    expect(all.items[0]).toMatchObject({
      enrollmentId: null,
      actorUserId: s.guardian.actorUserId,
      delegatingGuardianUserId: null,
      delegationId: null,
      policyBasis: 'guardians-only',
    });
    expect(all.items[1]).toMatchObject({
      enrollmentId: s.enrollmentId,
      actorUserId: s.agent.actorUserId,
      delegatingGuardianUserId: s.guardian.actorUserId,
      delegationId: 'delegation-1',
      enabled: false,
    });
    const own = await s.as(s.guardian, () =>
      s.authoring.listUpgradeChoices({
        ...s.guardian,
        courseId: s.course.courseId,
        enrollmentId: s.enrollmentId,
        limit: 1,
      }),
    );
    expect(own.items.map((c) => c.sequence)).toEqual([2]);
    expect(own.nextCursor).not.toBeNull();
    expect(own.governing).toMatchObject({ sequence: 3, enabled: true });
    const next = await s.as(s.guardian, () =>
      s.authoring.listUpgradeChoices({
        ...s.guardian,
        courseId: s.course.courseId,
        enrollmentId: s.enrollmentId,
        limit: 1,
        cursor: own.nextCursor ?? undefined,
      }),
    );
    expect(next.items.map((c) => c.sequence)).toEqual([3]);
    expect(next.nextCursor).toBeNull();
  });

  it('enrollment identity fields: learner, authored course and release course on every view', async () => {
    const s = await setup();
    const learnerId = String(s.f.learner.id);
    const read = () =>
      s.as(s.guardian, () =>
        s.authoring.getEnrollmentRelease({
          ...s.guardian,
          enrollmentId: s.enrollmentId,
        }),
      );
    const first = await read();
    expect(first).toMatchObject({
      learnerId,
      courseId: s.course.courseId,
      releaseCourseId: s.rel1.releaseCourseId,
    });
    expect(first.pin).toMatchObject({
      enrollmentId: s.enrollmentId,
      learnerId,
      courseId: s.course.courseId,
      releaseCourseId: s.rel1.releaseCourseId,
    });
    expect(first.pin.history[0].releaseCourseId).toBe(s.rel1.releaseCourseId);
    // setAutoUpgrade results carry the learner for an enrollment choice, null for a course choice.
    const enrollmentChoice = await s.optIn(s.guardian, true, s.enrollmentId);
    expect(enrollmentChoice).toMatchObject({
      courseId: s.course.courseId,
      enrollmentId: s.enrollmentId,
      learnerId,
    });
    expect((await s.optIn(s.guardian, true)).learnerId).toBeNull();
    // An automatic move (history) and an explicit upgrade (result view).
    const q = await s.question(mcq('Q-auto'));
    const rel2 = await s.publish([['a', [q]]]);
    const auto = await read();
    expect(auto.pin.kind).toBe('auto');
    expect(auto).toMatchObject({
      learnerId,
      courseId: s.course.courseId,
      releaseCourseId: rel2.releaseCourseId,
    });
    expect(auto.pin.history.map((h) => [h.kind, h.releaseCourseId])).toEqual([
      ['initial', s.rel1.releaseCourseId],
      ['auto', rel2.releaseCourseId],
    ]);
    await s.optIn(s.guardian, false, s.enrollmentId);
    const rel3 = await s.publish([
      ['a', [q]],
      ['c', [s.q1]],
    ]);
    const explicit = await s.upgrade(rel3.id);
    expect(explicit).toMatchObject({
      learnerId,
      courseId: s.course.courseId,
      releaseId: rel3.id,
      releaseCourseId: rel3.releaseCourseId,
    });
    expect(explicit.history.at(-1)?.releaseCourseId).toBe(rel3.releaseCourseId);
    // Tenant isolation is unchanged: the foreign actor reaches nothing.
    await expect(
      s.as(s.outsider, () =>
        s.authoring.getEnrollmentRelease({
          ...s.outsider,
          enrollmentId: s.enrollmentId,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    await expect(
      s.as(s.outsider, () =>
        s.authoring.setAutoUpgrade({
          ...s.outsider,
          courseId: s.course.courseId,
          enrollmentId: s.enrollmentId,
          enabled: true,
          requestKey: s.key('x'),
          policyBasis: 'guardians-only',
        }),
      ),
    ).rejects.toBeTruthy();
    // Skip views already expose learner and course.
    const skipped = await s.as(s.guardian, () =>
      s.authoring.listAutoUpgradeSkips({
        ...s.guardian,
        enrollmentId: s.enrollmentId,
      }),
    );
    for (const row of skipped.items)
      expect(row).toMatchObject({ learnerId, courseId: s.course.courseId });
  });

  describe('policy basis from the authorizer', () => {
    const grant = (
      s: Awaited<ReturnType<typeof setup>>,
      basis: unknown,
      only?: string,
    ) => {
      s.state.override = (call) =>
        call.action === 'education.course.assign' &&
        (!only || call.operation === only)
          ? {
              allowed: true,
              ...(basis === undefined ? {} : { policyBasis: basis as string }),
            }
          : undefined;
    };
    const rows = (s: Awaited<ReturnType<typeof setup>>, table: string) =>
      s.db.list(table, {});
    // A second release, and a fresh enrollment on its course for initial pins.
    async function fixture() {
      const s = await setup();
      const q = await s.question(mcq('Q-basis'));
      const rel2 = await s.publish([['a', [q]]]);
      const fresh = await s.f.as(s.f.parent, () =>
        s.f.service.enroll({
          ...s.f.parent,
          curriculumId: String(s.f.curriculum.id),
          courseId: rel2.releaseCourseId,
        }),
      );
      return { s, rel2, fresh: String(fresh.id) };
    }
    const pin = (
      s: Awaited<ReturnType<typeof setup>>,
      enrollmentId: string,
      releaseId: string,
      extra: Record<string, unknown> = {},
      requestKey = s.key('pin'),
    ) =>
      s.as(s.guardian, () =>
        s.authoring.pinEnrollment({
          ...s.guardian,
          enrollmentId,
          releaseId,
          requestKey,
          ...extra,
        } as never),
      );
    const optIn = (
      s: Awaited<ReturnType<typeof setup>>,
      extra: Record<string, unknown> = {},
    ) =>
      s.as(s.guardian, () =>
        s.authoring.setAutoUpgrade({
          ...s.guardian,
          courseId: s.course.courseId,
          enabled: true,
          requestKey: s.key('opt'),
          ...extra,
        } as never),
      );

    it('records the authorizer basis on pin, upgrade and opt-in without a caller basis', async () => {
      const { s, rel2, fresh } = await fixture();
      grant(s, 'learner-setting:guardians-only');
      const pinned = await pin(s, fresh, rel2.id);
      expect(pinned.policyBasis).toBe('learner-setting:guardians-only');
      const upgraded = await s.as(s.guardian, () =>
        s.authoring.upgradeEnrollment({
          ...s.guardian,
          enrollmentId: s.enrollmentId,
          releaseId: rel2.id,
          requestKey: s.key('up'),
        }),
      );
      expect(upgraded.policyBasis).toBe('learner-setting:guardians-only');
      await optIn(s, { enrollmentId: s.enrollmentId });
      expect((await rows(s, 'course_upgrade_choices')).at(-1)).toMatchObject({
        policy_basis: 'learner-setting:guardians-only',
      });
      expect(
        (await rows(s, 'enrollment_release_pins')).filter(
          (r) => r.policy_basis === 'learner-setting:guardians-only',
        ),
      ).toHaveLength(2);
    });

    it('still accepts a caller basis alone, or an equal one; boolean decisions are unchanged', async () => {
      const { s, rel2, fresh } = await fixture();
      // Default authorizer returns a boolean.
      expect(
        (await pin(s, fresh, rel2.id, { policyBasis: 'guardians-only' }))
          .policyBasis,
      ).toBe('guardians-only');
      grant(s, 'guardians-only');
      const result = await optIn(s, { policyBasis: 'guardians-only' });
      expect(result.policyBasis).toBe('guardians-only');
    });

    it('refuses a differing basis, a missing basis and an invalid authorizer basis without writing', async () => {
      const { s, rel2, fresh } = await fixture();
      const counts = async () => [
        (await rows(s, 'enrollment_release_pins')).length,
        (await rows(s, 'course_upgrade_choices')).length,
      ];
      const snapshot = await counts();
      grant(s, 'from-host');
      await expect(
        pin(s, fresh, rel2.id, { policyBasis: 'from-caller' }),
      ).rejects.toBeInstanceOf(CoursePolicyBasisMismatchError);
      await expect(
        optIn(s, { policyBasis: 'from-caller' }),
      ).rejects.toMatchObject({ code: 'policy-basis-mismatch' });
      grant(s, undefined);
      await expect(pin(s, fresh, rel2.id)).rejects.toBeInstanceOf(
        CourseAuthoringValidationError,
      );
      await expect(optIn(s)).rejects.toBeInstanceOf(
        CourseAuthoringValidationError,
      );
      for (const bad of ['x'.repeat(201), '   ', 'bad\nbasis', 42]) {
        grant(s, bad);
        await expect(pin(s, fresh, rel2.id)).rejects.toBeInstanceOf(
          CourseAuthoringValidationError,
        );
        await expect(
          pin(s, fresh, rel2.id, { policyBasis: 'guardians-only' }),
        ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
        await expect(optIn(s)).rejects.toBeInstanceOf(
          CourseAuthoringValidationError,
        );
      }
      expect(await counts()).toEqual(snapshot);
    });

    it('authorizes live on replay and compares the effective basis', async () => {
      const { s, rel2, fresh } = await fixture();
      grant(s, 'basis-a');
      const key = s.key('replay');
      const first = await pin(s, fresh, rel2.id, {}, key);
      const count = (await rows(s, 'enrollment_release_pins')).length;
      // Replay without resending the basis returns the original result.
      expect(await pin(s, fresh, rel2.id, {}, key)).toEqual(first);
      expect((await rows(s, 'enrollment_release_pins')).length).toBe(count);
      // The authorizer now relies on another basis: a request-key conflict.
      grant(s, 'basis-b');
      await expect(pin(s, fresh, rel2.id, {}, key)).rejects.toBeInstanceOf(
        CourseRequestKeyConflictError,
      );
      // Authorization is still live on a replay.
      s.state.override = () => false;
      await expect(pin(s, fresh, rel2.id, {}, key)).rejects.toBeInstanceOf(
        CourseAuthoringAuthorizationError,
      );
    });

    it('records the per-enrollment decision basis on automatic moves and skips, falling back to the opt-in basis', async () => {
      const cases: Array<[string, unknown, boolean, string]> = [
        ['decision basis on a move', 'per-learner', true, 'per-learner'],
        ['fallback on a move', undefined, true, 'guardians-only'],
        [
          'invalid basis denies, opt-in basis kept',
          'bad\nbasis',
          false,
          'guardians-only',
        ],
      ];
      for (const [label, basis, moved, expected] of cases) {
        const s = await setup();
        await s.optIn(s.guardian, true);
        s.state.override = (call) =>
          call.operation === 'auto-upgrade'
            ? {
                allowed: true,
                ...(basis === undefined
                  ? {}
                  : { policyBasis: basis as string }),
              }
            : undefined;
        const q = await s.question(mcq(`Q-${label}`));
        await s.publish([['a', [q]]]);
        const pins = (await rows(s, 'enrollment_release_pins')).filter(
          (r) => r.kind === 'auto',
        );
        const skips = await rows(s, 'enrollment_auto_upgrade_skips');
        expect(pins.length, label).toBe(moved ? 1 : 0);
        expect(skips.length, label).toBe(moved ? 0 : 1);
        expect((moved ? pins : skips)[0].policy_basis, label).toBe(expected);
      }
      // A denial that names its own basis records it on the skip.
      const s = await setup();
      await s.optIn(s.guardian, true);
      s.state.override = (call) =>
        call.operation === 'auto-upgrade'
          ? { allowed: false, policyBasis: 'denied-under', code: 'x' }
          : undefined;
      await s.publish([['a', [await s.question(mcq('Q-deny'))]]]);
      expect((await rows(s, 'enrollment_auto_upgrade_skips'))[0]).toMatchObject(
        {
          policy_basis: 'denied-under',
        },
      );
    });
  });

  describe('skips', () => {
    async function skipped(decision: () => unknown) {
      const s = await setup();
      await s.optIn(s.agent, true);
      s.state.override = (call) =>
        call.operation === 'auto-upgrade'
          ? (decision() as boolean | CourseAuthorizationDecision)
          : undefined;
      const q = await s.question(mcq('Q9'));
      await s.publish([['a', [q]]]);
      return s;
    }
    const list = (s: Awaited<ReturnType<typeof setup>>, extra = {}) =>
      s.as(s.guardian, () =>
        s.authoring.listAutoUpgradeSkips({
          ...s.guardian,
          courseId: s.course.courseId,
          ...extra,
        }),
      );

    it('records and exposes the authorizer reason and code', async () => {
      const s = await skipped(() => ({
        allowed: false,
        reason: 'Agents may not assign this learner',
        code: 'agent-permission',
      }));
      const page = await list(s);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        enrollmentId: s.enrollmentId,
        learnerId: String(s.f.learner.id),
        courseId: s.course.courseId,
        optInScope: 'course',
        optInActorUserId: s.agent.actorUserId,
        optInDelegatingGuardianUserId: s.guardian.actorUserId,
        optInDelegationId: 'delegation-1',
        policyBasis: 'guardians-only',
        reason: 'Agents may not assign this learner',
        code: 'agent-permission',
      });
      // Filter by enrollment, and the same rows via the enrollment alone.
      const byEnrollment = await s.as(s.guardian, () =>
        s.authoring.listAutoUpgradeSkips({
          ...s.guardian,
          enrollmentId: s.enrollmentId,
        }),
      );
      expect(byEnrollment.items).toEqual(page.items);
      // The pin did not move.
      const pin = await s.as(s.guardian, () =>
        s.authoring.getEnrollmentRelease({
          ...s.guardian,
          enrollmentId: s.enrollmentId,
        }),
      );
      expect(pin.pin.releaseId).toBe(s.rel1.id);
    });

    it('keeps a boolean denial generic and sanitizes bad values', async () => {
      const results: unknown[] = [
        false,
        { allowed: false },
        {
          allowed: false,
          reason: `bad\u0000\u0007 text${'x'.repeat(400)}`,
          code: 'Bad Code!',
        },
        { allowed: false, reason: 5, code: 'x'.repeat(65) },
      ];
      let i = 0;
      const s = await skipped(() => results[i++]);
      for (let n = 1; n < results.length; n += 1) {
        const q = await s.question(mcq(`more ${n}`));
        await s.publish([['a', [q]]]);
      }
      const items = (await list(s)).items;
      expect(items).toHaveLength(4);
      const [boolean, noReason, dirty, wrongTypes] = items;
      expect(boolean).toMatchObject({ reason: 'not-authorized', code: '' });
      expect(noReason).toMatchObject({ reason: 'not-authorized', code: '' });
      expect(dirty.code).toBe('');
      expect(dirty.reason.length).toBeLessThanOrEqual(200);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: assert none stored
      expect(dirty.reason).not.toMatch(/[\u0000-\u001f]/);
      expect(dirty.reason.startsWith('bad')).toBe(true);
      expect(wrongTypes).toMatchObject({ reason: 'not-authorized', code: '' });
    });

    it('never records a thrown message', async () => {
      const s = await skipped(() => {
        throw new Error('policy store down: secret-dsn');
      });
      const page = await list(s);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        reason: 'not-authorized',
        code: '',
      });
      expect(JSON.stringify(page)).not.toContain('secret-dsn');
      const rows = await s.db.list('enrollment_auto_upgrade_skips', {});
      expect(JSON.stringify(rows)).not.toContain('secret-dsn');
    });

    it('requires a course or enrollment and paginates', async () => {
      const s = await skipped(() => false);
      await expect(
        s.as(s.guardian, () =>
          s.authoring.listAutoUpgradeSkips({ ...s.guardian }),
        ),
      ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
      const q = await s.question(mcq('another'));
      await s.publish([['a', [q]]]);
      const first = await list(s, { limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await list(s, {
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0].id).not.toBe(first.items[0].id);
      expect(second.nextCursor).toBeNull();
    });
  });

  it('authoring lesson: keyed bundle with revision, layout and question refs', async () => {
    const s = await setup();
    const view = await s.as(s.guardian, () =>
      s.authoring.readReleasedLesson({
        ...s.guardian,
        releaseId: s.rel1.id,
        lessonKey: 'a',
      }),
    );
    expect(view).toMatchObject({
      releaseId: s.rel1.id,
      courseId: s.course.courseId,
      lessonKey: 'a',
      lessonId: s.lessons1.a,
    });
    expect(view.revision).toMatchObject({
      title: 'A',
      body: 'Body of a',
      layoutParams: { columns: 2 },
    });
    expect(view.revision.questions.map((q) => q.questionRevisionId)).toEqual([
      s.q1,
      s.q2,
    ]);
    expect(view.worksheet.audience).toBe('guardian');
    expect(view.worksheet.worksheetVersionId).toMatch(/^wsv1-/);
    expect(view.worksheet.items.map((i) => i.questionRevisionId)).toEqual([
      s.q1,
      s.q2,
    ]);
    expect(JSON.stringify(view.worksheet)).toContain(SECRET);
    await expect(
      s.as(s.guardian, () =>
        s.authoring.readReleasedLesson({
          ...s.guardian,
          releaseId: s.rel1.id,
          lessonKey: 'nope',
        }),
      ),
    ).rejects.toBeInstanceOf(QuestionNotFoundError);
  });

  it('learner lesson: keyless, effective set only, also for the guardian', async () => {
    const s = await setup();
    const own = await s.readLearner(s.f.own, s.lessons1.a);
    expect(own).toMatchObject({
      lessonKey: 'a',
      lessonId: s.lessons1.a,
      releaseId: s.rel1.id,
      title: 'A',
      body: 'Body of a',
      bodyWithheld: false,
      pinnedToOlderRelease: false,
    });
    expect(own.worksheet.audience).toBe('learner');
    expect(own.worksheet.items).toHaveLength(2);
    const text = JSON.stringify(own);
    for (const leak of [
      SECRET,
      'answerKey',
      'rubric',
      'fieldProvenance',
      'materials',
      'externalUrl',
      'licenseKind',
    ])
      expect(text).not.toContain(leak);
    // A guardian reading for the learner gets the same keyless view.
    const viaGuardian = await s.readLearner(s.f.parent, s.lessons1.a);
    expect(viaGuardian).toEqual(own);
    s.learnerCalls.length = 0;
    await s.readLearner(s.f.parent, s.lessons1.a);
    expect(s.learnerCalls.at(-1)).toMatchObject({
      action: 'education.learner.read',
      own: false,
    });
    // A lesson that is not part of the enrollment is a scope error.
    await expect(
      s.readLearner(s.f.own, String(s.f.wrongLesson.id)),
    ).rejects.toBeInstanceOf(QuestionResponseScopeError);
    await expect(s.readLearner(s.f.own, randomUUID())).rejects.toBeInstanceOf(
      QuestionResponseScopeError,
    );
    // A different learner of the same family is not authorized.
    await expect(
      s.readLearner(s.f.sibling as never, s.lessons1.a),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  });

  it('learner lesson: personal-use body is withheld, questions stay learner-safe', async () => {
    const s = await setup();
    const view = await s.readLearner(s.f.own, s.lessons1.b);
    expect(view).toMatchObject({
      title: 'B',
      body: '',
      bodyWithheld: true,
    });
    expect(view.worksheet.items).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    // The authoring view still carries the body for the guardian's own use.
    const authored = await s.as(s.guardian, () =>
      s.authoring.readReleasedLesson({
        ...s.guardian,
        releaseId: s.rel1.id,
        lessonKey: 'b',
      }),
    );
    expect(authored.revision.body).toBe('Body of b');
    expect(authored.revision.licenseKind).toBe('personal-use-copy');
  });

  it('learner lesson: after an upgrade, started lessons stay readable on their row', async () => {
    const s = await setup();
    await s.f.as(s.f.own, () =>
      s.f.service.startLesson({
        ...s.f.own,
        enrollmentId: s.enrollmentId,
        lessonId: s.lessons1.a,
      }),
    );
    const q = await s.question(mcq('Q new'));
    const rel2 = await s.publish([
      ['a', [q]],
      ['b', [q]],
    ]);
    const r2 = s.ids(rel2);
    await s.upgrade(rel2.id);
    const started = await s.readLearner(s.f.own, s.lessons1.a);
    expect(started).toMatchObject({
      releaseId: s.rel1.id,
      pinnedToOlderRelease: true,
    });
    expect(started.worksheet.items.map((i) => i.questionRevisionId)).toEqual([
      s.q1,
      s.q2,
    ]);
    // Unstarted lesson b follows release 2; its release-1 row is refused.
    const moved = await s.readLearner(s.f.own, r2.b);
    expect(moved).toMatchObject({ releaseId: rel2.id, lessonKey: 'b' });
    await expect(s.readLearner(s.f.own, s.lessons1.b)).rejects.toBeInstanceOf(
      QuestionResponseScopeError,
    );
    // Started lesson a on release 2 is not the effective row.
    await expect(s.readLearner(s.f.own, r2.a)).rejects.toBeInstanceOf(
      QuestionResponseScopeError,
    );
  });
});
