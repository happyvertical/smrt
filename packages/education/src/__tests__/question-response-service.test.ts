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
  CourseRequestKeyConflictError,
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  QuestionAuthoringService,
  type QuestionContentInput,
  QuestionResponseCollection,
  QuestionResponseNotFoundError,
  QuestionResponseScopeError,
  QuestionResponseService,
  QuestionResponseValidationError,
} from '../index.js';
import { learnerFixture } from './learner-workflows.js';
import { submissionClasses } from './submission-workflows.js';

/*
 * Behavior-to-test matrix (guarded QuestionResponse write path):
 *  learner records on own effective lesson question ......... 'records'
 *  cannot respond for another learner / actor ............... 'other learners'
 *  cannot respond outside the effective set (upgrade, pins) . 'effective set'
 *  cannot read keys / rubrics / provenance .................. 'keyless reads'
 *  guardian reads and reviews, sees keys .................... 'guardian'
 *  corrections append and reference, never overwrite ........ 'corrections'
 *  request-key replay and conflict .......................... 'request keys'
 *  assistance recorded ...................................... 'corrections'
 *  cross-tenant isolation ................................... 'other learners'
 *  authorizer receives executor + operation ................. 'authorizer'
 *  question revisions are never mutated ..................... 'records'
 *  closed response shape / completion mode .................. 'validation'
 *  additive migration diff ................................. question-records.test.ts
 *    ('ships the schema change as an additive manifest diff'; question_responses
 *    is a table added by the same unreleased change, so the diff is unchanged)
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
const mcq = (prompt: string, extra: Partial<QuestionContentInput> = {}) =>
  ({
    prompt,
    responseType: 'multiple-choice',
    choices: [
      { id: 'a', label: 'One' },
      { id: 'b', label: 'Two' },
    ],
    answerKey: { correctChoiceIds: ['a'], explanation: SECRET },
    rubric: { criteria: [{ id: 'm', label: 'Method', maxPoints: 2 }] },
    provenance: 'supplied',
    ...extra,
  }) as QuestionContentInput;

async function setup() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes,
  });
  opened.push(db);
  const f = await learnerFixture(db);
  const calls: Array<Parameters<LearnerAuthorizer>[0]> = [];
  const authorize: LearnerAuthorizer = (call) => {
    calls.push(call);
    return call.own || call.relationshipTypeId === f.guardianType.id;
  };
  const responses = new QuestionResponseService(db, authorize, () => true);
  const guardian: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: f.parent.actorUserId,
  };
  const authoring = new QuestionAuthoringService(
    db,
    (call) =>
      call.actorUserId === guardian.actorUserId &&
      COURSE_AUTHORING_ACTIONS.includes(call.action),
    { releaseReviewGate: () => ({ current: true, reviewId: 'review-1' }) },
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
  const course = await as(guardian, () =>
    authoring.createCourse({
      ...guardian,
      requestKey: key('course'),
      title: 'Fractions',
      levelMin: 3,
      levelMax: 4,
    }),
  );
  let expected = course.headRevisionId;
  const publish = async (
    lessons: Array<[string, string[]]>,
  ): Promise<{
    id: string;
    releaseCourseId: string;
    lessons: Array<{ lessonKey: string; lessonId: string }>;
  }> => {
    const saved = await as(guardian, () =>
      authoring.saveDraft({
        ...guardian,
        courseId: course.courseId,
        expectedHeadRevisionId: expected,
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
              lessons: lessons.map(([lessonKey, ids]) => ({
                lessonKey,
                title: lessonKey.toUpperCase(),
                lessonType: 'worksheet' as const,
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
    expected = saved.headRevisionId;
    return as(guardian, () =>
      authoring.release({
        ...guardian,
        courseId: course.courseId,
        revisionId: saved.revisionId,
        requestKey: key('rel'),
      }),
    ) as never;
  };
  const q1 = await question(mcq('Q1'));
  const q2 = await question(
    mcq('Q2', {
      responseType: 'short-answer',
      answerKey: { acceptedAnswers: [SECRET] },
      choices: undefined,
    }),
  );
  const q3 = await question(mcq('Q3'));
  const rel1 = await publish([
    ['a', [q1, q2]],
    ['b', [q3]],
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
    }),
  );
  const ids = (release: {
    lessons: Array<{ lessonKey: string; lessonId: string }>;
  }) =>
    Object.fromEntries(release.lessons.map((l) => [l.lessonKey, l.lessonId]));
  const lessons1 = ids(rel1);
  const learnerCall = (lessonKey: string) => ({
    ...f.own,
    enrollmentId,
    lessonId: lessonKey,
  });
  const record = (
    over: Partial<
      Parameters<QuestionResponseService['recordResponse']>[0]
    > = {},
  ) =>
    f.as(f.own, () =>
      responses.recordResponse({
        ...f.own,
        enrollmentId,
        lessonId: lessons1.a,
        questionRevisionId: q1,
        requestKey: key('r'),
        response: { choiceIds: ['a'] },
        ...over,
      }),
    );
  const correct = (
    over: Partial<
      Parameters<QuestionResponseService['recordGuardianCorrection']>[0]
    >,
  ) =>
    f.as(f.parent, () =>
      responses.recordGuardianCorrection({
        ...f.parent,
        enrollmentId,
        lessonId: lessons1.a,
        questionRevisionId: q1,
        requestKey: key('c'),
        correctsResponseId: '',
        ...over,
      }),
    );
  const readAs = (
    actor: typeof f.own | typeof f.parent,
    lessonId = lessons1.a,
  ) =>
    f.as(actor, () =>
      responses.readLessonResponses({ ...actor, enrollmentId, lessonId }),
    );
  return {
    db,
    f,
    calls,
    responses,
    authoring,
    guardian,
    as,
    key,
    publish,
    question,
    q1,
    q2,
    q3,
    rel1,
    enrollmentId,
    lessons1,
    ids,
    record,
    correct,
    readAs,
    learnerCall,
    upgrade: (releaseId: string) =>
      as(guardian, () =>
        authoring.upgradeEnrollment({
          ...guardian,
          enrollmentId,
          releaseId,
          requestKey: key('up'),
        }),
      ),
  };
}

describe('QuestionResponseService', () => {
  it('records: learner answers a question on their effective lesson', async () => {
    const s = await setup();
    const before = await s.db.list('question_revisions', {});
    const first = await s.record();
    expect(first).toMatchObject({
      attemptNumber: 1,
      completionMode: 'online',
      assistance: 'unknown',
      previousResponseId: null,
      byGuardian: false,
      questionRevisionId: s.q1,
      response: { choiceIds: ['a'] },
    });
    expect(first.worksheetVersionId).toMatch(/^wsv1-/);
    const second = await s.record({
      questionRevisionId: s.q2,
      response: { text: '3/4' },
      assistance: 'independent',
    });
    expect(second.assistance).toBe('independent');
    // A new attempt on the same question gets the next number and episode.
    const retry = await s.record();
    expect(retry.attemptNumber).toBe(2);
    expect(retry.episodeId).not.toBe(first.episodeId);
    // Question definitions are untouched.
    expect(await s.db.list('question_revisions', {})).toEqual(before);
    expect(await s.db.list('question_responses', {})).toHaveLength(3);
  });

  it('other learners: wrong actor, sibling, guardian attempt, other tenant', async () => {
    const s = await setup();
    const { f } = s;
    const base = { enrollmentId: s.enrollmentId, lessonId: s.lessons1.a };
    const attempt = (actor: typeof f.own, over = {}) =>
      f.as(actor, () =>
        s.responses.recordResponse({
          ...actor,
          ...base,
          questionRevisionId: s.q1,
          requestKey: s.key(),
          response: { choiceIds: ['a'] },
          ...over,
        }),
      );
    const sibling = {
      ...f.own,
      actorUserId: String(f.bob.user.id),
      learnerId: String(f.sibling.id),
    };
    const foreign = {
      tenantId: String(f.foreign.tenantId),
      actorUserId: String(f.stranger.user.id),
      learnerId: String(f.foreign.id),
    };
    for (const actor of [
      sibling,
      foreign,
      { ...f.own, actorUserId: String(f.bob.user.id) },
      { ...f.own, learnerId: String(f.sibling.id) },
    ])
      await expect(attempt(actor)).rejects.toBeInstanceOf(
        LearnerAuthorizationError,
      );
    // A guardian never starts an attempt for the learner.
    await expect(attempt(f.parent)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    // Ambient tenant must match.
    await expect(
      withTenant(
        { tenantId: foreign.tenantId, userId: f.own.actorUserId },
        () =>
          s.responses.recordResponse({
            ...f.own,
            ...base,
            questionRevisionId: s.q1,
            requestKey: s.key(),
            response: { text: 'x' },
          }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      f.as(sibling, () =>
        s.responses.readLessonResponses({ ...sibling, ...base }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // A learner cannot reach a guardian action by claiming it.
    await expect(
      f.as(f.own, () =>
        s.responses.recordGuardianCorrection({
          ...f.own,
          ...base,
          questionRevisionId: s.q1,
          requestKey: s.key(),
          correctsResponseId: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    expect(await s.db.list('question_responses', {})).toHaveLength(0);
  });

  it('effective set: unknown, other-lesson and post-upgrade questions are refused', async () => {
    const s = await setup();
    // A question of lesson b is not valid against lesson a.
    await expect(s.record({ questionRevisionId: s.q3 })).rejects.toBeInstanceOf(
      QuestionResponseScopeError,
    );
    await expect(
      s.record({ questionRevisionId: randomUUID() }),
    ).rejects.toBeInstanceOf(QuestionResponseScopeError);
    await expect(
      s.record({ lessonId: String(s.f.wrongLesson.id) }),
    ).rejects.toBeInstanceOf(QuestionResponseScopeError);
    // Start lesson a (pinned to release 1), then upgrade to release 2.
    await s.f.as(s.f.own, () =>
      s.f.service.startLesson({
        ...s.f.own,
        enrollmentId: s.enrollmentId,
        lessonId: s.lessons1.a,
      }),
    );
    const q1b = await s.question(mcq('Q1 new'));
    const q3b = await s.question(mcq('Q3 new'));
    const rel2 = await s.publish([
      ['a', [q1b]],
      ['b', [q3b]],
    ]);
    const r2 = s.ids(rel2);
    await s.upgrade(rel2.id);
    // Started lesson a stays on release 1: old question valid, new refused.
    expect((await s.record({ questionRevisionId: s.q1 })).attemptNumber).toBe(
      1,
    );
    await expect(
      s.record({ lessonId: r2.a, questionRevisionId: q1b }),
    ).rejects.toBeInstanceOf(QuestionResponseScopeError);
    await expect(s.record({ questionRevisionId: q1b })).rejects.toBeInstanceOf(
      QuestionResponseScopeError,
    );
    // Unstarted lesson b follows release 2: old rev1 row and question refused.
    await expect(
      s.record({ lessonId: s.lessons1.b, questionRevisionId: s.q3 }),
    ).rejects.toBeInstanceOf(QuestionResponseScopeError);
    await expect(
      s.record({ lessonId: r2.b, questionRevisionId: s.q3 }),
    ).rejects.toBeInstanceOf(QuestionResponseScopeError);
    const ok = await s.record({ lessonId: r2.b, questionRevisionId: q3b });
    expect(ok.questionRevisionId).toBe(q3b);
    // An unpinned enrollment has no authored questions at all.
    await expect(
      s.f.as(s.f.own, () =>
        s.responses.recordResponse({
          ...s.f.own,
          enrollmentId: String(s.f.enrollment.id),
          lessonId: String(s.f.lesson.id),
          questionRevisionId: s.q1,
          requestKey: s.key(),
          response: { text: 'x' },
        }),
      ),
    ).rejects.toBeInstanceOf(QuestionResponseScopeError);
  });

  it('keyless reads: the learner never receives keys, rubrics or provenance', async () => {
    const s = await setup();
    await s.record();
    const view = await s.readAs(s.f.own);
    expect(view.worksheet.audience).toBe('learner');
    expect(view.worksheet.items.map((i) => i.questionRevisionId)).toEqual([
      s.q1,
      s.q2,
    ]);
    const text = JSON.stringify(view);
    for (const leak of [
      SECRET,
      'correctChoiceIds',
      'answerKey',
      'rubric',
      'Method',
      'fieldProvenance',
      'acceptedAnswers',
    ])
      expect(text).not.toContain(leak);
    // Only the actor decides the audience; there is no request flag.
    expect(view.responses).toHaveLength(1);
    // Another lesson of the enrollment is a different bundle; unknown is refused.
    await expect(
      s.readAs(s.f.own, String(s.f.wrongLesson.id)),
    ).rejects.toBeInstanceOf(QuestionResponseScopeError);
  });

  it('guardian: reads responses with keys and records review corrections', async () => {
    const s = await setup();
    const first = await s.record();
    const view = await s.readAs(s.f.parent);
    expect(view.worksheet.audience).toBe('guardian');
    const keyed = view.worksheet.items as Array<{
      answerKey: unknown;
      rubric: unknown;
    }>;
    expect(JSON.stringify(keyed[0].answerKey)).toContain(SECRET);
    expect(keyed[0].rubric).toMatchObject({ criteria: [{ id: 'm' }] });
    expect(view.responses.map((r) => r.id)).toEqual([first.id]);
    // The guardian without a relationship, or a learner, gets no review access.
    await expect(
      s.readAs({
        ...s.f.parent,
        guardianRelationshipId: randomUUID(),
      } as never),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      s.readAs({ ...s.f.parent, guardianRelationshipId: undefined } as never),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  });

  it('corrections: append, reference the corrected response, record assistance', async () => {
    const s = await setup();
    const first = await s.record({ response: { choiceIds: ['b'] } });
    const fix = await s.correct({
      correctsResponseId: first.id,
      response: { choiceIds: ['a'] },
      assistance: 'assisted',
    });
    expect(fix).toMatchObject({
      previousResponseId: first.id,
      episodeId: first.episodeId,
      attemptNumber: 1,
      assistance: 'assisted',
      byGuardian: true,
      completionMode: 'online',
      response: { choiceIds: ['a'] },
    });
    // Assistance-only note keeps the corrected answer.
    const note = await s.correct({
      correctsResponseId: fix.id,
      assistance: 'independent',
    });
    expect(note.response).toEqual({ choiceIds: ['a'] });
    expect(note.assistance).toBe('independent');
    // The learner may correct their own answer; history is never rewritten.
    const own = await s.record({
      correctsResponseId: note.id,
      response: { choiceIds: ['b'] },
    });
    expect(own).toMatchObject({
      previousResponseId: note.id,
      attemptNumber: 1,
      byGuardian: false,
    });
    const rows = await s.readAs(s.f.parent);
    expect(rows.responses.map((r) => r.id)).toEqual([
      first.id,
      fix.id,
      note.id,
      own.id,
    ]);
    expect(rows.responses[0].response).toEqual({ choiceIds: ['b'] });
    expect(rows.responses[0].assistance).toBe('unknown');
    // Correcting an unknown or another question's response is refused.
    await expect(
      s.correct({ correctsResponseId: randomUUID() }),
    ).rejects.toBeInstanceOf(QuestionResponseNotFoundError);
    const other = await s.record({
      questionRevisionId: s.q2,
      response: { text: 'x' },
    });
    await expect(
      s.correct({ correctsResponseId: other.id }),
    ).rejects.toBeInstanceOf(QuestionResponseNotFoundError);
    await expect(s.correct({ correctsResponseId: '' })).rejects.toBeInstanceOf(
      QuestionResponseValidationError,
    );
    // Rows cannot be rewritten or erased even by the trusted collection.
    const collection = await QuestionResponseCollection.create({ db: s.db });
    const stored = await s.f.as(s.f.own, () =>
      collection.get({ id: first.id }, { cache: false }),
    );
    await expect(stored?.save()).rejects.toThrow();
    await expect(stored?.delete()).rejects.toThrow();
  });

  it('request keys: replay returns the same row, a different payload conflicts', async () => {
    const s = await setup();
    const requestKey = s.key('same');
    const first = await s.record({ requestKey });
    expect(await s.record({ requestKey })).toEqual(first);
    expect(await s.db.list('question_responses', {})).toHaveLength(1);
    for (const over of [
      { response: { choiceIds: ['b'] } },
      { questionRevisionId: s.q2, response: { text: 'x' } },
      { assistance: 'assisted' as const },
    ])
      await expect(s.record({ requestKey, ...over })).rejects.toBeInstanceOf(
        CourseRequestKeyConflictError,
      );
    // A retry after the lesson left scope still replays.
    const fix = await s.correct({
      requestKey: 'fix-1',
      correctsResponseId: first.id,
      assistance: 'assisted',
    });
    expect(
      await s.correct({
        requestKey: 'fix-1',
        correctsResponseId: first.id,
        assistance: 'assisted',
      }),
    ).toEqual(fix);
    await expect(
      s.correct({
        requestKey: 'fix-1',
        correctsResponseId: first.id,
        assistance: 'independent',
      }),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    expect(await s.db.list('question_responses', {})).toHaveLength(2);
  });

  it('validation: closed shape, known choices and parts, online only', async () => {
    const s = await setup();
    const cases: Array<Record<string, unknown>> = [
      { response: {} },
      { response: { choiceIds: ['zzz'] } },
      { response: { unexpected: 1 } },
      { response: { text: 5 } },
      { response: { numeric: Number.NaN } },
      { response: { choiceIds: ['a', 'a'] } },
      { response: { parts: { nope: { text: 'x' } } } },
      { response: { parts: [] } },
      { response: 'x' },
      { requestKey: '' },
      { requestKey: 'has space' },
      { completionMode: 'printable' },
      { assistance: 'maybe' },
      { questionRevisionId: '' },
    ];
    for (const over of cases)
      await expect(s.record(over as never)).rejects.toBeInstanceOf(
        QuestionResponseValidationError,
      );
    expect(await s.db.list('question_responses', {})).toHaveLength(0);
  });

  it('authorizer: receives the executor, operation and tenant-bound identity', async () => {
    const s = await setup();
    s.calls.length = 0;
    await s.record();
    await s.readAs(s.f.parent);
    const actions = s.calls.map((c) => c.action);
    expect(actions).toContain('education.learner.respond');
    expect(actions).toContain('education.learner.review-response');
    for (const call of s.calls) {
      expect(call.executor).toBeTruthy();
      expect(call.tenantId).toBe(s.f.own.tenantId);
    }
    // A host denial writes nothing.
    const denied = new QuestionResponseService(
      s.db,
      () => false,
      () => true,
    );
    await expect(
      s.f.as(s.f.own, () =>
        denied.recordResponse({
          ...s.f.own,
          enrollmentId: s.enrollmentId,
          lessonId: s.lessons1.a,
          questionRevisionId: s.q1,
          requestKey: s.key(),
          response: { text: 'x' },
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // A throwing authorizer fails closed.
    const throwing = new QuestionResponseService(
      s.db,
      () => {
        throw new Error('policy down');
      },
      () => true,
    );
    await expect(
      s.f.as(s.f.own, () =>
        throwing.readLessonResponses({
          ...s.f.own,
          enrollmentId: s.enrollmentId,
          lessonId: s.lessons1.a,
        }),
      ),
    ).rejects.toThrow();
    expect(await s.db.list('question_responses', {})).toHaveLength(1);
  });
});
