import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { HandlerContext } from '@happyvertical/smrt-ingestion/execution';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseRequestKeyConflictError,
  matchExtractedQuestions,
  normalizeQuestionExtraction,
  QUESTION_EXTRACTION_ARGS_SCHEMA,
  type QuestionContentInput,
  type QuestionExtractionGrounding,
  type QuestionExtractionInput,
  QuestionExtractionNotFoundError,
  QuestionExtractionPendingError,
  QuestionExtractionService,
  QuestionExtractionValidationError,
  questionExtractionSourceIdentity,
  type WorksheetBundle,
} from '../index.js';
import {
  educationQuestionExtractionHandler,
  preserveQuestionExtractionAnalysis,
  QUESTION_EXTRACTION_HANDLER_ID,
  questionExtractionGrounding,
} from '../ingestion.js';
import { learnerFixture } from './learner-workflows.js';
import { workbookClasses } from './lesson-work-workflows.js';
import { submissionClasses } from './submission-workflows.js';

/*
 * Question extraction matrix (#4517), see docs/test-matrix/4517-question-extraction.md:
 *  closed schema, evidence/page/region grounding, page coverage ......... 'validation'
 *  source identity from hashes, never text ............................. 'identity'
 *  matcher: identifier + layout only; ambiguity unattached ............. 'matching'
 *  preserve idempotent per attempt; conflict on changed payload ......... 'preserve'
 *  apply: provenance, anchors, examples/unreadable kept, replay ......... 'apply'
 *  re-ingest same bytes replays; changed content goes to review ......... 'idempotency'
 *  known worksheet scan links revisions and student work ............... 'known worksheet'
 *  authorization and tenancy ........................................... 'authorization'
 *  ingestion handler + preserve bridge ................................. 'ingestion'
 */
const classes = [
  ...new Set([
    ...submissionClasses,
    ...workbookClasses,
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
    'GeneratedPrintable',
    'QuestionExtractionRecord',
    'ExtractedQuestionLink',
  ]),
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
const storages: string[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
  for (const dir of storages.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const IMG = 'ev-image';
const PDF = 'ev-pdf';
const grounding = (
  overrides: Partial<QuestionExtractionGrounding> = {},
): QuestionExtractionGrounding => ({
  version: 1,
  extractionAttemptId: 'attempt-x',
  sources: [
    {
      evidenceId: IMG,
      sha256: 'a'.repeat(64),
      mediaType: 'image/jpeg',
      pages: [],
      observedRegions: {
        version: 1,
        coordinateSpace: 'display-oriented',
        regions: [
          { id: 'r1', text: '1. What is 2 + 2?', rect: [0.1, 0.1, 0.5, 0.1] },
          { id: 'r2', text: 'learner: 4', rect: [0.6, 0.1, 0.2, 0.1] },
        ],
      },
    },
  ],
  ...overrides,
});
const anchor = (regionId: string | null = 'r1') => ({
  evidenceId: IMG,
  page: null,
  regionId,
});
type Q = QuestionExtractionInput['questions'][number];
const question = (overrides: Partial<Q> = {}): Q => ({
  key: '1',
  numbering: '1.',
  role: 'exercise',
  sectionId: null,
  status: 'complete',
  prompt: 'What is 2 + 2?',
  responseType: 'short-answer',
  responseTypeOrigin: 'source',
  choices: [],
  subparts: [],
  media: [],
  answerKey: null,
  rubric: null,
  pointsPossible: null,
  pointsOrigin: null,
  anchors: [anchor()],
  ...overrides,
});
const args = (
  overrides: Partial<QuestionExtractionInput> = {},
): QuestionExtractionInput => ({
  version: 1,
  sourceKind: 'worksheet_scan',
  worksheetVersionId: null,
  pages: [
    { evidenceId: IMG, page: null, role: 'exercise', readability: 'readable' },
  ],
  sections: [],
  questions: [question()],
  studentWork: [
    {
      questionKey: '1',
      observed: '4',
      legibility: 'legible',
      anchors: [anchor('r2')],
    },
  ],
  omissions: [],
  ...overrides,
});
const expectInvalid = (value: unknown, g = grounding()) =>
  expect(() => normalizeQuestionExtraction(value, g)).toThrow(
    QuestionExtractionValidationError,
  );

describe('validation', () => {
  it('accepts the closed shape and resolves region rects from the catalog only', () => {
    const out = normalizeQuestionExtraction(args(), grounding());
    expect(out.questions[0].anchors[0]).toEqual({
      evidenceId: IMG,
      sha256: 'a'.repeat(64),
      page: null,
      regionId: 'r1',
      rect: [0.1, 0.1, 0.5, 0.1],
    });
    expect(out.studentWork[0].anchors[0].rect).toEqual([0.6, 0.1, 0.2, 0.1]);
    // Without a region id there are no coordinates at all.
    const plain = normalizeQuestionExtraction(
      args({ questions: [question({ anchors: [anchor(null)] })] }),
      grounding(),
    );
    expect(plain.questions[0].anchors[0].rect).toBeNull();
  });

  it('the JSON schema is closed: every object lists all its properties as required', () => {
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object') {
        expect(n.additionalProperties, path).toBe(false);
        const props = Object.keys(n.properties as object);
        // Only answer-key members are optional (a key has at least one of them).
        if (!path.endsWith('answerKey.anyOf.0'))
          expect([...(n.required as string[])].sort(), path).toEqual(
            props.sort(),
          );
      }
      for (const [k, v] of Object.entries(n))
        if (Array.isArray(v))
          for (const [i, x] of v.entries()) walk(x, `${path}.${k}.${i}`);
        else if (typeof v === 'object') walk(v, `${path}.${k}`);
    };
    walk(QUESTION_EXTRACTION_ARGS_SCHEMA, '$');
  });

  it('refuses ungrounded evidence, pages and regions; never invents coordinates', () => {
    expectInvalid(
      args({
        questions: [
          question({ anchors: [{ ...anchor(), evidenceId: 'nope' }] }),
        ],
      }),
    );
    expectInvalid(
      args({ questions: [question({ anchors: [{ ...anchor(), page: 2 }] })] }),
    );
    expectInvalid(args({ questions: [question({ anchors: [anchor('r9')] })] }));
    // A PDF page the provider never reported.
    const pdf = grounding({
      sources: [
        {
          evidenceId: PDF,
          sha256: 'b'.repeat(64),
          mediaType: 'application/pdf',
          pages: [1, 2],
        },
      ],
    });
    const pdfPages = [
      {
        evidenceId: PDF,
        page: 1,
        role: 'exercise' as const,
        readability: 'readable' as const,
      },
      {
        evidenceId: PDF,
        page: 2,
        role: 'answer_key' as const,
        readability: 'readable' as const,
      },
    ];
    expect(
      normalizeQuestionExtraction(
        args({
          pages: pdfPages,
          questions: [
            question({
              anchors: [{ evidenceId: PDF, page: 2, regionId: null }],
            }),
          ],
          studentWork: [],
        }),
        pdf,
      ).questions[0].anchors[0].page,
    ).toBe(2);
    expectInvalid(
      args({
        pages: pdfPages,
        questions: [
          question({ anchors: [{ evidenceId: PDF, page: 3, regionId: null }] }),
        ],
        studentWork: [],
      }),
      pdf,
    );
    // PDF regions are not supported: no catalog, so no region id.
    expectInvalid(
      args({
        pages: pdfPages,
        questions: [
          question({ anchors: [{ evidenceId: PDF, page: 1, regionId: 'r1' }] }),
        ],
        studentWork: [],
      }),
      pdf,
    );
  });

  it('marks unreadable content instead of omitting it: every source page is covered', () => {
    const pdf = grounding({
      sources: [
        {
          evidenceId: PDF,
          sha256: 'b'.repeat(64),
          mediaType: 'application/pdf',
          pages: [1, 2],
        },
      ],
    });
    expectInvalid(
      args({
        pages: [
          {
            evidenceId: PDF,
            page: 1,
            role: 'exercise',
            readability: 'readable',
          },
        ],
        questions: [],
        studentWork: [],
      }),
      pdf,
    );
    const out = normalizeQuestionExtraction(
      args({
        pages: [
          {
            evidenceId: PDF,
            page: 1,
            role: 'exercise',
            readability: 'partial',
          },
          {
            evidenceId: PDF,
            page: 2,
            role: 'unknown',
            readability: 'unreadable',
          },
        ],
        questions: [
          question({
            key: '2',
            numbering: '2',
            status: 'unreadable',
            prompt: null,
            responseType: null,
            anchors: [{ evidenceId: PDF, page: 1, regionId: null }],
          }),
        ],
        studentWork: [],
        omissions: [
          {
            evidenceId: PDF,
            page: 2,
            reason: 'unreadable',
            description: 'Water damage',
          },
        ],
      }),
      pdf,
    );
    expect(out.questions[0].status).toBe('unreadable');
    expect(out.omissions).toHaveLength(1);
  });

  it('keeps printed and inferred facts apart and refuses inconsistent items', () => {
    // Unreadable items never carry a prompt; readable ones always do.
    expectInvalid(args({ questions: [question({ status: 'unreadable' })] }));
    expectInvalid(args({ questions: [question({ prompt: null })] }));
    // An empty key is not a key.
    expectInvalid(
      args({ questions: [question({ answerKey: { origin: 'inferred' } })] }),
    );
    // A key naming a choice that does not exist.
    expectInvalid(
      args({
        questions: [
          question({
            responseType: 'multiple-choice',
            choices: [
              { id: 'a', label: '3' },
              { id: 'b', label: '4' },
            ],
            answerKey: { correctChoiceIds: ['c'], origin: 'source' },
          }),
        ],
      }),
    );
    expectInvalid(args({ questions: [question({ pointsPossible: 2 })] }));
    // Illegible handwriting is never transcribed.
    expectInvalid(
      args({
        studentWork: [
          {
            questionKey: '1',
            observed: '4',
            legibility: 'illegible',
            anchors: [],
          },
        ],
      }),
    );
    expectInvalid(
      args({
        studentWork: [
          {
            questionKey: '9',
            observed: '4',
            legibility: 'legible',
            anchors: [],
          },
        ],
      }),
    );
    expectInvalid(args({ questions: [question(), question()] }));
    expectInvalid({ ...args(), version: 2 });
    expectInvalid({ ...args(), sourceKind: 'email' });
    expectInvalid({ ...args(), worksheetVersionId: 'wsv1-short' });
    expectInvalid(args({ questions: [question({ prompt: 'a\u0000b' })] }));
  });
});

describe('partial sources', () => {
  const partial = grounding({
    warnings: ['source_incomplete', 'bad_code'],
    sources: [
      {
        evidenceId: PDF,
        sha256: 'b'.repeat(64),
        mediaType: 'application/pdf',
        pages: [1, 2],
        omittedPages: [2],
        incomplete: true,
      },
      {
        evidenceId: IMG,
        sha256: 'a'.repeat(64),
        mediaType: 'image/jpeg',
        pages: [],
        extracted: false,
      },
    ],
  });
  const onlyPageOne = args({
    pages: [
      { evidenceId: PDF, page: 1, role: 'exercise', readability: 'readable' },
    ],
    questions: [
      question({ anchors: [{ evidenceId: PDF, page: 1, regionId: null }] }),
    ],
    studentWork: [],
  });

  it('adds what ingestion never extracted as visible entries and warns', () => {
    const out = normalizeQuestionExtraction(onlyPageOne, partial);
    expect(out.pages).toEqual([
      { evidenceId: PDF, page: 1, role: 'exercise', readability: 'readable' },
      { evidenceId: PDF, page: 2, role: 'unknown', readability: 'unreadable' },
      {
        evidenceId: IMG,
        page: null,
        role: 'unknown',
        readability: 'unreadable',
      },
    ]);
    expect(out.omissions.map((o) => [o.evidenceId, o.page, o.reason])).toEqual([
      [PDF, 2, 'not_extracted'],
      [IMG, null, 'not_extracted'],
    ]);
    expect(out.sourceWarnings).toEqual(['bad_code', 'source_incomplete']);
    // An extractor may honestly cite an omitted page.
    expect(
      normalizeQuestionExtraction(
        args({
          pages: [
            {
              evidenceId: PDF,
              page: 1,
              role: 'exercise',
              readability: 'readable',
            },
            {
              evidenceId: PDF,
              page: 2,
              role: 'unknown',
              readability: 'unreadable',
            },
            {
              evidenceId: IMG,
              page: null,
              role: 'cover',
              readability: 'unreadable',
            },
          ],
          questions: [],
          studentWork: [],
          omissions: [
            {
              evidenceId: PDF,
              page: 2,
              reason: 'unreadable',
              description: 'Torn',
            },
          ],
        }),
        partial,
      ).omissions,
    ).toHaveLength(1);
  });

  it('still refuses an extracted page the extractor left out', () => {
    expectInvalid(
      args({
        pages: [
          {
            evidenceId: PDF,
            page: 2,
            role: 'exercise',
            readability: 'readable',
          },
        ],
        questions: [],
        studentWork: [],
      }),
      partial,
    );
    expectInvalid(onlyPageOne, { ...partial, warnings: ['NOT A CODE'] });
  });
});

describe('identity', () => {
  it('is derived from source kind and evidence hashes, never from text', () => {
    const g = grounding();
    const id = questionExtractionSourceIdentity('worksheet_scan', g);
    expect(id).toMatch(/^qxs1-[0-9a-f]{40}$/);
    expect(
      questionExtractionSourceIdentity('worksheet_scan', {
        ...g,
        extractionAttemptId: 'other',
        sources: g.sources.map((s) => ({ ...s, evidenceId: 'renamed' })),
      }),
    ).toBe(id);
    expect(questionExtractionSourceIdentity('course_import', g)).not.toBe(id);
    expect(
      questionExtractionSourceIdentity('worksheet_scan', {
        ...g,
        sources: g.sources.map((s) => ({ ...s, sha256: 'c'.repeat(64) })),
      }),
    ).not.toBe(id);
  });
});

const WSV = `wsv1-${'0'.repeat(40)}`;
function worksheet(id = WSV): WorksheetBundle {
  const item = (ordinal: number, extra: Record<string, unknown> = {}) => ({
    ordinal,
    questionId: `q${ordinal}`,
    questionRevisionId: `rev${ordinal}`,
    section: '',
    column: 1,
    anchor: null,
    prompt: `Printed prompt ${ordinal}`,
    responseType: 'short-answer' as const,
    choices: [],
    subparts: [],
    media: [],
    pointsPossible: null,
    ...extra,
  });
  return {
    audience: 'learner',
    worksheetVersionId: id,
    lessonRevisionId: 'lr',
    layoutParams: {},
    items: [
      item(1, { section: 'Warm-up' }),
      item(2, {
        responseType: 'multiple-choice',
        choices: [
          { id: 'a', label: 'x' },
          { id: 'b', label: 'y' },
        ],
      }),
    ],
  };
}

describe('matching', () => {
  const extraction = (overrides: Partial<QuestionExtractionInput> = {}) =>
    normalizeQuestionExtraction(args(overrides), grounding());

  it('never matches without a worksheet identifier, or by text alone', () => {
    // Identical printed text, no identifier: unmatched.
    const m = matchExtractedQuestions(
      extraction({ questions: [question({ prompt: 'Printed prompt 1' })] }),
      [worksheet()],
    );
    expect(m.questions[0]).toMatchObject({
      outcome: 'unmatched',
      reason: 'no_worksheet_identifier',
      questionRevisionId: null,
    });
    expect(
      matchExtractedQuestions(
        extraction({ worksheetVersionId: `wsv1-${'1'.repeat(40)}` }),
        [worksheet()],
      ).questions[0].reason,
    ).toBe('unknown_worksheet');
  });

  it('matches on identifier plus printed position, whatever the prompt text', () => {
    const m = matchExtractedQuestions(
      extraction({
        worksheetVersionId: WSV,
        questions: [question({ prompt: 'Different OCR text' })],
      }),
      [worksheet()],
    );
    expect(m).toMatchObject({
      worksheetSource: 'observed',
      worksheetKnown: true,
    });
    expect(m.questions[0]).toMatchObject({
      outcome: 'matched',
      reason: 'worksheet_position',
      questionRevisionId: 'rev1',
      ordinal: 1,
    });
    // A host-known worksheet works when the id is not legible.
    expect(
      matchExtractedQuestions(extraction(), [worksheet()], {
        expectedWorksheetVersionId: WSV,
      }).worksheetSource,
    ).toBe('expected');
  });

  it('leaves conflicts and duplicate claims unattached', () => {
    const base = { worksheetVersionId: WSV };
    const conflict = (q: Partial<Q>) =>
      matchExtractedQuestions(
        extraction({ ...base, questions: [question(q)], studentWork: [] }),
        [worksheet()],
      ).questions[0];
    expect(conflict({ responseType: 'numeric' })).toMatchObject({
      outcome: 'ambiguous',
      reason: 'layout_conflict',
      questionRevisionId: null,
    });
    // An inferred type is not layout evidence.
    expect(
      conflict({ responseType: 'numeric', responseTypeOrigin: 'inferred' })
        .outcome,
    ).toBe('matched');
    expect(
      conflict({
        key: '2',
        numbering: '2',
        responseType: 'multiple-choice',
        choices: [
          { id: 'a', label: 'x' },
          { id: 'b', label: 'y' },
          { id: 'c', label: 'z' },
        ],
      }).reason,
    ).toBe('layout_conflict');
    expect(conflict({ numbering: '7' }).reason).toBe(
      'position_not_on_worksheet',
    );
    expect(conflict({ numbering: null }).reason).toBe('no_layout_position');
    expect(conflict({ role: 'example' }).reason).toBe('not_an_exercise');
    const section = matchExtractedQuestions(
      extraction({
        ...base,
        sections: [{ id: 's', label: 'Stretch', evidenceId: IMG, page: null }],
        questions: [question({ sectionId: 's' })],
        studentWork: [],
      }),
      [worksheet()],
    ).questions[0];
    expect(section.reason).toBe('layout_conflict');
    const dup = matchExtractedQuestions(
      extraction({
        ...base,
        questions: [question(), question({ key: 'u:again:1', numbering: '1' })],
        studentWork: [],
      }),
      [worksheet()],
    ).questions;
    expect(dup.map((q) => q.reason)).toEqual([
      'duplicate_position',
      'duplicate_position',
    ]);
    expect(dup.every((q) => q.questionRevisionId === null)).toBe(true);
    // One compatible and one conflicting claimant of position 1: neither attaches.
    const contested = matchExtractedQuestions(
      extraction({
        ...base,
        questions: [
          question(),
          question({
            key: 'u:other:1',
            numbering: '1',
            responseType: 'numeric',
          }),
        ],
        studentWork: [],
      }),
      [worksheet()],
    ).questions;
    expect(contested.map((q) => q.reason)).toEqual([
      'duplicate_position',
      'layout_conflict',
    ]);
    expect(contested.every((q) => q.questionRevisionId === null)).toBe(true);
    // Printed id disagreeing with the host's expectation: nothing attaches.
    expect(
      matchExtractedQuestions(extraction(base), [worksheet()], {
        expectedWorksheetVersionId: `wsv1-${'1'.repeat(40)}`,
      }).questions[0].reason,
    ).toBe('worksheet_conflict');
  });
});

async function setup() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes,
  });
  opened.push(db);
  const f = await learnerFixture(db);
  const storage = await mkdtemp(join(tmpdir(), 'education-extraction-'));
  storages.push(storage);
  const guardian: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: f.parent.actorUserId,
  };
  const roleId = String(
    (await db.list('memberships', { user_id: guardian.actorUserId }))[0]
      .role_id,
  );
  const member = async (tenantId: string) => {
    const user = await (await UserCollection.create({ db })).create({
      profileId: '',
      email: '',
    });
    await (await MembershipCollection.create({ db })).create({
      userId: String(user.id),
      tenantId,
      roleId,
      status: 'active',
    });
    return String(user.id);
  };
  const reader: CourseAuthoringActor = {
    tenantId: guardian.tenantId,
    actorUserId: await member(guardian.tenantId),
  };
  const outsider: CourseAuthoringActor = {
    tenantId: String(f.foreign.tenantId),
    actorUserId: await member(String(f.foreign.tenantId)),
  };
  const grants = new Map<string, CourseAuthoringAction[]>([
    [guardian.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [reader.actorUserId, ['education.course.read-draft']],
    [outsider.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
  ]);
  const authorizer: CourseAuthoringAuthorizer = (call) =>
    (grants.get(call.actorUserId) ?? []).includes(call.action);
  const service = new QuestionExtractionService(db, authorizer, {
    releaseReviewGate: () => ({ current: true, reviewId: 'review-1' }),
    printableAssets: { storage },
  });
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  let counter = 0;
  const key = (label: string) => `${label}-${++counter}`;
  /** Release one worksheet lesson and attach its printable, as a printed sheet would be. */
  async function printedWorksheet() {
    const content = (
      extra: Partial<QuestionContentInput>,
    ): QuestionContentInput => ({
      prompt: 'What is 2 + 2?',
      responseType: 'short-answer',
      answerKey: { acceptedAnswers: ['4'] },
      provenance: 'supplied',
      ...extra,
    });
    const a = await as(guardian, () =>
      service.createQuestion({
        ...guardian,
        requestKey: key('q'),
        content: content({}),
      }),
    );
    const b = await as(guardian, () =>
      service.createQuestion({
        ...guardian,
        requestKey: key('q'),
        content: content({
          prompt: 'Pick the even number.',
          responseType: 'multiple-choice',
          choices: [
            { id: 'a', label: '3' },
            { id: 'b', label: '4' },
          ],
          answerKey: { correctChoiceIds: ['b'] },
        }),
      }),
    );
    const head = await as(guardian, () =>
      service.createCourse({
        ...guardian,
        requestKey: key('c'),
        title: 'Sums',
      }),
    );
    const saved = await as(guardian, () =>
      service.saveDraft({
        ...guardian,
        courseId: head.courseId,
        expectedHeadRevisionId: head.headRevisionId,
        requestKey: key('s'),
        draft: {
          title: 'Sums',
          provenance: 'supplied',
          sections: [
            {
              sectionKey: 'unit',
              title: 'Unit',
              lessons: [
                {
                  lessonKey: 'ws',
                  title: 'Sums worksheet',
                  lessonType: 'worksheet',
                  questions: [
                    { questionRevisionId: a.headRevisionId },
                    { questionRevisionId: b.headRevisionId },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    const rel = await as(guardian, () =>
      service.release({
        ...guardian,
        courseId: head.courseId,
        revisionId: saved.revisionId,
        requestKey: key('r'),
      }),
    );
    const lesson = await as(guardian, () =>
      service.readReleasedLesson({
        ...guardian,
        releaseId: rel.id,
        lessonKey: 'ws',
      }),
    );
    await as(guardian, () =>
      service.attachGeneratedPrintable({
        ...guardian,
        lessonId: lesson.lessonId,
        worksheetVersionId: lesson.worksheet.worksheetVersionId,
        audience: 'learner',
      }),
    );
    return { a, b, worksheetVersionId: lesson.worksheet.worksheetVersionId };
  }
  const preserve = (
    value: unknown,
    options: {
      actor?: CourseAuthoringActor;
      attempt?: string;
      item?: string;
      g?: QuestionExtractionGrounding;
    } = {},
  ) => {
    const actor = options.actor ?? guardian;
    return as(actor, () =>
      service.preserveExtraction({
        ...actor,
        intakeItemId: options.item ?? 'item-1',
        analysisAttemptId: options.attempt ?? 'attempt-1',
        grounding: options.g ?? grounding(),
        extractor: { provider: 'test', model: 'vision', version: '1' },
        extraction: value,
      }),
    );
  };
  const apply = (extractionId: string, actor = guardian) =>
    as(actor, () => service.applyExtraction({ ...actor, extractionId }));
  const count = async (table: string) => (await db.list(table, {})).length;
  return {
    db,
    service,
    guardian,
    reader,
    outsider,
    as,
    printedWorksheet,
    preserve,
    apply,
    count,
  };
}

const importArgs = (): QuestionExtractionInput =>
  args({
    sourceKind: 'course_import',
    sections: [{ id: 'unit-1', label: 'Unit 1', evidenceId: IMG, page: null }],
    questions: [
      question({
        sectionId: 'unit-1',
        answerKey: { numeric: 4, origin: 'source' },
        pointsPossible: 2,
        pointsOrigin: 'inferred',
        media: [
          { kind: 'diagram', description: 'Number line', anchor: anchor('r1') },
        ],
      }),
      question({
        key: '2',
        numbering: '2',
        responseType: 'multiple-choice',
        responseTypeOrigin: 'inferred',
        prompt: 'Pick one.',
        choices: [
          { id: 'a', label: 'Yes' },
          { id: 'b', label: 'No' },
        ],
        answerKey: { correctChoiceIds: ['a'], origin: 'inferred' },
      }),
      question({
        key: 'u:example:1',
        numbering: null,
        role: 'example',
        prompt: 'Example: 1 + 1 = 2',
      }),
      question({
        key: '3',
        numbering: '3',
        status: 'unreadable',
        prompt: null,
        responseType: null,
      }),
      question({
        key: '4',
        numbering: '4',
        status: 'unsupported',
        prompt: null,
        responseType: null,
      }),
    ],
    studentWork: [],
  });

describe('preserve', () => {
  it('records once per analysis attempt and refuses a different payload for it', async () => {
    const s = await setup();
    const first = await s.preserve(args());
    expect(first.applied).toBeNull();
    expect(first.studentWork[0]).toMatchObject({
      observed: '4',
      questionRevisionId: null,
    });
    expect((await s.preserve(args())).extractionId).toBe(first.extractionId);
    expect(await s.count('question_extractions')).toBe(1);
    await expect(
      s.preserve(args({ questions: [question({ prompt: 'Changed' })] })),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    // Same attempt and arguments, different retained evidence: a conflict too.
    await expect(
      s.preserve(args(), {
        g: grounding({
          sources: grounding().sources.map((x) => ({
            ...x,
            sha256: 'e'.repeat(64),
          })),
        }),
      }),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    await expect(
      s.as(s.guardian, () =>
        s.service.preserveExtraction({
          ...s.guardian,
          intakeItemId: 'item-1',
          analysisAttemptId: 'attempt-1',
          grounding: grounding(),
          extractor: { provider: 'test', model: 'vision', version: '1' },
          extraction: args(),
          expectedWorksheetVersionId: WSV,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseRequestKeyConflictError);
    await expect(s.preserve({ ...args(), extra: true })).rejects.toBeInstanceOf(
      QuestionExtractionValidationError,
    );
    expect(await s.count('questions')).toBe(0);
  });
});

describe('apply', () => {
  it('creates extracted question records with inferred facts flagged and anchors kept', async () => {
    const s = await setup();
    const view = await s.preserve(importArgs());
    const results = await s.apply(view.extractionId);
    expect(results.map((r) => [r.key, r.outcome])).toEqual([
      ['1', 'created'],
      ['2', 'created'],
      ['u:example:1', 'not_an_exercise'],
      ['3', 'unreadable'],
      ['4', 'unsupported'],
    ]);
    expect(await s.count('questions')).toBe(2);
    const one = await s.as(s.guardian, () =>
      s.service.readQuestion({
        ...s.guardian,
        questionId: results[0].questionId as string,
      }),
    );
    expect(one.revision).toMatchObject({
      prompt: 'What is 2 + 2?',
      provenance: 'extracted',
      answerKey: { numeric: { value: 4 } },
      pointsPossible: 2,
      fieldProvenance: {
        prompt: 'extracted',
        responseType: 'extracted',
        answerKey: 'extracted',
        pointsPossible: 'inferred',
      },
    });
    const two = await s.as(s.guardian, () =>
      s.service.readQuestion({
        ...s.guardian,
        questionId: results[1].questionId as string,
      }),
    );
    expect(two.revision.fieldProvenance).toMatchObject({
      responseType: 'inferred',
      choices: 'extracted',
      answerKey: 'inferred',
    });
    const link = await s.db.get('extracted_question_links', {
      question_id: results[0].questionId,
    });
    expect(JSON.parse(String(link?.anchors_json))[0]).toMatchObject({
      evidenceId: IMG,
      regionId: 'r1',
      rect: [0.1, 0.1, 0.5, 0.1],
    });
    expect(JSON.parse(String(link?.media_json))[0]).toMatchObject({
      kind: 'diagram',
    });
    // A repeated apply replays the stored outcomes and writes nothing.
    expect(await s.apply(view.extractionId)).toEqual(results);
    expect(await s.count('questions')).toBe(2);
    expect(await s.count('extracted_question_links')).toBe(5);
    expect(
      (
        await s.as(s.guardian, () =>
          s.service.readExtraction({
            ...s.guardian,
            extractionId: view.extractionId,
          }),
        )
      ).applied,
    ).toEqual(results);
  });
});

describe('idempotency', () => {
  it('re-ingesting the same bytes replays; repeated prompts in one source stay distinct', async () => {
    const s = await setup();
    const twin = args({
      questions: [question(), question({ key: '2', numbering: '2' })],
      studentWork: [],
    });
    const first = await s.apply((await s.preserve(twin)).extractionId);
    expect(first.map((r) => r.outcome)).toEqual(['created', 'created']);
    expect(first[0].questionId).not.toBe(first[1].questionId);
    // A retry of the whole pipeline: new item and attempt, same retained bytes.
    const again = await s.apply(
      (await s.preserve(twin, { item: 'item-2', attempt: 'attempt-2' }))
        .extractionId,
    );
    expect(again.map((r) => r.outcome)).toEqual(['replayed', 'replayed']);
    expect(again.map((r) => r.questionId)).toEqual(
      first.map((r) => r.questionId),
    );
    expect(await s.count('questions')).toBe(2);
    // Same source, different extraction: never overwritten, never duplicated.
    const changed = await s.apply(
      (
        await s.preserve(
          args({
            questions: [question({ prompt: 'What is 2 plus 2?' })],
            studentWork: [],
          }),
          { item: 'item-3', attempt: 'attempt-3' },
        )
      ).extractionId,
    );
    expect(changed[0]).toMatchObject({
      outcome: 'source_changed',
      questionId: first[0].questionId,
      questionRevisionId: null,
    });
    expect(await s.count('question_revisions')).toBe(2);
    // A fresh scan (new bytes) of an unknown sheet is a new source.
    const rescan = await s.apply(
      (
        await s.preserve(twin, {
          item: 'item-4',
          attempt: 'attempt-4',
          g: grounding({
            sources: grounding().sources.map((x) => ({
              ...x,
              sha256: 'd'.repeat(64),
            })),
          }),
        })
      ).extractionId,
    );
    expect(rescan.map((r) => r.outcome)).toEqual(['created', 'created']);
  });
});

describe('known worksheet', () => {
  it('links a scan of a generated worksheet to its revisions without new records', async () => {
    const s = await setup();
    const sheet = await s.printedWorksheet();
    const before = await s.count('questions');
    const scan = args({
      worksheetVersionId: sheet.worksheetVersionId,
      questions: [
        question({ prompt: 'Wha7 is 2 + 2' }),
        question({
          key: '2',
          numbering: '2.',
          prompt: 'Pick the even number.',
          responseType: 'multiple-choice',
          choices: [
            { id: 'a', label: '3' },
            { id: 'b', label: '4' },
            { id: 'c', label: '5' },
          ],
        }),
      ],
      studentWork: [
        {
          questionKey: '1',
          observed: '4',
          legibility: 'legible',
          anchors: [anchor('r2')],
        },
        {
          questionKey: '2',
          observed: null,
          legibility: 'illegible',
          anchors: [],
        },
      ],
    });
    const view = await s.preserve(scan);
    expect(view.match).toMatchObject({
      worksheetKnown: true,
      worksheetSource: 'observed',
    });
    expect(view.match.questions.map((m) => m.outcome)).toEqual([
      'matched',
      'ambiguous',
    ]);
    // Student work is attached only to the matched question, never the ambiguous one.
    expect(view.studentWork.map((w) => w.questionRevisionId)).toEqual([
      sheet.a.headRevisionId,
      null,
    ]);
    const results = await s.apply(view.extractionId);
    expect(results).toEqual([
      {
        key: '1',
        outcome: 'matched',
        questionId: sheet.a.questionId,
        questionRevisionId: sheet.a.headRevisionId,
      },
      {
        key: '2',
        outcome: 'needs_review',
        questionId: null,
        questionRevisionId: null,
      },
    ]);
    expect(await s.count('questions')).toBe(before);
    // The same bytes later read without the printed id: an earlier match is not a
    // prior creation, so the new record reports `created`, never `replayed`.
    const unmatched = await s.apply(
      (
        await s.preserve(
          args({
            questions: [question({ prompt: 'Wha7 is 2 + 2' })],
            studentWork: [],
          }),
          { item: 'item-2', attempt: 'attempt-2' },
        )
      ).extractionId,
    );
    expect(unmatched[0].outcome).toBe('created');
  });

  it('refuses host-supplied worksheets that are not this tenant’s revisions', async () => {
    const s = await setup();
    await expect(
      s.as(s.guardian, () =>
        s.service.preserveExtraction({
          ...s.guardian,
          intakeItemId: 'item-1',
          analysisAttemptId: 'attempt-1',
          grounding: grounding(),
          extractor: { provider: 'test', model: 'vision', version: '1' },
          extraction: args({ worksheetVersionId: WSV, studentWork: [] }),
          worksheets: [worksheet()],
        }),
      ),
    ).rejects.toBeInstanceOf(QuestionExtractionValidationError);
    expect(await s.count('question_extractions')).toBe(0);
  });
});

describe('authorization', () => {
  it('needs author to preserve/apply, read-draft to read; foreign tenants see nothing', async () => {
    const s = await setup();
    await expect(
      s.preserve(args(), { actor: s.reader }),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    const view = await s.preserve(args());
    await expect(s.apply(view.extractionId, s.reader)).rejects.toBeInstanceOf(
      CourseAuthoringAuthorizationError,
    );
    expect(
      (
        await s.as(s.reader, () =>
          s.service.readExtraction({
            ...s.reader,
            extractionId: view.extractionId,
          }),
        )
      ).extractionId,
    ).toBe(view.extractionId);
    await expect(s.apply(view.extractionId, s.outsider)).rejects.toBeInstanceOf(
      QuestionExtractionNotFoundError,
    );
    // Actor must match the active tenant context.
    await expect(
      s.as(s.outsider, () =>
        s.service.applyExtraction({
          ...s.guardian,
          extractionId: view.extractionId,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect(await s.count('questions')).toBe(0);
  });
});

describe('ingestion', () => {
  const snapshot = (suggestions: unknown[], outcome = 'proposals') => ({
    attemptId: 'attempt-9',
    configuration: { stage: 'interpret' },
    evidence: [
      {
        id: IMG,
        contentHash: 'a'.repeat(64),
        mediaType: 'image/jpeg',
        parentEvidenceId: null,
        partId: 'p1',
      },
    ],
    result: {
      status: 'completed',
      output: {
        results: [
          {
            evidence: { id: IMG, contentHash: 'a'.repeat(64) },
            capabilities: [{ location: 'source' }],
            segments: [
              {
                location: { kind: 'source' },
                observedRegions: grounding().sources[0].observedRegions,
              },
            ],
          },
        ],
        proposals: {
          version: 1,
          outcome,
          suggestions,
          provenance: {
            generative: { provider: 'p', model: 'm', version: 'v' },
            configurationVersion: 'cfg',
            promptVersion: 'pv',
          },
        },
      },
    },
  });
  const suggestion = (value: unknown) => ({
    handlerId: QUESTION_EXTRACTION_HANDLER_ID,
    handlerVersion: '1',
    args: value,
    missingFields: [],
  });
  const fakeIngestion = (snap: unknown) =>
    ({ getCompletedAnalysis: async () => snap }) as never;

  it('preserves the completed proposal, then the handler previews and applies it', async () => {
    const s = await setup();
    const view = await s.as(s.guardian, () =>
      preserveQuestionExtractionAnalysis({
        ingestion: fakeIngestion(snapshot([suggestion(args())])),
        extractions: s.service,
        request: s.guardian,
        itemId: 'item-1',
      }),
    );
    expect(view.extractor).toEqual({
      provider: 'p',
      model: 'm',
      version: 'v',
      configurationVersion: 'cfg',
      promptVersion: 'pv',
    });
    expect(view.extraction.questions[0].anchors[0].rect).toEqual([
      0.1, 0.1, 0.5, 0.1,
    ]);
    const handler = educationQuestionExtractionHandler({
      extractions: s.service,
      request: s.guardian,
    });
    const context = (db: DatabaseInterface, actorId = s.guardian.actorUserId) =>
      ({
        db,
        scope: { tenantId: s.guardian.tenantId, actorId },
        itemId: 'item-1',
        policy: { requireReview: true },
        assertTarget: async () => {},
      }) as unknown as HandlerContext;
    const preview = await s.as(s.guardian, () =>
      handler.preview(args() as never, context(s.db)),
    );
    expect(preview.display).toMatchObject({
      extractionId: view.extractionId,
      questions: 1,
      unmatched: 1,
      studentWork: 1,
      extractionReviewRequired: true,
    });
    expect(preview.targetPreconditions).toEqual([]);
    // A different (unpreserved) payload cannot be applied.
    await expect(
      s.as(s.guardian, () =>
        handler.validate(
          args({ questions: [question({ prompt: 'Other' })] }) as never,
          context(s.db),
        ),
      ),
    ).rejects.toThrow('preserved');
    // Another actor's scope is refused.
    await expect(
      s.as(s.guardian, () =>
        handler.validate(args() as never, context(s.db, 'someone')),
      ),
    ).rejects.toThrow('scope mismatch');
    if (handler.execution.kind !== 'database')
      throw new Error('database handler');
    const execution = handler.execution;
    const result = await s.as(s.guardian, () =>
      s.db.transaction?.((tx) => execution.apply(args() as never, context(tx))),
    );
    expect(result).toEqual({ extractionId: view.extractionId });
    expect(await s.count('questions')).toBe(1);
  });

  it('keeps a missing result and omitted pages in grounding, and shows the warning', async () => {
    const s = await setup();
    const snap = snapshot([suggestion(args())], 'needs_review');
    // A second retained original that ingestion produced no result for.
    snap.evidence.push({
      id: PDF,
      contentHash: 'b'.repeat(64),
      mediaType: 'application/pdf',
      parentEvidenceId: null,
      partId: 'p2',
    });
    (snap.result.output.proposals as Record<string, unknown>).warnings = [
      'source_incomplete',
    ];
    expect(
      questionExtractionGrounding(snap as never).sources.find(
        (x) => x.evidenceId === PDF,
      ),
    ).toMatchObject({ pages: [], extracted: false });
    const view = await s.as(s.guardian, () =>
      preserveQuestionExtractionAnalysis({
        ingestion: fakeIngestion(snap),
        extractions: s.service,
        request: s.guardian,
        itemId: 'item-1',
      }),
    );
    expect(view.extraction.sourceWarnings).toEqual(['source_incomplete']);
    expect(view.extraction.pages.map((p) => [p.evidenceId, p.page])).toEqual([
      [IMG, null],
      [PDF, null],
    ]);
    expect(view.extraction.omissions.at(-1)).toMatchObject({
      evidenceId: PDF,
      reason: 'not_extracted',
    });
    // The missing original changes the source identity: no false replay later.
    expect(view.sourceIdentity).not.toBe(
      questionExtractionSourceIdentity('worksheet_scan', grounding()),
    );
    // With a truncated result, omitted pages are known, citable and required.
    (snap.result.output.results as unknown[]).push({
      evidence: { id: PDF, contentHash: 'b'.repeat(64) },
      segments: [{ location: { kind: 'page', page: 1 } }],
      omitted: [{ kind: 'pages', startPage: 2, endPage: 3 }],
      errors: [],
      truncated: true,
    });
    expect(
      questionExtractionGrounding(snap as never).sources.find(
        (x) => x.evidenceId === PDF,
      ),
    ).toMatchObject({
      pages: [1, 2, 3],
      omittedPages: [2, 3],
      incomplete: true,
    });
    const handler = educationQuestionExtractionHandler({
      extractions: s.service,
      request: s.guardian,
    });
    const preview = await s.as(s.guardian, () =>
      handler.preview(
        args() as never,
        {
          db: s.db,
          scope: {
            tenantId: s.guardian.tenantId,
            actorId: s.guardian.actorUserId,
          },
          itemId: 'item-1',
          policy: { requireReview: true },
          assertTarget: async () => {},
        } as unknown as HandlerContext,
      ),
    );
    expect(preview.display.sourceWarnings).toEqual(['source_incomplete']);
  });

  it('refuses an absurd page range instead of truncating it', () => {
    const snap = snapshot([]);
    (snap.result.output.results[0] as Record<string, unknown>).omitted = [
      { kind: 'pages', startPage: 1, endPage: 5000 },
    ];
    expect(() => questionExtractionGrounding(snap as never)).toThrow(
      QuestionExtractionValidationError,
    );
  });

  it('reports pending, missing and competing proposals as typed pending errors', async () => {
    const s = await setup();
    const run = (snap: unknown) =>
      preserveQuestionExtractionAnalysis({
        ingestion: fakeIngestion(snap),
        extractions: s.service,
        request: s.guardian,
        itemId: 'item-1',
      });
    const reason = async (snap: unknown) => {
      try {
        await run(snap);
      } catch (error) {
        if (error instanceof QuestionExtractionPendingError)
          return error.reason;
        throw error;
      }
      return 'none';
    };
    expect(
      await reason({ ...snapshot([]), configuration: { stage: 'extract' } }),
    ).toBe('pending');
    expect(await reason(snapshot([]))).toBe('no_proposal');
    expect(await reason(snapshot([], 'no_action'))).toBe('no_proposal');
    expect(await reason(snapshot([], 'ambiguous'))).toBe('ambiguous');
    expect(
      await reason(snapshot([suggestion(args()), suggestion(args())])),
    ).toBe('ambiguous');
    await expect(
      run(snapshot([{ ...suggestion(args()), missingFields: ['pages'] }])),
    ).rejects.toBeInstanceOf(QuestionExtractionValidationError);
    const unavailable = {
      getCompletedAnalysis: async () => {
        throw new Error('Analysis unavailable');
      },
    } as never;
    await expect(
      preserveQuestionExtractionAnalysis({
        ingestion: unavailable,
        extractions: s.service,
        request: s.guardian,
        itemId: 'item-1',
      }),
    ).rejects.toBeInstanceOf(QuestionExtractionPendingError);
    expect(await s.count('question_extractions')).toBe(0);
  });
});
