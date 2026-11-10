import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  bundleOf,
  enroll,
  type Lesson,
  opened,
  setup,
} from './course-bundle-course-workflows.js';

/*
 * SMRT #4656: a lesson's materials carry the step they belong to; attach
 * records it, a supersede restates it, and listLessonSteps walks the lesson.
 */
beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

const KEY = 'class-crunchlabs:steps';
const V1 = 'aaaaaaaaaa1';
const V1B = 'aaaaaaaaaa2';
const V2 = 'aaaaaaaaaa3';
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

const lessonOf = (
  opts: { checkLabel?: string; dropV2?: boolean } = {},
): Lesson => ({
  key: 'lesson-1',
  title: 'Lesson 1',
  order: 1,
  members: [
    { path: 'l1/handout.pdf', role: 'handout', title: 'Worksheet' },
    { path: 'l1/log.docx', role: 'learner-pages', title: 'Mission Log' },
    {
      path: 'l1/deck.pptx',
      role: 'slides',
      audience: 'learner',
      title: 'Launch Deck',
      step: { key: 'launch', order: 0, label: 'Launch' },
    },
    { path: 'l1/guide.pdf', role: 'teacher-guide' },
    { path: 'l1/key.pdf', role: 'assessment-guidance' },
    {
      path: 'l1/worksheet.pdf',
      role: 'assessment',
      title: 'Status Check',
      step: {
        key: 'check',
        order: 9999,
        label: opts.checkLabel ?? 'Status check',
      },
    },
  ],
  // Declared out of order: the read model orders by step order, not by position.
  videos: [
    {
      reference: V1B,
      title: 'Build the ramp',
      step: { key: '1b', order: 1.02, label: 'Build the ramp' },
    },
    {
      reference: V1,
      title: 'Meet the ramp',
      step: { key: '1', order: 1, label: 'Meet the ramp' },
    },
    ...(opts.dropV2
      ? []
      : [
          {
            reference: V2,
            title: 'Adult prep',
            step: { key: '2', order: 2 },
            audience: 'guardian',
          },
        ]),
  ],
});
const lesson2: Lesson = {
  key: 'lesson-2',
  title: 'Lesson 2',
  order: 2,
  members: [{ path: 'l2/handout.pdf', role: 'handout' }],
};
const bundle = (opts: Parameters<typeof lessonOf>[0] = {}) =>
  bundleOf([lessonOf(opts), lesson2], { key: KEY });

async function attached() {
  const s = await setup();
  const { result, assets } = await s.importAndStore(bundle());
  const first = await s.attach(bundle(), result.import.importId, assets);
  const enrollmentId = await enroll(s, first.courseId);
  const lessonId = first.lessons['lesson-1'] as string;
  const lesson2Id = first.lessons['lesson-2'] as string;
  const steps = (actor = s.f.own, id = lessonId) =>
    s.f.as(actor, () =>
      s.submissions.listLessonSteps({ ...actor, enrollmentId, lessonId: id }),
    );
  const materials = () =>
    s.f.as(s.f.own, () =>
      s.submissions.listLessonMaterials({ ...s.f.own, enrollmentId, lessonId }),
    );
  return {
    s,
    result,
    assets,
    first,
    enrollmentId,
    lessonId,
    lesson2Id,
    steps,
    materials,
  };
}

describe('listLessonSteps', () => {
  it('orders a learner’s steps by order then key, groups halves, and keeps setup apart', async () => {
    const { steps } = await attached();
    const view = await steps();
    expect(view.steps.map((x) => [x.key, x.kind, x.order, x.label])).toEqual([
      ['launch', 'present', 0, 'Launch'],
      ['1', 'watch', 1, 'Meet the ramp'],
      ['1b', 'watch', 1.02, 'Build the ramp'],
      ['check', 'check', 9999, 'Status check'],
    ]);
    // The learner sees the rendered deck and assessment, never the editable originals.
    const launch = view.steps[0]?.materials ?? [];
    expect(launch.map((m) => [m.relationship, m.rendition])).toEqual([
      ['slides', 'rendered'],
    ]);
    expect(view.steps[1]?.materials[0]).toMatchObject({
      kind: 'external-video',
      videoId: V1,
      scope: 'lesson',
    });
    // Stepless learner material is setup; guides and guidance appear nowhere.
    expect(view.setup.map((m) => m.relationship).sort()).toEqual([
      'handout',
      'learner-pages',
    ]);
    const all = [...view.setup, ...view.steps.flatMap((x) => x.materials)];
    expect(
      all.some((m) =>
        ['teacher-guide', 'assessment-guidance'].includes(m.relationship),
      ),
    ).toBe(false);
    expect(all.some((m) => m.videoId === V2)).toBe(false);
  });

  it('shows a guardian the guardian-only steps and both halves of a pair, using the same views as listLessonMaterials', async () => {
    const { s, steps, materials, enrollmentId, lessonId } = await attached();
    const view = await steps(s.f.parent);
    expect(view.steps.map((x) => x.key)).toEqual([
      'launch',
      '1',
      '1b',
      '2',
      'check',
    ]);
    const two = view.steps.find((x) => x.key === '2');
    expect(two).toMatchObject({ kind: 'watch', label: '2', order: 2 });
    const launch = view.steps.find((x) => x.key === 'launch');
    expect(launch?.materials.map((m) => m.rendition).sort()).toEqual([
      'original',
      'rendered',
    ]);
    const [a, b] = launch?.materials ?? [];
    expect(a?.pairedMaterialId).toBe(b?.id);
    expect(view.setup.map((m) => m.relationship).sort()).toEqual([
      'handout',
      'learner-pages',
    ]);
    // Same view objects as the material list, id for id.
    const listed = await s.f.as(s.f.parent, () =>
      s.submissions.listLessonMaterials({
        ...s.f.parent,
        enrollmentId,
        lessonId,
      }),
    );
    for (const m of [...view.setup, ...view.steps.flatMap((x) => x.materials)])
      expect(listed).toContainEqual(m);
    void materials;
  });

  it('returns no steps for a lesson that declares none, and still checks the enrollment', async () => {
    const { s, steps, lesson2Id, enrollmentId } = await attached();
    const view = await steps(s.f.own, lesson2Id);
    expect(view.steps).toEqual([]);
    expect(view.setup.map((m) => m.relationship)).toEqual(['handout']);
    await expect(
      s.f.as(s.f.foreign, () =>
        s.submissions.listLessonSteps({
          ...s.f.foreign,
          enrollmentId,
          lessonId: lesson2Id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('records the step on attach, sharing it across both halves of a pair', async () => {
    const { s, lessonId, assets } = await attached();
    const rows = await s.db.list('lesson_assets', { lesson_id: lessonId });
    const deck = rows.filter(
      (r) =>
        r.asset_id === assets['l1/deck.pptx']?.original ||
        r.asset_id === assets['l1/deck.pptx']?.rendered,
    );
    expect(deck).toHaveLength(2);
    for (const r of deck)
      expect([r.step_key, Number(r.step_order), r.step_label]).toEqual([
        'launch',
        0,
        'Launch',
      ]);
    const handout = rows.find(
      (r) => r.asset_id === assets['l1/handout.pdf']?.original,
    );
    expect([handout?.step_key ?? null, handout?.step_order ?? null]).toEqual([
      null,
      null,
    ]);
    const videos = await s.db.list('lesson_external_videos', {
      lesson_id: lessonId,
    });
    const b = videos.find((v) => v.video_id === V1B);
    expect([b?.step_key, Number(b?.step_position), b?.step_label]).toEqual([
      '1b',
      1.02,
      'Build the ramp',
    ]);
    // The whole-number video rank stays the floor of the step order.
    expect(Number(b?.step_order)).toBe(1);
    const adult = videos.find((v) => v.video_id === V2);
    expect(adult?.step_label ?? null).toBeNull();
  });

  it('a re-attach is idempotent and fills missing step data without a conflict', async () => {
    const { s, result, assets, lessonId, steps } = await attached();
    const before = await steps();
    const again = await s.attach(bundle(), result.import.importId, assets);
    expect(again.updated ?? 0).toBe(0);
    expect(await steps()).toEqual(before);
    await s.db.query(
      `UPDATE lesson_assets SET step_key = NULL, step_order = NULL, step_label = NULL WHERE lesson_id = '${lessonId}'`,
    );
    await s.db.query(
      `UPDATE lesson_external_videos SET step_key = NULL, step_position = NULL, step_label = NULL WHERE lesson_id = '${lessonId}'`,
    );
    expect((await steps()).steps).toEqual([]);
    await s.attach(bundle(), result.import.importId, assets);
    expect(await steps()).toEqual(before);
  });

  it('a different step conflicts without a supersede, and a supersede restates it in place', async () => {
    const { s, assets, lessonId, steps, first } = await attached();
    const idsOf = async () =>
      (await s.db.list('lesson_assets', { lesson_id: lessonId }))
        .map((r) => String(r.id))
        .sort();
    const ids = await idsOf();
    await tick();
    const next = await s.importAndStore(
      bundle({ checkLabel: 'Mission check' }),
    );
    const reused = { ...next.assets };
    for (const path of Object.keys(reused))
      if (assets[path]) reused[path] = assets[path];
    await expect(
      s.attach(
        bundle({ checkLabel: 'Mission check' }),
        next.result.import.importId,
        reused,
      ),
    ).rejects.toThrow();
    const out = await s.attach(
      bundle({ checkLabel: 'Mission check' }),
      next.result.import.importId,
      reused,
      { supersede: true },
    );
    expect(out.courseId).toBe(first.courseId);
    expect(await idsOf()).toEqual(ids);
    expect((await steps()).steps.find((x) => x.key === 'check')?.label).toBe(
      'Mission check',
    );
  });

  it('leaves a step a newer build dropped out of the lesson, and brings it back when restored', async () => {
    const { s, assets, steps, lessonId } = await attached();
    expect((await steps(s.f.parent)).steps.map((x) => x.key)).toContain('2');
    await tick();
    const dropped = await s.importAndStore(bundle({ dropV2: true }));
    const reused = { ...dropped.assets };
    for (const path of Object.keys(reused))
      if (assets[path]) reused[path] = assets[path];
    await s.attach(
      bundle({ dropV2: true }),
      dropped.result.import.importId,
      reused,
      {
        supersede: true,
      },
    );
    const retired = await s.db.list('lesson_external_videos', {
      lesson_id: lessonId,
    });
    expect(retired.find((v) => v.video_id === V2)?.retired_at).toBeTruthy();
    expect((await steps(s.f.parent)).steps.map((x) => x.key)).toEqual([
      'launch',
      '1',
      '1b',
      'check',
    ]);
    await tick();
    const back = await s.importAndStore(bundle({ checkLabel: 'Check v3' }));
    const reusedBack = { ...back.assets };
    for (const path of Object.keys(reusedBack))
      if (assets[path]) reusedBack[path] = assets[path];
    await s.attach(
      bundle({ checkLabel: 'Check v3' }),
      back.result.import.importId,
      reusedBack,
      {
        supersede: true,
      },
    );
    expect((await steps(s.f.parent)).steps.map((x) => x.key)).toEqual([
      'launch',
      '1',
      '1b',
      '2',
      'check',
    ]);
  });

  it('a step of retired material is not listed (retired files)', async () => {
    const { s, steps, lessonId } = await attached();
    await s.db.query(
      `UPDATE lesson_assets SET retired_at = '2026-01-01T00:00:00.000Z' WHERE lesson_id = '${lessonId}' AND step_key = 'check'`,
    );
    expect((await steps()).steps.map((x) => x.key)).toEqual([
      'launch',
      '1',
      '1b',
    ]);
  });
});
