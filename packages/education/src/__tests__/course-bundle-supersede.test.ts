import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CourseAuthoringAuthorizationError } from '../index.js';
import {
  bundleOf,
  enroll,
  type Lesson,
  lesson1,
  lesson2,
  opened,
  setup,
} from './course-bundle-course-workflows.js';

/*
 * SMRT #4645: `attachCourse({ supersede: true })` brings an attached unit up
 * to a newer build of the same unit, keeping identity and learner progress.
 */
beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

const KEY = 'class-crunchlabs:carnival';
const part = (index: number, count = 2) => ({
  key: KEY,
  part: { index, count },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

// 0.60.0: bare titles. 0.60.1: real titles, a new worksheet instead of the handout.
const old1 = () => bundleOf([lesson1], { ...part(1), courseMembers: true });
const old2 = () => bundleOf([lesson2], part(2));
const lesson1New: Lesson = {
  ...lesson1,
  title: 'Lesson 1: The Anchor',
  members: [
    ...lesson1.members.filter((m) => m.path !== 'l1/handout.pdf'),
    { path: 'l1/worksheet.pdf', role: 'handout' },
  ],
};
const lesson2New: Lesson = { ...lesson2, title: 'Lesson 2: Weight & Motion' };
const new1 = () => bundleOf([lesson1New], { ...part(1), courseMembers: true });
const new2 = () => bundleOf([lesson2New], part(2));

type S = Awaited<ReturnType<typeof setup>>;
type Assets = Record<
  string,
  { original?: string; rendered?: string; thumbnail?: string }
>;

/** A host stores a path once per content hash: unchanged paths reuse their asset. */
async function newerBuild(
  s: S,
  bundle: ReturnType<typeof bundleOf>,
  earlier: Assets,
) {
  await tick();
  const built = await s.importAndStore(bundle);
  const assets: Assets = { ...built.assets };
  for (const path of Object.keys(assets))
    if (earlier[path]) assets[path] = earlier[path] as Assets[string];
  return { importId: built.result.import.importId, assets };
}

async function attachedUnit() {
  const s = await setup();
  const a = await s.importAndStore(old1());
  const b = await s.importAndStore(old2());
  const first = await s.attach(old1(), a.result.import.importId, a.assets);
  await s.attach(old2(), b.result.import.importId, b.assets);
  const enrollmentId = await enroll(s, first.courseId);
  const lessonId = first.lessons['lesson-1'] as string;
  await s.f.as(s.f.own, () =>
    s.f.service.startLesson({ ...s.f.own, enrollmentId, lessonId }),
  );
  return { s, a, b, first, enrollmentId, lessonId };
}

describe('supersede', () => {
  it('brings an attached, started unit up to a newer build and keeps progress', async () => {
    const { s, a, b, first, enrollmentId, lessonId } = await attachedUnit();
    const progressBefore = await s.db.list('lesson_progress', {});
    expect(progressBefore.length).toBeGreaterThan(0);
    const lessonRows = async () =>
      (await s.db.list('lessons', {}))
        .filter((l) => Object.values(first.lessons).includes(String(l.id)))
        .map((l) => [String(l.id), l.title, l.external_ref]);
    const before = await lessonRows();

    const n1 = await newerBuild(s, new1(), a.assets);
    const result = await s.attach(new1(), n1.importId, n1.assets, {
      supersede: true,
    });
    expect(result).toMatchObject({
      courseId: first.courseId,
      created: false,
      replayed: false,
      superseded: { importId: a.result.import.importId, partIndex: 1 },
      renamed: 1,
      // the worksheet is new; every unchanged path reuses its asset
      lessonAssets: 1,
      retired: { lessonAssets: 1, courseAssets: 0, lessonVideos: 0 },
      part: { index: 1, count: 2, attached: [1, 2], complete: true },
    });
    // Identity by key: same ids, new title.
    expect(result.lessons['lesson-1']).toBe(lessonId);
    const after = await lessonRows();
    expect(after.map((r) => [r[0], r[2]])).toEqual(
      before.map((r) => [r[0], r[2]]),
    );
    expect(after.map((r) => r[1])).toEqual(['Lesson 1: The Anchor']);
    // Progress and enrolment are untouched.
    expect(await s.db.list('lesson_progress', {})).toEqual(progressBefore);
    // The part belongs to the newer import; the audit says which replaced which.
    const attachments = await s.db.list('course_bundle_attachments', {
      course_id: first.courseId,
    });
    expect(attachments.map((r) => [r.part_index, r.import_id]).sort()).toEqual([
      [1, n1.importId],
      [2, b.result.import.importId],
    ]);
    expect(
      await s.db.list('course_bundle_supersessions', {
        course_id: first.courseId,
      }),
    ).toMatchObject([
      {
        import_id: n1.importId,
        superseded_import_id: a.result.import.importId,
        part_index: 1,
        unit_key: KEY,
      },
    ]);
    const view = await s.as(s.guardian, () =>
      s.service.readImport({ ...s.guardian, importId: n1.importId }),
    );
    expect(view.attachment).toMatchObject({ partIndex: 1, partCount: 2 });

    // The dropped handout is retired, not deleted; its asset still resolves.
    const handout = a.assets['l1/handout.pdf']?.original as string;
    const retired = (
      await s.db.list('lesson_assets', { lesson_id: lessonId })
    ).find((r) => r.asset_id === handout);
    expect(retired?.retired_at).toBeTruthy();
    expect(await s.db.get('assets', { id: handout })).toBeTruthy();
    const learner = await s.f.as(s.f.own, () =>
      s.submissions.listLessonMaterials({ ...s.f.own, enrollmentId, lessonId }),
    );
    expect(learner.map((m) => m.assetId)).not.toContain(handout);
    expect(learner.map((m) => m.assetId)).toContain(
      n1.assets['l1/worksheet.pdf']?.original,
    );
    expect(learner.map((m) => m.assetId)).toContain(
      a.assets['l1/log.docx']?.rendered,
    );

    // The second part follows; a replay of either changes nothing.
    const n2 = await newerBuild(s, new2(), b.assets);
    const second = await s.attach(new2(), n2.importId, n2.assets, {
      supersede: true,
    });
    expect(second).toMatchObject({
      renamed: 1,
      retired: { lessonAssets: 0, courseAssets: 0, lessonVideos: 0 },
      superseded: { importId: b.result.import.importId, partIndex: 2 },
    });
    const courseLessons = (await s.db.list('lessons', {}))
      .filter((l) => l.section_id === second.sections.unit)
      .sort((x, y) => Number(x.sort_order) - Number(y.sort_order));
    expect(courseLessons.map((l) => l.title)).toEqual([
      'Lesson 1: The Anchor',
      'Lesson 2: Weight & Motion',
    ]);
    const snapshot = async () => ({
      counts: await s.counts(),
      assets: await s.db.list('lesson_assets', {}),
      lessons: await s.db.list('lessons', {}),
      placements: await s.db.list('course_bundle_placements', {}),
      supersessions: await s.db.list('course_bundle_supersessions', {}),
    });
    const settled = await snapshot();
    for (const [bundle, built] of [
      [new1(), n1],
      [new2(), n2],
    ] as const) {
      const again = await s.attach(bundle, built.importId, built.assets, {
        supersede: true,
      });
      expect(again).toMatchObject({
        replayed: true,
        superseded: null,
        renamed: 0,
        lessonAssets: 0,
        courseAssets: 0,
        lessonVideos: 0,
        retired: { lessonAssets: 0, courseAssets: 0, lessonVideos: 0 },
      });
    }
    expect(await snapshot()).toEqual(settled);
  });

  it('does not let an older build overwrite a newer one', async () => {
    const { s, a, first } = await attachedUnit();
    const n1 = await newerBuild(s, new1(), a.assets);
    await s.attach(new1(), n1.importId, n1.assets, { supersede: true });
    const before = {
      counts: await s.counts(),
      lessons: await s.db.list('lessons', {}),
      assets: await s.db.list('lesson_assets', {}),
    };
    await expect(
      s.attach(old1(), a.result.import.importId, a.assets, { supersede: true }),
    ).rejects.toMatchObject({ reason: 'stale-build' });
    // Without the opt-in the old import is still just a part-conflict.
    await expect(
      s.attach(old1(), a.result.import.importId, a.assets),
    ).rejects.toMatchObject({ reason: 'part-conflict' });
    expect({
      counts: await s.counts(),
      lessons: await s.db.list('lessons', {}),
      assets: await s.db.list('lesson_assets', {}),
    }).toEqual(before);
    expect((await s.db.list('course_bundle_supersessions', {})).length).toBe(1);
    expect(first.courseId).toBeTruthy();
  });

  it('refuses a part count change even with supersede', async () => {
    const { s } = await attachedUnit();
    const recount = bundleOf([lesson1New], {
      ...part(1, 3),
      courseMembers: true,
    });
    await tick();
    const r = await s.importAndStore(recount);
    const before = await s.counts();
    await expect(
      s.attach(recount, r.result.import.importId, r.assets, {
        supersede: true,
      }),
    ).rejects.toMatchObject({ reason: 'unit-mismatch' });
    expect(await s.counts()).toEqual(before);
  });

  it('without supersede a newer build is still a part-conflict and changes nothing', async () => {
    const { s, a } = await attachedUnit();
    const n1 = await newerBuild(s, new1(), a.assets);
    const before = {
      counts: await s.counts(),
      lessons: await s.db.list('lessons', {}),
      placements: await s.db.list('course_bundle_placements', {}),
    };
    await expect(
      s.attach(new1(), n1.importId, n1.assets),
    ).rejects.toMatchObject({ reason: 'part-conflict' });
    expect({
      counts: await s.counts(),
      lessons: await s.db.list('lessons', {}),
      placements: await s.db.list('course_bundle_placements', {}),
    }).toEqual(before);
    expect(await s.db.list('course_bundle_supersessions', {})).toEqual([]);
  });

  it('keeps the attach authorization', async () => {
    const { s, a } = await attachedUnit();
    const n1 = await newerBuild(s, new1(), a.assets);
    const stranger = { ...s.guardian, actorUserId: String(s.f.bob.user.id) };
    await expect(
      s.as(stranger, () =>
        s.service.attachCourse({
          ...stranger,
          importId: n1.importId,
          bundle: new1(),
          assets: n1.assets,
          supersede: true,
        }),
      ),
    ).rejects.toBeInstanceOf(CourseAuthoringAuthorizationError);
    expect(await s.db.list('course_bundle_supersessions', {})).toEqual([]);
  });

  it('retires dropped course materials and videos, and revives them if they return', async () => {
    const s = await setup();
    const withVideos = (title: string): Lesson => ({
      ...lesson1,
      title,
      members: lesson1.members,
    });
    const v1 = bundleOf([withVideos('Lesson 1')], {
      key: KEY,
      courseMembers: true,
    });
    const a = await s.importAndStore(v1);
    await s.attach(v1, a.result.import.importId, a.assets);
    // The newer build has no supplies list and one video fewer.
    const lean: Lesson = {
      ...lesson1,
      title: 'Lesson 1: The Anchor',
      members: lesson1.members.filter((m) => m.path !== 'l1/handout.pdf'),
      videos: lesson1.videos?.slice(1),
    };
    const v2 = bundleOf([lean], { key: KEY });
    const n = await newerBuild(s, v2, a.assets);
    const result = await s.attach(v2, n.importId, n.assets, {
      supersede: true,
    });
    expect(result.retired).toEqual({
      lessonAssets: 1,
      courseAssets: 1,
      lessonVideos: 1,
    });
    expect(
      (await s.db.list('course_assets', {})).every((r) => r.retired_at),
    ).toBe(true);
    expect(
      (await s.db.list('lesson_external_videos', {})).filter(
        (r) => r.retired_at,
      ),
    ).toHaveLength(1);
    // C brings the materials back; D drops them again and they retire again.
    const lessonId = result.lessons['lesson-1'] as string;
    const handout = a.assets['l1/handout.pdf']?.original as string;
    const build = (title: string, full: boolean) =>
      full
        ? bundleOf([{ ...withVideos(title) }], {
            key: KEY,
            courseMembers: true,
          })
        : bundleOf([{ ...lean, title }], { key: KEY });
    const step = async (title: string, full: boolean) => {
      const bundle = build(title, full);
      const built = await newerBuild(s, bundle, a.assets);
      return s.attach(bundle, built.importId, built.assets, {
        supersede: true,
      });
    };
    const current = async () => ({
      assets: (await s.db.list('course_assets', {})).filter(
        (r) => !r.retired_at,
      ).length,
      handout: (
        await s.db.list('lesson_assets', { lesson_id: lessonId })
      ).filter((r) => r.asset_id === handout && !r.retired_at).length,
      videos: (await s.db.list('lesson_external_videos', {})).filter(
        (r) => !r.retired_at,
      ).length,
    });
    const revived = await step('Lesson 1: The Anchor (C)', true);
    expect(revived.retired).toEqual({
      lessonAssets: 0,
      courseAssets: 0,
      lessonVideos: 0,
    });
    expect(await current()).toEqual({ assets: 1, handout: 1, videos: 2 });
    const dropped = await step('Lesson 1: The Anchor (D)', false);
    expect(dropped.retired).toEqual({
      lessonAssets: 1,
      courseAssets: 1,
      lessonVideos: 1,
    });
    expect(await current()).toEqual({ assets: 0, handout: 0, videos: 1 });
    const enrollmentId = await enroll(s, result.courseId);
    const learner = await s.f.as(s.f.own, () =>
      s.submissions.listLessonMaterials({ ...s.f.own, enrollmentId, lessonId }),
    );
    expect(learner.map((m) => m.assetId)).not.toContain(handout);
    expect(
      learner.filter((m) => m.kind === 'external-video').map((m) => m.videoId),
    ).toHaveLength(1);
  });
});
