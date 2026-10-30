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
  COURSE_REVIEW_DISCLAIMER,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseAuthoringService,
  CourseAuthoringValidationError,
  CourseDiscardRefusedError,
  CourseFindingResolvedError,
  CourseGenerationInProgressError,
  CourseGenerationNotFoundError,
  CourseGenerationReviewService,
  CourseGeneratorNotConfiguredError,
  type CourseGeneratorRequest,
  type CourseMaterialGenerator,
  CourseNotFoundError,
  CourseProposalFieldError,
  CourseRequestKeyConflictError,
  CourseReview,
  type CourseReviewFindingInput,
  CourseReviewTargetError,
  CourseStaleHeadError,
  createProposalCourseGenerator,
  evaluateReviewer,
  HumanVerificationRequiredError,
  type ReviewFixtureCase,
  ReviewNotCurrentError,
} from '../index.js';
import { REVIEW_FIXTURE_CASES } from './course-review-fixtures.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

const tables = [
  'CourseGenerationJob',
  'CourseGenerationEvent',
  'CourseProposal',
  'CourseProposalDecision',
  'CourseReview',
  'CourseReviewFinding',
  'CourseReviewOutdatedMarker',
  'CourseFindingResolution',
];
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
  'LearningObjective',
  'LearningObjectiveRevision',
  'Question',
  'QuestionRevision',
  'QuestionResponse',
  ...tables,
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

type Call = Parameters<CourseAuthoringAuthorizer>[0];

const OUTPUT = {
  course: {
    summary: 'Generated summary',
    subject: 'Math',
    objectives: ['Generated objective'],
  },
  lessons: [
    { lessonKey: 'a', body: 'Generated body A' },
    { lessonKey: 'b', body: 'Generated body B' },
    { sectionKey: 'unit-1', title: 'Generated lesson', body: 'Brand new' },
  ],
  rationale: 'Because.',
};

async function setup(
  options: { generator?: boolean; timeoutMs?: number } = {},
) {
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
  };
  const outsider: CourseAuthoringActor = {
    tenantId: String(f.foreign.tenantId),
    actorUserId: String(f.stranger.user.id),
  };
  const calls: Call[] = [];
  const grants = new Map<string, CourseAuthoringAction[]>([
    [guardian.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [
      agent.actorUserId,
      COURSE_AUTHORING_ACTIONS.filter((a) => a !== 'education.course.archive'),
    ],
    [outsider.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
  ]);
  const denied = new Set<CourseAuthoringAction>();
  const authorizer: CourseAuthoringAuthorizer = (call) => {
    calls.push(call);
    return (
      !denied.has(call.action) &&
      (grants.get(call.actorUserId) ?? []).includes(call.action)
    );
  };
  const gen = {
    output: OUTPUT as unknown,
    usage: undefined as Record<string, number> | undefined,
    responseModel: undefined as string | undefined,
    error: null as Error | null,
    hold: null as Promise<void> | null,
    waitForAbort: false,
    calls: [] as CourseGeneratorRequest[],
  };
  const generator: CourseMaterialGenerator = {
    identity: { provider: 'test-provider', model: 'stub-model', version: 'v1' },
    async generate(request, opts) {
      gen.calls.push(request);
      if (gen.waitForAbort)
        await new Promise((_, reject) =>
          opts.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        );
      if (gen.hold) await gen.hold;
      if (gen.error) throw gen.error;
      return {
        output: gen.output,
        completion: 'complete',
        ...(gen.usage ? { usage: gen.usage } : {}),
        ...(gen.responseModel ? { responseModel: gen.responseModel } : {}),
      };
    },
  };
  const service = new CourseGenerationReviewService(db, authorizer, {
    ...(options.generator === false ? {} : { generator }),
    ...(options.timeoutMs
      ? { generationLimits: { timeoutMs: options.timeoutMs } }
      : {}),
  });
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  let counter = 0;
  const key = (label = 'k') => `${label}-${++counter}`;
  const sections = [
    {
      sectionKey: 'unit-1',
      title: 'Unit 1',
      lessons: [
        { lessonKey: 'a', title: 'Lesson A', body: 'Supplied body A' },
        { lessonKey: 'b', title: 'Lesson B' },
      ],
    },
  ];
  const save = (
    courseId: string,
    expected: string,
    next = sections,
    actor = guardian,
    extra: Record<string, unknown> = {},
  ) =>
    as(actor, () =>
      service.saveDraft({
        ...actor,
        courseId,
        expectedHeadRevisionId: expected,
        requestKey: key('save'),
        draft: {
          title: 'Fractions',
          summary: 'Supplied summary',
          theme: 'space',
          levelMin: 3,
          levelMax: 4,
          objectives: ['Original objective'],
          sections: next,
          provenance: 'supplied',
          ...extra,
        },
      }),
    );
  /** A course whose head carries supplied material. */
  async function course(actor = guardian) {
    const head = await as(actor, () =>
      service.createCourse({
        ...actor,
        requestKey: key('create'),
        title: 'Fractions',
        levelMin: 3,
        levelMax: 4,
      }),
    );
    const saved = await save(
      head.courseId,
      head.headRevisionId,
      sections,
      actor,
    );
    return { courseId: head.courseId, headRevisionId: saved.revisionId };
  }
  const request = (
    c: { courseId: string; headRevisionId: string },
    actor = guardian,
    requestKey = key('gen'),
    instruction = 'Fill gaps',
  ) =>
    as(actor, () =>
      service.requestGeneration({
        ...actor,
        courseId: c.courseId,
        expectedHeadRevisionId: c.headRevisionId,
        requestKey,
        instruction,
      }),
    );
  const run = (jobId: string, actor = guardian) =>
    as(actor, () => service.runGeneration({ ...actor, jobId }));
  async function generated(actor = guardian) {
    const c = await course(actor);
    const job = await request(c, actor);
    const done = await run(job.jobId, actor);
    return { c, job, done };
  }
  const read = (courseId: string, revisionId?: string, actor = guardian) =>
    as(actor, () => service.readDraft({ ...actor, courseId, revisionId }));
  const head = async (courseId: string) =>
    (await as(guardian, () => service.readDraft({ ...guardian, courseId })))
      .head.headRevisionId;
  const finding = (
    target: CourseReviewFindingInput['target'],
    extra: Partial<CourseReviewFindingInput> = {},
  ): CourseReviewFindingInput => ({
    section: 'general-level',
    target,
    concern: 'factual-error',
    explanation: 'This is wrong because of the following.',
    suggestedChange: 'Say it correctly.',
    ...extra,
  });
  const review = (
    courseId: string,
    revisionId: string,
    findings: CourseReviewFindingInput[] = [],
    extra: Record<string, unknown> = {},
    actor = guardian,
  ) =>
    as(actor, () =>
      service.recordReview({
        ...actor,
        courseId,
        revisionId,
        requestKey: key('rev'),
        generalSummary: 'Suitable for the level overall in these respects.',
        findings,
        ...extra,
      } as never),
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
  const count = async (table: string) => (await db.list(table, {})).length;
  return {
    db,
    f,
    service,
    guardian,
    agent,
    outsider,
    calls,
    denied,
    gen,
    as,
    key,
    course,
    save,
    request,
    run,
    generated,
    read,
    head,
    finding,
    review,
    release,
    count,
  };
}

describe('generation proposals', () => {
  it('writes proposals into a new draft revision and keeps supplied material', async () => {
    const s = await setup();
    const { c, done } = await s.generated();
    expect(done.status).toBe('succeeded');
    expect(done.resultRevisionId).toBeTruthy();
    const current = await s.read(c.courseId);
    expect(current.head.headRevisionId).toBe(done.resultRevisionId);
    expect(current.revision.parentRevisionId).toBe(c.headRevisionId);
    // Supplied fields stay; only empty fields are filled, with generated provenance.
    expect(current.revision.summary).toBe('Supplied summary');
    expect(current.revision.objectives).toEqual(['Original objective']);
    expect(current.revision.subject).toBe('Math');
    expect(current.revision.fieldProvenance.subject).toBe('generated');
    const [a, b, added] = current.revision.sections[0].lessons;
    expect(a.body).toBe('Supplied body A');
    expect(b.body).toBe('Generated body B');
    expect(b.fieldProvenance.body).toBe('generated');
    expect(added.title).toBe('Generated lesson');
    expect(added.provenance).toBe('generated');
    // The supplied base revision is immutable and unchanged.
    const base = await s.read(c.courseId, c.headRevisionId);
    expect(base.revision.subject).toBe('');
    expect(base.revision.sections[0].lessons).toHaveLength(2);
  });

  it('exposes a per-field comparison and never replaces supplied content silently', async () => {
    const s = await setup();
    const { c, done } = await s.generated();
    const view = await s.as(s.guardian, () =>
      s.service.getProposal({
        ...s.guardian,
        courseId: c.courseId,
        proposalId: done.proposalId as string,
      }),
    );
    const byField = Object.fromEntries(view.fields.map((f) => [f.field, f]));
    expect(byField['course.summary']).toMatchObject({
      status: 'conflict',
      supplied: 'Supplied summary',
      proposed: 'Generated summary',
      current: 'Supplied summary',
      decision: null,
    });
    expect(byField['course.subject'].status).toBe('filled');
    expect(byField['lesson:a.body'].status).toBe('conflict');
    expect(byField['lesson:b.body'].status).toBe('filled');
    expect(byField['new-lesson:0'].status).toBe('added');
    expect(view.baseRevisionId).toBe(c.headRevisionId);
  });

  it('applies an accepted conflict only through a recorded, CAS-guarded decision', async () => {
    const s = await setup();
    const { c, done } = await s.generated();
    const decide = (
      fields: string[],
      expected: string,
      decision: 'accept' | 'reject' = 'accept',
      requestKey = s.key('dec'),
      actor = s.guardian,
    ) =>
      s.as(actor, () =>
        s.service.decideProposal({
          ...actor,
          courseId: c.courseId,
          proposalId: done.proposalId as string,
          expectedHeadRevisionId: expected,
          decision,
          fields,
          requestKey,
        }),
      );
    // A stale expected head changes nothing.
    await expect(
      decide(['course.summary'], c.headRevisionId),
    ).rejects.toBeInstanceOf(CourseStaleHeadError);
    expect(await s.count('course_proposal_decisions')).toBe(0);
    // Only undecided conflicts are decidable.
    await expect(
      decide(['course.subject'], done.resultRevisionId as string),
    ).rejects.toBeInstanceOf(CourseProposalFieldError);
    const key = s.key('accept');
    const accepted = await decide(
      ['course.summary', 'lesson:a.body'],
      done.resultRevisionId as string,
      'accept',
      key,
    );
    expect(accepted.headRevisionId).not.toBe(done.resultRevisionId);
    const now = await s.read(c.courseId);
    expect(now.revision.summary).toBe('Generated summary');
    expect(now.revision.fieldProvenance.summary).toBe('generated');
    expect(now.revision.sections[0].lessons[0].body).toBe('Generated body A');
    expect(now.revision.objectives).toEqual(['Original objective']);
    const decisions = await s.db.list('course_proposal_decisions', {});
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: 'accepted',
      actor_user_id: s.guardian.actorUserId,
      result_revision_id: accepted.headRevisionId,
    });
    // Replay returns the same result and appends nothing.
    const revisions = await s.count('course_revisions');
    const replay = await decide(
      ['lesson:a.body', 'course.summary'],
      done.resultRevisionId as string,
      'accept',
      key,
    );
    expect(replay.headRevisionId).toBe(accepted.headRevisionId);
    expect(await s.count('course_revisions')).toBe(revisions);
    await expect(
      decide(
        ['course.summary'],
        done.resultRevisionId as string,
        'accept',
        key,
      ),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    // A decided field cannot be decided again.
    await expect(
      decide(['course.summary'], accepted.headRevisionId, 'reject'),
    ).rejects.toBeInstanceOf(CourseProposalFieldError);
    // Reject keeps the draft and is recorded.
    const rejected = await decide(
      ['course.objectives'],
      accepted.headRevisionId,
      'reject',
    );
    expect(rejected.headRevisionId).toBe(accepted.headRevisionId);
    expect((await s.read(c.courseId)).revision.objectives).toEqual([
      'Original objective',
    ]);
    expect(
      rejected.fields.find((f) => f.field === 'course.objectives')?.decision,
    ).toBe('rejected');
  });

  it('never writes into a released revision or assigns to a learner', async () => {
    const s = await setup();
    const c = await s.course();
    await s.as(s.guardian, () =>
      s.service.recordReview({
        ...s.guardian,
        courseId: c.courseId,
        revisionId: c.headRevisionId,
        requestKey: s.key('rev'),
        findings: [],
      }),
    );
    const released = await s.release(c.courseId, c.headRevisionId);
    const lessonRowsBefore = await s.db.list('lesson_revisions', {});
    const enrollments = await s.count('enrollments');
    const releases = await s.count('course_releases');
    const releasedRevision = (
      await s.db.get('course_revisions', { id: c.headRevisionId })
    )?.content_digest;
    const job = await s.request({
      courseId: c.courseId,
      headRevisionId: c.headRevisionId,
    });
    const done = await s.run(job.jobId);
    expect(done.status).toBe('succeeded');
    expect(done.resultRevisionId).not.toBe(c.headRevisionId);
    expect(await s.count('enrollments')).toBe(enrollments);
    expect(await s.count('course_releases')).toBe(releases);
    expect(await s.count('enrollment_release_pins')).toBe(0);
    expect(
      (await s.db.get('course_revisions', { id: c.headRevisionId }))
        ?.content_digest,
    ).toBe(releasedRevision);
    // Released lesson rows are untouched; the release row still names the revision.
    for (const row of lessonRowsBefore)
      expect(
        await s.db.get('lesson_revisions', { id: row.id as string }),
      ).toMatchObject({ content_digest: row.content_digest });
    expect(released.revisionId).toBe(c.headRevisionId);
  });

  it('keeps retries idempotent and rejects the same key with different input', async () => {
    const s = await setup();
    const c = await s.course();
    const key = s.key('gen');
    const first = await s.request(c, s.guardian, key, 'Fill gaps');
    const second = await s.request(c, s.guardian, key, 'Fill gaps');
    expect(second.jobId).toBe(first.jobId);
    expect(await s.count('course_generation_jobs')).toBe(1);
    expect(await s.count('course_generation_events')).toBe(1);
    await expect(
      s.request(c, s.guardian, key, 'Something else'),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    const done = await s.run(first.jobId);
    const again = await s.run(first.jobId);
    expect(again.proposalId).toBe(done.proposalId);
    expect(s.gen.calls).toHaveLength(1);
    // A duplicate submission after success returns the existing proposal.
    const duplicate = await s.request(c, s.guardian, key, 'Fill gaps');
    expect(duplicate.status).toBe('succeeded');
    expect(duplicate.proposalId).toBe(done.proposalId);
    expect(await s.count('course_proposals')).toBe(1);
  });

  it('records provider, model, usage and outcome per job', async () => {
    const s = await setup();
    s.gen.usage = { inputTokens: 120, outputTokens: 45, costUsd: 0.0123 };
    s.gen.responseModel = 'stub-model-2026-10';
    const { done } = await s.generated();
    expect(done).toMatchObject({
      status: 'succeeded',
      provider: 'test-provider',
      model: 'stub-model',
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        cost: 0.0123,
        costCurrency: 'USD',
      },
    });
    expect(done.events.map((e) => e.status)).toEqual([
      'queued',
      'running',
      'succeeded',
    ]);
    expect(done.events[2].responseModel).toBe('stub-model-2026-10');
    // Missing usage stays null rather than zero.
    const bare = await setup();
    const { done: noUsage } = await bare.generated();
    expect(noUsage.usage).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cost: null,
      costCurrency: null,
    });
  });

  it('leaves the head unchanged and keeps the input when a job fails', async () => {
    const s = await setup();
    const c = await s.course();
    const revisions = await s.count('course_revisions');
    s.gen.error = new Error('provider down; secret-token-123');
    const job = await s.request(c);
    const failed = await s.run(job.jobId);
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'provider-error',
    });
    expect(JSON.stringify(failed)).not.toContain('secret-token');
    expect(await s.head(c.courseId)).toBe(c.headRevisionId);
    expect(await s.count('course_revisions')).toBe(revisions);
    const row = await s.db.get('course_generation_jobs', { id: job.jobId });
    expect(JSON.parse(String(row?.input_json)).material.title).toBe(
      'Fractions',
    );
    expect(row?.instruction).toBe('Fill gaps');
    // A failed job stays failed; the request key still returns it.
    expect((await s.run(job.jobId)).status).toBe('failed');
  });

  it('rejects invalid provider output without touching the draft', async () => {
    const s = await setup();
    const c = await s.course();
    const revisions = await s.count('course_revisions');
    const bad: unknown[] = [
      { ...OUTPUT, extra: 1 },
      { course: { summary: 'ok', score: 9 }, lessons: [] },
      { lessons: [{ lessonKey: 'nope', body: 'x' }] },
      { lessons: [{ lessonKey: 'a' }] },
      { lessons: [{ sectionKey: 'unit-1', body: 'no title' }] },
      { course: { objectives: [] } },
      { lessons: [{ lessonKey: 'a', body: 'x', difficulty: 99 }] },
      'not an object',
      null,
    ];
    for (const output of bad) {
      s.gen.output = output;
      const job = await s.request(c, s.guardian, s.key('gen'), 'try');
      const result = await s.run(job.jobId);
      expect(result).toMatchObject({
        status: 'failed',
        errorCode: 'invalid-generation-output',
      });
      expect(await s.head(c.courseId)).toBe(c.headRevisionId);
    }
    expect(await s.count('course_revisions')).toBe(revisions);
    expect(await s.count('course_proposals')).toBe(0);
  });

  it('fails a job whose head moved and fails closed without a generator', async () => {
    const s = await setup();
    const c = await s.course();
    const job = await s.request(c);
    const moved = await s.save(
      c.courseId,
      c.headRevisionId,
      undefined,
      s.guardian,
      {
        summary: 'Edited meanwhile',
      },
    );
    const result = await s.run(job.jobId);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'stale-head' });
    expect(await s.head(c.courseId)).toBe(moved.revisionId);
    const closed = await setup({ generator: false });
    const c2 = await closed.course();
    const j2 = await closed.request(c2);
    await expect(closed.run(j2.jobId)).rejects.toBeInstanceOf(
      CourseGeneratorNotConfiguredError,
    );
    expect(
      (
        await closed.as(closed.guardian, () =>
          closed.service.getGeneration({ ...closed.guardian, jobId: j2.jobId }),
        )
      ).status,
    ).toBe('queued');
  });

  it('cancels queued and running jobs without touching the draft', async () => {
    const s = await setup();
    const c = await s.course();
    const queued = await s.request(c);
    const cancelled = await s.as(s.guardian, () =>
      s.service.cancelGeneration({
        ...s.guardian,
        jobId: queued.jobId,
        requestKey: s.key('cancel'),
      }),
    );
    expect(cancelled.status).toBe('cancelled');
    expect((await s.run(queued.jobId)).status).toBe('cancelled');
    expect(s.gen.calls).toHaveLength(0);
    // Cancel while the provider is still working: the late output is dropped.
    let release!: () => void;
    s.gen.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = await s.request(c, s.guardian, s.key('gen'), 'second');
    const running = s.run(job.jobId);
    await vi_waitFor(() => s.gen.calls.length === 1);
    await expect(s.run(job.jobId)).rejects.toBeInstanceOf(
      CourseGenerationInProgressError,
    );
    await s.as(s.guardian, () =>
      s.service.cancelGeneration({
        ...s.guardian,
        jobId: job.jobId,
        requestKey: s.key('cancel'),
      }),
    );
    release();
    expect((await running).status).toBe('cancelled');
    expect(await s.head(c.courseId)).toBe(c.headRevisionId);
    expect(await s.count('course_proposals')).toBe(0);
    const row = await s.db.get('course_generation_jobs', { id: job.jobId });
    expect(row?.instruction).toBe('second');
  });

  it('times out a slow provider as a failed job', async () => {
    const s = await setup({ timeoutMs: 25 });
    s.gen.waitForAbort = true;
    const c = await s.course();
    const job = await s.request(c);
    expect(await s.run(job.jobId)).toMatchObject({
      status: 'failed',
      errorCode: 'provider-timeout',
    });
    expect(await s.head(c.courseId)).toBe(c.headRevisionId);
  });

  it('withholds personal-use lesson bodies from the provider snapshot', async () => {
    const s = await setup();
    const head = await s.as(s.guardian, () =>
      s.service.createCourse({
        ...s.guardian,
        requestKey: s.key('c'),
        title: 'Private',
        levelMin: 1,
        levelMax: 2,
      }),
    );
    const saved = await s.save(head.courseId, head.headRevisionId, [
      {
        sectionKey: 'u',
        title: 'U',
        lessons: [
          {
            lessonKey: 'p',
            title: 'Private lesson',
            body: 'Purchased workbook text',
            licenseKind: 'personal-use-copy',
          },
          { lessonKey: 'q', title: 'Open', body: 'Open text' },
        ],
      },
    ] as never);
    const job = await s.request({
      courseId: head.courseId,
      headRevisionId: saved.revisionId,
    });
    s.gen.output = { rationale: 'nothing to add' };
    await s.run(job.jobId);
    const sent = JSON.stringify(s.gen.calls[0].material);
    expect(sent).not.toContain('Purchased workbook text');
    expect(sent).toContain('bodyWithheld');
    expect(sent).toContain('Open text');
  });

  it('adapts an ingestion proposal generator and unwraps its suggestion', async () => {
    const s = await setup({ generator: false });
    const seen: unknown[] = [];
    const adapter = createProposalCourseGenerator({
      identity: { provider: 'sdk', model: 'm', version: '1' },
      async generate(input) {
        seen.push(input);
        return {
          output: { suggestions: [{ args: OUTPUT }] },
          completion: 'unknown',
          usage: { input_tokens: 5 },
        };
      },
    });
    const wired = new CourseGenerationReviewService(
      s.db,
      (call) => call.actorUserId === s.guardian.actorUserId,
      { generator: adapter },
    );
    const c = await s.course();
    const job = await s.as(s.guardian, () =>
      wired.requestGeneration({
        ...s.guardian,
        courseId: c.courseId,
        expectedHeadRevisionId: c.headRevisionId,
        requestKey: s.key('gen'),
      }),
    );
    const done = await s.as(s.guardian, () =>
      wired.runGeneration({ ...s.guardian, jobId: job.jobId }),
    );
    expect(done).toMatchObject({ status: 'succeeded', provider: 'sdk' });
    expect(done.usage.inputTokens).toBe(5);
    const input = seen[0] as {
      offered: Array<{
        handler: { argsSchema: { additionalProperties: boolean } };
      }>;
    };
    expect(input.offered[0].handler.argsSchema.additionalProperties).toBe(
      false,
    );
  });
});

describe('authority and tenancy', () => {
  it('treats foreign courses, jobs, proposals and reviews as not found', async () => {
    const s = await setup();
    const { c, job, done } = await s.generated();
    const r = await s.review(c.courseId, done.resultRevisionId as string);
    await expect(s.request(c, s.outsider)).rejects.toBeInstanceOf(
      CourseNotFoundError,
    );
    await expect(s.run(job.jobId, s.outsider)).rejects.toBeInstanceOf(
      CourseGenerationNotFoundError,
    );
    await expect(
      s.as(s.outsider, () =>
        s.service.getGeneration({ ...s.outsider, jobId: job.jobId }),
      ),
    ).rejects.toBeInstanceOf(CourseGenerationNotFoundError);
    await expect(
      s.as(s.outsider, () =>
        s.service.getProposal({
          ...s.outsider,
          courseId: c.courseId,
          proposalId: done.proposalId as string,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    await expect(
      s.as(s.outsider, () =>
        s.service.getReview({
          ...s.outsider,
          courseId: c.courseId,
          reviewId: r.id,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    await expect(
      s.as(s.outsider, () =>
        s.service.listReviews({ ...s.outsider, courseId: c.courseId }),
      ),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    // A forged tenant against the ambient context is refused.
    await expect(
      s.as(s.outsider, () =>
        s.service.getGeneration({ ...s.guardian, jobId: job.jobId }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
  });

  it('authorizes each operation with its action, operation, executor and delegation', async () => {
    const s = await setup();
    const { c, job, done } = await s.generated(s.agent);
    const reviewView = await s.review(
      c.courseId,
      done.resultRevisionId as string,
      [
        s.finding({
          kind: 'course-revision',
          id: done.resultRevisionId as string,
          field: 'summary',
        }),
      ],
      {},
      s.agent,
    );
    await s.as(s.agent, () =>
      s.service.getGeneration({ ...s.agent, jobId: job.jobId }),
    );
    const seen = new Map(
      s.calls.map((call) => [`${call.operation}:${call.action}`, call]),
    );
    for (const expected of [
      'request-generation:education.course.generate',
      'run-generation:education.course.generate',
      'save-draft:education.course.author',
      'record-review:education.course.review',
      'read-generation:education.course.read-draft',
    ])
      expect(seen.has(expected), expected).toBe(true);
    for (const call of s.calls) {
      expect(call.executor).toBeTruthy();
      expect(call.delegatingGuardianUserId).toBe(s.guardian.actorUserId);
    }
    expect(reviewView.reviewerKind).toBe('agent');
    expect(reviewView.delegatingGuardianUserId).toBe(s.guardian.actorUserId);
  });

  it('denies each operation when its action is not granted', async () => {
    const s = await setup();
    const c = await s.course();
    const job = await s.request(c);
    const done = await s.run(job.jobId);
    const r = await s.review(c.courseId, c.headRevisionId, [
      s.finding(
        { kind: 'course-revision', id: c.headRevisionId, field: 'summary' },
        { blocking: true },
      ),
    ]);
    const attempts: Array<[CourseAuthoringAction, () => Promise<unknown>]> = [
      ['education.course.generate', () => s.request(c, s.guardian, s.key('x'))],
      ['education.course.generate', () => s.run(job.jobId)],
      [
        'education.course.generate',
        () =>
          s.as(s.guardian, () =>
            s.service.cancelGeneration({
              ...s.guardian,
              jobId: job.jobId,
              requestKey: s.key('x'),
            }),
          ),
      ],
      [
        'education.course.generate',
        () =>
          s.as(s.guardian, () =>
            s.service.decideProposal({
              ...s.guardian,
              courseId: c.courseId,
              proposalId: done.proposalId as string,
              expectedHeadRevisionId: done.resultRevisionId as string,
              decision: 'reject',
              fields: ['course.summary'],
              requestKey: s.key('x'),
            }),
          ),
      ],
      ['education.course.review', () => s.review(c.courseId, c.headRevisionId)],
      [
        'education.course.review',
        () =>
          s.as(s.guardian, () =>
            s.service.resolveFinding({
              ...s.guardian,
              courseId: c.courseId,
              findingId: r.sections.generalLevel.findings[0].id,
              resolution: 'addressed',
              requestKey: s.key('x'),
            }),
          ),
      ],
      [
        'education.course.review',
        () =>
          s.as(s.guardian, () =>
            s.service.noteContextChange({
              ...s.guardian,
              courseId: c.courseId,
              learnerId: String(s.f.learner.id),
              evidenceSnapshotRef: 'snap',
              requestKey: s.key('x'),
            }),
          ),
      ],
      [
        'education.course.read-draft',
        () =>
          s.as(s.guardian, () =>
            s.service.listReviews({ ...s.guardian, courseId: c.courseId }),
          ),
      ],
      [
        'education.course.read-draft',
        () =>
          s.as(s.guardian, () =>
            s.service.getProposal({
              ...s.guardian,
              courseId: c.courseId,
              proposalId: done.proposalId as string,
            }),
          ),
      ],
    ];
    for (const [action, attempt] of attempts) {
      s.denied.add(action);
      await expect(attempt(), action).rejects.toBeInstanceOf(
        CourseAuthoringAuthorizationError,
      );
      s.denied.delete(action);
    }
    // Generated provenance still needs `generate` to be saved by the author path.
    expect(await s.count('course_proposal_decisions')).toBe(0);
  });
});

describe('educational review', () => {
  it('binds to an exact revision and context, with no score and a disclaimer', async () => {
    const s = await setup();
    const c = await s.course();
    const view = await s.review(
      c.courseId,
      c.headRevisionId,
      [
        s.finding(
          {
            kind: 'course-revision',
            id: c.headRevisionId,
            field: 'objectives',
          },
          {
            concern: 'level-mismatch',
            uncertain: true,
            humanVerificationRequired: true,
            suggestedChange: 'Reword the objective for this level.',
          },
        ),
      ],
      {
        context: {
          learnerId: String(s.f.learner.id),
          evidenceSnapshotRef: 'snapshot-1',
        },
        learnerSummary: 'This learner has not yet shown fraction fluency.',
        reviewer: { provider: 'test', model: 'reviewer-1' },
      },
    );
    expect(view).toMatchObject({
      revisionId: c.headRevisionId,
      sequence: 1,
      disclaimer: COURSE_REVIEW_DISCLAIMER,
      outdated: null,
      context: {
        levelMin: 3,
        levelMax: 4,
        theme: 'space',
        learnerId: String(s.f.learner.id),
        evidenceSnapshotRef: 'snapshot-1',
      },
    });
    expect(view.contextDigest).toMatch(/^[0-9a-f]{64}$/);
    const [f] = view.sections.generalLevel.findings;
    expect(f).toMatchObject({
      concern: 'level-mismatch',
      uncertain: true,
      humanVerificationRequired: true,
      target: {
        kind: 'course-revision',
        id: c.headRevisionId,
        field: 'objectives',
      },
    });
    expect(view.unresolvedBlocking).toBe(1);
    // No score, rating or grade appears anywhere in the model or the view.
    const columns = Object.keys(new CourseReview());
    expect(
      [...columns, ...Object.keys(view), ...Object.keys(f)].join(' '),
    ).not.toMatch(/score|rating|grade/i);
    await expect(
      s.review(c.courseId, c.headRevisionId, [], { score: 9 }),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    await expect(
      s.review(c.courseId, c.headRevisionId, [
        {
          ...s.finding({
            kind: 'course-revision',
            id: c.headRevisionId,
            field: 'x',
          }),
          score: 3,
        } as never,
      ]),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
  });

  it('keeps general-level and individual-learner sections separate', async () => {
    const s = await setup();
    const c = await s.course();
    const target = {
      kind: 'course-revision' as const,
      id: c.headRevisionId,
      field: 'summary',
    };
    const general = await s.review(c.courseId, c.headRevisionId, [
      s.finding(target),
    ]);
    expect(general.sections.individualLearner).toBeNull();
    // A learner finding needs a learner context, and a learner summary too.
    await expect(
      s.review(c.courseId, c.headRevisionId, [
        s.finding(target, { section: 'individual-learner' }),
      ]),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    await expect(
      s.review(c.courseId, c.headRevisionId, [], { learnerSummary: 'x' }),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    await expect(
      s.review(c.courseId, c.headRevisionId, [], {
        context: { learnerId: String(s.f.learner.id) },
      }),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    await expect(
      s.review(c.courseId, c.headRevisionId, [], {
        context: { learnerId: 'not-a-learner', evidenceSnapshotRef: 's' },
      }),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
    const both = await s.review(
      c.courseId,
      c.headRevisionId,
      [
        s.finding(target),
        s.finding(target, {
          section: 'individual-learner',
          concern: 'level-mismatch',
        }),
      ],
      {
        context: {
          learnerId: String(s.f.learner.id),
          evidenceSnapshotRef: 'snap',
        },
        learnerSummary: 'For this learner.',
      },
    );
    expect(both.sections.generalLevel.findings).toHaveLength(1);
    expect(both.sections.individualLearner?.findings).toHaveLength(1);
    expect(both.sections.individualLearner?.findings[0].concern).toBe(
      'level-mismatch',
    );
  });

  it('requires findings to reference material of the reviewed revision', async () => {
    const s = await setup();
    const question = await s.as(s.guardian, () =>
      s.service.createQuestion({
        ...s.guardian,
        requestKey: s.key('q'),
        content: {
          prompt: 'What is 1/2 + 1/4?',
          responseType: 'short-answer',
          answerKey: { acceptedAnswers: ['2/6'] },
          provenance: 'supplied',
        },
      }),
    );
    const head = await s.as(s.guardian, () =>
      s.service.createCourse({
        ...s.guardian,
        requestKey: s.key('c'),
        title: 'Q',
        levelMin: 3,
        levelMax: 4,
      }),
    );
    const saved = await s.save(head.courseId, head.headRevisionId, [
      {
        sectionKey: 'u',
        title: 'U',
        lessons: [
          {
            lessonKey: 'w',
            title: 'Worksheet',
            lessonType: 'worksheet',
            questions: [{ questionRevisionId: question.headRevisionId }],
          },
        ],
      },
    ] as never);
    const view = await s.read(head.courseId, saved.revisionId);
    const lessonRevisionId = view.revision.sections[0].lessons[0].id;
    const ok = await s.review(head.courseId, saved.revisionId, [
      s.finding(
        {
          kind: 'question-revision',
          id: question.headRevisionId,
          field: 'answerKey',
          region: 'accepted answer 1',
        },
        { concern: 'answer-key', explanation: '1/2 + 1/4 is 3/4, not 2/6.' },
      ),
      s.finding({
        kind: 'lesson-revision',
        id: lessonRevisionId,
        field: 'body',
      }),
    ]);
    expect(ok.sections.generalLevel.findings[0].target.region).toBe(
      'accepted answer 1',
    );
    for (const bad of [
      { kind: 'question-revision' as const, id: lessonRevisionId, field: 'x' },
      { kind: 'lesson-revision' as const, id: 'unknown', field: 'x' },
      { kind: 'course-revision' as const, id: lessonRevisionId, field: 'x' },
    ])
      await expect(
        s.review(head.courseId, saved.revisionId, [s.finding(bad)]),
      ).rejects.toBeInstanceOf(CourseReviewTargetError);
    // A review of a revision that is not this course's is not found.
    const other = await s.course();
    await expect(
      s.review(head.courseId, other.headRevisionId),
    ).rejects.toBeInstanceOf(CourseNotFoundError);
  });

  it('makes reviews outdated on a new revision or a context change and retains history', async () => {
    const s = await setup();
    const c = await s.course();
    const learner = {
      context: {
        learnerId: String(s.f.learner.id),
        evidenceSnapshotRef: 'snap-1',
      },
    };
    const general = await s.review(c.courseId, c.headRevisionId);
    const forLearner = await s.review(
      c.courseId,
      c.headRevisionId,
      [],
      learner,
    );
    expect(general.sequence).toBe(1);
    expect(forLearner.sequence).toBe(2);
    // Context change: only the learner review that used another snapshot goes stale.
    const changed = await s.as(s.guardian, () =>
      s.service.noteContextChange({
        ...s.guardian,
        courseId: c.courseId,
        learnerId: String(s.f.learner.id),
        evidenceSnapshotRef: 'snap-2',
        requestKey: s.key('ctx'),
      }),
    );
    expect(changed.outdatedReviewIds).toEqual([forLearner.id]);
    const repeated = await s.as(s.guardian, () =>
      s.service.noteContextChange({
        ...s.guardian,
        courseId: c.courseId,
        learnerId: String(s.f.learner.id),
        evidenceSnapshotRef: 'snap-3',
        requestKey: s.key('ctx'),
      }),
    );
    expect(repeated.outdatedReviewIds).toEqual([]);
    let reviews = await s.as(s.guardian, () =>
      s.service.listReviews({ ...s.guardian, courseId: c.courseId }),
    );
    expect(
      reviews.map((r) => [r.id, r.outdated?.reason ?? null]).sort(),
    ).toEqual(
      [
        [general.id, null],
        [forLearner.id, 'context-changed'],
      ].sort(),
    );
    // A new draft revision persists an explicit marker on every earlier review.
    const next = await s.save(
      c.courseId,
      c.headRevisionId,
      undefined,
      s.guardian,
      {
        summary: 'Edited',
      },
    );
    const markers = await s.db.list('course_review_outdated_markers', {});
    expect(markers.map((m) => m.reason).sort()).toEqual([
      'context-changed',
      'revision-changed',
    ]);
    reviews = await s.as(s.guardian, () =>
      s.service.listReviews({ ...s.guardian, courseId: c.courseId }),
    );
    expect(reviews.every((r) => r.outdated)).toBe(true);
    expect(reviews.find((r) => r.id === general.id)?.outdated).toEqual({
      reason: 'revision-changed',
      supersedingRevisionId: next.revisionId,
    });
    // A revise and review loop retains every review, finding and author.
    const second = await s.review(
      c.courseId,
      next.revisionId,
      [
        s.finding({
          kind: 'course-revision',
          id: next.revisionId,
          field: 'summary',
        }),
      ],
      {},
      s.agent,
    );
    expect(second.outdated).toBeNull();
    reviews = await s.as(s.guardian, () =>
      s.service.listReviews({ ...s.guardian, courseId: c.courseId }),
    );
    expect(reviews).toHaveLength(3);
    expect(await s.count('course_reviews')).toBe(3);
    const mine = reviews.find((r) => r.id === second.id);
    expect(mine).toMatchObject({
      reviewerKind: 'agent',
      authorUserId: s.agent.actorUserId,
      delegatingGuardianUserId: s.guardian.actorUserId,
    });
    const byRevision = await s.as(s.guardian, () =>
      s.service.listReviews({
        ...s.guardian,
        courseId: c.courseId,
        revisionId: c.headRevisionId,
      }),
    );
    expect(byRevision).toHaveLength(2);
    // The first revision's rows are append-only.
    await expect(
      s.db.get('course_reviews', { id: general.id }).then(async (row) => {
        const { CourseReviewCollection } = await import(
          '../course-review-models.js'
        );
        const rows = await s.as(s.guardian, async () =>
          (await CourseReviewCollection.create({ db: s.db })).get(
            { id: general.id },
            { cache: false },
          ),
        );
        if (!rows || !row) throw new Error('missing');
        rows.generalSummary = 'tampered';
        return s.as(s.guardian, () => rows.save());
      }),
    ).rejects.toThrow(/immutable/);
  });

  it('records reviews idempotently and rejects a reused key with another payload', async () => {
    const s = await setup();
    const c = await s.course();
    const key = s.key('rev');
    const make = (summary: string) =>
      s.as(s.guardian, () =>
        s.service.recordReview({
          ...s.guardian,
          courseId: c.courseId,
          revisionId: c.headRevisionId,
          requestKey: key,
          generalSummary: summary,
          findings: [],
        }),
      );
    const first = await make('One');
    expect((await make('One')).id).toBe(first.id);
    expect(await s.count('course_reviews')).toBe(1);
    await expect(make('Two')).rejects.toBeInstanceOf(
      CourseRequestKeyConflictError,
    );
  });
});

describe('release gate and discard guard', () => {
  it('blocks release without a current review and allows it with one', async () => {
    const s = await setup();
    const c = await s.course();
    await expect(s.release(c.courseId, c.headRevisionId)).rejects.toMatchObject(
      {
        code: 'review-not-current',
        reason: 'no-review',
      },
    );
    const r = await s.review(c.courseId, c.headRevisionId);
    const released = await s.release(c.courseId, c.headRevisionId);
    expect(released.reviewId).toBe(r.id);
    // Without any gate the plain service still fails closed.
    const plain = new CourseAuthoringService(s.db, () => true);
    const c2 = await s.course();
    await expect(
      s.as(s.guardian, () =>
        plain.release({
          ...s.guardian,
          courseId: c2.courseId,
          revisionId: c2.headRevisionId,
          requestKey: s.key('rel'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'review-gate-required' });
  });

  it('blocks release for an outdated review, then for a changed context, then allows a fresh one', async () => {
    const s = await setup();
    const c = await s.course();
    await s.review(c.courseId, c.headRevisionId);
    const next = await s.save(
      c.courseId,
      c.headRevisionId,
      undefined,
      s.guardian,
      {
        summary: 'Changed',
      },
    );
    await expect(s.release(c.courseId, next.revisionId)).rejects.toBeInstanceOf(
      ReviewNotCurrentError,
    );
    // The earlier revision's review no longer makes that revision releasable.
    await expect(s.release(c.courseId, c.headRevisionId)).rejects.toMatchObject(
      {
        reason: 'outdated',
      },
    );
    const fresh = await s.review(c.courseId, next.revisionId, [], {
      context: {
        learnerId: String(s.f.learner.id),
        evidenceSnapshotRef: 'snap-1',
      },
    });
    await s.as(s.guardian, () =>
      s.service.noteContextChange({
        ...s.guardian,
        courseId: c.courseId,
        learnerId: String(s.f.learner.id),
        evidenceSnapshotRef: 'snap-2',
        requestKey: s.key('ctx'),
      }),
    );
    await expect(s.release(c.courseId, next.revisionId)).rejects.toMatchObject({
      reason: 'outdated',
    });
    // The latest review wins: a general review of the same revision unblocks it.
    const again = await s.review(c.courseId, next.revisionId);
    const released = await s.release(c.courseId, next.revisionId);
    expect(released.reviewId).toBe(again.id);
    expect(fresh.id).not.toBe(again.id);
  });

  it('blocks release while a blocking or human-verification finding is unresolved', async () => {
    const s = await setup();
    const c = await s.course();
    const target = {
      kind: 'course-revision' as const,
      id: c.headRevisionId,
      field: 'summary',
    };
    const r = await s.review(c.courseId, c.headRevisionId, [
      s.finding(target, { blocking: true }),
      s.finding(target, { humanVerificationRequired: true, uncertain: true }),
      s.finding(target, { concern: 'clarity' }),
    ]);
    await expect(s.release(c.courseId, c.headRevisionId)).rejects.toMatchObject(
      {
        reason: 'unresolved-findings',
      },
    );
    const [blocking, verify, advisory] = r.sections.generalLevel.findings;
    const resolve = (
      findingId: string,
      resolution: 'addressed' | 'dismissed' | 'verified',
      actor = s.guardian,
      requestKey = s.key('res'),
    ) =>
      s.as(actor, () =>
        s.service.resolveFinding({
          ...actor,
          courseId: c.courseId,
          findingId,
          resolution,
          note: 'checked',
          requestKey,
        }),
      );
    // An agent may resolve an ordinary blocking finding but never a human-verify one.
    await expect(
      resolve(verify.id, 'verified', s.agent),
    ).rejects.toBeInstanceOf(HumanVerificationRequiredError);
    const key = s.key('res');
    const after = await resolve(blocking.id, 'addressed', s.agent, key);
    expect(after.sections.generalLevel.findings[0].resolution).toMatchObject({
      resolution: 'addressed',
      actorUserId: s.agent.actorUserId,
      delegatingGuardianUserId: s.guardian.actorUserId,
    });
    expect(
      (await resolve(blocking.id, 'addressed', s.agent, key))
        .unresolvedBlocking,
    ).toBe(1);
    await expect(resolve(blocking.id, 'dismissed')).rejects.toBeInstanceOf(
      CourseFindingResolvedError,
    );
    await expect(
      resolve(blocking.id, 'dismissed', s.agent, key),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    await expect(
      s.release(c.courseId, c.headRevisionId),
    ).rejects.toBeInstanceOf(ReviewNotCurrentError);
    await resolve(verify.id, 'verified');
    // The advisory finding never blocks.
    expect(advisory.resolution).toBeNull();
    const released = await s.release(c.courseId, c.headRevisionId);
    expect(released.reviewId).toBe(r.id);
    expect(await s.count('course_finding_resolutions')).toBe(2);
  });

  it('refuses to discard a draft with review or generation references', async () => {
    const s = await setup();
    const discard = (courseId: string) =>
      s.as(s.guardian, () =>
        s.service.discardDraft({
          ...s.guardian,
          courseId,
          requestKey: s.key('d'),
        }),
      );
    const clean = await s.course();
    expect((await discard(clean.courseId)).state).toBe('discarded');
    const reviewed = await s.course();
    await s.review(reviewed.courseId, reviewed.headRevisionId);
    await expect(discard(reviewed.courseId)).rejects.toMatchObject({
      references: ['review'],
    });
    const generating = await s.course();
    await s.request(generating);
    const error = await discard(generating.courseId).catch((e) => e);
    expect(error).toBeInstanceOf(CourseDiscardRefusedError);
    expect(error.references).toEqual(['generation']);
    // A host-supplied extra guard (for example variants) is honoured too.
    const guarded = new CourseGenerationReviewService(s.db, () => true, {
      referenceGuard: () => ({ referenced: true, kinds: ['variant'] }),
    });
    const other = await s.course();
    const err = await s
      .as(s.guardian, () =>
        guarded.discardDraft({
          ...s.guardian,
          courseId: other.courseId,
          requestKey: s.key('d'),
        }),
      )
      .catch((e) => e);
    expect(err.references).toEqual(['variant']);
  });
});

describe('evaluation fixtures', () => {
  const seededTotal = REVIEW_FIXTURE_CASES.reduce(
    (n, c) => n + c.seeded.length,
    0,
  );
  const oracle = (input: Pick<ReviewFixtureCase, 'id'>) =>
    REVIEW_FIXTURE_CASES.find((c) => c.id === input.id)?.seeded.map((s) => ({
      ref: s.ref,
      concern: s.concern,
    })) ?? [];

  it('covers every seeded category and suitable material', () => {
    const concerns = new Set(
      REVIEW_FIXTURE_CASES.flatMap((c) => c.seeded.map((s) => s.concern)),
    );
    expect([...concerns].sort()).toEqual([
      'answer-key',
      'factual-error',
      'level-mismatch',
      'missing-prerequisite',
    ]);
    expect(
      REVIEW_FIXTURE_CASES.filter((c) => !c.seeded.length).length,
    ).toBeGreaterThanOrEqual(3);
    for (const c of REVIEW_FIXTURE_CASES)
      for (const flaw of c.seeded)
        expect(c.materials.some((m) => m.ref === flaw.ref)).toBe(true);
  });

  it('scores an exact stub reviewer as perfect with no false alarms', async () => {
    const report = await evaluateReviewer(REVIEW_FIXTURE_CASES, oracle);
    expect(report).toMatchObject({
      truePositives: seededTotal,
      falsePositives: 0,
      missed: 0,
      precision: 1,
      recall: 1,
      falseAlarmRate: 0,
    });
    expect(report.byConcern['answer-key']).toEqual({ found: 2, seeded: 2 });
  });

  it('measures false alarms, misses and wrong concerns', async () => {
    const everything = await evaluateReviewer(REVIEW_FIXTURE_CASES, (input) =>
      input.materials.map((m) => ({
        ref: m.ref,
        concern: 'factual-error' as const,
      })),
    );
    expect(everything.falseAlarmRate).toBe(1);
    expect(everything.precision).toBeLessThan(0.5);
    expect(everything.recall).toBeLessThan(1);
    const silent = await evaluateReviewer(REVIEW_FIXTURE_CASES, () => []);
    expect(silent).toMatchObject({
      precision: null,
      recall: 0,
      falseAlarmRate: 0,
      missed: seededTotal,
    });
    // The right place with the wrong concern, an unknown ref and a duplicate are false alarms.
    const sloppy = await evaluateReviewer(REVIEW_FIXTURE_CASES, (input) => {
      const found = oracle(input);
      return input.id === 'factual-error'
        ? [
            { ref: found[0].ref, concern: 'clarity' as const },
            { ref: 'lesson:invented', concern: 'factual-error' as const },
            ...found,
            ...found,
          ]
        : found;
    });
    expect(sloppy.truePositives).toBe(seededTotal);
    expect(sloppy.falsePositives).toBe(3);
    expect(
      sloppy.cases.find((r) => r.id === 'factual-error')?.falsePositives,
    ).toBe(3);
  });
});

describe('schema', () => {
  it('ships the generation and review models as an additive manifest diff', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        ...learnerClasses,
        'AuthoredCourse',
        'CourseRevision',
        'CourseDraftHead',
      ],
    });
    opened.push(db);
    const schemas = Object.fromEntries(
      tables.map((name) => {
        const schema = ObjectRegistry.getSchema(name);
        if (!schema) throw new Error(`Missing schema ${name}`);
        return [schema.tableName, schema];
      }),
    );
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      schemas,
    );
    expect(diff.added_tables.map((t) => t.tableName).sort()).toEqual(
      Object.keys(schemas).sort(),
    );
    expect(diff.modified_tables ?? []).toEqual([]);
    const generated = new MigrationGenerator({
      engine: 'sqlite',
    }).generateFromDiff(diff, {
      name: 'course_generation_review',
    });
    const migration = createMigrationDefinition(
      '20261030_course_generation_review',
      generated.up,
      generated.down,
      { packageName: '@happyvertical/smrt-education', version: '0.57.42' },
    );
    const applied = await new MigrationTracker({
      db,
      engineHint: 'sqlite',
      useConcurrentIndexes: false,
    }).applyAll([migration], { postgresSafe: false });
    expect(applied.every((r) => r.success)).toBe(true);
    const second = await new SchemaComparer(db, {
      engineHint: 'sqlite',
    }).compare(schemas);
    expect(second.added_tables).toEqual([]);
    expect(
      getSQLFromDiff(second).filter((value) => !value.startsWith('--')),
    ).toEqual([]);
    expect(JSON.stringify(generated.up)).not.toMatch(
      /ALTER TABLE "?(enrollments|lessons|courses|course_revisions|lesson_revisions)/i,
    );
  });
});

async function vi_waitFor(condition: () => boolean, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition never became true');
}
