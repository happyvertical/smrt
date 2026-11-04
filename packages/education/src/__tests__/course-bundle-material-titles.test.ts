import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AcceptedCourseBundleMember } from '../index.js';
import {
  bundleOf,
  enroll,
  type Lesson,
  opened,
  setup,
} from './course-bundle-course-workflows.js';

/*
 * SMRT #4653: the manifest's material title is recorded on the material row,
 * restated by a supersede, shown by the material views and handed to the host.
 */
beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

const KEY = 'class-crunchlabs:titles';
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const lessonOf = (handoutTitle: string): Lesson => ({
  key: 'lesson-1',
  title: 'Lesson 1',
  order: 1,
  members: [
    {
      path: 'l1/log.docx',
      role: 'learner-pages',
      title: 'Student Mission Log',
    },
    {
      path: 'l1/deck.pptx',
      role: 'slides',
      audience: 'learner',
      title: 'Mission Launch Deck',
    },
    {
      path: 'l1/guide.pdf',
      role: 'teacher-guide',
      title: 'Teacher Mission Manual',
    },
    { path: 'l1/key.pdf', role: 'assessment-guidance' },
    { path: 'l1/handout.pdf', role: 'handout', title: handoutTitle },
  ],
});
const bundle = (handoutTitle = 'Mission Worksheet') =>
  bundleOf([lessonOf(handoutTitle)], { key: KEY, courseMembers: true });

async function attached() {
  const s = await setup();
  const received: AcceptedCourseBundleMember[] = [];
  const result = await s.as(s.guardian, () =>
    s.service.importBundle({
      ...s.guardian,
      bundle: bundle(),
      receiveMember: (member) => {
        received.push(member);
      },
    }),
  );
  const assets = await s.store(result.accepted);
  const first = await s.attach(bundle(), result.import.importId, assets);
  const enrollmentId = await enroll(s, first.courseId);
  const lessonId = first.lessons['lesson-1'] as string;
  const materials = () =>
    s.f.as(s.f.own, () =>
      s.submissions.listLessonMaterials({ ...s.f.own, enrollmentId, lessonId }),
    );
  return {
    s,
    received,
    result,
    assets,
    first,
    enrollmentId,
    lessonId,
    materials,
  };
}

describe('material titles', () => {
  it('hands the manifest title to receiveMember, none when the manifest gave none', async () => {
    const { received } = await attached();
    const titleOf = (path: string) => received.find((m) => m.path === path);
    expect(titleOf('l1/guide.pdf')?.title).toBe('Teacher Mission Manual');
    expect(titleOf('l1/deck.pptx')?.title).toBe('Mission Launch Deck');
    expect(titleOf('l1/log.docx')?.title).toBe('Student Mission Log');
    expect(titleOf('unit/supplies.pdf')?.title).toBe('Supply list');
    expect(titleOf('l1/handout.pdf')?.title).toBe('Mission Worksheet');
    expect(titleOf('l1/key.pdf')).toBeDefined();
    expect(titleOf('l1/key.pdf')).not.toHaveProperty('title');
  });

  it('records titles at attach and shows them instead of the stored file name', async () => {
    const { s, materials, lessonId, assets } = await attached();
    const rows = await s.db.list('lesson_assets', { lesson_id: lessonId });
    const byAsset = new Map(rows.map((r) => [String(r.asset_id), r]));
    expect(byAsset.get(assets['l1/guide.pdf']?.original as string)?.title).toBe(
      'Teacher Mission Manual',
    );
    // No manifest title: stored as null, shown by asset name.
    expect(
      byAsset.get(assets['l1/key.pdf']?.original as string)?.title,
    ).toBeNull();

    const views = await materials();
    const log = views.filter((v) => v.relationship === 'learner-pages');
    expect(log.length).toBeGreaterThan(0);
    for (const v of views.filter((v) => v.kind === 'file')) {
      expect(v.title).not.toMatch(/\.(pdf|docx|pptx)/);
    }
    // The original and rendered halves share the title.
    const deck = views.filter((v) => v.relationship === 'slides');
    expect(deck.map((v) => v.title)).toEqual(
      deck.map(() => 'Mission Launch Deck'),
    );
    expect(log.map((v) => v.title)).toEqual(
      log.map(() => 'Student Mission Log'),
    );
  });

  it('falls back to the asset name for rows without a title', async () => {
    const { s, materials, lessonId, assets } = await attached();
    await s.db.query(
      `UPDATE lesson_assets SET title = NULL WHERE lesson_id = '${lessonId}'`,
    );
    const views = await materials();
    const handout = views.find(
      (v) => v.assetId === assets['l1/handout.pdf']?.original,
    );
    expect(handout?.title).toBe('l1/handout.pdf');
  });

  it('shows course material titles, falling back for an empty one', async () => {
    const { s, first, enrollmentId } = await attached();
    const list = () =>
      s.f.as(s.f.own, () =>
        s.submissions.listCourseMaterials({ ...s.f.own, enrollmentId }),
      );
    expect((await list()).map((v) => v.title)).toEqual(['Supply list']);
    await s.db.query(
      `UPDATE course_assets SET title = '' WHERE course_id = '${first.courseId}'`,
    );
    expect((await list()).map((v) => v.title)).toEqual(['unit/supplies.pdf']);
  });

  it('a supersede renames a material in place, and revives a retired row with the new title', async () => {
    const { s, result, assets, lessonId, materials, first } = await attached();
    const idOf = async () =>
      new Map(
        (await s.db.list('lesson_assets', { lesson_id: lessonId })).map((r) => [
          String(r.asset_id),
          String(r.id),
        ]),
      );
    const before = await idOf();
    await tick();
    const next = await s.importAndStore(bundle('Worksheet v2'));
    const reused = { ...next.assets };
    for (const path of Object.keys(reused))
      if (assets[path]) reused[path] = assets[path];
    const out = await s.attach(
      bundle('Worksheet v2'),
      next.result.import.importId,
      reused,
      { supersede: true },
    );
    expect(out.updated ?? 0).toBeGreaterThan(0);
    expect(await idOf()).toEqual(before);
    const guide = (await materials()).find(
      (v) => v.assetId === assets['l1/handout.pdf']?.original,
    );
    expect(guide?.title).toBe('Worksheet v2');
    expect(first.courseId).toBe(out.courseId);

    // A row a newer build dropped and a later one brings back is current and retitled.
    await tick();
    const dropped = await s.importAndStore(
      bundleOf(
        [
          {
            ...lessonOf('x'),
            members: lessonOf('x').members.filter(
              (m) => m.path !== 'l1/handout.pdf',
            ),
          },
        ],
        { key: KEY, courseMembers: true },
      ),
    );
    const dr = { ...dropped.assets };
    for (const path of Object.keys(dr))
      if (assets[path]) dr[path] = assets[path];
    await s.attach(
      bundleOf(
        [
          {
            ...lessonOf('x'),
            members: lessonOf('x').members.filter(
              (m) => m.path !== 'l1/handout.pdf',
            ),
          },
        ],
        { key: KEY, courseMembers: true },
      ),
      dropped.result.import.importId,
      dr,
      { supersede: true },
    );
    expect(
      (await materials()).some(
        (v) => v.assetId === assets['l1/handout.pdf']?.original,
      ),
    ).toBe(false);
    await tick();
    const back = await s.importAndStore(bundle('Worksheet v3'));
    const br = { ...back.assets };
    for (const path of Object.keys(br))
      if (assets[path]) br[path] = assets[path];
    await s.attach(bundle('Worksheet v3'), back.result.import.importId, br, {
      supersede: true,
    });
    const revived = (await materials()).find(
      (v) => v.assetId === assets['l1/handout.pdf']?.original,
    );
    expect(revived?.title).toBe('Worksheet v3');
    expect(result.import.importId).not.toBe(back.result.import.importId);
  });

  it('fills a missing title on a re-attach without a conflict', async () => {
    const { s, result, assets, lessonId } = await attached();
    await s.db.query(
      `UPDATE lesson_assets SET title = NULL WHERE lesson_id = '${lessonId}'`,
    );
    await s.attach(bundle(), result.import.importId, assets);
    const rows = await s.db.list('lesson_assets', { lesson_id: lessonId });
    expect(
      rows.find((r) => r.asset_id === assets['l1/handout.pdf']?.original)
        ?.title,
    ).toBe('Mission Worksheet');
  });
});
