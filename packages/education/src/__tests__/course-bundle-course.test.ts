import { randomUUID } from 'node:crypto';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BUNDLE_COURSE_SOURCE,
  CourseAuthoringAuthorizationError,
  CourseBundleRefusedError,
  FakeDocumentConverter,
  type LessonMaterialView,
  parseBundleManifestV2,
} from '../index.js';
import {
  assertChooseDuringAttach,
  bundleOf,
  enroll,
  lesson1,
  lesson2,
  MIME,
  opened,
  setup,
  single,
  VIDEO_A,
  VIDEO_B,
} from './course-bundle-course-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

describe('attach', () => {
  it('creates one family course with lessons, materials, pages and videos, and replays', async () => {
    const s = await setup();
    const bundle = single();
    const { result, assets } = await s.importAndStore(bundle);
    const before = await s.counts();
    const attached = await s.attach(bundle, result.import.importId, assets);
    expect(attached).toMatchObject({
      created: true,
      replayed: false,
      unitKey: `bundle:${result.import.bundleIdentity}`,
      part: { index: 1, count: 1, attached: [1], complete: true },
      courseAssets: 1,
      // log (rendered), deck (original + rendered), guide, key, 2 handouts
      lessonAssets: 7,
      lessonPages: 2,
      lessonVideos: 2,
    });
    const course = await s.db.get('courses', { id: attached.courseId });
    expect(course).toMatchObject({
      tenant_id: s.guardian.tenantId,
      source_key: BUNDLE_COURSE_SOURCE,
      license_kind: 'personal-use-copy',
      status: 'draft',
      subject: 'Science',
    });
    const lessons = (await s.db.list('lessons', {})).filter((l) =>
      Object.values(attached.lessons).includes(String(l.id)),
    );
    expect(
      lessons.map((l) => [l.external_ref, l.sort_order, l.section_id]).sort(),
    ).toEqual([
      ['lesson-1', 1, attached.sections.unit],
      ['lesson-2', 2, attached.sections.unit],
    ]);
    // Videos keep their step order.
    const videos = (await s.db.list('lesson_external_videos', {}))
      .map((v) => [v.step_order, v.video_id])
      .sort();
    expect(videos).toEqual([
      [1, VIDEO_A],
      [2, VIDEO_B],
    ]);
    const view = await s.as(s.guardian, () =>
      s.service.readImport({ ...s.guardian, importId: result.import.importId }),
    );
    expect(view.attachment).toEqual({
      courseId: attached.courseId,
      unitKey: attached.unitKey,
      partIndex: 1,
      partCount: 1,
    });
    // A retry writes nothing new.
    const after = await s.counts();
    const again = await s.attach(bundle, result.import.importId, assets);
    expect(again).toMatchObject({
      courseId: attached.courseId,
      created: false,
      replayed: true,
      lessonAssets: 0,
      courseAssets: 0,
      lessonPages: 0,
      lessonVideos: 0,
    });
    expect(await s.counts()).toEqual(after);
    expect(after.courses).toBe(before.courses + 1);
  });

  it('authorizes the author and refuses another bundle, writing nothing', async () => {
    const s = await setup();
    const bundle = single();
    const { result, assets } = await s.importAndStore(bundle);
    const before = await s.counts();
    const stranger = { ...s.guardian, actorUserId: String(s.f.bob.user.id) };
    await expect(
      s.as(stranger, () =>
        s.service.attachCourse({
          ...stranger,
          importId: result.import.importId,
          bundle,
          assets,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    const { 'l2/handout.pdf': _gone, ...partial } = assets;
    await expect(
      s.attach(bundle, result.import.importId, partial),
    ).rejects.toMatchObject({ reason: 'asset-missing' });
    expect(await s.counts()).toEqual(before);
  });
});

describe('parts', () => {
  const KEY = 'class-crunchlabs:carnival';
  const part1 = () =>
    bundleOf([lesson1], {
      key: KEY,
      part: { index: 1, count: 2 },
      courseMembers: true,
    });
  const part2 = () =>
    bundleOf([lesson2], { key: KEY, part: { index: 2, count: 2 } });

  it('merges a unit split across bundles into one course, in any order', async () => {
    const s = await setup();
    const p1 = await s.importAndStore(part1());
    const p2 = await s.importAndStore(part2());
    // Part 2 first: it creates the course; part 1 joins it.
    const second = await s.attach(
      part2(),
      p2.result.import.importId,
      p2.assets,
    );
    expect(second).toMatchObject({
      created: true,
      unitKey: KEY,
      part: { index: 2, count: 2, attached: [2], complete: false },
    });
    const first = await s.attach(
      part1(),
      p1.result.import.importId,
      p1.assets,
      {
        courseId: second.courseId,
      },
    );
    expect(first).toMatchObject({
      courseId: second.courseId,
      created: false,
      part: { index: 1, count: 2, attached: [1, 2], complete: true },
    });
    expect(await s.count('courses')).toBe(3); // fixture course + other + this one
    const rows = (await s.db.list('lessons', {}))
      .filter((l) => String(l.section_id) === first.sections.unit)
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
    expect(rows.map((l) => l.title)).toEqual(['Lesson 1', 'Lesson 2']);
    expect(await s.count('course_sections')).toBe(3);
    expect(await s.count('course_bundle_attachments')).toBe(2);
    // Replaying either part changes nothing.
    const counts = await s.counts();
    await s.attach(part2(), p2.result.import.importId, p2.assets);
    await s.attach(part1(), p1.result.import.importId, p1.assets);
    expect(await s.counts()).toEqual(counts);
  });

  it('fails closed on another unit, another part count, or a second import of a part', async () => {
    const s = await setup();
    const p1 = await s.importAndStore(part1());
    const first = await s.attach(part1(), p1.result.import.importId, p1.assets);
    const before = await s.counts();

    // Another unit asserted onto this course.
    const otherUnit = bundleOf([lesson2], {
      key: 'class-crunchlabs:other',
      part: { index: 2, count: 2 },
    });
    const o = await s.importAndStore(otherUnit);
    await expect(
      s.attach(otherUnit, o.result.import.importId, o.assets, {
        courseId: first.courseId,
      }),
    ).rejects.toMatchObject({ reason: 'unit-mismatch' });

    // Same unit key, different part count.
    const recount = bundleOf([lesson2], {
      key: KEY,
      part: { index: 2, count: 3 },
    });
    const r = await s.importAndStore(recount);
    await expect(
      s.attach(recount, r.result.import.importId, r.assets),
    ).rejects.toMatchObject({ reason: 'unit-mismatch' });

    // A different import claiming part 1 again.
    const again = bundleOf([lesson1, lesson2], {
      key: KEY,
      part: { index: 1, count: 2 },
    });
    const a = await s.importAndStore(again);
    await expect(
      s.attach(again, a.result.import.importId, a.assets),
    ).rejects.toMatchObject({ reason: 'part-conflict' });
    expect(await s.counts()).toEqual(before);
  });

  it.each([
    ['part 1 first', false],
    ['part 2 first', true],
  ])('refuses parts that disagree on a shared section or lesson (%s)', async (_, reverse) => {
    const lessonB = { ...lesson2 };
    const variants = [
      // shared section, another title
      bundleOf([lessonB], {
        key: KEY,
        part: { index: 2, count: 2 },
        sectionTitle: 'Another unit',
      }),
      // shared section, another declared order
      bundleOf([lessonB], {
        key: KEY,
        part: { index: 2, count: 2 },
        sectionOrder: 4,
      }),
      // shared lesson, another title
      bundleOf(
        [lessonB, { key: 'lesson-1', title: 'Renamed', order: 1, members: [] }],
        {
          key: KEY,
          part: { index: 2, count: 2 },
        },
      ),
      // shared lesson, another declared order
      bundleOf(
        [
          lessonB,
          { key: 'lesson-1', title: 'Lesson 1', order: 9, members: [] },
        ],
        {
          key: KEY,
          part: { index: 2, count: 2 },
        },
      ),
    ];
    for (const bad of variants) {
      const s = await setup();
      const p1 = await s.importAndStore(part1());
      const p2 = await s.importAndStore(bad);
      const empty = await s.counts();
      const [first, second] = reverse
        ? [[bad, p2] as const, [part1(), p1] as const]
        : [[part1(), p1] as const, [bad, p2] as const];
      await s.attach(
        first[0],
        first[1].result.import.importId,
        first[1].assets,
      );
      const before = await s.counts();
      expect(before).not.toEqual(empty);
      await expect(
        s.attach(second[0], second[1].result.import.importId, second[1].assets),
      ).rejects.toMatchObject({ reason: 'part-conflict' });
      expect(await s.counts()).toEqual(before);
    }
  });

  it('requires a unit key for a part and parses unit-wide order', () => {
    const paths = new Set(['a.pdf']);
    const doc = (body: Record<string, unknown>) =>
      Buffer.from(
        JSON.stringify({
          version: 2,
          sections: [
            {
              key: 's',
              title: 'S',
              order: 3,
              lessons: [
                {
                  key: 'l',
                  title: 'L',
                  order: 7,
                  members: [{ path: 'a.pdf', role: 'handout' }],
                },
              ],
            },
          ],
          ...body,
        }),
      );
    expect(() =>
      parseBundleManifestV2(doc({ part: { index: 1, count: 2 } }), paths),
    ).toThrow(CourseBundleRefusedError);
    expect(() =>
      parseBundleManifestV2(
        doc({ course: { key: 'u' }, part: { index: 3, count: 2 } }),
        paths,
      ),
    ).toThrow(CourseBundleRefusedError);
    const parsed = parseBundleManifestV2(
      doc({
        course: { key: 'u', title: 'Unit' },
        part: { index: 2, count: 2 },
      }),
      paths,
    );
    expect(parsed.unit).toEqual({ key: 'u', title: 'Unit', part: 2, parts: 2 });
    expect(parsed.sections[0]?.order).toBe(3);
    expect(parsed.sections[0]?.lessons[0]?.order).toBe(7);
  });
});

describe('audience', () => {
  it('serializes a review choice made while an attach is in flight', async () => {
    await assertChooseDuringAttach();
  });

  it('applies review choices made before attach, within role bounds', async () => {
    const s = await setup();
    const bundle = single();
    const { result, assets } = await s.importAndStore(bundle);
    const importId = result.import.importId;
    const choose = (extra: Record<string, unknown>) =>
      s.as(s.guardian, () =>
        s.service.chooseMaterialAudience({
          ...s.guardian,
          importId,
          ...extra,
        } as never),
      );
    // Hide a handout and the intro video from the learner; show the guide.
    await choose({ path: 'l1/handout.pdf', audience: 'learner' });
    await choose({ path: 'l1/handout.pdf', audience: 'guardian' });
    await choose({ path: 'l1/guide.pdf', audience: 'learner' });
    await choose({
      video: { lessonKey: 'lesson-1', videoId: VIDEO_A },
      audience: 'guardian',
    });
    // Keys and guidance never become learner material; unknown paths are refused.
    await expect(
      choose({ path: 'l1/key.pdf', audience: 'learner' }),
    ).rejects.toMatchObject({ reason: 'invalid-audience' });
    await expect(
      choose({ path: 'nope.pdf', audience: 'learner' }),
    ).rejects.toMatchObject({ reason: 'invalid-audience' });
    const view = await s.as(s.guardian, () =>
      s.service.readImport({ ...s.guardian, importId }),
    );
    expect(view.audienceChoices).toEqual([
      {
        target: 'file:l1/guide.pdf',
        path: 'l1/guide.pdf',
        lessonKey: null,
        videoId: null,
        audience: 'learner',
      },
      {
        target: 'file:l1/handout.pdf',
        path: 'l1/handout.pdf',
        lessonKey: null,
        videoId: null,
        audience: 'guardian',
      },
      {
        target: `video:lesson-1:${VIDEO_A}`,
        path: null,
        lessonKey: 'lesson-1',
        videoId: VIDEO_A,
        audience: 'guardian',
      },
    ]);
    const attached = await s.attach(bundle, importId, assets);
    const joinOf = async (path: string) =>
      (await s.db.list('lesson_assets', {})).find(
        (r) => r.asset_id === assets[path]?.original,
      );
    expect((await joinOf('l1/handout.pdf'))?.audience).toBe('guardian');
    expect((await joinOf('l1/guide.pdf'))?.audience).toBe('learner');
    expect((await joinOf('l1/key.pdf'))?.audience).toBe('guardian');
    expect(
      (await s.db.list('lesson_external_videos', {})).find(
        (v) => v.video_id === VIDEO_A,
      )?.audience,
    ).toBe('guardian');
    // After attach, choices are closed: the material itself changes instead.
    await expect(
      choose({ path: 'l1/handout.pdf', audience: 'learner' }),
    ).rejects.toMatchObject({ reason: 'already-attached' });
    expect(attached.created).toBe(true);
  });

  it('changes audience after attach, never opening an original or a key to the learner', async () => {
    const s = await setup();
    const bundle = single();
    const { result, assets } = await s.importAndStore(bundle);
    const attached = await s.attach(bundle, result.import.importId, assets);
    const enrollmentId = await enroll(s, attached.courseId);
    const lessonId = attached.lessons['lesson-1'] as string;
    const list = (actor: typeof s.f.parent | typeof s.f.own) =>
      s.f.as(actor, () =>
        s.submissions.listLessonMaterials({ ...actor, enrollmentId, lessonId }),
      );
    const guardianView = await list(s.f.parent);
    const handout = guardianView.find(
      (m) => m.assetId === assets['l1/handout.pdf']?.original,
    ) as LessonMaterialView;
    const original = guardianView.find(
      (m) => m.assetId === assets['l1/deck.pptx']?.original,
    ) as LessonMaterialView;
    const set = (materialId: string, audience: 'learner' | 'guardian') =>
      s.f.as(s.f.parent, () =>
        s.submissions.setMaterialAudience({
          ...s.f.parent,
          enrollmentId,
          scope: 'lesson',
          kind: 'file',
          materialId,
          audience,
        }),
      );
    expect((await set(handout.id, 'guardian')).audience).toBe('guardian');
    await expect(set(original.id, 'learner')).rejects.toThrow(
      'Invalid material audience',
    );
    const learnerIds = (await list(s.f.own)).map((m) => m.assetId);
    expect(learnerIds).not.toContain(assets['l1/handout.pdf']?.original);
    // A replayed attach keeps the family's later choice.
    await s.attach(bundle, result.import.importId, assets);
    expect((await list(s.f.own)).map((m) => m.assetId)).not.toContain(
      assets['l1/handout.pdf']?.original,
    );
  });
});

describe('views', () => {
  it('a learner never sees guardian material; views carry MIME, rendition, pairing and thumbnail', async () => {
    const s = await setup();
    const bundle = single();
    const { result, assets } = await s.importAndStore(bundle);
    const deck = result.accepted.find((m) => m.path === 'l1/deck.pptx');
    expect(deck?.rendered?.thumbnail).toMatchObject({
      mediaType: 'image/png',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const attached = await s.attach(bundle, result.import.importId, assets);
    const enrollmentId = await enroll(s, attached.courseId);
    const lessonId = attached.lessons['lesson-1'] as string;
    const guardian = await s.f.as(s.f.parent, () =>
      s.submissions.listLessonMaterials({
        ...s.f.parent,
        enrollmentId,
        lessonId,
      }),
    );
    const byAsset = (id?: string) =>
      guardian.find((m) => m.assetId === id) as LessonMaterialView;
    const original = byAsset(assets['l1/deck.pptx']?.original);
    const rendered = byAsset(assets['l1/deck.pptx']?.rendered);
    expect(original).toMatchObject({
      relationship: 'slides',
      audience: 'guardian',
      rendition: 'original',
      mimeType: MIME.pptx,
      pairedMaterialId: rendered.id,
      thumbnailAssetId: null,
    });
    expect(rendered).toMatchObject({
      relationship: 'slides',
      audience: 'learner',
      rendition: 'rendered',
      mimeType: 'application/pdf',
      pairedMaterialId: original.id,
      thumbnailAssetId: assets['l1/deck.pptx']?.thumbnail,
    });
    expect(byAsset(assets['l1/guide.pdf']?.original)).toMatchObject({
      rendition: null,
      mimeType: 'application/pdf',
      pairedMaterialId: null,
    });
    const videos = guardian.filter((m) => m.kind === 'external-video');
    expect(videos.map((v) => [v.order, v.videoId, v.mimeType])).toEqual([
      [1, VIDEO_A, null],
      [2, VIDEO_B, null],
    ]);

    const learner = await s.f.as(s.f.own, () =>
      s.submissions.listLessonMaterials({ ...s.f.own, enrollmentId, lessonId }),
    );
    expect(learner.every((m) => m.audience === 'learner')).toBe(true);
    const learnerAssets = learner.map((m) => m.assetId);
    for (const hidden of [
      assets['l1/deck.pptx']?.original,
      assets['l1/guide.pdf']?.original,
      assets['l1/key.pdf']?.original,
    ])
      expect(learnerAssets).not.toContain(hidden);
    // The learner's rendered deck is not paired with the hidden original.
    expect(
      learner.find((m) => m.assetId === assets['l1/deck.pptx']?.rendered),
    ).toMatchObject({ rendition: 'rendered', pairedMaterialId: null });
    // Learners cannot sign guardian material by id, even its thumbnail.
    await expect(
      s.f.as(s.f.own, () =>
        s.submissions.signLessonMaterial({
          ...s.f.own,
          enrollmentId,
          lessonId,
          materialId: original.id,
        }),
      ),
    ).rejects.toThrow();
    await s.f.as(s.f.own, () =>
      s.submissions.signLessonMaterial({
        ...s.f.own,
        enrollmentId,
        lessonId,
        materialId: rendered.id,
        thumbnail: true,
      }),
    );
    expect(s.claims).toEqual([assets['l1/deck.pptx']?.thumbnail]);
    const course = await s.f.as(s.f.own, () =>
      s.submissions.listCourseMaterials({ ...s.f.own, enrollmentId }),
    );
    expect(course).toMatchObject([
      {
        title: 'Supply list',
        mimeType: 'application/pdf',
        rendition: null,
        thumbnailAssetId: null,
      },
    ]);
  });

  it('drops an unusable thumbnail rather than failing the member', async () => {
    const s = await setup({
      converter: new FakeDocumentConverter({
        thumbnail: Buffer.from('not an image'),
      }),
    });
    const { result } = await s.importAndStore(single());
    const deck = result.accepted.find((m) => m.path === 'l1/deck.pptx');
    expect(deck?.rendered).toMatchObject({ thumbnail: null });
  });
});

describe('zero renderings', () => {
  it('attaches without a converter: Office members are skipped, nothing is faked', async () => {
    const s = await setup({ converter: null });
    const bundle = single();
    const { result, assets } = await s.importAndStore(bundle);
    expect(
      result.import.members
        .filter((m) => m.kind === 'docx' || m.kind === 'pptx')
        .map((m) => [m.status, m.reason, m.renderedSha256]),
    ).toEqual([
      ['unsupported', 'converter_unavailable', null],
      ['unsupported', 'converter_unavailable', null],
    ]);
    expect(result.accepted.every((m) => m.rendered === null)).toBe(true);
    const attached = await s.attach(bundle, result.import.importId, assets);
    expect(attached.skipped.map((x) => [x.path, x.reason]).sort()).toEqual([
      ['l1/deck.pptx', 'converter_unavailable'],
      ['l1/log.docx', 'converter_unavailable'],
    ]);
    // guide, key, two handouts; no deck, no log, no pages over a missing rendering
    expect(attached).toMatchObject({ lessonAssets: 4, lessonPages: 0 });
    const rows = await s.db.list('lesson_assets', {});
    expect(rows.every((r) => !r.rendition && !r.thumbnail_asset_id)).toBe(true);
    expect(rows.map((r) => r.relationship)).not.toContain('slides');
  });
});
