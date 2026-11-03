import {
  getSQLFromDiff,
  getTestDatabase,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  MigrationGenerator,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseGenerationBriefError,
  CourseGenerationReviewService,
  type CourseGeneratorRequest,
  type CourseMaterialGenerator,
  CourseNotFoundError,
  CourseRequestKeyConflictError,
  LearnerService,
  ReviewNotCurrentError,
} from '../index.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

const tables = ['CourseGenerationBriefRecord'];
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
  'LearningObjective',
  'LearningObjectiveRevision',
  'Question',
  'QuestionRevision',
  'QuestionResponse',
  'CourseGenerationJob',
  'CourseGenerationEvent',
  'CourseProposal',
  'CourseProposalDecision',
  'CourseReview',
  'CourseReviewFinding',
  'CourseReviewOutdatedMarker',
  'CourseFindingResolution',
  'LearnerInterestThemeChange',
  ...tables,
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

const OBJECTIVE = 'Multiply a whole number by a multiple of ten';
const LESSON_OUTPUT = {
  lessons: [
    {
      sectionKey: 'requested',
      sectionTitle: 'Requested lessons',
      title: 'Shields by tens',
      body: 'You have 24 diamonds. A shield takes 6. How many shields?',
      estimatedMinutes: 20,
      questions: [
        {
          prompt: 'A shield takes 6 diamonds. How many for 30 shields?',
          responseType: 'numeric',
          answerKey: {
            numeric: { value: 180 },
            explanation: '6 x 3 tens = 18 tens = 180.',
          },
          pointsPossible: 1,
        },
        {
          prompt: 'What is 40 x 7?',
          responseType: 'short-answer',
          answerKey: { acceptedAnswers: ['280'] },
        },
      ],
    },
  ],
  rationale: 'A one-lesson worksheet.',
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
  const agent: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: String(f.bob.user.id),
    delegatingGuardianUserId: guardian.actorUserId,
    delegationId: 'delegation-1',
  };
  const calls: Array<Parameters<CourseAuthoringAuthorizer>[0]> = [];
  const grants = new Map<string, CourseAuthoringAction[]>([
    [guardian.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [agent.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
  ]);
  const denied = new Set<CourseAuthoringAction>();
  const deniedLearners = new Set<string>();
  const hostBasis = { value: undefined as string | undefined };
  const authorizer: CourseAuthoringAuthorizer = (call) => {
    calls.push(call);
    const allowed =
      !denied.has(call.action) &&
      !(call.learnerId && deniedLearners.has(call.learnerId)) &&
      (grants.get(call.actorUserId) ?? []).includes(call.action);
    return allowed && hostBasis.value && call.action.endsWith('.release')
      ? { allowed, policyBasis: hostBasis.value }
      : allowed;
  };
  const gen = {
    output: LESSON_OUTPUT as unknown,
    calls: [] as CourseGeneratorRequest[],
  };
  const generator: CourseMaterialGenerator = {
    identity: { provider: 'test-provider', model: 'stub', version: 'v1' },
    async generate(request) {
      gen.calls.push(request);
      return { output: gen.output, completion: 'complete' };
    },
  };
  const delegation = { allowed: true };
  const service = new CourseGenerationReviewService(db, authorizer, {
    verifyDelegation: () => delegation.allowed,
    generator,
  });
  const learners = new LearnerService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
  );
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  let counter = 0;
  const key = (label = 'k') => `${label}-${++counter}`;
  const learnerId = String(f.learner.id);
  const setSavedTheme = (label: string, themeKey = '') =>
    f.as(f.parent, () =>
      learners.setInterestTheme({
        ...f.parent,
        theme: { label, ...(themeKey ? { key: themeKey } : {}) },
        policyBasis: 'guardian',
      }),
    );
  /** The per-learner "Requested lessons" course: one empty section, released once. */
  async function course() {
    const created = await as(guardian, () =>
      service.createCourse({
        ...guardian,
        requestKey: key('create'),
        title: 'Requested lessons',
        levelMin: 3,
        levelMax: 4,
      }),
    );
    const saved = await as(guardian, () =>
      service.saveDraft({
        ...guardian,
        courseId: created.courseId,
        expectedHeadRevisionId: created.headRevisionId,
        requestKey: key('save'),
        draft: {
          title: 'Requested lessons',
          sections: [
            {
              sectionKey: 'requested',
              title: 'Requested lessons',
              lessons: [{ lessonKey: 'first', title: 'First', body: 'Hello' }],
            },
          ],
          provenance: 'supplied',
        },
      }),
    );
    return { courseId: created.courseId, headRevisionId: saved.revisionId };
  }
  const objective = async () =>
    (
      await as(guardian, () =>
        service.createLearningObjective({
          ...guardian,
          requestKey: key('obj'),
          externalKey: key('multiply-tens'),
          objective: { statement: OBJECTIVE, subject: 'Math' },
        }),
      )
    ).id;
  const request = (
    c: { courseId: string; headRevisionId: string },
    brief: Record<string, unknown> | undefined,
    actor = guardian,
    requestKey = key('gen'),
  ) =>
    as(actor, () =>
      service.requestGeneration({
        ...actor,
        courseId: c.courseId,
        expectedHeadRevisionId: c.headRevisionId,
        requestKey,
        instruction: 'Add a lesson',
        ...(brief ? { brief } : {}),
      } as never),
    );
  const run = (jobId: string, actor = guardian) =>
    as(actor, () => service.runGeneration({ ...actor, jobId }));
  const read = (courseId: string, revisionId?: string) =>
    as(guardian, () =>
      service.readDraft({ ...guardian, courseId, revisionId }),
    );
  const count = async (table: string) => (await db.list(table, {})).length;
  return {
    db,
    f,
    service,
    guardian,
    agent,
    calls,
    denied,
    deniedLearners,
    delegation,
    hostBasis,
    gen,
    as,
    key,
    learnerId,
    setSavedTheme,
    course,
    objective,
    request,
    run,
    read,
    count,
  };
}

const lessonBrief = (extra: Record<string, unknown> = {}) => ({
  target: 'lesson',
  subject: 'Math',
  category: 'Multiplication and division',
  area: 'multiplying by tens',
  grade: 4,
  objective: OBJECTIVE,
  ...extra,
});

describe('one-lesson generation target', () => {
  it('generates one themed lesson with a worksheet and answer keys, linked to the objective', async () => {
    const s = await setup();
    const c = await s.course();
    const objectiveId = await s.objective();
    const job = await s.request(
      c,
      lessonBrief({
        learnerId: s.learnerId,
        learningObjectiveId: objectiveId,
        theme: { label: 'Minecraft', key: 'minecraft' },
      }),
    );
    expect(job.brief).toEqual({
      target: 'lesson',
      subject: 'Math',
      category: 'Multiplication and division',
      area: 'multiplying by tens',
      grade: 4,
      objective: OBJECTIVE,
      learningObjectiveId: objectiveId,
      learnerId: s.learnerId,
      theme: { label: 'Minecraft', key: 'minecraft' },
      themeSource: 'override',
    });
    const done = await s.run(job.jobId);
    expect(done.status).toBe('succeeded');
    // The provider was given the resolved brief, objective and theme source.
    expect(s.gen.calls[0].brief).toMatchObject({
      target: 'lesson',
      objective: OBJECTIVE,
      themeSource: 'override',
    });
    const head = await s.read(c.courseId);
    expect(head.head.headRevisionId).toBe(done.resultRevisionId);
    const [first, added] = head.revision.sections[0].lessons;
    expect(first.title).toBe('First');
    expect(added.title).toBe('Shields by tens');
    expect(added.lessonType).toBe('worksheet');
    expect(added.provenance).toBe('generated');
    expect(added.questions).toHaveLength(2);
    // Each worksheet question is a generated, keyed record linked to the objective.
    const ref = added.questions[0].questionRevisionId;
    const revision = await s.db.get('question_revisions', { id: ref });
    const question = await s.as(s.guardian, () =>
      s.service.readQuestion({
        ...s.guardian,
        questionId: String(revision?.question_id),
      }),
    );
    expect(question.revision.provenance).toBe('generated');
    expect(question.revision.answerKey).toMatchObject({
      numeric: { value: 180 },
      explanation: '6 x 3 tens = 18 tens = 180.',
    });
    expect(question.revision.objectives.map((o) => o.objectiveId)).toEqual([
      objectiveId,
    ]);
    // The proposal carries the same objective and the theme used, for review.
    const proposal = await s.as(s.guardian, () =>
      s.service.getProposal({
        ...s.guardian,
        courseId: c.courseId,
        proposalId: String(done.proposalId),
      }),
    );
    expect(proposal.brief).toMatchObject({
      objective: OBJECTIVE,
      theme: { label: 'Minecraft', key: 'minecraft' },
      themeSource: 'override',
    });
    const field = proposal.fields.find((f) => f.field === 'new-lesson:0');
    expect(
      (field?.proposed as { objective: string } | undefined)?.objective,
    ).toBe(OBJECTIVE);
    expect(
      (
        await s.as(s.guardian, () =>
          s.service.getGeneration({ ...s.guardian, jobId: job.jobId }),
        )
      ).brief,
    ).toEqual(job.brief);
  });

  it('keeps the lesson target to the same review and release flow', async () => {
    const s = await setup();
    const c = await s.course();
    const done = await s.run((await s.request(c, lessonBrief())).jobId);
    const revisionId = String(done.resultRevisionId);
    await expect(
      s.as(s.guardian, () =>
        s.service.release({
          ...s.guardian,
          courseId: c.courseId,
          revisionId,
          requestKey: s.key('rel'),
        }),
      ),
    ).rejects.toBeInstanceOf(ReviewNotCurrentError);
    await s.as(s.guardian, () =>
      s.service.recordReview({
        ...s.guardian,
        courseId: c.courseId,
        revisionId,
        requestKey: s.key('rev'),
        generalSummary: 'Suitable for the level overall in these respects.',
        findings: [],
      } as never),
    );
    const released = await s.as(s.guardian, () =>
      s.service.release({
        ...s.guardian,
        courseId: c.courseId,
        revisionId,
        requestKey: s.key('rel'),
      }),
    );
    expect(released.lessons).toHaveLength(2);
    expect(released.policyBasis).toBeNull();
  });

  it('uses the area as the objective and refuses a lesson target with neither', async () => {
    const s = await setup();
    const c = await s.course();
    const job = await s.request(c, {
      target: 'lesson',
      area: 'multiplying by tens',
    });
    expect(job.brief?.objective).toBe('multiplying by tens');
    for (const brief of [
      { target: 'lesson' },
      { target: 'lesson', subject: 'Math' },
      { target: 'lesson', objective: '   ' },
    ])
      await expect(s.request(c, brief)).rejects.toBeInstanceOf(
        CourseGenerationBriefError,
      );
  });

  it('rejects malformed briefs without writing a job', async () => {
    const s = await setup();
    const c = await s.course();
    for (const brief of [
      { target: 'unit' },
      { target: 'course', grade: 13 },
      { target: 'course', grade: 4.5 },
      { target: 'course', subject: 'x'.repeat(201) },
      { target: 'course', area: 'bad\u0007' },
      { target: 'course', theme: { label: 'a@b.example' } },
      { target: 'course', theme: { label: 'Cars', key: 'NOT OK' } },
      { target: 'course', learnerId: 'has space' },
      { target: 'lesson', objective: 'x'.repeat(1001) },
      'lesson',
    ])
      await expect(s.request(c, brief as never)).rejects.toBeInstanceOf(
        CourseGenerationBriefError,
      );
    // Unknown objective and learner ids are refused, never stored.
    await expect(
      s.request(c, lessonBrief({ learningObjectiveId: 'unknown-objective' })),
    ).rejects.toBeInstanceOf(CourseGenerationBriefError);
    await expect(
      s.request(c, lessonBrief({ learnerId: 'unknown-learner' })),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    expect(await s.count('course_generation_jobs')).toBe(0);
    expect(await s.count('course_generation_briefs')).toBe(0);
  });

  it('fails the job, leaving no question or draft, when the output changes the objective or the shape', async () => {
    const s = await setup();
    const c = await s.course();
    const lesson = LESSON_OUTPUT.lessons[0];
    const cases: Array<[string, unknown]> = [
      [
        'lessons.0.objective',
        {
          ...LESSON_OUTPUT,
          lessons: [{ ...lesson, objective: 'Add fractions' }],
        },
      ],
      ['lessons', { ...LESSON_OUTPUT, lessons: [lesson, lesson] }],
      ['course', { ...LESSON_OUTPUT, course: { summary: 'A course summary' } }],
      [
        'lessons.0.body',
        { ...LESSON_OUTPUT, lessons: [{ ...lesson, body: undefined }] },
      ],
      [
        'lessons.0.questions',
        { ...LESSON_OUTPUT, lessons: [{ ...lesson, questions: [] }] },
      ],
      [
        'lessons.0.questions.0.answerKey',
        {
          ...LESSON_OUTPUT,
          lessons: [
            {
              ...lesson,
              questions: [{ prompt: 'No key?', responseType: 'numeric' }],
            },
          ],
        },
      ],
      [
        'lessons.0.questions.0',
        {
          ...LESSON_OUTPUT,
          lessons: [
            {
              ...lesson,
              questions: [
                {
                  prompt: 'Bad',
                  responseType: 'numeric',
                  answerKey: {},
                },
              ],
            },
          ],
        },
      ],
      [
        'lessons.0.questions.0.hint',
        {
          ...LESSON_OUTPUT,
          lessons: [
            {
              ...lesson,
              questions: [
                {
                  prompt: 'p',
                  responseType: 'numeric',
                  answerKey: { numeric: { value: 1 } },
                  hint: 'extra',
                },
              ],
            },
          ],
        },
      ],
      [
        'lessons.0.lessonKey',
        {
          ...LESSON_OUTPUT,
          lessons: [
            {
              lessonKey: 'first',
              body: 'Rewrite',
              questions: lesson.questions,
            },
          ],
        },
      ],
    ];
    for (const [path, output] of cases) {
      s.gen.output = output;
      const job = await s.request(c, lessonBrief());
      const done = await s.run(job.jobId);
      expect(done.status, path).toBe('failed');
      expect(done.errorCode, path).toBe('invalid-generation-output');
      const events = done.events.at(-1);
      expect(events?.detail, path).toBe(path);
    }
    expect(await s.count('questions')).toBe(0);
    expect(await s.count('course_proposals')).toBe(0);
    expect((await s.read(c.courseId)).head.headRevisionId).toBe(
      c.headRevisionId,
    );
  });

  it('accepts an echoed objective that differs only in whitespace', async () => {
    const s = await setup();
    const c = await s.course();
    s.gen.output = {
      ...LESSON_OUTPUT,
      lessons: [
        {
          ...LESSON_OUTPUT.lessons[0],
          objective: `  ${OBJECTIVE.replace(' ', '  ')} `,
        },
      ],
    };
    const done = await s.run((await s.request(c, lessonBrief())).jobId);
    expect(done.status).toBe('succeeded');
  });

  it('does not accept worksheet or objective members on a course target', async () => {
    const s = await setup();
    const c = await s.course();
    const job = await s.request(c, { target: 'course', subject: 'Math' });
    expect(job.brief?.target).toBe('course');
    const done = await s.run(job.jobId);
    expect(done.status).toBe('failed');
    expect(done.events.at(-1)?.detail).toBe('lessons.0.questions');
    // A plain request keeps today's behaviour and has no brief.
    s.gen.output = {
      lessons: [
        { sectionKey: 'requested', title: 'Plain', body: 'Plain body' },
      ],
    };
    const plain = await s.request(c, undefined);
    expect(plain.brief).toBeNull();
    const ok = await s.run(plain.jobId);
    expect(ok.status).toBe('succeeded');
    expect(s.gen.calls.at(-1)?.brief).toBeUndefined();
  });

  it('lets the host refuse a learner the requester has no relationship with, writing nothing', async () => {
    const s = await setup();
    const c = await s.course();
    const before = await s.db.list('course_generation_briefs', {});
    s.deniedLearners.add(String(s.f.sibling.id));
    await expect(
      s.request(c, lessonBrief({ learnerId: String(s.f.sibling.id) })),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect(await s.db.list('course_generation_briefs', {})).toEqual(before);
    expect(await s.db.list('course_generation_jobs', {})).toEqual([]);
  });

  it('requires the generate grant and asks the host about the learner', async () => {
    const s = await setup();
    const c = await s.course();
    s.denied.add('education.course.generate');
    await expect(
      s.request(c, lessonBrief({ learnerId: s.learnerId })),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    s.denied.clear();
    await s.request(c, lessonBrief({ learnerId: s.learnerId }));
    expect(
      s.calls.find(
        (call) =>
          call.operation === 'request-generation' &&
          call.learnerId === s.learnerId,
      ),
    ).toBeTruthy();
    // A delegated agent's run is authorized per delegation like any generation.
    s.delegation.allowed = false;
    await expect(s.request(c, lessonBrief(), s.agent)).rejects.toBeInstanceOf(
      CourseAuthoringAuthorizationError,
    );
  });
});

describe('per-request theme', () => {
  const themes = async (target: 'course' | 'lesson') => {
    const s = await setup();
    const c = await s.course();
    if (target === 'course')
      s.gen.output = {
        lessons: [{ sectionKey: 'requested', title: 'T', body: 'Body' }],
      };
    const brief = (extra: Record<string, unknown>) =>
      target === 'lesson'
        ? lessonBrief({ learnerId: s.learnerId, ...extra })
        : {
            target: 'course',
            subject: 'Math',
            learnerId: s.learnerId,
            ...extra,
          };
    return { s, c, brief };
  };

  for (const target of ['lesson', 'course'] as const) {
    it(`${target} target: the override beats the saved theme, the saved theme applies without one, and none means none`, async () => {
      const { s, c, brief } = await themes(target);
      // Neither: no theme.
      const none = await s.request(c, brief({}));
      expect(none.brief).toMatchObject({ theme: null, themeSource: 'none' });
      // Saved only: the learner's saved theme.
      await s.setSavedTheme('Roman', 'roman');
      const saved = await s.request(c, brief({}));
      expect(saved.brief).toMatchObject({
        theme: { label: 'Roman', key: 'roman' },
        themeSource: 'saved',
      });
      // Override wins for this request, with a stable key or a free label.
      const keyed = await s.request(
        c,
        brief({ theme: { label: 'Hockey', key: 'hockey' } }),
      );
      expect(keyed.brief).toMatchObject({
        theme: { label: 'Hockey', key: 'hockey' },
        themeSource: 'override',
      });
      const free = await s.request(
        c,
        brief({ theme: { label: ' Ancient   Egypt ' } }),
      );
      expect(free.brief).toMatchObject({
        theme: { label: 'Ancient Egypt', key: '' },
        themeSource: 'override',
      });
      // A request without a learner has nothing to fall back to.
      const anonymous = await s.request(
        c,
        target === 'lesson'
          ? lessonBrief()
          : { target: 'course', subject: 'Math' },
      );
      expect(anonymous.brief).toMatchObject({
        theme: null,
        themeSource: 'none',
      });
    });
  }

  it('never mutates the saved preference, whichever way the request ends', async () => {
    const { s, c, brief } = await themes('lesson');
    await s.setSavedTheme('Roman', 'roman');
    const history = await s.count('learner_interest_theme_changes');
    const row = await s.db.get('learners', { id: s.learnerId });
    const job = await s.request(
      c,
      brief({ theme: { label: 'Minecraft', key: 'minecraft' } }),
    );
    await s.run(job.jobId);
    const moved = (await s.read(c.courseId)).head.headRevisionId;
    s.gen.output = { lessons: [] };
    await s.run(
      (
        await s.request(
          { courseId: c.courseId, headRevisionId: moved },
          brief({ theme: { label: 'Cars' } }),
        )
      ).jobId,
    );
    const after = await s.db.get('learners', { id: s.learnerId });
    expect([after?.interest_theme_label, after?.interest_theme_key]).toEqual([
      'Roman',
      'roman',
    ]);
    expect(after).toEqual(row);
    expect(await s.count('learner_interest_theme_changes')).toBe(history);
    // The next request without an override still reads the saved theme.
    const next = await s.request(
      {
        courseId: c.courseId,
        headRevisionId: (await s.read(c.courseId)).head.headRevisionId,
      },
      brief({}),
    );
    expect(next.brief).toMatchObject({
      theme: { label: 'Roman', key: 'roman' },
      themeSource: 'saved',
    });
  });

  it('records the theme as it was on the request, not as it is later', async () => {
    const { s, c, brief } = await themes('lesson');
    await s.setSavedTheme('Roman', 'roman');
    const job = await s.request(c, brief({}));
    await s.setSavedTheme('Cars', 'cars');
    const done = await s.run(job.jobId);
    expect(done.brief?.theme).toEqual({ label: 'Roman', key: 'roman' });
    expect(s.gen.calls.at(-1)?.brief?.theme?.key).toBe('roman');
  });

  it('replays a request key as a no-op and refuses a changed brief', async () => {
    const { s, c, brief } = await themes('lesson');
    const first = await s.request(c, brief({}), s.guardian, 'same-key');
    const again = await s.request(c, brief({}), s.guardian, 'same-key');
    expect(again.jobId).toBe(first.jobId);
    expect(await s.count('course_generation_briefs')).toBe(1);
    // Resolution is not repeated: a later saved theme does not alter the replay.
    await s.setSavedTheme('Cars', 'cars');
    expect(
      (await s.request(c, brief({}), s.guardian, 'same-key')).brief,
    ).toEqual(first.brief);
    for (const changed of [
      brief({ theme: { label: 'Cars' } }),
      brief({ objective: 'Something else' }),
      { ...brief({}), target: 'course' },
      undefined,
    ])
      await expect(
        s.request(c, changed, s.guardian, 'same-key'),
      ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
  });

  it('refuses another tenant learner and keeps the brief off a plain request', async () => {
    const { s, c, brief } = await themes('lesson');
    await expect(
      s.request(c, brief({ learnerId: String(s.f.foreign.id) })),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    expect(await s.count('course_generation_jobs')).toBe(0);
  });
});

describe('release policy basis (auto-approve under a host setting)', () => {
  async function approved(s: Awaited<ReturnType<typeof setup>>) {
    const c = await s.course();
    const done = await s.run(
      (await s.request(c, lessonBrief(), s.agent)).jobId,
      s.agent,
    );
    return { c, revisionId: String(done.resultRevisionId) };
  }
  const review = (
    s: Awaited<ReturnType<typeof setup>>,
    courseId: string,
    revisionId: string,
    actor: CourseAuthoringActor,
    findings: unknown[] = [],
  ) =>
    s.as(actor, () =>
      s.service.recordReview({
        ...actor,
        courseId,
        revisionId,
        requestKey: s.key('rev'),
        generalSummary: 'Suitable for the level overall in these respects.',
        findings,
      } as never),
    );
  const release = (
    s: Awaited<ReturnType<typeof setup>>,
    courseId: string,
    revisionId: string,
    actor: CourseAuthoringActor,
    extra: Record<string, unknown> = {},
    requestKey = s.key('rel'),
  ) =>
    s.as(actor, () =>
      s.service.release({
        ...actor,
        courseId,
        revisionId,
        requestKey,
        ...extra,
      }),
    );

  it('records the basis a delegated agent relied on, after the same review gate', async () => {
    const s = await setup();
    const { c, revisionId } = await approved(s);
    await expect(
      release(s, c.courseId, revisionId, s.agent, {
        policyBasis: 'auto-approve-requested-lessons',
      }),
    ).rejects.toBeInstanceOf(ReviewNotCurrentError);
    await review(s, c.courseId, revisionId, s.agent);
    const released = await release(
      s,
      c.courseId,
      revisionId,
      s.agent,
      { policyBasis: 'auto-approve-requested-lessons' },
      'rel-1',
    );
    expect(released).toMatchObject({
      policyBasis: 'auto-approve-requested-lessons',
      actorUserId: s.agent.actorUserId,
      delegatingGuardianUserId: s.guardian.actorUserId,
      delegationId: 'delegation-1',
    });
    const row = await s.db.get('course_releases', { id: released.id });
    expect(row?.policy_basis).toBe('auto-approve-requested-lessons');
    // Replay is a no-op; another basis for the same key is a conflict.
    expect(
      (
        await release(
          s,
          c.courseId,
          revisionId,
          s.agent,
          { policyBasis: 'auto-approve-requested-lessons' },
          'rel-1',
        )
      ).id,
    ).toBe(released.id);
    for (const extra of [{ policyBasis: 'another' }, {}])
      await expect(
        release(s, c.courseId, revisionId, s.agent, extra, 'rel-1'),
      ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
  });

  it('lets the host authorizer state the basis; a disagreeing caller basis is refused', async () => {
    const s = await setup();
    const { c, revisionId } = await approved(s);
    await review(s, c.courseId, revisionId, s.guardian);
    s.hostBasis.value = 'learner-setting:auto-approve';
    await expect(
      release(s, c.courseId, revisionId, s.guardian, {
        policyBasis: 'something-else',
      }),
    ).rejects.toMatchObject({ code: 'policy-basis-mismatch' });
    const released = await release(s, c.courseId, revisionId, s.guardian);
    expect(released.policyBasis).toBe('learner-setting:auto-approve');
  });

  it('rejects an invalid basis and writes nothing', async () => {
    const s = await setup();
    const { c, revisionId } = await approved(s);
    await review(s, c.courseId, revisionId, s.guardian);
    for (const policyBasis of ['x'.repeat(201), 'bad\u0007', 5, '  '])
      await expect(
        release(s, c.courseId, revisionId, s.guardian, { policyBasis }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(await s.count('course_releases')).toBe(0);
  });

  it('does not let auto-approve bypass the gate, the grant or the delegation check', async () => {
    const s = await setup();
    const { c, revisionId } = await approved(s);
    // A human-verification finding blocks the release; the agent cannot clear it.
    await review(s, c.courseId, revisionId, s.agent, [
      {
        section: 'general-level',
        target: { kind: 'course-revision', id: revisionId, field: 'summary' },
        concern: 'factual-error',
        explanation: 'This needs a person to check the arithmetic.',
        suggestedChange: 'Check it.',
        humanVerificationRequired: true,
      },
    ]);
    await expect(
      release(s, c.courseId, revisionId, s.agent, {
        policyBasis: 'auto-approve-requested-lessons',
      }),
    ).rejects.toMatchObject({ reason: 'unresolved-findings' });
    // No release grant, or a delegation the host no longer verifies: denied.
    s.denied.add('education.course.release');
    await expect(
      release(s, c.courseId, revisionId, s.agent, { policyBasis: 'x' }),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    s.denied.clear();
    s.delegation.allowed = false;
    await expect(
      release(s, c.courseId, revisionId, s.agent, { policyBasis: 'x' }),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect(await s.count('course_releases')).toBe(0);
  });
});

describe('schema', () => {
  it('ships the brief table and the release basis column as an additive manifest diff', async () => {
    const s = await setup();
    const brief = ObjectRegistry.getSchema('CourseGenerationBriefRecord');
    const releases = ObjectRegistry.getSchema('CourseRelease');
    if (!brief || !releases) throw new Error('Missing schemas');
    await s.db.query(`DROP TABLE "${brief.tableName}"`);
    await s.db.query(
      `ALTER TABLE "${releases.tableName}" DROP COLUMN "policy_basis"`,
    );
    const schemas = {
      [brief.tableName]: brief,
      [releases.tableName]: releases,
    };
    const diff = await new SchemaComparer(s.db, {
      engineHint: 'sqlite',
    }).compare(schemas);
    expect(diff.added_tables.map((t) => t.tableName)).toEqual([
      brief.tableName,
    ]);
    expect(
      diff.changes
        .filter((change) => change.type === 'add_column')
        .map((change) => [change.table, change.name]),
    ).toEqual([[releases.tableName, 'policy_basis']]);
    const generated = new MigrationGenerator({
      engine: 'sqlite',
    }).generateFromDiff(diff, { name: 'learner_lesson_request' });
    const migration = createMigrationDefinition(
      '20261103_learner_lesson_request',
      generated.up,
      generated.down,
      { packageName: '@happyvertical/smrt-education', version: '0.57.51' },
    );
    const applied = await new MigrationTracker({
      db: s.db,
      engineHint: 'sqlite',
      useConcurrentIndexes: false,
    }).applyAll([migration], { postgresSafe: false });
    expect(applied.every((r) => r.success)).toBe(true);
    const second = await new SchemaComparer(s.db, {
      engineHint: 'sqlite',
    }).compare(schemas);
    expect(second.added_tables).toEqual([]);
    expect(
      getSQLFromDiff(second).filter((value) => !value.startsWith('--')),
    ).toEqual([]);
  });

  it('degrades on a host without the brief table: plain requests work, structured ones fail closed', async () => {
    const s = await setup();
    const c = await s.course();
    await s.db.query('DROP TABLE "course_generation_briefs"');
    const plain = await s.request(c, undefined);
    expect(plain.brief).toBeNull();
    await expect(s.request(c, lessonBrief())).rejects.toMatchObject({
      code: 'schema-unavailable',
    });
  });
});
