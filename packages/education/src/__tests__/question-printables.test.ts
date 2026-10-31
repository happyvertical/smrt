import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
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
import { decodePDFRawStream, PDFDocument, PDFRawStream } from 'pdf-lib';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  buildGuardianWorksheet,
  buildLearnerWorksheet,
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseAuthoringValidationError,
  GeneratedPrintableCollection,
  LearnerAuthorizationError,
  MAX_PRINTABLE_ITEMS,
  MAX_PRINTABLE_TEXT_LENGTH,
  PrintableStorageNotConfiguredError,
  QuestionAuthoringService,
  type QuestionContentInput,
  QuestionNotFoundError,
  renderGuardianWorksheetPdf,
  renderLearnerWorksheetPdf,
  SubmissionService,
  WorksheetVersionMismatchError,
} from '../index.js';
import { learnerFixture } from './learner-workflows.js';
import { submissionClasses } from './submission-workflows.js';
import { workbookClasses } from './workbook-workflows.js';

/*
 * attachGeneratedPrintable matrix (#4541):
 *  learner copy valid, keyless; guardian copy keyed ................. 'copies'
 *  footer/metadata carry version id and audience, fixed dates ....... 'copies'
 *  idempotent, both audiences coexist under their relationships ..... 'idempotent'
 *  stale/foreign version, foreign/unknown lesson refused, no writes . 'refusals'
 *  learner (and learner delegations) refused before the host ........ 'learners'
 *  delegation through verifyDelegation; read-draft for guardian ..... 'delegation'
 *  signLessonPrintable signs printable, refuses answer-key .......... 'signing'
 *  rollback leaves no asset, file or row; retry works ............... 'rollback'
 *  concurrent first calls converge .................................. 'concurrency'
 *  deterministic bytes, WinAnsi fallback, caps ...................... 'renderer'
 *  storage fails closed ............................................. 'unconfigured'
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
  ]),
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
const storages: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) await db.close?.();
  for (const dir of storages.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const KEY = 'KEYTEXT-7391';
const PART_KEY = 'PARTKEY-4412';
const EXPLAIN = 'EXPLAIN-5520';
const content = (
  extra: Partial<QuestionContentInput> = {},
): QuestionContentInput => ({
  prompt: 'What is 1/2 + 1/4?',
  responseType: 'short-answer',
  answerKey: { acceptedAnswers: [KEY], explanation: EXPLAIN },
  pointsPossible: 2,
  provenance: 'supplied',
  ...extra,
});

/** Decoded text-showing operands of every content stream, plus Info strings. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: string[] = [
    doc.getTitle() ?? '',
    doc.getSubject() ?? '',
    doc.getKeywords() ?? '',
  ];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const decoded = Buffer.from(decodePDFRawStream(object).decode());
    for (const match of decoded
      .toString('latin1')
      .matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g))
      out.push(Buffer.from(match[1], 'hex').toString('latin1'));
  }
  return out.join('\n');
}
async function files(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

async function setup(
  options: { storage?: boolean; verifyDelegation?: boolean } = {},
) {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes,
  });
  opened.push(db);
  const f = await learnerFixture(db);
  const storage = await mkdtemp(join(tmpdir(), 'education-printables-'));
  storages.push(storage);
  const guardian: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: f.parent.actorUserId,
  };
  // An agent that is not a learner: a plain member user without a profile.
  const roleId = String(
    (await db.list('memberships', { user_id: guardian.actorUserId }))[0]
      .role_id,
  );
  const addMember = async (tenantId: string, memberRole: string) => {
    const user = await (await UserCollection.create({ db })).create({
      profileId: '',
      email: '',
    });
    await (await MembershipCollection.create({ db })).create({
      userId: String(user.id),
      tenantId,
      roleId: memberRole,
      status: 'active',
    });
    return String(user.id);
  };
  const agentUserId = await addMember(guardian.tenantId, roleId);
  const foreignRoleId = String(
    (await db.list('memberships', { user_id: String(f.stranger.user.id) }))[0]
      .role_id,
  );
  const agent: CourseAuthoringActor = {
    tenantId: guardian.tenantId,
    actorUserId: agentUserId,
    delegatingGuardianUserId: guardian.actorUserId,
    delegationId: 'delegation-1',
  };
  const learnerActor: CourseAuthoringActor = {
    tenantId: guardian.tenantId,
    actorUserId: f.own.actorUserId,
  };
  // A guardian of another family (not a learner there).
  const outsider: CourseAuthoringActor = {
    tenantId: String(f.foreign.tenantId),
    actorUserId: await addMember(String(f.foreign.tenantId), foreignRoleId),
  };
  const calls: Array<Parameters<CourseAuthoringAuthorizer>[0]> = [];
  const grants = new Map<string, CourseAuthoringAction[]>([
    [guardian.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [agent.actorUserId, ['education.course.author']],
    // A learner is granted everything: only the service's own rule can refuse.
    [learnerActor.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [outsider.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
  ]);
  const authorizer: CourseAuthoringAuthorizer = (call) => {
    calls.push(call);
    return (grants.get(call.actorUserId) ?? []).includes(call.action);
  };
  const verified: Array<Record<string, unknown>> = [];
  const service = new QuestionAuthoringService(db, authorizer, {
    ...(options.verifyDelegation === false
      ? {}
      : {
          verifyDelegation: (_tx, request) => {
            verified.push(request as unknown as Record<string, unknown>);
            return true;
          },
        }),
    releaseReviewGate: () => ({ current: true, reviewId: 'review-1' }),
    ...(options.storage === false ? {} : { printableAssets: { storage } }),
  });
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  let counter = 0;
  const key = (label = 'k') => `${label}-${++counter}`;
  const question = (c = content(), actor = guardian) =>
    as(actor, () =>
      service.createQuestion({ ...actor, requestKey: key('q'), content: c }),
    );
  async function release(
    refs: Array<{ questionRevisionId: string; section?: string }>,
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
                  title: 'Fraction worksheet',
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
    const rel = await as(guardian, () =>
      service.release({
        ...guardian,
        courseId: head.courseId,
        revisionId: saved.revisionId,
        requestKey: key('rel'),
      }),
    );
    const lesson = await as(guardian, () =>
      service.readReleasedLesson({
        ...guardian,
        releaseId: rel.id,
        lessonKey: 'ws',
      }),
    );
    return {
      release: rel,
      lessonId: lesson.lessonId,
      worksheetVersionId: lesson.worksheet.worksheetVersionId,
    };
  }
  /** One lesson with a short-answer, a choice, and a multi-part question. */
  async function standard() {
    const a = await question();
    const b = await question(
      content({
        prompt: 'Pick the larger fraction.',
        responseType: 'multiple-choice',
        choices: [
          { id: 'c1', label: '1/3' },
          { id: 'c2', label: '1/2' },
        ],
        answerKey: { correctChoiceIds: ['c2'] },
      }),
    );
    const c = await question(
      content({
        prompt: 'Solve each part.',
        responseType: 'multi-part',
        subparts: [
          { partKey: 'a', prompt: 'One third of 9' },
          { partKey: 'b', prompt: 'One half of 8' },
        ],
        answerKey: {
          acceptedAnswers: ['see parts'],
          parts: {
            a: { acceptedAnswers: [PART_KEY] },
            b: { numeric: { value: 4 } },
          },
        },
        rubric: { criteria: [{ id: 'r1', label: 'Shows work', maxPoints: 2 }] },
      }),
    );
    return release([
      { questionRevisionId: a.headRevisionId, section: 'warm-up' },
      { questionRevisionId: b.headRevisionId, section: 'warm-up' },
      { questionRevisionId: c.headRevisionId, section: 'stretch' },
    ]);
  }
  const attach = (
    lesson: { lessonId: string; worksheetVersionId: string },
    audience: 'learner' | 'guardian',
    actor: CourseAuthoringActor = guardian,
    override: Record<string, unknown> = {},
  ) =>
    as(actor, () =>
      service.attachGeneratedPrintable({
        ...actor,
        lessonId: lesson.lessonId,
        worksheetVersionId: lesson.worksheetVersionId,
        audience,
        ...override,
      }),
    );
  const counts = async () => ({
    printables: (await db.list('generated_printables', {})).length,
    assets: (await db.list('assets', {})).length,
    links: (await db.list('lesson_assets', {})).length,
    files: (await files(storage)).length,
  });
  const read = async (assetId: string) => {
    const asset = await db.get('assets', { id: assetId });
    return readFile(
      new URL(String(asset?.source_uri)).pathname.replace(/%20/g, ' '),
    );
  };
  return {
    db,
    f,
    storage,
    service,
    guardian,
    agent,
    learnerActor,
    outsider,
    calls,
    grants,
    verified,
    as,
    key,
    question,
    release,
    standard,
    attach,
    counts,
    read,
  };
}

describe('generated printables', () => {
  it('copies: learner copy is a keyless PDF, guardian copy carries the keys', async () => {
    const s = await setup();
    const lesson = await s.standard();
    const learner = await s.attach(lesson, 'learner');
    const guardian = await s.attach(lesson, 'guardian');
    expect(learner).toEqual({
      lessonId: lesson.lessonId,
      worksheetVersionId: lesson.worksheetVersionId,
      audience: 'learner',
      assetId: learner.assetId,
      relationship: 'printable',
      created: true,
    });
    expect(guardian.relationship).toBe('answer-key');
    expect(Object.keys(guardian).sort()).toEqual(Object.keys(learner).sort());

    const learnerBytes = await s.read(learner.assetId);
    const guardianBytes = await s.read(guardian.assetId);
    expect(Buffer.from(learnerBytes.subarray(0, 5)).toString()).toBe('%PDF-');
    const learnerDoc = await PDFDocument.load(learnerBytes, {
      updateMetadata: false,
    });
    expect(learnerDoc.getPageCount()).toBeGreaterThan(0);
    expect(learnerDoc.getCreationDate()?.toISOString()).toBe(
      '2000-01-01T00:00:00.000Z',
    );
    expect(learnerDoc.getModificationDate()?.toISOString()).toBe(
      '2000-01-01T00:00:00.000Z',
    );

    const learnerText = await pdfText(learnerBytes);
    for (const secret of [KEY, PART_KEY, EXPLAIN, 'Shows work'])
      expect(learnerText).not.toContain(secret);
    // Raw bytes too: nothing is hidden from the extraction above.
    for (const secret of [KEY, PART_KEY, EXPLAIN, 'Shows work'])
      expect(Buffer.from(learnerBytes).toString('latin1')).not.toContain(
        secret,
      );
    expect(learnerText).toContain('What is 1/2 + 1/4?');
    expect(learnerText).toContain('Pick the larger fraction.');
    expect(learnerText).toContain('(a) One third of 9');
    expect(learnerText).toContain('warm-up');
    expect(learnerText).toContain('stretch');
    expect(learnerText).toContain(lesson.worksheetVersionId);
    expect(learnerText).toContain('learner copy');
    expect(learnerText).toContain('Fraction worksheet');

    const guardianText = await pdfText(guardianBytes);
    for (const secret of [KEY, PART_KEY, EXPLAIN, 'Shows work'])
      expect(guardianText).toContain(secret);
    expect(guardianText).toContain('B. 1/2');
    expect(guardianText).toContain('guardian copy');
    expect(guardianText).toContain(lesson.worksheetVersionId);
    const guardianDoc = await PDFDocument.load(guardianBytes, {
      updateMetadata: false,
    });
    expect(guardianDoc.getKeywords()).toContain(lesson.worksheetVersionId);
  });

  it('idempotent: a repeat replays without rendering or storing, audiences coexist', async () => {
    const s = await setup();
    const lesson = await s.standard();
    const first = await s.attach(lesson, 'learner');
    const after = await s.counts();
    expect(after).toEqual({ printables: 1, assets: 1, links: 1, files: 1 });
    const second = await s.attach(lesson, 'learner');
    expect(second).toEqual({ ...first, created: false });
    expect(await s.counts()).toEqual(after);
    const key = await s.attach(lesson, 'guardian');
    expect(key.assetId).not.toBe(first.assetId);
    expect(await s.counts()).toEqual({
      printables: 2,
      assets: 2,
      links: 2,
      files: 2,
    });
    const links = await s.db.list('lesson_assets', {
      lesson_id: lesson.lessonId,
    });
    expect(links.map((l) => `${l.relationship}:${l.asset_id}`).sort()).toEqual(
      [`printable:${first.assetId}`, `answer-key:${key.assetId}`].sort(),
    );
    const asset = await s.db.get('assets', { id: first.assetId });
    expect(asset?.access_mode).toBe('private');
    expect(asset?.tenant_id).toBe(s.guardian.tenantId);
    expect(asset?.owner_profile_id).toBe(String(s.f.guardian.profile.id));
    const row = await s.db.get('generated_printables', {
      asset_id: first.assetId,
    });
    expect(row?.generated_by_user_id).toBe(s.guardian.actorUserId);
    // The row is append-only.
    await s.as(s.guardian, async () => {
      const model = await (
        await GeneratedPrintableCollection.create({ db: s.db })
      ).get({ id: String(row?.id) }, { cache: false });
      await expect(model?.delete()).rejects.toThrow();
    });
  });

  it('refusals: stale, foreign and unknown ids throw and write nothing', async () => {
    const s = await setup();
    const lesson = await s.standard();
    const other = await s.standard();
    const before = await s.counts();
    await expect(
      s.attach(lesson, 'learner', s.guardian, {
        worksheetVersionId: other.worksheetVersionId,
      }),
    ).rejects.toMatchObject({
      code: 'worksheet-version-mismatch',
      constructor: WorksheetVersionMismatchError,
    });
    await expect(
      s.attach(lesson, 'guardian', s.guardian, {
        worksheetVersionId: 'wsv1-unknown',
      }),
    ).rejects.toBeInstanceOf(WorksheetVersionMismatchError);
    await expect(
      s.attach(lesson, 'learner', s.guardian, { lessonId: 'no-such-lesson' }),
    ).rejects.toBeInstanceOf(QuestionNotFoundError);
    // Another tenant's actor cannot see this tenant's lesson, and vice versa.
    await expect(
      s.attach(lesson, 'learner', s.outsider),
    ).rejects.toBeInstanceOf(QuestionNotFoundError);
    await expect(
      s.attach(lesson, 'learner', s.guardian, { audience: 'staff' }),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    expect(await s.counts()).toEqual(before);
    // A lesson with no questions has nothing to print.
    const empty = await s.release([]);
    await expect(s.attach(empty, 'learner')).rejects.toBeInstanceOf(
      CourseAuthoringValidationError,
    );
    expect(await s.counts()).toEqual(before);
  });

  it('learners: refused before the host is asked, nothing stored', async () => {
    const s = await setup();
    const lesson = await s.standard();
    s.calls.length = 0;
    const before = await s.counts();
    const attempts = [
      s.attach(lesson, 'learner', s.learnerActor),
      s.attach(lesson, 'guardian', s.learnerActor),
      // A learner claiming a delegation from a guardian.
      s.attach(lesson, 'learner', {
        ...s.learnerActor,
        delegatingGuardianUserId: s.guardian.actorUserId,
        delegationId: 'd-1',
      }),
      // An agent claiming a learner as the delegating guardian.
      s.attach(lesson, 'learner', {
        ...s.agent,
        delegatingGuardianUserId: s.learnerActor.actorUserId,
      }),
    ];
    for (const attempt of attempts)
      await expect(attempt).rejects.toBeInstanceOf(
        CourseAuthoringAuthorizationError,
      );
    expect(s.calls).toEqual([]);
    expect(s.verified).toEqual([]);
    expect(await s.counts()).toEqual(before);
  });

  it('delegation: verified agents pass through the usual path, guardian copy needs read-draft', async () => {
    const s = await setup();
    const lesson = await s.standard();
    s.calls.length = 0;
    const result = await s.attach(lesson, 'learner', s.agent);
    expect(result.created).toBe(true);
    expect(s.verified.map((v) => [v.operation, v.action])).toEqual([
      ['attach-printable', 'education.course.author'],
    ]);
    expect(s.calls.map((c) => [c.operation, c.action])).toEqual([
      ['attach-printable', 'education.course.author'],
    ]);
    expect(s.calls[0].delegationId).toBe('delegation-1');
    // The delegated agent's asset is owned by the delegating guardian.
    const asset = await s.db.get('assets', { id: result.assetId });
    expect(asset?.owner_profile_id).toBe(String(s.f.guardian.profile.id));
    expect(
      (await s.db.get('generated_printables', { asset_id: result.assetId }))
        ?.delegation_id,
    ).toBe('delegation-1');
    // The audience never widens authority: the agent lacks read-draft.
    const before = await s.counts();
    await expect(s.attach(lesson, 'guardian', s.agent)).rejects.toBeInstanceOf(
      CourseAuthoringAuthorizationError,
    );
    expect(await s.counts()).toEqual(before);
    s.grants.set(s.agent.actorUserId, [
      'education.course.author',
      'education.course.read-draft',
    ]);
    expect((await s.attach(lesson, 'guardian', s.agent)).created).toBe(true);

    // No verifier: delegation fields are refused, like every authoring call.
    const plain = await setup({ verifyDelegation: false });
    const plainLesson = await plain.standard();
    await expect(
      plain.attach(plainLesson, 'learner', plain.agent),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect((await plain.counts()).assets).toBe(0);
  });

  it('signing: only the printable copy is ever signed for an enrolled learner', async () => {
    const s = await setup();
    const lesson = await s.standard();
    const learnerCopy = await s.attach(lesson, 'learner');
    const keyCopy = await s.attach(lesson, 'guardian');
    const claims: Array<{ assetId: string }> = [];
    const submissions = new SubmissionService(
      s.db,
      ({ own, relationshipTypeId }) =>
        own || relationshipTypeId === s.f.guardianType.id,
      () => true,
      {
        storage: s.storage,
        signAsset: async (claim) => {
          claims.push(claim);
          return `https://school.test/${claim.assetId}`;
        },
      },
    );
    const enrollment = await s.f.as(s.f.parent, () =>
      s.f.service.enroll({
        ...s.f.parent,
        curriculumId: String(s.f.curriculum.id),
        courseId: lesson.release.releaseCourseId,
      }),
    );
    const request = {
      ...s.f.own,
      enrollmentId: String(enrollment.id),
      lessonId: lesson.lessonId,
    };
    const signed = await s.f.as(s.f.own, () =>
      submissions.signLessonPrintable({
        ...request,
        assetId: learnerCopy.assetId,
      }),
    );
    expect(signed.url).toContain(learnerCopy.assetId);
    await expect(
      s.f.as(s.f.own, () =>
        submissions.signLessonPrintable({
          ...request,
          assetId: keyCopy.assetId,
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    expect(claims.map((c) => c.assetId)).toEqual([learnerCopy.assetId]);
  });

  it('rollback: a failure after the bytes are written leaves no asset, file or row', async () => {
    const s = await setup();
    const lesson = await s.standard();
    const create = vi
      .spyOn(GeneratedPrintableCollection.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected failure'));
    await expect(s.attach(lesson, 'learner')).rejects.toThrow(
      'injected failure',
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(await s.counts()).toEqual({
      printables: 0,
      assets: 0,
      links: 0,
      files: 0,
    });
    // A retry uses a fresh asset and succeeds.
    const retry = await s.attach(lesson, 'learner');
    expect(retry.created).toBe(true);
    expect(await s.counts()).toEqual({
      printables: 1,
      assets: 1,
      links: 1,
      files: 1,
    });
  });

  it('concurrency: simultaneous first calls converge on one asset', async () => {
    const s = await setup();
    const lesson = await s.standard();
    const results = await Promise.all([
      s.attach(lesson, 'learner'),
      s.attach(lesson, 'learner'),
      s.attach(lesson, 'learner'),
    ]);
    expect(new Set(results.map((r) => r.assetId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await s.counts()).toEqual({
      printables: 1,
      assets: 1,
      links: 1,
      files: 1,
    });
  });

  it('concurrency: losing the unique-index race retries into a replay, no orphan', async () => {
    const s = await setup();
    const lesson = await s.standard();
    const winner = await s.attach(lesson, 'learner');
    // Simulate the loser: its existence check misses once (the winner's row is
    // hidden), then the insert collides with the winner's committed row.
    const winnerRow = String(
      (await s.db.get('generated_printables', { asset_id: winner.assetId }))
        ?.id,
    );
    const hide = (tx: DatabaseInterface, value: string) =>
      tx.update(
        'generated_printables',
        { id: winnerRow },
        { worksheet_version_id: value },
      );
    const internals = s.service as unknown as {
      lock: (...args: unknown[]) => Promise<void>;
    };
    const realLock = internals.lock.bind(s.service);
    let phase = 0;
    vi.spyOn(internals, 'lock').mockImplementation(async (...args) => {
      await realLock(...args);
      if (phase === 0 && args[1] === 'lessons') {
        phase = 1;
        await hide(args[0] as DatabaseInterface, 'hidden');
      }
    });
    const realCreate = GeneratedPrintableCollection.prototype.create;
    vi.spyOn(
      GeneratedPrintableCollection.prototype,
      'create',
    ).mockImplementation(async function (
      this: { db: DatabaseInterface },
      data: never,
    ) {
      if (phase === 1) {
        phase = 2;
        await hide(this.db, lesson.worksheetVersionId);
      }
      return realCreate.call(this as never, data);
    } as never);
    const result = await s.attach(lesson, 'learner');
    expect(phase).toBe(2);
    expect(result.assetId).toBe(winner.assetId);
    expect(result.created).toBe(false);
    expect(await s.counts()).toEqual({
      printables: 1,
      assets: 1,
      links: 1,
      files: 1,
    });
  });

  it('renderer: deterministic, WinAnsi-safe and capped', async () => {
    const s = await setup();
    const lesson = await s.standard();
    const learner = await s.attach(lesson, 'learner');
    const stored = await s.read(learner.assetId);
    const worksheet = await s.as(s.guardian, () =>
      s.service.getWorksheet({
        ...s.guardian,
        releaseId: lesson.release.id,
        lessonKey: 'ws',
        audience: 'learner',
      }),
    );
    if (worksheet.audience !== 'learner') throw new Error('expected learner');
    const again = await renderLearnerWorksheetPdf(
      worksheet,
      'Fraction worksheet',
    );
    expect(Buffer.from(again).equals(stored)).toBe(true);
    expect(
      Buffer.from(
        await renderLearnerWorksheetPdf(worksheet, 'Fraction worksheet'),
      ).equals(Buffer.from(again)),
    ).toBe(true);

    // Characters outside WinAnsi are replaced, not thrown on.
    const odd = await s.question(
      content({ prompt: 'Read 日本語 ✓ café \u{1F600} ok' }),
    );
    const oddLesson = await s.release([
      { questionRevisionId: odd.headRevisionId },
    ]);
    const oddResult = await s.attach(oddLesson, 'learner');
    const oddText = await pdfText(await s.read(oddResult.assetId));
    expect(oddText).toContain('Read ??? ? café ? ok');

    // Long prompts wrap onto further pages instead of overflowing.
    const long = await s.question(
      content({
        prompt: `${'word '.repeat(1500)}end`,
        responseType: 'extended',
      }),
    );
    const longLesson = await s.release([
      { questionRevisionId: long.headRevisionId },
    ]);
    const longResult = await s.attach(longLesson, 'learner');
    expect(
      (await PDFDocument.load(await s.read(longResult.assetId))).getPageCount(),
    ).toBeGreaterThan(1);

    // Caps are validation errors, never unbounded output.
    const item = worksheet.items[0];
    const bundle = (n: number) => ({
      ...worksheet,
      items: Array.from({ length: n }, () => item),
    });
    await expect(
      renderLearnerWorksheetPdf(bundle(MAX_PRINTABLE_ITEMS + 1), 't'),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    await expect(
      renderLearnerWorksheetPdf(
        {
          ...worksheet,
          items: [
            { ...item, prompt: 'x'.repeat(MAX_PRINTABLE_TEXT_LENGTH + 1) },
          ],
        },
        't',
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringValidationError);
    // The guardian renderer works from the keyed bundle, learner from the keyless one.
    void buildGuardianWorksheet;
    void buildLearnerWorksheet;
    void renderGuardianWorksheetPdf;
  });

  it('unconfigured: fails closed with a clear error and stores nothing', async () => {
    const s = await setup({ storage: false });
    const lesson = await s.standard();
    await expect(s.attach(lesson, 'learner')).rejects.toBeInstanceOf(
      PrintableStorageNotConfiguredError,
    );
    expect(await s.counts()).toEqual({
      printables: 0,
      assets: 0,
      links: 0,
      files: 0,
    });
  });
});
