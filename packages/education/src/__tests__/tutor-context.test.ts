import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SubmissionCollection } from '../collections.js';
import { EnrollmentNoteService } from '../enrollment-note-service.js';
import {
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringActor,
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  LearnerService,
  LearnerValidationError,
  MAX_TUTOR_BODY_CHARS,
  MAX_TUTOR_CHOICES,
  MAX_TUTOR_CONTEXT_CHARS,
  MAX_TUTOR_PROMPT_CHARS,
  MAX_TUTOR_QUESTIONS,
  QuestionAuthoringService,
  type QuestionContentInput,
  TutorContextService,
} from '../index.js';
import { learnerFixture } from './learner-workflows.js';
import { submissionClasses } from './submission-workflows.js';

/*
 * Behavior-to-test matrix (TutorContextService, child-safety boundary):
 *  learner audience carries no key/rubric/note/asset/other-learner data .. 'sentinels'
 *  answerKeyAvailable true (key, asset) / false (no key) ................. 'answerKeyAvailable'
 *  guardian audience carries key + rubric text, never asset locators ..... 'guardian'
 *  guardian audience refused for the learner's own actor ................. 'guardian'
 *  size caps, truncation flag, question and context bounds ............... 'bounds'
 *  authorizer action, own flag and the current executor .................. 'authorizer'
 *  sibling, other tenant, foreign lesson/question, unauthorized .......... 'denials'
 *  request shape errors ................................................. 'denials'
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
    'LearningObjective',
    'LearningObjectiveRevision',
    'Question',
    'QuestionRevision',
    'QuestionResponse',
    'LessonPage',
    'LessonActivity',
    'WorkAttempt',
    'WorkAssessmentRevision',
    'WorkFeedbackRelease',
    'TutorSession',
    'TutorSessionClosure',
    'TutorExchange',
    'LearnerInterestThemeChange',
  ]),
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

const S = {
  key: 'SENTINEL-ANSWER-KEY-8841',
  rubric: 'SENTINEL-RUBRIC-LABEL-5520',
  note: 'SENTINEL-GUARDIAN-NOTE-3127',
  assetId: 'SENTINEL-KEY-ASSET-ID-9904',
  assetUri: 'SENTINEL-s3://private/answer-key.pdf',
  body: 'Today we add fractions with unlike denominators.',
};

async function tutorSetup(
  options: {
    body?: string;
    prompt?: string;
    questionCount?: number;
    withKey?: boolean;
    huge?: boolean;
  } = {},
) {
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
  const tutor = new TutorContextService(db, authorize, () => true);
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
  const objective = await as(guardian, () =>
    authoring.createLearningObjective({
      ...guardian,
      requestKey: key('o'),
      externalKey: 'obj-1',
      objective: { statement: 'Add unlike fractions' },
    }),
  );
  const withKey = options.withKey ?? true;
  const big = (n: number) => options.huge === true && n === 0;
  const content = (n: number): QuestionContentInput => ({
    prompt: big(n)
      ? 'q'.repeat(MAX_TUTOR_PROMPT_CHARS)
      : n === 0 && options.prompt
        ? options.prompt
        : `Question ${n + 1}`,
    responseType: 'multiple-choice',
    choices: big(n)
      ? Array.from({ length: MAX_TUTOR_CHOICES }, (_, i) => ({
          id: i === 0 ? 'a' : `c${i}`,
          label: '\\"'.repeat(MAX_TUTOR_PROMPT_CHARS / 2),
        }))
      : [
          { id: 'a', label: 'One' },
          { id: 'b', label: 'Two' },
        ],
    objectiveIds: [String(objective.id)],
    ...(withKey
      ? {
          answerKey: { correctChoiceIds: ['a'], explanation: S.key },
          rubric: {
            criteria: [{ id: 'm', label: S.rubric, maxPoints: 2 }],
          },
        }
      : {}),
    provenance: 'supplied',
  });
  const questionIds: string[] = [];
  for (let i = 0; i < (options.questionCount ?? 2); i++)
    questionIds.push(
      (
        await as(guardian, () =>
          authoring.createQuestion({
            ...guardian,
            requestKey: key('q'),
            content: content(i),
          }),
        )
      ).headRevisionId,
    );
  const course = await as(guardian, () =>
    authoring.createCourse({
      ...guardian,
      requestKey: key('course'),
      title: 'Fractions',
      levelMin: 3,
      levelMax: 4,
    }),
  );
  const saved = await as(guardian, () =>
    authoring.saveDraft({
      ...guardian,
      courseId: course.courseId,
      expectedHeadRevisionId: course.headRevisionId,
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
            lessons: [
              {
                lessonKey: 'a',
                title: 'Lesson A',
                body: options.body ?? S.body,
                lessonType: 'worksheet' as const,
                questions: questionIds.map((questionRevisionId) => ({
                  questionRevisionId,
                })),
              },
            ],
          },
        ],
      },
    }),
  );
  const release = (await as(guardian, () =>
    authoring.release({
      ...guardian,
      courseId: course.courseId,
      revisionId: saved.revisionId,
      requestKey: key('rel'),
    }),
  )) as unknown as {
    id: string;
    releaseCourseId: string;
    lessons: Array<{ lessonKey: string; lessonId: string }>;
  };
  const enrollment = await f.as(f.parent, () =>
    f.service.enroll({
      ...f.parent,
      curriculumId: String(f.curriculum.id),
      courseId: release.releaseCourseId,
    }),
  );
  const enrollmentId = String(enrollment.id);
  await as(guardian, () =>
    authoring.pinEnrollment({
      ...guardian,
      enrollmentId,
      releaseId: release.id,
      requestKey: key('pin'),
      policyBasis: 'guardians-only',
    }),
  );
  const lessonId = release.lessons[0].lessonId;
  // Guardian-only note on the same enrollment.
  const notes = new EnrollmentNoteService(db, authorize, () => true);
  await f.as(f.parent, () =>
    notes.addEnrollmentNote({
      ...f.parent,
      enrollmentId,
      text: S.note,
      requestKey: 'note-1',
    }),
  );
  const compose = (
    actor: typeof f.own | typeof f.parent,
    audience: 'learner' | 'guardian',
    extra: Record<string, unknown> = {},
  ) =>
    f.as(actor, () =>
      tutor.compose({
        ...actor,
        audience,
        enrollmentId,
        lessonId,
        ...extra,
      }),
    );
  return {
    db,
    f,
    calls,
    tutor,
    authorize,
    compose,
    enrollmentId,
    lessonId,
    questionIds,
    authoring,
    guardian,
    as,
  };
}

describe('TutorContextService', () => {
  it('sentinels: the learner audience carries no key, rubric, note, asset or other learner', async () => {
    const s = await tutorSetup();
    // A private answer-key asset joined to the lesson.
    await s.db.insert('lesson_assets', {
      id: randomUUID(),
      tenant_id: s.f.own.tenantId,
      lesson_id: s.lessonId,
      asset_id: S.assetId,
      relationship: 'answer-key',
      sort_order: 0,
      slug: randomUUID(),
      context: '',
    });
    const context = await s.compose(s.f.own, 'learner');
    const text = JSON.stringify(context);
    for (const sentinel of Object.values(S).filter((v) => v !== S.body))
      expect(text).not.toContain(sentinel);
    // The sibling and the foreign learner never appear.
    for (const other of [s.f.sibling, s.f.foreign])
      expect(text).not.toContain(String(other.id));
    expect(text).not.toContain('Bob');
    expect(context.lesson?.body).toBe(S.body);
    expect(context.lesson?.title).toBe('Lesson A');
    expect(context.course?.title).toBe('Fractions');
    expect(context.section?.title).toBe('Unit 1');
    expect(context.objectives).toEqual(['Add unlike fractions']);
    expect(context.questions.map((q) => q.prompt)).toEqual([
      'Question 1',
      'Question 2',
    ]);
    expect(context.questions[0]).not.toHaveProperty('answerKey');
    expect(context.questions[0]).not.toHaveProperty('rubric');
    expect(context.answerKeyAvailable).toBe(true);
    expect(context.audience).toBe('learner');
    expect(context.truncated).toBe(false);
    expect(context.contextHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sentinels: a guardian previewing the learner audience still sees no key', async () => {
    const s = await tutorSetup();
    const context = await s.compose(s.f.parent, 'learner');
    const text = JSON.stringify(context);
    for (const sentinel of [S.key, S.rubric, S.note, S.assetId])
      expect(text).not.toContain(sentinel);
  });

  it('answerKeyAvailable: false without any key, true from an asset alone', async () => {
    const s = await tutorSetup({ withKey: false });
    expect((await s.compose(s.f.own, 'learner')).answerKeyAvailable).toBe(
      false,
    );
    await s.db.insert('lesson_assets', {
      id: randomUUID(),
      tenant_id: s.f.own.tenantId,
      lesson_id: s.lessonId,
      asset_id: S.assetId,
      relationship: 'answer-key',
      sort_order: 0,
      slug: randomUUID(),
      context: '',
    });
    const context = await s.compose(s.f.own, 'learner');
    expect(context.answerKeyAvailable).toBe(true);
    expect(JSON.stringify(context)).not.toContain(S.assetId);
  });

  it('guardian: includes key and rubric text, never locators or notes', async () => {
    const s = await tutorSetup();
    await s.db.insert('lesson_assets', {
      id: randomUUID(),
      tenant_id: s.f.own.tenantId,
      lesson_id: s.lessonId,
      asset_id: S.assetId,
      relationship: 'answer-key',
      sort_order: 0,
      slug: randomUUID(),
      context: '',
    });
    const context = await s.compose(s.f.parent, 'guardian');
    const text = JSON.stringify(context);
    expect(text).toContain(S.key);
    expect(text).toContain(S.rubric);
    expect(text).not.toContain(S.assetId);
    expect(text).not.toContain(S.assetUri);
    expect(text).not.toContain(S.note);
    expect(context.questions[0].answerKey).toContain(S.key);
    expect(context.answerKeyAvailable).toBe(true);
    // The learner cannot ask for the guardian audience, whatever the host says.
    const permissive = new TutorContextService(
      s.db,
      () => true,
      () => true,
    );
    await expect(
      s.f.as(s.f.own, () =>
        permissive.compose({
          ...s.f.own,
          audience: 'guardian',
          enrollmentId: s.enrollmentId,
          lessonId: s.lessonId,
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  });

  it('bounds: caps text, questions and the whole context and flags truncation', async () => {
    const s = await tutorSetup({
      body: 'x'.repeat(MAX_TUTOR_BODY_CHARS + 500),
      prompt: 'p'.repeat(MAX_TUTOR_PROMPT_CHARS + 50),
      questionCount: MAX_TUTOR_QUESTIONS + 3,
    });
    const context = await s.compose(s.f.own, 'learner');
    expect(context.lesson?.body).toHaveLength(MAX_TUTOR_BODY_CHARS);
    expect(context.questions[0].prompt).toHaveLength(MAX_TUTOR_PROMPT_CHARS);
    expect(context.questions).toHaveLength(MAX_TUTOR_QUESTIONS);
    expect(context.truncated).toBe(true);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(
      MAX_TUTOR_CONTEXT_CHARS,
    );
    // The focus question survives the question cap.
    const last = s.questionIds[s.questionIds.length - 1];
    const focused = await s.compose(s.f.own, 'learner', {
      questionRevisionId: last,
    });
    expect(focused.focusQuestionRevisionId).toBe(last);
    expect(focused.questions.map((q) => q.questionRevisionId)).toContain(last);
    expect(focused.questions).toHaveLength(MAX_TUTOR_QUESTIONS);
  });

  it('bounds: an oversized focused question is shrunk to fit, keeping its identity', async () => {
    const s = await tutorSetup({ huge: true, questionCount: 3 });
    const focus = s.questionIds[0];
    for (const [actor, audience] of [
      [s.f.own, 'learner'],
      [s.f.parent, 'guardian'],
    ] as const) {
      const context = await s.compose(actor, audience, {
        questionRevisionId: focus,
      });
      expect(JSON.stringify(context).length).toBeLessThanOrEqual(
        MAX_TUTOR_CONTEXT_CHARS,
      );
      expect(context.truncated).toBe(true);
      expect(context.focusQuestionRevisionId).toBe(focus);
      expect(context.questions.map((q) => q.questionRevisionId)).toContain(
        focus,
      );
    }
  });

  it('bounds: a JSON-expanding lesson body still fits the serialized ceiling', async () => {
    const s = await tutorSetup({
      body: '\u0001'.repeat(MAX_TUTOR_BODY_CHARS),
      questionCount: 2,
    });
    const context = await s.compose(s.f.own, 'learner');
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(
      MAX_TUTOR_CONTEXT_CHARS,
    );
    expect(context.truncated).toBe(true);
  });

  it('authorizer: asks education.tutor.read with own flag on the current executor', async () => {
    const s = await tutorSetup();
    s.calls.length = 0;
    await s.compose(s.f.own, 'learner');
    expect(s.calls.length).toBeGreaterThan(0);
    for (const call of s.calls) {
      expect(call.action).toBe('education.tutor.read');
      expect(call.own).toBe(true);
      expect(call.executor).toBe(s.db);
    }
    s.calls.length = 0;
    await s.compose(s.f.parent, 'guardian');
    expect(s.calls.every((c) => c.own === false)).toBe(true);
    // Host denial fails closed.
    const deny = new TutorContextService(
      s.db,
      () => false,
      () => true,
    );
    await expect(
      s.f.as(s.f.own, () => deny.compose({ ...s.f.own, audience: 'learner' })),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // Inside a transaction the transaction executor is the one asked.
    const seen: unknown[] = [];
    const watch = new TutorContextService(
      s.db,
      (call) => {
        seen.push(call.executor);
        return call.own;
      },
      () => true,
    );
    await s.f.as(s.f.own, () =>
      watch.withTransaction((service) =>
        service.compose({ ...s.f.own, audience: 'learner' }),
      ),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((executor) => executor !== s.db)).toBe(true);
  });

  it('denials: sibling, other tenant, unrelated lesson, foreign question, bad shape', async () => {
    const s = await tutorSetup();
    const sibling = {
      tenantId: s.f.own.tenantId,
      actorUserId: String(s.f.bob.user.id),
      learnerId: s.f.own.learnerId,
    };
    await expect(
      s.f.as(sibling, () =>
        s.tutor.compose({
          ...sibling,
          audience: 'learner',
          enrollmentId: s.enrollmentId,
          lessonId: s.lessonId,
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    const foreign = {
      tenantId: s.f.foreign.tenantId,
      actorUserId: String(s.f.stranger.user.id),
      learnerId: s.f.own.learnerId,
    };
    await expect(
      s.f.as(foreign, () =>
        s.tutor.compose({ ...foreign, audience: 'learner' }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // Alice cannot read the sibling's learner or another tenant's.
    for (const other of [s.f.sibling, s.f.foreign])
      await expect(
        s.compose({ ...s.f.own, learnerId: String(other.id) }, 'learner'),
      ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // Lesson outside the enrollment.
    await expect(
      s.compose(s.f.own, 'learner', { lessonId: String(s.f.lesson.id) }),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // Question not in the lesson.
    await expect(
      s.compose(s.f.own, 'learner', { questionRevisionId: 'nope' }),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // A guardian without a relationship id.
    await expect(
      s.f.as(s.f.parent, () =>
        s.tutor.compose({
          ...s.f.parent,
          guardianRelationshipId: undefined,
          audience: 'guardian',
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // Shape errors.
    await expect(s.compose(s.f.own, 'robot' as never)).rejects.toBeInstanceOf(
      LearnerValidationError,
    );
    await expect(
      s.f.as(s.f.own, () =>
        s.tutor.compose({
          ...s.f.own,
          audience: 'learner',
          lessonId: s.lessonId,
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerValidationError);
  });

  it('composes a learner-level context without an enrollment', async () => {
    const s = await tutorSetup();
    const context = await s.f.as(s.f.own, () =>
      s.tutor.compose({ ...s.f.own, audience: 'learner' }),
    );
    expect(context.lesson).toBeNull();
    expect(context.questions).toEqual([]);
    expect(context.learner).toMatchObject({ displayName: 'Alice', level: 0 });
  });
  it('interest theme: both audiences read the learner-safe theme and nothing private beside it', async () => {
    const s = await tutorSetup();
    const none = await s.compose(s.f.own, 'learner');
    expect(none.learner.interestTheme).toBeNull();
    // Guardian-only sentinels in the learner row's free settings JSON.
    await s.f.as(s.f.parent, async () => {
      const row = await s.f.learners.get({ id: String(s.f.learner.id) });
      if (!row) throw new Error('missing learner');
      row.setSettings({ guardianOnly: 'SENTINEL-LEARNER-SETTING-7731' });
      await row.save();
    });
    await s.f.as(s.f.parent, () =>
      new LearnerService(
        s.db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === s.f.guardianType.id,
        () => true,
      ).setInterestTheme({
        ...s.f.parent,
        theme: { label: 'Minecraft', key: 'minecraft' },
        policyBasis: 'guardian',
      }),
    );
    for (const audience of ['learner', 'guardian'] as const) {
      const context = await s.compose(
        audience === 'learner' ? s.f.own : s.f.parent,
        audience,
      );
      expect(context.learner.interestTheme).toEqual({
        label: 'Minecraft',
        key: 'minecraft',
      });
      expect(Object.keys(context.learner).sort()).toEqual([
        'displayName',
        'id',
        'interestTheme',
        'level',
      ]);
      const text = JSON.stringify(context);
      for (const sentinel of [
        'SENTINEL-LEARNER-SETTING-7731',
        S.key,
        S.rubric,
        S.note,
      ])
        if (audience === 'learner') expect(text).not.toContain(sentinel);
      expect(text).not.toContain('SENTINEL-LEARNER-SETTING-7731');
    }
    // A changed theme changes the context digest, so sessions can tell.
    const before = (await s.compose(s.f.own, 'learner')).contextHash;
    await s.f.as(s.f.parent, () =>
      new LearnerService(
        s.db,
        ({ own, relationshipTypeId }) =>
          own || relationshipTypeId === s.f.guardianType.id,
        () => true,
      ).setInterestTheme({
        ...s.f.parent,
        theme: null,
        policyBasis: 'guardian',
      }),
    );
    const after = await s.compose(s.f.own, 'learner');
    expect(after.learner.interestTheme).toBeNull();
    expect(after.contextHash).not.toBe(before);
  });

  it('feedback: the learner sees only released feedback text; a guardian sees the newest', async () => {
    const s = await tutorSetup();
    const tenant = s.f.own.tenantId;
    const learner = s.f.own.learnerId;
    const activity = randomUUID();
    const attempt = randomUUID();
    const progress = await s.f.as(s.f.own, () =>
      s.f.service.startLesson({
        ...s.f.own,
        enrollmentId: s.enrollmentId,
        lessonId: s.lessonId,
      }),
    );
    const submission = await s.f.as(s.f.own, () =>
      SubmissionCollection.create({ db: s.db }).then((c) =>
        c.create({
          tenantId: tenant,
          learnerId: learner,
          lessonId: s.lessonId,
          progressId: progress.id,
          status: 'graded',
          notes: 'SENTINEL-SUBMISSION-NOTE',
        }),
      ),
    );
    const row = (extra: Record<string, unknown>) => ({
      slug: randomUUID(),
      context: '',
      tenant_id: tenant,
      learner_id: learner,
      ...extra,
    });
    await s.db.insert(
      'workbook_activities',
      row({
        id: activity,
        enrollment_id: s.enrollmentId,
        lesson_id: s.lessonId,
        capture_kind: 'identified',
      }),
    );
    await s.db.insert(
      'workbook_attempts',
      row({
        id: attempt,
        activity_id: activity,
        submission_id: String(submission.id),
        captured_at: new Date().toISOString(),
        episode_id: 'e1',
        review_required: 1,
        policy_version: 1,
        assistance: 'unknown',
        actor_user_id: tenant,
        source_hashes: '[]',
      }),
    );
    const revision = async (feedback: string, at: number, kind = 'ai') => {
      const id = randomUUID();
      await s.db.insert(
        'workbook_assessment_revisions',
        row({
          id,
          attempt_id: attempt,
          request_key: id,
          request_digest: id,
          kind,
          actor_user_id: tenant,
          decision_reason: '',
          assessment_json: JSON.stringify({ feedback }),
          recorded_at: new Date(at).toISOString(),
        }),
      );
      return id;
    };
    const released = await revision('RELEASED-FEEDBACK-TEXT', 1000);
    await revision('UNRELEASED-SENTINEL-FEEDBACK', 2000);
    await s.db.insert(
      'workbook_feedback_releases',
      row({
        id: randomUUID(),
        attempt_id: attempt,
        revision_id: released,
        request_key: 'r1',
        actor_user_id: tenant,
        recorded_at: new Date(3000).toISOString(),
      }),
    );
    const learnerView = await s.compose(s.f.own, 'learner');
    expect(learnerView.progress?.status).toBe('in_progress');
    expect(learnerView.submissions).toEqual({
      count: 1,
      latestStatus: 'graded',
    });
    expect(JSON.stringify(learnerView)).not.toContain(
      'SENTINEL-SUBMISSION-NOTE',
    );
    expect(learnerView.feedback).toEqual({ text: 'RELEASED-FEEDBACK-TEXT' });
    expect(JSON.stringify(learnerView)).not.toContain('UNRELEASED-SENTINEL');
    const guardianView = await s.compose(s.f.parent, 'guardian');
    expect(guardianView.feedback).toEqual({
      text: 'UNRELEASED-SENTINEL-FEEDBACK',
    });
  });
});
