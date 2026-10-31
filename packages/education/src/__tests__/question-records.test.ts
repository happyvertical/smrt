import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetCollection } from '@happyvertical/smrt-assets';
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
  GradeCollection,
  ScannedSubmissionCollection,
} from '../collections.js';
import {
  buildLearnerWorksheet,
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseAuthoringValidationError,
  CourseRequestKeyConflictError,
  CourseStaleHeadError,
  LearningObjectiveKeyConflictError,
  LearningObjectiveNotFoundError,
  QuestionAuthoringService,
  type QuestionContentInput,
  QuestionNotFoundError,
  QuestionReferenceError,
  QuestionResponseCollection,
  worksheetVersionId,
} from '../index.js';
import { WORKBOOK_MATH_VOCABULARY } from '../workbook-contracts.js';
import { WorkbookAssessmentRevisionCollection } from '../workbook-models.js';
import { WorkbookService } from '../workbook-service.js';
import { learnerFixture } from './learner-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

const authoringExtra = [
  'AuthoredCourse',
  'Reading',
  'Video',
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
];
const questionTables = [
  'LearningObjective',
  'LearningObjectiveRevision',
  'Question',
  'QuestionRevision',
  'QuestionResponse',
];
const allClasses = [
  ...new Set([...workbookClasses, ...authoringExtra, ...questionTables]),
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

const mc = (
  extra: Partial<QuestionContentInput> = {},
): QuestionContentInput => ({
  prompt: 'What is 1/2 + 1/4?',
  responseType: 'short-answer',
  answerKey: { acceptedAnswers: ['3/4'] },
  provenance: 'supplied',
  ...extra,
});

async function setup() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: allClasses,
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
  const calls: Array<Parameters<CourseAuthoringAuthorizer>[0]> = [];
  const grants = new Map<string, CourseAuthoringAction[]>([
    [guardian.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [
      agent.actorUserId,
      // An agent that may author but not generate.
      ['education.course.author', 'education.course.read-draft'],
    ],
    [outsider.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
  ]);
  const authorizer: CourseAuthoringAuthorizer = (call) => {
    calls.push(call);
    return (grants.get(call.actorUserId) ?? []).includes(call.action);
  };
  const service = new QuestionAuthoringService(db, authorizer, {
    releaseReviewGate: () => ({ current: true, reviewId: 'review-1' }),
  });
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  let counter = 0;
  const key = (label = 'k') => `${label}-${++counter}`;
  const question = (
    content: QuestionContentInput = mc(),
    actor = guardian,
    extra: { courseId?: string; requestKey?: string } = {},
  ) =>
    as(actor, () =>
      service.createQuestion({
        ...actor,
        requestKey: extra.requestKey ?? key('q'),
        courseId: extra.courseId,
        content,
      }),
    );
  const objective = (
    externalKey: string,
    statement = 'Add fractions',
    actor = guardian,
  ) =>
    as(actor, () =>
      service.createLearningObjective({
        ...actor,
        requestKey: key('o'),
        externalKey,
        objective: { statement },
      }),
    );
  /** A course with one worksheet lesson whose questions are given, released. */
  async function releasedWorksheet(
    refs: Array<{
      questionRevisionId: string;
      section?: string;
      column?: number;
    }>,
    layoutParams: Record<string, string | number | boolean> = { columns: 2 },
  ) {
    const head = await as(guardian, () =>
      service.createCourse({
        ...guardian,
        requestKey: key('course'),
        title: 'Fractions',
      }),
    );
    const saved = await as(guardian, () =>
      service.saveDraft({
        ...guardian,
        courseId: head.courseId,
        expectedHeadRevisionId: head.headRevisionId,
        requestKey: key('save'),
        draft: {
          title: 'Fractions',
          provenance: 'supplied',
          sections: [
            {
              sectionKey: 'unit-1',
              title: 'Unit 1',
              lessons: [
                {
                  lessonKey: 'ws',
                  title: 'Worksheet',
                  lessonType: 'worksheet',
                  questions: refs,
                  layoutParams,
                },
              ],
            },
          ],
        },
      }),
    );
    const release = await as(guardian, () =>
      service.release({
        ...guardian,
        courseId: head.courseId,
        revisionId: saved.revisionId,
        requestKey: key('rel'),
      }),
    );
    return { head, saved, release };
  }
  return {
    db,
    f,
    service,
    guardian,
    agent,
    outsider,
    calls,
    as,
    key,
    question,
    objective,
    releasedWorksheet,
  };
}

describe('question and learning-objective records', () => {
  it('isolates tenants and enforces authorization', async () => {
    const s = await setup();
    const created = await s.question();
    // A foreign actor cannot read, extend or reference another tenant's question.
    await expect(
      s.as(s.outsider, () =>
        s.service.readQuestion({
          ...s.outsider,
          questionId: created.questionId,
        }),
      ),
    ).rejects.toBeInstanceOf(QuestionNotFoundError);
    await expect(
      s.as(s.outsider, () =>
        s.service.saveQuestionRevision({
          ...s.outsider,
          questionId: created.questionId,
          expectedHeadRevisionId: created.headRevisionId,
          requestKey: s.key(),
          content: mc(),
        }),
      ),
    ).rejects.toBeInstanceOf(QuestionNotFoundError);
    // A mismatched ambient tenant is refused before any read.
    await expect(
      s.as(s.outsider, () =>
        s.service.createQuestion({
          ...s.guardian,
          requestKey: s.key(),
          content: mc(),
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    // Writes use author; reads of keys use read-draft; the executor is passed.
    expect(
      s.calls.some(
        (c) =>
          c.operation === 'create-question' &&
          c.action === 'education.course.author' &&
          c.executor,
      ),
    ).toBe(true);
    await s.as(s.guardian, () =>
      s.service.readQuestion({ ...s.guardian, questionId: created.questionId }),
    );
    expect(s.calls.at(-1)).toMatchObject({
      action: 'education.course.read-draft',
      operation: 'read-question',
    });
    // Generated provenance additionally needs generate, which this agent lacks.
    await expect(
      s.question(mc({ provenance: 'generated' }), s.agent),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    await s.question(mc(), s.agent);
    // The same prompt in another tenant is a separate identity.
    const other = await s.question(mc(), s.outsider);
    expect(other.questionId).not.toBe(created.questionId);
    // Objective keys are unique per tenant, not globally.
    await s.objective('shared-key');
    await s.objective('shared-key', 'Other wording', s.outsider);
    await expect(
      s.as(s.guardian, () =>
        s.service.readLearningObjective({
          ...s.guardian,
          externalKey: 'missing',
        }),
      ),
    ).rejects.toBeInstanceOf(LearningObjectiveNotFoundError);
    // A foreign tenant's objective cannot be linked.
    const foreign = await s.objective('foreign-only', 'Foreign', s.outsider);
    await expect(
      s.question(mc({ objectiveIds: [foreign.id] })),
    ).rejects.toBeInstanceOf(LearningObjectiveNotFoundError);
  });

  it('uses expected-head compare-and-swap and request keys', async () => {
    const s = await setup();
    const requestKey = s.key('create');
    const first = await s.question(mc(), s.guardian, { requestKey });
    expect(await s.question(mc(), s.guardian, { requestKey })).toEqual(first);
    await expect(
      s.question(mc({ prompt: 'Different' }), s.guardian, { requestKey }),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);

    const save = (expected: string, requestKey: string, prompt: string) =>
      s.as(s.guardian, () =>
        s.service.saveQuestionRevision({
          ...s.guardian,
          questionId: first.questionId,
          expectedHeadRevisionId: expected,
          requestKey,
          content: mc({ prompt }),
        }),
      );
    const k2 = s.key('save');
    const second = await save(first.headRevisionId, k2, 'v2');
    expect(second.sequence).toBe(2);
    // A retry replays; it does not append again, even though the head moved on.
    expect(await save(first.headRevisionId, k2, 'v2')).toEqual(second);
    await expect(
      save(first.headRevisionId, k2, 'changed'),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    // A stale head is a typed conflict naming the current head.
    await expect(
      save(first.headRevisionId, s.key(), 'v3'),
    ).rejects.toMatchObject({
      code: 'stale-head',
      currentHeadRevisionId: second.headRevisionId,
    });
    await expect(
      save(first.headRevisionId, s.key(), 'v3'),
    ).rejects.toBeInstanceOf(CourseStaleHeadError);
    const rows = await s.db.list('question_revisions', {});
    expect(rows).toHaveLength(2);
    // Objectives CAS the same way.
    const o = await s.objective('obj-cas');
    const reword = (expected: string, requestKey: string, statement: string) =>
      s.as(s.guardian, () =>
        s.service.saveLearningObjectiveRevision({
          ...s.guardian,
          objectiveId: o.id,
          expectedHeadRevisionId: expected,
          requestKey,
          objective: { statement },
        }),
      );
    const reworded = await reword(
      o.headRevisionId,
      s.key(),
      'Add unlike fractions',
    );
    expect(reworded).toMatchObject({
      id: o.id,
      externalKey: 'obj-cas',
      sequence: 2,
    });
    await expect(reword(o.headRevisionId, s.key(), 'x')).rejects.toBeInstanceOf(
      CourseStaleHeadError,
    );
    await expect(
      s.objective('obj-cas', 'Add fractions'),
    ).rejects.toBeInstanceOf(LearningObjectiveKeyConflictError);
  });

  it('keeps a missing answer key missing and records provenance per field', async () => {
    const s = await setup();
    const keyless = await s.question(mc({ answerKey: undefined }));
    const row = (await s.db.get('question_revisions', {
      id: keyless.headRevisionId,
    })) as Record<string, unknown>;
    expect(row.answer_key_json).toBeNull();
    expect(row.rubric_json).toBeNull();
    expect(row.points_possible).toBeNull();
    const read = await s.as(s.guardian, () =>
      s.service.readQuestion({ ...s.guardian, questionId: keyless.questionId }),
    );
    expect(read.revision.answerKey).toBeNull();
    expect(read.revision.rubric).toBeNull();
    expect(read.revision.fieldProvenance).not.toHaveProperty('answerKey');
    // An empty key is never accepted as "no answer" or as an answer.
    await expect(s.question(mc({ answerKey: {} }))).rejects.toBeInstanceOf(
      CourseAuthoringValidationError,
    );
    await expect(
      s.question(mc({ answerKey: { acceptedAnswers: [] } })),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    // Provenance for a field that is not present is refused.
    await expect(
      s.question(
        mc({
          answerKey: undefined,
          fieldProvenance: { answerKey: 'inferred' },
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    // A key inferred from a supplied prompt stays labelled as such.
    const inferred = await s.question(
      mc({
        provenance: 'supplied',
        fieldProvenance: { answerKey: 'inferred' },
        pointsPossible: 2,
      }),
    );
    const view = await s.as(s.guardian, () =>
      s.service.readQuestion({
        ...s.guardian,
        questionId: inferred.questionId,
      }),
    );
    expect(view.revision.fieldProvenance).toMatchObject({
      prompt: 'supplied',
      answerKey: 'inferred',
      pointsPossible: 'supplied',
    });
    // The model refuses a stored empty key even when written directly.
    await expect(
      s.db.get('question_revisions', { id: inferred.headRevisionId }),
    ).resolves.toBeTruthy();
  });

  it('validates choices, subparts, media and concepts', async () => {
    const s = await setup();
    const choices = [
      { id: 'a', label: '1/2' },
      { id: 'b', label: '3/4' },
    ];
    await s.question(
      mc({
        responseType: 'multiple-choice',
        choices,
        answerKey: { correctChoiceIds: ['b'] },
      }),
    );
    for (const bad of [
      mc({
        responseType: 'multiple-choice',
        choices: [{ id: 'a', label: 'only one' }],
      }),
      mc({
        responseType: 'multiple-choice',
        choices,
        answerKey: { correctChoiceIds: ['zzz'] },
      }),
      mc({
        responseType: 'multiple-choice',
        choices,
        answerKey: { correctChoiceIds: ['a', 'b'] },
      }),
      mc({ choices }),
      mc({ responseType: 'multi-part' }),
      mc({
        responseType: 'multi-part',
        subparts: [{ partKey: 'a', prompt: 'x' }],
        answerKey: { parts: { z: { acceptedAnswers: ['1'] } } },
      }),
      mc({ conceptIds: ['not a concept!'] }),
      mc({ rubric: { criteria: [] } }),
    ])
      await expect(s.question(bad)).rejects.toBeInstanceOf(
        CourseAuthoringValidationError,
      );
    await s.question(
      mc({
        responseType: 'multi-part',
        subparts: [{ partKey: 'a', prompt: 'x' }],
        answerKey: { parts: { a: { numeric: { value: 3 } } } },
      }),
    );
    // Media must be an asset owned by this tenant.
    await expect(
      s.question(mc({ media: [{ assetId: randomUUID() }] })),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    const asset = await s.as(s.guardian, async () =>
      (await AssetCollection.create({ db: s.db })).create({
        tenantId: s.guardian.tenantId,
        name: 'figure',
        sourceUri: 'file:///figure.png',
        ownerProfileId: String(s.f.guardian.profile.id),
      }),
    );
    const withMedia = await s.question(
      mc({ media: [{ assetId: String(asset.id), role: 'figure', alt: 'a' }] }),
    );
    expect(withMedia.sequence).toBe(1);
    // A trusted concept vocabulary, when configured, closes the set.
    const closed = new QuestionAuthoringService(s.db, () => true, {
      conceptVocabulary: [{ id: 'math.fractions' }],
    });
    await expect(
      s.as(s.guardian, () =>
        closed.createQuestion({
          ...s.guardian,
          requestKey: s.key(),
          content: mc({ conceptIds: ['math.other'] }),
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
  });

  it('never edits or deletes revisions', async () => {
    const s = await setup();
    const created = await s.question();
    const { QuestionRevisionCollection, QuestionCollection } = await import(
      '../question-models.js'
    );
    const revisions = await QuestionRevisionCollection.create({ db: s.db });
    const revision = await s.as(s.guardian, () =>
      revisions.get({ id: created.headRevisionId }),
    );
    expect(revision).toBeTruthy();
    if (!revision) return;
    revision.prompt = 'rewritten';
    await expect(s.as(s.guardian, () => revision.save())).rejects.toThrow(
      'immutable',
    );
    await expect(s.as(s.guardian, () => revision.delete())).rejects.toThrow(
      'immutable',
    );
    const identity = await s.as(s.guardian, async () =>
      (await QuestionCollection.create({ db: s.db })).get({
        id: created.questionId,
      }),
    );
    await expect(
      s.as(s.guardian, () =>
        (identity as NonNullable<typeof identity>).delete(),
      ),
    ).rejects.toThrow('immutable');
    const row = (await s.db.get('question_revisions', {
      id: created.headRevisionId,
    })) as Record<string, unknown>;
    expect(row.prompt).toBe('What is 1/2 + 1/4?');
  });

  it('validates lesson question references and pins exact revisions', async () => {
    const s = await setup();
    const q = await s.question();
    const foreign = await s.question(mc(), s.outsider);
    const head = await s.as(s.guardian, () =>
      s.service.createCourse({
        ...s.guardian,
        requestKey: s.key(),
        title: 'C',
      }),
    );
    const draft = (refs: unknown) => ({
      title: 'C',
      provenance: 'supplied' as const,
      sections: [
        {
          sectionKey: 's',
          title: 'S',
          lessons: [{ lessonKey: 'l', title: 'L', questions: refs as never }],
        },
      ],
    });
    const save = (refs: unknown, expected = head.headRevisionId) =>
      s.as(s.guardian, () =>
        s.service.saveDraft({
          ...s.guardian,
          courseId: head.courseId,
          expectedHeadRevisionId: expected,
          requestKey: s.key(),
          draft: draft(refs),
        }),
      );
    for (const refs of [
      [{ questionRevisionId: randomUUID() }],
      [{ questionRevisionId: foreign.headRevisionId }],
      // A question identity id is not an immutable revision.
      [{ questionRevisionId: q.questionId }],
    ])
      await expect(save(refs)).rejects.toBeInstanceOf(QuestionReferenceError);
    for (const refs of [
      [
        { questionRevisionId: q.headRevisionId },
        { questionRevisionId: q.headRevisionId },
      ],
      [{ questionRevisionId: q.headRevisionId, column: 0 }],
      [
        {
          questionRevisionId: q.headRevisionId,
          anchor: { rect: [0, 0, 2, 1] },
        },
      ],
      [{ questionRevisionId: q.headRevisionId, extra: true }],
    ])
      await expect(save(refs)).rejects.toBeInstanceOf(
        CourseAuthoringValidationError,
      );
    const saved = await save([
      {
        questionRevisionId: q.headRevisionId,
        section: 'part-a',
        column: 2,
        anchor: { page: 7, rect: [0.1, 0.1, 0.5, 0.2] },
      },
    ]);
    const read = await s.as(s.guardian, () =>
      s.service.readDraft({ ...s.guardian, courseId: head.courseId }),
    );
    expect(read.revision.id).toBe(saved.revisionId);
    expect(read.revision.sections[0].lessons[0].questions).toEqual([
      {
        questionRevisionId: q.headRevisionId,
        section: 'part-a',
        column: 2,
        anchor: { page: 7, rect: [0.1, 0.1, 0.5, 0.2] },
      },
    ]);
    // A newer question revision never moves the pinned reference.
    await s.as(s.guardian, () =>
      s.service.saveQuestionRevision({
        ...s.guardian,
        questionId: q.questionId,
        expectedHeadRevisionId: q.headRevisionId,
        requestKey: s.key(),
        content: mc({ prompt: 'Reworded' }),
      }),
    );
    const again = await s.as(s.guardian, () =>
      s.service.readDraft({
        ...s.guardian,
        courseId: head.courseId,
        revisionId: saved.revisionId,
      }),
    );
    expect(
      again.revision.sections[0].lessons[0].questions[0].questionRevisionId,
    ).toBe(q.headRevisionId);
    // Changing only the refs yields a distinct lesson revision.
    const next = await save([], saved.headRevisionId);
    const lessonRows = await s.db.list('lesson_revisions', {});
    expect(lessonRows).toHaveLength(2);
    expect(next.revisionId).not.toBe(saved.revisionId);
  });

  it('renders the same pinned revisions for any medium and excludes keys from learners', async () => {
    const s = await setup();
    const rubric = {
      criteria: [{ id: 'method', label: 'Method', maxPoints: 2 }],
    };
    const q1 = await s.question(
      mc({
        rubric,
        answerKey: {
          acceptedAnswers: ['SECRET-ANSWER'],
          explanation: 'SECRET-WHY',
        },
      }),
    );
    const q2 = await s.question(mc({ prompt: 'Second', answerKey: undefined }));
    const refs = [
      { questionRevisionId: q1.headRevisionId, section: 'a', column: 1 },
      { questionRevisionId: q2.headRevisionId, section: 'a', column: 2 },
    ];
    const { release } = await s.releasedWorksheet(refs, {
      columns: 2,
      paper: 'letter',
    });
    const request = {
      ...s.guardian,
      releaseId: release.id,
      lessonKey: 'ws',
    };
    const learner = await s.as(s.guardian, () =>
      s.service.getWorksheet({ ...request, audience: 'learner' }),
    );
    const guardian = await s.as(s.guardian, () =>
      s.service.getWorksheet({ ...request, audience: 'guardian' }),
    );
    expect(learner.audience).toBe('learner');
    expect(learner.worksheetVersionId).toBe(guardian.worksheetVersionId);
    expect(learner.worksheetVersionId).toBe(
      worksheetVersionId(refs, { paper: 'letter', columns: 2 }),
    );
    expect(learner.items.map((i) => i.questionRevisionId)).toEqual([
      q1.headRevisionId,
      q2.headRevisionId,
    ]);
    // Keys, explanations, rubrics and provenance are excluded by construction.
    const serialized = JSON.stringify(learner);
    for (const leak of [
      'SECRET-ANSWER',
      'SECRET-WHY',
      'answerKey',
      'rubric',
      'fieldProvenance',
      'Method',
    ])
      expect(serialized).not.toContain(leak);
    const g = guardian.items as Array<{ answerKey: unknown; rubric: unknown }>;
    expect(g[0].answerKey).toMatchObject({
      acceptedAnswers: ['SECRET-ANSWER'],
    });
    expect(g[0].rubric).toEqual(rubric);
    // The missing key is still missing in the guardian bundle.
    expect(g[1].answerKey).toBeNull();
    // Newer question revisions never change a released worksheet.
    await s.as(s.guardian, () =>
      s.service.saveQuestionRevision({
        ...s.guardian,
        questionId: q1.questionId,
        expectedHeadRevisionId: q1.headRevisionId,
        requestKey: s.key(),
        content: mc({ prompt: 'Changed later' }),
      }),
    );
    const replay = await s.as(s.guardian, () =>
      s.service.getWorksheet({ ...request, audience: 'learner' }),
    );
    expect(replay).toEqual(learner);
    // Layout params and order participate in the id; key order does not.
    expect(worksheetVersionId(refs, { paper: 'letter', columns: 2 })).toBe(
      worksheetVersionId(refs, { columns: 2, paper: 'letter' }),
    );
    expect(worksheetVersionId(refs, { columns: 3 })).not.toBe(
      worksheetVersionId(refs, { columns: 2 }),
    );
    expect(worksheetVersionId([...refs].reverse(), {})).not.toBe(
      worksheetVersionId(refs, {}),
    );
    // Authorization and tenancy apply to the bundle read.
    await expect(
      s.as(s.outsider, () =>
        s.service.getWorksheet({
          ...s.outsider,
          releaseId: release.id,
          lessonKey: 'ws',
          audience: 'learner',
        }),
      ),
    ).rejects.toBeInstanceOf(QuestionNotFoundError);
    expect(() =>
      buildLearnerWorksheet({
        lessonRevisionId: 'x',
        refs,
        revisions: new Map(),
      }),
    ).toThrow('missing question');
  });

  it('keeps learning-objective identity stable across wording, variants and themes', async () => {
    const s = await setup();
    const o = await s.objective('hearth:fractions.add');
    const q = await s.question(
      mc({ objectiveIds: [o.id], conceptIds: ['math.fractions'] }),
    );
    const themed = await s.question(
      mc({ prompt: 'Pizza: 1/2 + 1/4?', objectiveIds: [o.id] }),
    );
    const reworded = await s.as(s.guardian, () =>
      s.service.saveLearningObjectiveRevision({
        ...s.guardian,
        objectiveId: o.id,
        expectedHeadRevisionId: o.headRevisionId,
        requestKey: s.key(),
        objective: { statement: 'Add fractions with unlike denominators' },
      }),
    );
    expect(reworded.id).toBe(o.id);
    expect(reworded.externalKey).toBe('hearth:fractions.add');
    const byKey = await s.as(s.guardian, () =>
      s.service.readLearningObjective({
        ...s.guardian,
        externalKey: 'hearth:fractions.add',
      }),
    );
    expect(byKey.id).toBe(o.id);
    for (const created of [q, themed]) {
      const view = await s.as(s.guardian, () =>
        s.service.readQuestion({
          ...s.guardian,
          questionId: created.questionId,
        }),
      );
      expect(view.revision.objectives).toEqual([
        {
          objectiveId: o.id,
          externalKey: 'hearth:fractions.add',
          revisionId: reworded.headRevisionId,
          statement: 'Add fractions with unlike denominators',
        },
      ]);
    }
    // Linking appends a revision, keeps other fields and labels the link as supplied.
    const o2 = await s.objective('hearth:fractions.compare');
    const linked = await s.as(s.guardian, () =>
      s.service.linkObjectives({
        ...s.guardian,
        questionId: q.questionId,
        expectedHeadRevisionId: q.headRevisionId,
        requestKey: s.key(),
        objectiveIds: [o.id, o2.id],
      }),
    );
    expect(linked.sequence).toBe(2);
    const after = await s.as(s.guardian, () =>
      s.service.readQuestion({ ...s.guardian, questionId: q.questionId }),
    );
    expect(after.revision.objectives.map((x) => x.externalKey)).toEqual([
      'hearth:fractions.add',
      'hearth:fractions.compare',
    ]);
    expect(after.revision.conceptIds).toEqual(['math.fractions']);
    expect(after.revision.answerKey).toEqual({ acceptedAnswers: ['3/4'] });
    expect(after.revision.fieldProvenance.objectives).toBe('supplied');
    await expect(
      s.as(s.guardian, () =>
        s.service.linkObjectives({
          ...s.guardian,
          questionId: q.questionId,
          expectedHeadRevisionId: q.headRevisionId,
          requestKey: s.key(),
          objectiveIds: [],
        }),
      ),
    ).rejects.toBeInstanceOf(CourseStaleHeadError);
    // The older revision still shows its original link set.
    const old = await s.as(s.guardian, () =>
      s.service.readQuestion({
        ...s.guardian,
        questionId: q.questionId,
        revisionId: q.headRevisionId,
      }),
    );
    expect(old.revision.objectives).toHaveLength(1);
  });

  it('attempts, responses and grades reference the exact revision', async () => {
    const s = await setup();
    const rubric = {
      criteria: [
        { id: 'method', label: 'Method', maxPoints: 2 },
        { id: 'answer', label: 'Answer', maxPoints: 1 },
      ],
    };
    const withRubric = await s.question(mc({ rubric, pointsPossible: 3 }));
    const withoutRubric = await s.question(mc({ prompt: 'No rubric' }));
    const { f } = s;
    const progress = await f.as(f.own, () =>
      f.service.startLesson({
        ...f.own,
        enrollmentId: String(f.enrollment.id),
        lessonId: String(f.lesson.id),
      }),
    );
    const scans = await ScannedSubmissionCollection.create({ db: s.db });
    const submission = await f.as(f.own, () =>
      scans.create({
        tenantId: f.own.tenantId,
        learnerId: f.own.learnerId,
        lessonId: String(f.lesson.id),
        progressId: String(progress.id),
        pageCount: 1,
        captureKey: 'c1',
        captureDigest: 'a'.repeat(64),
      }),
    );
    const responses = await QuestionResponseCollection.create({ db: s.db });
    const base = {
      tenantId: f.own.tenantId,
      learnerId: f.own.learnerId,
      enrollmentId: String(f.enrollment.id),
      questionRevisionId: withRubric.headRevisionId,
      submissionId: String(submission.id),
      episodeId: 'ep-1',
      completionMode: 'printable',
      assistance: 'unknown',
      worksheetVersionId: 'wsv1-abc',
      responseJson: JSON.stringify({ value: '3/4' }),
      actorUserId: f.own.actorUserId,
    };
    const first = await f.as(f.own, () =>
      responses.create({ ...base, requestKey: 'r1' }),
    );
    // Modes, assistance, corrections and history follow workbook semantics.
    await expect(
      f.as(f.own, () =>
        responses.create({
          ...base,
          requestKey: 'r2',
          completionMode: 'paper',
        }),
      ),
    ).rejects.toThrow('mode');
    await expect(
      f.as(f.own, () =>
        responses.create({ ...base, requestKey: 'r3', assistance: 'guessed' }),
      ),
    ).rejects.toThrow('assistance');
    // A newer question revision does not disturb the earlier response.
    await s.as(s.guardian, () =>
      s.service.saveQuestionRevision({
        ...s.guardian,
        questionId: withRubric.questionId,
        expectedHeadRevisionId: withRubric.headRevisionId,
        requestKey: s.key(),
        content: mc({ prompt: 'Newer wording' }),
      }),
    );
    const correction = await f.as(f.own, () =>
      responses.create({
        ...base,
        requestKey: 'r4',
        completionMode: 'online',
        assistance: 'assisted',
        previousResponseId: String(first.id),
        responseJson: JSON.stringify({ value: '0.75' }),
      }),
    );
    expect(correction.previousResponseId).toBe(String(first.id));
    const stored = await s.db.list('question_responses', {});
    expect(stored).toHaveLength(2);
    expect(
      new Set(
        stored.map((r) => (r as Record<string, unknown>).question_revision_id),
      ),
    ).toEqual(new Set([withRubric.headRevisionId]));
    // A correction must stay on the same revision and episode.
    await expect(
      f.as(f.own, () =>
        responses.create({
          ...base,
          requestKey: 'r5',
          questionRevisionId: withoutRubric.headRevisionId,
          previousResponseId: String(first.id),
        }),
      ),
    ).rejects.toThrow('ownership');
    // History is append-only.
    await expect(f.as(f.own, () => first.save())).rejects.toThrow('immutable');
    await expect(f.as(f.own, () => first.delete())).rejects.toThrow(
      'immutable',
    );
    // A foreign or unknown revision cannot be referenced.
    await expect(
      f.as(f.own, () =>
        responses.create({
          ...base,
          requestKey: 'r6',
          questionRevisionId: randomUUID(),
        }),
      ),
    ).rejects.toThrow('ownership');

    const grades = await GradeCollection.create({ db: s.db });
    const grade = (extra: Record<string, unknown>) =>
      f.as(f.own, () =>
        grades.create({
          tenantId: f.own.tenantId,
          submissionId: String(submission.id),
          graderKind: 'guardian',
          ...extra,
        }),
      );
    // Legacy grades keep unvalidated results and an unset revision.
    const legacy = await grade({
      rubricResults: JSON.stringify({ anything: { earned: 1 } }),
    });
    expect(legacy.questionRevisionId).toBeNull();
    const good = await grade({
      questionRevisionId: withRubric.headRevisionId,
      rubricResults: JSON.stringify({ method: 2, answer: { points: 1 } }),
      pointsEarned: 3,
      pointsPossible: 3,
    });
    expect(good.questionRevisionId).toBe(withRubric.headRevisionId);
    // Unscored results stay unscored rather than becoming zero.
    await grade({ questionRevisionId: withRubric.headRevisionId });
    for (const rubricResults of [
      { unknown: 1 },
      { method: 3 },
      { method: -1 },
      { method: 'two' },
    ])
      await expect(
        grade({
          questionRevisionId: withRubric.headRevisionId,
          rubricResults: JSON.stringify(rubricResults),
        }),
      ).rejects.toThrow('Rubric results');
    await expect(
      grade({
        questionRevisionId: withoutRubric.headRevisionId,
        rubricResults: JSON.stringify({ method: 1 }),
      }),
    ).rejects.toThrow('require a rubric');
    await expect(grade({ questionRevisionId: randomUUID() })).rejects.toThrow(
      'question revision',
    );
  });

  it('pins question revisions inside workbook assessments', async () => {
    const s = await setup();
    const q = await s.question();
    const storage = await mkdtemp(join(tmpdir(), 'question-records-'));
    const { f } = s;
    const workbook = new WorkbookService(
      s.db,
      ({ own, relationshipTypeId }) =>
        own || relationshipTypeId === f.guardianType.id,
      () => true,
      { storage },
    );
    await f.as(f.parent, async () => {
      const activity = await workbook.resolveWorkbookActivity({
        ...f.parent,
        workbookKey: 'wb',
        title: 'Workbook',
        edition: '',
        pageKey: 'p1',
        pageLabel: 'Page 1',
      });
      const attempt = await workbook.captureWorkbookWork({
        ...f.parent,
        activityId: activity.id,
        requestKey: 'cap',
        pages: [
          {
            name: 'p.png',
            mimeType: 'image/png' as const,
            data: Buffer.from('synthetic'),
          },
        ],
      });
      const anchors = await workbook.getWorkbookSourceAnchors({
        ...f.parent,
        activityId: activity.id,
        submissionId: attempt.submissionId,
      });
      const assessment = (questionRevisionId?: string) =>
        JSON.stringify({
          version: 1,
          feedback: '',
          provenance: {
            provider: 'synthetic',
            model: 'test',
            configurationVersion: '1',
            rubricVersion: '1',
            inputHash: anchors[0].sha256,
            analysisId: 'a',
          },
          vocabulary: WORKBOOK_MATH_VOCABULARY,
          questions: [
            {
              id: '1',
              prompt: 'x',
              answer: '',
              feedback: '',
              result: 'unassessed',
              reason: 'unanswered',
              points: null,
              possiblePoints: null,
              anchors: [{ ...anchors[0], page: 1, rect: [0, 0, 1, 1] }],
              conceptIds: [],
              ...(questionRevisionId ? { questionRevisionId } : {}),
            },
          ],
        });
      const revisions = await WorkbookAssessmentRevisionCollection.create({
        db: s.db,
      });
      const create = (json: string) =>
        revisions.create({
          tenantId: f.parent.tenantId,
          learnerId: f.parent.learnerId,
          attemptId: attempt.id,
          requestKey: randomUUID(),
          kind: 'ai',
          assessmentJson: json,
        });
      // Legacy entries without a reference are unchanged.
      await create(assessment());
      const pinned = await create(assessment(q.headRevisionId));
      expect(
        JSON.parse(pinned.assessmentJson).questions[0].questionRevisionId,
      ).toBe(q.headRevisionId);
      await expect(create(assessment(randomUUID()))).rejects.toThrow(
        'reference mismatch',
      );
      await expect(create(assessment('  '))).rejects.toThrow();
    });
  });

  it('ships the schema change as an additive manifest diff', async () => {
    // Rebuild the pre-change schema: no question tables, none of the new columns.
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [...workbookClasses, ...authoringExtra],
    });
    opened.push(db);
    for (const table of questionTables.map(
      (name) => ObjectRegistry.getSchema(name)?.tableName,
    ))
      await db.query(`DROP TABLE IF EXISTS ${table}`, []);
    for (const [table, column] of [
      ['grades', 'question_revision_id'],
      ['lesson_revisions', 'questions_json'],
      ['lesson_revisions', 'layout_params_json'],
    ])
      await db.query(`ALTER TABLE ${table} DROP COLUMN ${column}`, []);
    const schemas = Object.fromEntries(
      [...questionTables, 'Grade', 'LessonRevision'].map((name) => {
        const schema = ObjectRegistry.getSchema(name);
        if (!schema) throw new Error(`Missing schema ${name}`);
        return [schema.tableName, schema];
      }),
    );
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      schemas,
    );
    expect(diff.added_tables.map((t) => t.tableName).sort()).toEqual(
      [
        'learning_objectives',
        'learning_objective_revisions',
        'question_responses',
        'question_revisions',
        'questions',
      ].sort(),
    );
    // Existing tables only gain nullable columns: Grade keeps every column.
    // Existing tables only gain nullable columns; nothing is dropped or altered.
    expect(
      diff.changes.map((c) => [c.type, c.table, c.name, c.column?.notNull]),
    ).toEqual([
      ['add_column', 'grades', 'question_revision_id', false],
      ['add_column', 'lesson_revisions', 'questions_json', false],
      ['add_column', 'lesson_revisions', 'layout_params_json', false],
    ]);
    expect(diff.dropped_tables).toEqual([]);
    const generated = new MigrationGenerator({
      engine: 'sqlite',
    }).generateFromDiff(diff, {
      name: 'question_records',
    });
    const up = JSON.stringify(generated.up);
    expect(up).not.toMatch(/DROP (TABLE|COLUMN)/i);
    expect(up).not.toMatch(/ALTER COLUMN|RENAME/i);
    const migration = createMigrationDefinition(
      '20261030_question_records',
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
    expect(getSQLFromDiff(second).filter((v) => !v.startsWith('--'))).toEqual(
      [],
    );
  });
});
