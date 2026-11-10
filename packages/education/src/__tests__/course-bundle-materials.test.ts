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
  type AcceptedCourseBundleMember,
  COURSE_AUTHORING_ACTIONS,
  type CourseAuthoringAction,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseBundleImportService,
  CourseBundleMaterialsError,
  CourseBundleNotFoundError,
  createOfficeTextReader,
  DocumentConversionError,
  FakeDocumentConverter,
} from '../index.js';
import { tinyPdf } from './bundle-zip-writer.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';
import { officeDocx, officePptx, officeXlsx } from './office-fixtures.js';

/*
 * Manifest v2 through the service (#4615), see docs/test-matrix/4615-manifest-v2.md:
 *  slides deck + rendered pages, roles/audience on the hand-off .. 'hand-off'
 *  LessonAsset / CourseAsset / LessonPage / LessonExternalVideo ... 'apply'
 *  deliberate, idempotent retry of a failed rendering ............ 'retry'
 *  SDK Office reader adapter ...................................... 'reader'
 */
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
  'CourseBundleImport',
  'CourseBundleMember',
  'CourseBundleRendering',
];

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

const VIDEO = 'dQw4w9WgXcQ';
const manifest = {
  version: 2,
  course: { subject: 'Science' },
  courseMembers: [
    { path: 'unit/supplies.pdf', role: 'attachment', title: 'Supply list' },
  ],
  sections: [
    {
      key: 'unit',
      title: 'Unit',
      lessons: [
        {
          key: 'l1',
          title: 'Lesson 1',
          members: [
            { path: 'l1/log.docx', role: 'learner-pages' },
            { path: 'l1/deck.pptx', role: 'slides' },
            { path: 'l1/guide.pdf', role: 'teacher-guide' },
            { path: 'l1/key.pdf', role: 'assessment-guidance' },
          ],
          pages: [{ member: 'l1/log.docx', from: 1, to: 2, label: 'Log' }],
          videos: [{ reference: VIDEO, title: 'Recap', step: 1 }],
        },
        {
          key: 'l2',
          title: 'Lesson 2',
          members: [{ path: 'l2/handout.pdf', role: 'handout' }],
        },
      ],
    },
  ],
};
const bundle = (override: Record<string, unknown> = manifest) => ({
  files: [
    { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(override)) },
    { path: 'l1/log.docx', bytes: officeDocx('mission log') },
    { path: 'l1/deck.pptx', bytes: officePptx('launch deck') },
    { path: 'l1/guide.pdf', bytes: tinyPdf('guide') },
    { path: 'l1/key.pdf', bytes: tinyPdf('key') },
    { path: 'l2/handout.pdf', bytes: tinyPdf('handout') },
    { path: 'unit/supplies.pdf', bytes: tinyPdf('supplies') },
  ],
});

async function setup(options: { converter?: FakeDocumentConverter } = {}) {
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
  const reader: CourseAuthoringActor = {
    tenantId: f.own.tenantId,
    actorUserId: String(f.bob.user.id),
  };
  const grants = new Map<string, CourseAuthoringAction[]>([
    [guardian.actorUserId, [...COURSE_AUTHORING_ACTIONS]],
    [reader.actorUserId, ['education.course.read-draft']],
  ]);
  const authorizer: CourseAuthoringAuthorizer = (call) =>
    (grants.get(call.actorUserId) ?? []).includes(call.action);
  const converter = options.converter ?? new FakeDocumentConverter();
  const service = new CourseBundleImportService(db, authorizer, { converter });
  const as = <T>(actor: CourseAuthoringActor, fn: () => Promise<T>) =>
    withTenant({ tenantId: actor.tenantId, userId: actor.actorUserId }, fn);
  const profile = String(
    (await db.get('users', { id: guardian.actorUserId }))?.profile_id,
  );
  const asset = async (
    name: string,
    access: 'private' | 'public' = 'private',
  ) => {
    const id = randomUUID();
    const create = async () =>
      (await AssetCollection.create({ db })).create({
        id,
        tenantId: guardian.tenantId,
        name,
        accessMode: access,
        ownerProfileId: profile,
        sourceUri: `file:///education/${id}.pdf`,
      });
    await as(guardian, () =>
      access === 'private'
        ? withPrivateAssetAccess(
            {
              tenantId: guardian.tenantId,
              actorUserId: guardian.actorUserId,
              ownerProfileId: profile,
              assetIds: [id],
            },
            create,
          )
        : create(),
    );
    return id;
  };
  const importBundle = (
    input = bundle(),
    extra: Record<string, unknown> = {},
    actor = guardian,
    target = service,
  ) =>
    as(actor, () => target.importBundle({ ...actor, bundle: input, ...extra }));
  const count = async (table: string) => (await db.list(table, {})).length;
  const lessons = {
    l1: String(f.lesson.id),
    l2: String(f.secondLesson.id),
  };
  return {
    db,
    f,
    guardian,
    reader,
    converter,
    service,
    as,
    asset,
    importBundle,
    count,
    lessons,
    courseId: String(f.course.id),
  };
}

/** Store every accepted member as private assets, like a host's `receiveMember`. */
async function storeAll(
  s: Awaited<ReturnType<typeof setup>>,
  accepted: AcceptedCourseBundleMember[],
) {
  const assets: Record<string, { original?: string; rendered?: string }> = {};
  for (const member of accepted)
    assets[member.path] = {
      original: await s.asset(member.path),
      ...(member.rendered
        ? { rendered: await s.asset(`${member.path}.pdf`) }
        : {}),
    };
  return assets;
}

describe('manifest v2 hand-off', () => {
  it('keeps the slide deck as the original and as rendered pages, with role and audience', async () => {
    const s = await setup();
    const { import: view, accepted, materials } = await s.importBundle();
    expect(view).toMatchObject({
      readerId: 'manifest-v2',
      manifestVersion: 2,
      acceptedCount: 6,
      unsupportedCount: 0,
    });
    const deck = accepted.find((m) => m.path === 'l1/deck.pptx');
    expect(deck).toMatchObject({
      kind: 'pptx',
      role: 'slides',
      audience: 'guardian',
      courseLevel: false,
      lessonKey: 'l1',
      sectionKey: 'unit',
    });
    // Original (Open in PowerPoint) and rendered pages (Present).
    expect(deck?.bytes.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(deck?.rendered?.bytes ?? []).toString()).toContain(
      '%PDF-',
    );
    const byPath = (p: string) => accepted.find((m) => m.path === p);
    expect(byPath('l1/log.docx')).toMatchObject({
      role: 'learner-pages',
      audience: 'learner',
    });
    expect(byPath('l1/key.pdf')).toMatchObject({
      role: 'assessment-guidance',
      audience: 'guardian',
    });
    expect(byPath('unit/supplies.pdf')).toMatchObject({
      role: 'attachment',
      courseLevel: true,
      lessonKey: null,
    });
    expect(view.members.find((m) => m.path === 'l1/key.pdf')).toMatchObject({
      role: 'assessment-guidance',
      audience: 'guardian',
    });
    expect(materials.pages.map((p) => p.pageKey)).toEqual(['p1', 'p2']);
    expect(materials.videos).toHaveLength(1);
  });

  it('never puts guardian-audience text or Office text into a proposal', async () => {
    const s = await setup();
    const { import: view } = await s.importBundle();
    expect(view.members.every((m) => m.audience !== undefined)).toBe(true);
  });
});

describe('Excel course members', () => {
  it('renders a workbook as a course member and never offers it to the text reader', async () => {
    const s = await setup();
    const read: string[] = [];
    const service = new CourseBundleImportService(s.db, () => true, {
      converter: s.converter,
      officeTextReader: {
        read: async ({ kind }) => {
          read.push(kind);
          return null;
        },
      },
    });
    const withSheet = bundle({
      ...manifest,
      courseMembers: [
        {
          path: 'unit/supplies.xlsx',
          role: 'attachment',
          title: 'Supply list',
        },
      ],
    });
    withSheet.files.push({
      path: 'unit/supplies.xlsx',
      bytes: officeXlsx('supplies'),
    });
    const { accepted, import: view } = await s.importBundle(
      withSheet,
      {},
      s.guardian,
      service,
    );
    const sheet = accepted.find((m) => m.kind === 'xlsx');
    expect(sheet).toMatchObject({
      courseLevel: true,
      role: 'attachment',
      audience: 'learner',
    });
    expect(Buffer.from(sheet?.rendered?.bytes ?? []).toString()).toContain(
      '%PDF-',
    );
    expect(view.members.find((m) => m.kind === 'xlsx')?.renderedSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(read.sort()).toEqual(['docx', 'pptx']);
    expect(s.converter.calls.some((c) => c.fileName === 'document.xlsx')).toBe(
      true,
    );
  });
});

describe('applying materials', () => {
  async function applied() {
    const s = await setup();
    const { import: view, accepted } = await s.importBundle();
    const assets = await storeAll(s, accepted);
    const request = {
      ...s.guardian,
      importId: view.importId,
      bundle: bundle(),
      courseId: s.courseId,
      lessons: s.lessons,
      assets,
    };
    const apply = (
      override: Record<string, unknown> = {},
      actor = s.guardian,
    ) =>
      s.as(actor, () =>
        s.service.applyMaterials({ ...request, ...actor, ...override }),
      );
    return { s, view, assets, request, apply };
  }

  it('writes course members, lesson materials, pages and videos', async () => {
    const { s, assets, apply } = await applied();
    const result = await apply();
    expect(result).toMatchObject({
      courseAssets: 1,
      // l1: log (rendered), deck (original + rendered), guide, key; l2: handout
      lessonAssets: 6,
      lessonPages: 2,
      lessonVideos: 1,
      unchanged: 0,
    });
    const course = await s.db.list('course_assets', {});
    expect(course).toHaveLength(1);
    expect(course[0]).toMatchObject({
      relationship: 'attachment',
      audience: 'learner',
      title: 'Supply list',
      asset_id: assets['unit/supplies.pdf']?.original,
    });
    const rows = (await s.db.list('lesson_assets', {})) as Array<
      Record<string, unknown>
    >;
    const forLesson = (lesson: string, role: string) =>
      rows
        .filter(
          (r) =>
            r.lesson_id === s.lessons[lesson as 'l1'] &&
            r.relationship === role,
        )
        .map((r) => r.asset_id)
        .sort();
    // Slides keep both the original deck and the rendered pages.
    expect(forLesson('l1', 'slides')).toEqual(
      [
        assets['l1/deck.pptx']?.original,
        assets['l1/deck.pptx']?.rendered,
      ].sort(),
    );
    // Another Office member joins only its rendered PDF, never the editable original.
    expect(forLesson('l1', 'learner-pages')).toEqual([
      assets['l1/log.docx']?.rendered,
    ]);
    expect(forLesson('l1', 'teacher-guide')).toEqual([
      assets['l1/guide.pdf']?.original,
    ]);
    expect(
      rows
        .filter(
          (r) =>
            r.relationship === 'assessment-guidance' ||
            r.relationship === 'teacher-guide' ||
            r.relationship === 'slides',
        )
        .every((r) => r.audience === 'guardian'),
    ).toBe(true);
    expect(rows.find((r) => r.relationship === 'handout')).toMatchObject({
      lesson_id: s.lessons.l2,
      audience: 'learner',
    });
    const pages = (await s.db.list('lesson_pages', {})) as Array<
      Record<string, unknown>
    >;
    expect(
      pages
        .map((p) => [
          p.page_key,
          p.label,
          p.source_page_number,
          p.source_asset_id,
          p.course_id,
        ])
        .sort(),
    ).toEqual([
      ['p1', 'Log 1', 1, assets['l1/log.docx']?.rendered, s.courseId],
      ['p2', 'Log 2', 2, assets['l1/log.docx']?.rendered, s.courseId],
    ]);
    expect(await s.db.list('lesson_external_videos', {})).toMatchObject([
      {
        provider: 'youtube',
        video_id: VIDEO,
        title: 'Recap',
        step_order: 1,
        audience: 'learner',
        lesson_id: s.lessons.l1,
      },
    ]);
  });

  it('is idempotent: a second apply changes nothing', async () => {
    const { s, apply } = await applied();
    await apply();
    const before = [
      await s.count('course_assets'),
      await s.count('lesson_assets'),
      await s.count('lesson_pages'),
      await s.count('lesson_external_videos'),
    ];
    const again = await apply();
    expect(again).toMatchObject({
      courseAssets: 0,
      lessonAssets: 0,
      lessonPages: 0,
      lessonVideos: 0,
      unchanged: 10,
    });
    expect([
      await s.count('course_assets'),
      await s.count('lesson_assets'),
      await s.count('lesson_pages'),
      await s.count('lesson_external_videos'),
    ]).toEqual(before);
  });

  it('refuses a conflicting row without writing anything new', async () => {
    const { s, apply } = await applied();
    await apply();
    await s.db.query(
      `UPDATE lesson_external_videos SET title = 'Edited by hand'`,
    );
    await s.db.query(`DELETE FROM lesson_pages WHERE page_key = 'p2'`);
    await expect(apply()).rejects.toMatchObject({
      reason: 'conflict',
      entry: `l1:${VIDEO}`,
    });
    // all or nothing: the deleted page was not re-created by the failed call
    expect(await s.count('lesson_pages')).toBe(1);
  });

  it('is all or nothing when an asset is missing', async () => {
    const { s, assets, apply } = await applied();
    const { 'l2/handout.pdf': _removed, ...rest } = assets;
    await expect(apply({ assets: rest })).rejects.toMatchObject({
      reason: 'asset-missing',
      entry: 'l2/handout.pdf',
    });
    expect(await s.count('lesson_assets')).toBe(0);
    expect(await s.count('course_assets')).toBe(0);
    const noRendering = {
      ...assets,
      'l1/deck.pptx': { original: assets['l1/deck.pptx']?.original },
    };
    await expect(apply({ assets: noRendering })).rejects.toMatchObject({
      reason: 'asset-missing',
    });
    expect(await s.count('lesson_assets')).toBe(0);
  });

  it('requires private assets for guardian-only material', async () => {
    const { s, assets, apply } = await applied();
    const publicAsset = await s.asset('public key', 'public');
    await expect(
      apply({
        assets: {
          ...assets,
          'l1/key.pdf': { original: publicAsset },
        },
      }),
    ).rejects.toThrow('private');
    expect(await s.count('lesson_assets')).toBe(0);
  });

  it('refuses a lesson that is not in the course, an authored course and unknown lessons', async () => {
    const { s, apply } = await applied();
    await expect(
      apply({ lessons: { ...s.lessons, l2: String(s.f.wrongLesson.id) } }),
    ).rejects.toMatchObject({ reason: 'lesson-missing', entry: 'l2' });
    await expect(
      apply({ lessons: { l1: s.lessons.l1 } }),
    ).rejects.toMatchObject({
      reason: 'lesson-missing',
      entry: 'l2',
    });
    await expect(apply({ courseId: randomUUID() })).rejects.toMatchObject({
      reason: 'course-not-found',
    });
    await s.db.query(`UPDATE courses SET source_key = 'authored'`);
    await expect(apply()).rejects.toMatchObject({ reason: 'authored-course' });
    expect(await s.count('lesson_assets')).toBe(0);
    expect(CourseBundleMaterialsError).toBeDefined();
  });

  it('authorizes the actor and checks the bundle is the imported one', async () => {
    const { s, apply } = await applied();
    await expect(apply({}, s.reader)).rejects.toBeInstanceOf(
      CourseAuthoringAuthorizationError,
    );
    const other = bundle();
    other.files.push({ path: 'extra.pdf', bytes: tinyPdf('extra') });
    await expect(apply({ bundle: other })).rejects.toBeInstanceOf(
      CourseBundleNotFoundError,
    );
    expect(await s.count('lesson_assets')).toBe(0);
  });

  it('skips members that could not be rendered rather than half-applying them', async () => {
    const converter = new FakeDocumentConverter({
      failWhen: (r) => r.kind === 'pptx',
    });
    const s = await setup({ converter });
    const { import: view, accepted } = await s.importBundle();
    const assets = await storeAll(s, accepted);
    const result = await s.as(s.guardian, () =>
      s.service.applyMaterials({
        ...s.guardian,
        importId: view.importId,
        bundle: bundle(),
        courseId: s.courseId,
        lessons: s.lessons,
        assets,
      }),
    );
    expect(result.skipped).toEqual([
      { path: 'l1/deck.pptx', reason: 'converter_rejected' },
    ]);
    const roles = (await s.db.list('lesson_assets', {})).map(
      (r) => r.relationship,
    );
    expect(roles).not.toContain('slides');
  });
});

describe('learner-audience slides', () => {
  it('give the learner only the rendered pages: the editable original join is always guardian-only, and old joins are repaired', async () => {
    const s = await setup();
    const shown = structuredClone(manifest) as typeof manifest;
    const deck = shown.sections[0]?.lessons[0]?.members.find(
      (m) => m.role === 'slides',
    ) as { audience?: string } | undefined;
    if (deck) deck.audience = 'learner';
    const input = () => bundle(shown);
    const { import: view, accepted } = await s.importBundle(input());
    const assets = await storeAll(s, accepted);
    const apply = () =>
      s.as(s.guardian, () =>
        s.service.applyMaterials({
          ...s.guardian,
          importId: view.importId,
          bundle: input(),
          courseId: s.courseId,
          lessons: s.lessons,
          assets,
        }),
      );
    await apply();
    const slides = async () =>
      (await s.db.list('lesson_assets', {})).filter(
        (r) => r.relationship === 'slides',
      );
    const audienceOf = async (id?: string) =>
      (await slides()).find((r) => r.asset_id === id)?.audience;
    expect(await audienceOf(assets['l1/deck.pptx']?.original)).toBe('guardian');
    expect(await audienceOf(assets['l1/deck.pptx']?.rendered)).toBe('learner');
    // a join written before this rule is repaired on re-apply, not left learner-visible
    await s.db.query(
      `UPDATE lesson_assets SET audience = 'learner' WHERE asset_id = '${assets['l1/deck.pptx']?.original}'`,
    );
    const again = await apply();
    expect(again.repaired).toBe(1);
    expect(await audienceOf(assets['l1/deck.pptx']?.original)).toBe('guardian');
    expect((await apply()).repaired).toBe(0);
  });
});

describe('repairing an original deck join', () => {
  it.each([
    [
      'sortOrder',
      "UPDATE lesson_assets SET sort_order = 99, audience = 'learner' WHERE asset_id = '%ORIG%'",
    ],
    [
      'title',
      "UPDATE course_assets SET title = 'Edited', audience = 'learner'",
    ],
  ])('conflicts, changing nothing (audience included), when a wrong audience comes with a conflicting %s', async (kind, sql) => {
    const s = await setup();
    const shown = structuredClone(manifest) as typeof manifest;
    const { import: view, accepted } = await s.importBundle(bundle(shown));
    const assets = await storeAll(s, accepted);
    const apply = () =>
      s.as(s.guardian, () =>
        s.service.applyMaterials({
          ...s.guardian,
          importId: view.importId,
          bundle: bundle(shown),
          courseId: s.courseId,
          lessons: s.lessons,
          assets,
        }),
      );
    await apply();
    const original = assets['l1/deck.pptx']?.original as string;
    if (kind === 'title') {
      // a course-level join that is not an original must conflict on its title alone
      await s.db.query(sql);
    } else await s.db.query(sql.replace('%ORIG%', original));
    const snapshot = async () => ({
      lesson: await s.db.list('lesson_assets', {}),
      course: await s.db.list('course_assets', {}),
    });
    const before = await snapshot();
    await expect(apply()).rejects.toMatchObject({ reason: 'conflict' });
    expect(await snapshot()).toEqual(before);
  });
});

describe('retrying a failed rendering', () => {
  /** A converter that is down until `up.value` is true. */
  function flaky() {
    const state = { up: false, calls: 0 };
    const converter = new FakeDocumentConverter({
      failWhen: () => {
        state.calls++;
        return false;
      },
    });
    const inner = converter.convertToPdf.bind(converter);
    converter.convertToPdf = async (request) => {
      if (!state.up) {
        state.calls++;
        throw new DocumentConversionError('unavailable');
      }
      return inner(request);
    };
    return { state, converter };
  }
  async function afterOutage() {
    const { state, converter } = flaky();
    const s = await setup({ converter });
    const first = await s.importBundle();
    return { s, state, converter, first };
  }
  const retry = (
    s: Awaited<ReturnType<typeof setup>>,
    importId: string,
    extra: Record<string, unknown> = {},
    actor = s.guardian,
  ) =>
    s.as(actor, () =>
      s.service.retryRendering({
        ...actor,
        importId,
        bundle: bundle(),
        ...extra,
      }),
    );

  it('renders the members that failed, records it once, and hands them to the host', async () => {
    const { s, state, first } = await afterOutage();
    expect(first.import).toMatchObject({
      acceptedCount: 4,
      unsupportedCount: 2,
    });
    expect(
      first.import.members
        .filter((m) => m.status === 'unsupported')
        .map((m) => [m.path, m.reason]),
    ).toEqual([
      ['l1/log.docx', 'converter_failed'],
      ['l1/deck.pptx', 'converter_failed'],
    ]);
    state.up = true;
    const received: string[] = [];
    const result = await retry(s, first.import.importId, {
      receiveMember: (m: AcceptedCourseBundleMember) =>
        void received.push(m.path),
    });
    expect(result.retried.map((r) => [r.path, r.outcome]).sort()).toEqual(
      [
        ['l1/deck.pptx', 'rendered'],
        ['l1/log.docx', 'rendered'],
        ['l1/guide.pdf', 'unchanged'],
        ['l1/key.pdf', 'unchanged'],
        ['l2/handout.pdf', 'unchanged'],
        ['manifest.json', 'unchanged'],
        ['unit/supplies.pdf', 'unchanged'],
      ].sort(),
    );
    expect(result.import).toMatchObject({
      acceptedCount: 6,
      unsupportedCount: 0,
    });
    const deck = result.import.members.find((m) => m.path === 'l1/deck.pptx');
    expect(deck).toMatchObject({ status: 'accepted', reason: null });
    expect(deck?.renderedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.accepted.map((m) => m.path).sort()).toEqual([
      'l1/deck.pptx',
      'l1/log.docx',
    ]);
    expect(received.sort()).toEqual(['l1/deck.pptx', 'l1/log.docx']);
    expect(
      result.accepted.find((m) => m.path === 'l1/deck.pptx'),
    ).toMatchObject({
      role: 'slides',
      audience: 'guardian',
      rendered: { mediaType: 'application/pdf' },
    });
    expect(await s.count('course_bundle_renderings')).toBe(2);
    // The first import's member rows are untouched (append-only evidence).
    const row = await s.db.get('course_bundle_members', {
      import_id: first.import.importId,
      path: 'l1/deck.pptx',
    });
    expect(row).toMatchObject({
      status: 'unsupported',
      reason: 'converter_failed',
    });
  });

  it('is idempotent: a second retry renders and records nothing more', async () => {
    const { s, state, converter, first } = await afterOutage();
    state.up = true;
    await retry(s, first.import.importId);
    const calls = state.calls;
    const again = await retry(s, first.import.importId);
    expect(again.retried.every((r) => r.outcome === 'unchanged')).toBe(true);
    expect(again.accepted).toEqual([]);
    expect(state.calls).toBe(calls);
    expect(await s.count('course_bundle_renderings')).toBe(2);
    expect(converter).toBeDefined();
  });

  it('is seen by a replayed import, which hands the repaired members over', async () => {
    const { s, state, first } = await afterOutage();
    state.up = true;
    await retry(s, first.import.importId);
    const replay = await s.importBundle();
    expect(replay.import).toMatchObject({ replayed: true, acceptedCount: 6 });
    expect(replay.accepted.map((m) => m.kind).sort()).toEqual([
      'docx',
      'pdf',
      'pdf',
      'pdf',
      'pdf',
      'pptx',
    ]);
  });

  it('records nothing when the converter is still down, so asking again is allowed', async () => {
    const { s, state, first } = await afterOutage();
    const failed = await retry(s, first.import.importId);
    expect(failed.retried.filter((r) => r.outcome === 'failed')).toHaveLength(
      2,
    );
    expect(failed.retried.find((r) => r.path === 'l1/deck.pptx')?.reason).toBe(
      'converter_failed',
    );
    expect(await s.count('course_bundle_renderings')).toBe(0);
    state.up = true;
    const ok = await retry(s, first.import.importId);
    expect(ok.retried.filter((r) => r.outcome === 'rendered')).toHaveLength(2);
  });

  it('can be limited to named members', async () => {
    const { s, state, first } = await afterOutage();
    state.up = true;
    const one = await retry(s, first.import.importId, {
      paths: ['l1/deck.pptx'],
    });
    expect(one.retried).toEqual([
      { path: 'l1/deck.pptx', outcome: 'rendered', reason: null },
    ]);
    expect(one.import).toMatchObject({ acceptedCount: 5, unsupportedCount: 1 });
  });

  it('does not retry what the converter rejected or a limit refused', async () => {
    const converter = new FakeDocumentConverter({
      failWhen: (r) => r.kind === 'pptx',
    });
    const s = await setup({ converter });
    const first = await s.importBundle();
    const result = await retry(s, first.import.importId, {
      paths: ['l1/deck.pptx'],
    });
    expect(result.retried).toEqual([
      {
        path: 'l1/deck.pptx',
        outcome: 'unchanged',
        reason: 'converter_rejected',
      },
    ]);
    expect(converter.calls.filter((c) => c.kind === 'pptx')).toHaveLength(1);
    expect(await s.count('course_bundle_renderings')).toBe(0);
  });

  it('collapses identical copies: the first reads accepted, the rest duplicates', async () => {
    const { state, converter } = flaky();
    const s = await setup({ converter });
    const copies = bundle();
    copies.files.push({
      path: 'l1/log-copy.docx',
      bytes: officeDocx('mission log'),
    });
    const first = await s.importBundle(copies);
    expect(first.import.unsupportedCount).toBe(3);
    state.up = true;
    const result = await s.as(s.guardian, () =>
      s.service.retryRendering({
        ...s.guardian,
        importId: first.import.importId,
        bundle: copies,
      }),
    );
    const log = result.import.members.filter((m) => m.kind === 'docx');
    expect(log.map((m) => [m.path, m.status])).toEqual([
      ['l1/log.docx', 'accepted'],
      ['l1/log-copy.docx', 'duplicate'],
    ]);
    expect(log[1]?.duplicateOfPath).toBe('l1/log.docx');
    expect(await s.count('course_bundle_renderings')).toBe(2);
  });

  it('needs a converter, the author grant and the imported bundle', async () => {
    const { s, state, first } = await afterOutage();
    state.up = true;
    await expect(
      retry(s, first.import.importId, {}, s.reader),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    await expect(
      retry(s, first.import.importId, {
        bundle: { files: bundle().files.slice(1) },
      }),
    ).rejects.toBeInstanceOf(CourseBundleNotFoundError);
    await expect(retry(s, randomUUID())).rejects.toBeInstanceOf(
      CourseBundleNotFoundError,
    );
    const bare = new CourseBundleImportService(s.db, () => true);
    await expect(
      s.as(s.guardian, () =>
        bare.retryRendering({
          ...s.guardian,
          importId: first.import.importId,
          bundle: bundle(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(await s.count('course_bundle_renderings')).toBe(0);
  });
});

describe('the SDK Office reader adapter', () => {
  const bytes = new Uint8Array([1]);
  it('flattens Word headings and reads slides with their speaker notes', async () => {
    const docx = createOfficeTextReader(async (_b, format) => {
      expect(format).toBe('docx');
      return {
        status: 'ok',
        parts: [
          { content: 'Intro', parts: [{ content: 'Nested' }] },
          { content: '  ' },
          { content: 'Outro' },
        ],
      };
    });
    expect(await docx.read({ bytes, kind: 'docx' })).toEqual({
      text: 'Intro\n\nNested\n\nOutro',
    });
    const requests: unknown[] = [];
    const pptx = createOfficeTextReader(async (_b, _f, options) => {
      requests.push(options);
      return {
        status: 'ok',
        parts: [
          {
            content: 'Title slide',
            notes: ' Say hello ',
            metadata: { slide: 1 },
          },
          { content: 'Second', metadata: {} },
        ],
      };
    });
    expect(await pptx.read({ bytes, kind: 'pptx' })).toEqual({
      text: 'Title slide\n\nSecond',
      slides: [
        { index: 1, text: 'Title slide', notes: 'Say hello' },
        { index: 2, text: 'Second' },
      ],
    });
    expect(requests).toEqual([{ extractImages: false }]);
  });

  it('reads as null without an engine and rejects on a corrupt file (the importer swallows both)', async () => {
    const none = createOfficeTextReader(async () => ({
      status: 'unsupported',
    }));
    expect(await none.read({ bytes, kind: 'docx' })).toBeNull();
    const broken = createOfficeTextReader(async () => {
      throw new Error('corrupt');
    });
    await expect(broken.read({ bytes, kind: 'pptx' })).rejects.toThrow(
      'corrupt',
    );
    const s = await setup();
    const service = new CourseBundleImportService(s.db, () => true, {
      converter: new FakeDocumentConverter(),
      officeTextReader: broken,
    });
    const { accepted } = await s.importBundle(
      bundle(),
      {},
      s.guardian,
      service,
    );
    expect(accepted.find((m) => m.kind === 'pptx')?.officeText).toBeNull();
  });
});
