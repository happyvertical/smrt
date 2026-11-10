import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addClassCrunchLabsUnit,
  buildClassCrunchLabsBundle,
  type CatalogActor,
  CatalogPolicy,
  type CatalogSourceRecord,
  CLASS_CRUNCHLABS_LICENSE_PENDING,
  CLASS_CRUNCHLABS_PROVIDER_ID,
  CLASS_CRUNCHLABS_PUBLIC_LISTING_DEFAULT,
  ClassCrunchLabsError,
  type ClassCrunchLabsPlaylist,
  CourseBundleImportService,
  canAddClassCrunchLabsUnit,
  classCrunchLabsPreviewEmbedUrl,
  classCrunchLabsStepOrder,
  classCrunchLabsUnitOfPlaylist,
  createClassCrunchLabsCatalogAdapter,
  createClassCrunchLabsPageCounter,
  FakeDocumentConverter,
  matchClassCrunchLabsVideos,
  memoryClassCrunchLabsSource,
  parseClassCrunchLabsVideoName,
  parsePlaylistItemTitle,
  pickUnitPlaylist,
  planCourseBundle,
  readFileSet,
} from '../index.js';
import { folderClassCrunchLabsSource } from '../node.js';
import { buildZip, tinyPdf } from './bundle-zip-writer.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';
import { officeDocx, officePptx, officeXlsx } from './office-fixtures.js';

/*
 * Class CrunchLabs source (#4616), see docs/test-matrix/4616-class-crunchlabs.md.
 * Every fixture is synthetic: tiny generated files named like a unit download.
 * No test reads the real download or the network; the playlist is injected.
 */
const ROOT = 'Marble Run Unit Material (Motion)_Class CrunchLabs';
const WIDE = `${ROOT}/Marble Run_All Unit Wide Materials`;
const L1 = `${ROOT}/Marble Run_Lesson 1`;
const L2 = `${ROOT}/Marble Run_Lesson 2`;

type Entry = { path: string; bytes: Uint8Array; exportId?: string };
/** A synthetic unit with the lettered layout. Identical labels give identical bytes. */
function unitFiles(exportId = '20261102T000000Z'): Entry[] {
  const e = (path: string, bytes: Uint8Array): Entry => ({
    path,
    bytes,
    exportId,
  });
  return [
    e(
      `${WIDE}/A. Marble Run_Teacher Mission Manual (all lessons)/Unit Wide Teacher Mission Manual_ALL INCLUSIVE_Marble Run_v1.0.pdf`,
      tinyPdf('wide manual'),
    ),
    e(
      `${WIDE}/A. Marble Run_Teacher Mission Manual (all lessons)/B. Class CrunchLabs_ Teacher Handbook_v1.0.docx`,
      officeDocx('handbook'),
    ),
    e(
      `${WIDE}/B. Marble Run_Unit Mission Launch Deck Slides (all lessons)/Marble Run_Unit-Wide Mission Launch Deck Slides (all lessons)_v1.1_.pptx`,
      officePptx('wide deck'),
    ),
    e(
      `${WIDE}/C. Marble Run_Student Mission Log (all lessons)/Unit WideStudent Mission Log_Marble Run v.1.1.docx`,
      officeDocx('wide log'),
    ),
    e(
      `${WIDE}/D. Marble Run_Assessments (all lessons)/Unit Wide Assessment Guidance_Marble Run_v1.0.pdf`,
      tinyPdf('wide guidance'),
    ),
    e(
      `${WIDE}/D. Marble Run_Assessments (all lessons)/Unit Wide Status Checks (Editable)_Marble Run_v1.0.docx`,
      officeDocx('wide checks'),
    ),
    e(
      `${WIDE}/D. Marble Run_Assessments (all lessons)/Unit Wide Status Checks_Marble Run_v1.0.pdf`,
      tinyPdf('wide checks pdf'),
    ),
    e(
      `${WIDE}/E. Marble Run_Handouts (all lessons)/Unit Wide Handouts_Marble Run_v1.0.pdf`,
      tinyPdf('wide handouts'),
    ),
    e(
      `${WIDE}/F. Other Materials (all lessons)/L02_Trading Cards_Marble Run_v1.0.pdf`,
      tinyPdf('cards'),
    ),
    e(
      `${WIDE}/F. Other Materials (all lessons)/SQIREL Poster_18x24_Marble Run_v1.0.pdf`,
      tinyPdf('poster'),
    ),
    e(`${WIDE}/Supply List_Marble Run_v1.0.xlsx`, officeXlsx('supplies')),
    e(`${WIDE}/Marble Run_UnitTeaserVideo.mp4`, Buffer.from('mp4')),
    e(
      `${WIDE}/G. Marble Run_Videos (all lessons)/L01.2_Video_AnchorCheckIn_Marble Run.mp4`,
      Buffer.from('v'),
    ),
    e(
      `${WIDE}/G. Marble Run_Videos (all lessons)/L01.4_Video_MaterialsPrep_Ramps_Marble  Run.mp4`,
      Buffer.from('v'),
    ),
    e(
      `${WIDE}/G. Marble Run_Videos (all lessons)/L01.4_Video_StudentHandsOnExploration_Ramps_Marble Run.mp4`,
      Buffer.from('v'),
    ),
    e(
      `${WIDE}/G. Marble Run_Videos (all lessons)/L02.1_Video_Recap_Marble Run.mp4`,
      Buffer.from('v'),
    ),
    e(
      `${WIDE}/G. Marble Run_Videos (all lessons)/L02.9_Video_CheckIn_Marble Run.mp4`,
      Buffer.from('v'),
    ),
    e(
      `${WIDE}/G. Marble Run_Videos (all lessons)/UnitTeaserVideo_Marble Run.mp4`,
      Buffer.from('v'),
    ),
    e(
      `${L1}/A. L01_Teacher Mission Manual_Marble Run_v1.0.pdf`,
      tinyPdf('l1 manual'),
    ),
    e(
      `${L1}/B. L01_Mission Launch Deck Slides_Marble Run_v1.1_.pptx`,
      officePptx('l1 deck'),
    ),
    e(
      `${L1}/C. L01_Student Mission Log_Marble Run v.1.1.docx`,
      officeDocx('l1 log'),
    ),
    e(
      `${L1}/D. L01_Status Check Lesson Assessment_Marble Run_v1.0.pdf`,
      tinyPdf('l1 check'),
    ),
    e(
      `${L1}/D. L01_Status Check Lesson Assessment (Editable)_Marble Run_v1.0.docx`,
      officeDocx('l1 check editable'),
    ),
    e(
      `${L1}/D. L01_Status Check Lesson Assessment Guidance_Marble Run_v1.0..pdf`,
      tinyPdf('l1 guidance'),
    ),
    e(
      `${L2}/A. L02_Teacher Mission Manual_Marble Run_v1.0.pdf`,
      tinyPdf('l2 manual'),
    ),
    e(
      `${L2}/C. L02_Student Mission Log_Marble Run v.1.1.docx`,
      officeDocx('l2 log'),
    ),
    e(
      `${L2}/D. L02_Status Check Lesson Assessment_Marble Run_v1.0.pdf`,
      tinyPdf('l2 check'),
    ),
    e(
      `${L2}/D. L02_Status Check Lesson Assessment_Marble Run_v1.0 copy.pdf`,
      tinyPdf('l2 check'),
    ),
    e(`${L2}/E. L02_Handouts_Marble Run_v1.0.pdf`, tinyPdf('l2 handouts')),
    e(`${L2}/F. L02_Trading Cards_Marble Run_v1.0.pdf`, tinyPdf('cards')),
    e(`${L2}/F. SQIREL Poster_18x24_Marble Run_v1.0.pdf`, tinyPdf('poster')),
    e('Have Feedback About the Unit_.docx', officeDocx('feedback')),
  ];
}

const PLAYLIST: ClassCrunchLabsPlaylist = {
  id: 'PLmarblerun01',
  title: 'Marble Run | Class CrunchLabs',
  items: [
    {
      videoId: 'AAAAAAAAAA1',
      title: 'Marble Run | L01.2 | Anchor Check-In',
      position: 1,
    },
    {
      videoId: 'AAAAAAAAAA2',
      title: 'Marble Run Lesson 1 Step 4: Materials Prep - Ramps',
      position: 2,
    },
    {
      videoId: 'AAAAAAAAAA3',
      title: 'Marble Run Lesson 1 Step 4: Student Hands-On Exploration - Ramps',
      position: 3,
    },
    {
      videoId: 'AAAAAAAAAA4',
      title: 'Marble Run | L02.1 | Recap',
      position: 4,
    },
    { videoId: 'AAAAAAAAAA5', title: 'Unit trailer', position: 5 },
  ],
};
const OTHER_PLAYLIST: ClassCrunchLabsPlaylist = {
  id: 'PLsolaroven01',
  title: 'Solar Oven | Class CrunchLabs',
  items: [
    {
      videoId: 'BBBBBBBBBB1',
      title: 'Solar Oven | L01.2 | Anchor Check-In',
      position: 1,
    },
  ],
};
const playlists = (...list: ClassCrunchLabsPlaylist[]) => ({
  playlists: async () => list,
});

const build = (files = unitFiles(), extra: Record<string, unknown> = {}) =>
  buildClassCrunchLabsBundle({
    files: memoryClassCrunchLabsSource(files),
    includeUnitWideAggregates: true,
    playlists: playlists(PLAYLIST, OTHER_PLAYLIST),
    pageCounter: async () => 4,
    ...extra,
  });

type Decl = { path: string; role: string; audience?: string; title: string };
const lessonOf = (b: Awaited<ReturnType<typeof build>>, key: string) =>
  (
    b.manifest.sections as Array<{
      lessons: Array<{
        key: string;
        members: Decl[];
        pages?: unknown[];
        videos?: Array<Record<string, unknown>>;
      }>;
    }>
  )[0]?.lessons.find((l) => l.key === key);

describe('readable titles (#4642)', () => {
  const U = 'Zoom Boom';
  const R = 'Zoom Boom Unit Material (Motion)_Class CrunchLabs';
  const Z1 = `${R}/${U}_Lesson 1`;
  const Z3 = `${R}/${U}_Lesson 3`;
  const W = `${R}/${U}_All Unit Wide Materials`;
  const f = (path: string, label: string) => ({
    path,
    bytes: tinyPdf(label),
  });
  const files = [
    f(`${Z1}/A. L01_Teacher Mission Manual_${U}_v1.0.pdf`, 'a'),
    f(`${Z1}/B. L01_Mission Launch Deck Slides_${U}_v1.1_.pdf`, 'b'),
    f(`${Z1}/C. L01_Student Mission Log_${U} v.1.1.pdf`, 'c'),
    f(
      `${Z1}/D. L01_Status Check Lesson Assessment Guidance_${U}_v1.0..pdf`,
      'd',
    ),
    f(`${Z1}/D. L01_Status Check Lesson Assessment_${U}_v1.0 copy.pdf`, 'e'),
    f(`${Z1}/D. L01_Status Check Lesson Assessment_${U}_v1.0.pdf`, 'f'),
    f(`${Z1}/E. L01_Handouts_${U}_v1.0.pdf`, 'g'),
    f(`${Z1}/F. L01_Trading Cards_${U}_v1.0.pdf`, 'h'),
    f(`${Z3}/A. L03_Teacher Mission Manual_${U}_v1.0.pdf`, 'i'),
    f(`${W}/F. Other Materials/SQIREL Poster - 8.5x11.pdf`, 'j'),
    f(`${W}/F. Other Materials/SQUIRL Poster - Letter by Letter.pdf`, 'k'),
    {
      path: `${W}/G. Videos/L01.4_Video_StudentHandsOnExploration_CarnivalGames_${U}-006.mp4`,
      bytes: Buffer.from('v'),
    },
    {
      path: `${W}/G. Videos/L03.6_Video_StudentHandsOnExploration_PlayWithPlungers_${U}-002.mp4`,
      bytes: Buffer.from('v'),
    },
  ];
  it('tidies material titles and names lessons for their activity', async () => {
    const b = await buildClassCrunchLabsBundle({
      files: memoryClassCrunchLabsSource(files),
      pageCounter: async () => 2,
    });
    const sections = b.manifest.sections as Array<{
      lessons: Array<{ key: string; title: string; members: Decl[] }>;
    }>;
    const lessons = sections.flatMap((x) => x.lessons);
    expect(lessons.map((l) => l.title)).toEqual([
      'Lesson 1: Carnival Games',
      'Lesson 3: Play with Plungers',
    ]);
    expect(lessons[0]?.members.map((m) => m.title).sort()).toEqual([
      'Handouts',
      'Mission Launch Deck Slides',
      'Status Check Lesson Assessment',
      'Status Check Lesson Assessment (2)',
      'Status Check Lesson Assessment Guidance',
      'Student Mission Log',
      'Teacher Mission Manual',
      'Trading Cards',
    ]);
    expect(
      (b.manifest.courseMembers as Decl[]).map((m) => m.title).sort(),
    ).toEqual([
      'SQIREL Poster (8.5\u00d711)',
      'SQUIRL Poster (Letter by Letter)',
    ]);
  });
  it('reads loose root videos, both name forms and download suffixes; the lowest step wins', async () => {
    const loose = [
      ...files.filter((x) => !/\.mp4$/.test(x.path)),
      {
        path: `L01.4_Video_StudentHandsOnExploration_CarnivalGames_Zoom  Boom-006.mp4`,
        bytes: Buffer.from('v'),
      },
      {
        path: `L01.4 Video_MaterialsPrep_CarnivalGames_Zoom  Boom-018.mp4`,
        bytes: Buffer.from('v'),
      },
      {
        path: `L03.7_Video_StudentHandsOnExploration_SumoSpheres_Zoom Boom.mp4`,
        bytes: Buffer.from('v'),
      },
      {
        path: `${W}/G. Videos/L03.6_Video_StudentHandsOnExploration_PlayWithPlungers_Zoom Boom-002.mp4`,
        bytes: Buffer.from('v'),
      },
      // another unit's loose video is not this unit's
      {
        path: `L01.4_Video_StudentHandsOnExploration_Other_Solar Oven.mp4`,
        bytes: Buffer.from('v'),
      },
    ];
    const b = await buildClassCrunchLabsBundle({
      files: memoryClassCrunchLabsSource(loose),
      pageCounter: async () => 2,
    });
    const lessons = (
      b.manifest.sections as Array<{ lessons: Array<{ title: string }> }>
    ).flatMap((x) => x.lessons.map((l) => l.title));
    expect(lessons).toEqual([
      'Lesson 1: Carnival Games',
      'Lesson 3: Play with Plungers',
    ]);
  });
  it('names a lesson from the cover headline the host reads, in title case', async () => {
    const seen: number[] = [];
    const b = await buildClassCrunchLabsBundle({
      files: memoryClassCrunchLabsSource(files),
      pageCounter: async () => 2,
      readFirstPageHeadline: async ({ bytes }) => {
        seen.push(bytes.byteLength);
        // lesson 1's manual is 'a', lesson 3's is 'i'; the host reads the page
        return seen.length === 1 ? 'WEIGHT & MOTION' : null;
      },
    });
    const lessons = (
      b.manifest.sections as Array<{ lessons: Array<{ title: string }> }>
    ).flatMap((x) => x.lessons.map((l) => l.title));
    expect(lessons).toEqual([
      'Lesson 1: Weight & Motion',
      'Lesson 3: Play with Plungers',
    ]);
    const thrown = await buildClassCrunchLabsBundle({
      files: memoryClassCrunchLabsSource(files),
      pageCounter: async () => 2,
      readFirstPageHeadline: async () => {
        throw new Error('no reader');
      },
    });
    expect(
      (
        thrown.manifest.sections as Array<{ lessons: Array<{ title: string }> }>
      ).flatMap((x) => x.lessons.map((l) => l.title)),
    ).toEqual(['Lesson 1: Carnival Games', 'Lesson 3: Play with Plungers']);
  });
  it('ignores a hook that throws synchronously or returns a non-string', async () => {
    for (const hook of [
      () => {
        throw new Error('sync');
      },
      async () => 42,
      async () => ({ text: 'x' }),
    ]) {
      const b = await buildClassCrunchLabsBundle({
        files: memoryClassCrunchLabsSource(files),
        pageCounter: async () => 2,
        readFirstPageHeadline: hook as never,
      });
      expect(
        (
          b.manifest.sections as Array<{ lessons: Array<{ title: string }> }>
        ).flatMap((x) => x.lessons.map((l) => l.title)),
      ).toEqual(['Lesson 1: Carnival Games', 'Lesson 3: Play with Plungers']);
    }
  });
  it('admits a loose video only when its terminal name part is the unit', async () => {
    const b = await buildClassCrunchLabsBundle({
      files: memoryClassCrunchLabsSource([
        ...files.filter((x) => !/\.mp4$/.test(x.path)),
        {
          path: 'L01.4_Video_StudentHandsOnExploration_ZoomBoomChallenge_Solar Oven.mp4',
          bytes: Buffer.from('v'),
        },
        {
          path: 'L01.4_Video_StudentHandsOnExploration_Racers_Zoom Boom-004.mp4',
          bytes: Buffer.from('v'),
        },
      ]),
      pageCounter: async () => 2,
    });
    const lessons = (
      b.manifest.sections as Array<{ lessons: Array<{ title: string }> }>
    ).flatMap((x) => x.lessons.map((l) => l.title));
    expect(lessons).toEqual(['Lesson 1: Racers', 'Lesson 3']);
  });
  it('strips only a real version from the unit part', async () => {
    const lessonsOf = async (names: string[]) => {
      const b = await buildClassCrunchLabsBundle({
        files: memoryClassCrunchLabsSource([
          ...files.filter((x) => !/\.mp4$/.test(x.path)),
          ...names.map((path) => ({ path, bytes: Buffer.from('v') })),
        ]),
        pageCounter: async () => 2,
      });
      return (
        b.manifest.sections as Array<{ lessons: Array<{ title: string }> }>
      ).flatMap((x) => x.lessons.map((l) => l.title))[0];
    };
    const v = (tail: string) =>
      `L01.4_Video_StudentHandsOnExploration_Racers_${tail}.mp4`;
    expect(await lessonsOf([v('Zoom Boom Vacation')])).toBe('Lesson 1');
    expect(await lessonsOf([v('ZoomBoomV2')])).toBe('Lesson 1: Racers');
    expect(await lessonsOf([v('Zoom Boom v1.1')])).toBe('Lesson 1: Racers');
    expect(await lessonsOf([v('ZoomBoomv1.0')])).toBe('Lesson 1: Racers');
    expect(await lessonsOf([v('Zoom Boom v.1.1')])).toBe('Lesson 1: Racers');
    expect(
      parseClassCrunchLabsVideoName(
        'L01.4_Video_StudentHandsOnExploration_Racers_ZoomBoomv1.0.mp4',
        'Zoom Boom',
      )?.title,
    ).toBe('Racers');
    expect(
      parseClassCrunchLabsVideoName(
        'L01.4_Video_StudentHandsOnExploration_Racers_ZoomBoomV2.mp4',
        'Zoom Boom',
      )?.title,
    ).toBe('Racers');
    // a unit-like word is kept in a material title
    const b = await buildClassCrunchLabsBundle({
      files: memoryClassCrunchLabsSource([
        f(`${Z1}/A. L01_Teacher Mission Manual_ZoomBoomVacation_v1.0.pdf`, 'z'),
      ]),
      pageCounter: async () => 2,
    });
    const titles = (
      b.manifest.sections as Array<{ lessons: Array<{ members: Decl[] }> }>
    ).flatMap((x) => x.lessons.flatMap((l) => l.members.map((m) => m.title)));
    expect(titles).toEqual(['Teacher Mission Manual - ZoomBoomVacation']);
    const t2 = await buildClassCrunchLabsBundle({
      files: memoryClassCrunchLabsSource([
        f(`${Z1}/A. L01_Teacher Mission Manual_ZoomBoomv1.0.pdf`, 'y'),
        f(`${Z1}/B. L01_Mission Launch Deck Slides_ZoomBoomV2.pdf`, 'w'),
      ]),
      pageCounter: async () => 2,
    });
    expect(
      (t2.manifest.sections as Array<{ lessons: Array<{ members: Decl[] }> }>)
        .flatMap((x) => x.lessons.flatMap((l) => l.members.map((m) => m.title)))
        .sort(),
    ).toEqual(['Mission Launch Deck Slides', 'Teacher Mission Manual']);
  });
  it('terminates when long equal-prefix titles collide', async () => {
    const long = 'Very Long Material Name '.repeat(12);
    const b = await buildClassCrunchLabsBundle({
      files: memoryClassCrunchLabsSource([
        f(`${Z1}/A. L01_${long}x1_${U}_v1.0.pdf`, 'p'),
        f(`${Z1}/A. L01_${long}x2_${U}_v1.0.pdf`, 'q'),
        f(`${Z1}/A. L01_${long}x3_${U}_v1.0.pdf`, 'r'),
      ]),
      pageCounter: async () => 2,
    });
    const titles = (
      b.manifest.sections as Array<{
        lessons: Array<{ members: Decl[] }>;
      }>
    )
      .flatMap((x) => x.lessons.flatMap((l) => l.members))
      .map((m) => m.title);
    expect(new Set(titles).size).toBe(3);
    expect(titles.every((t) => t.length <= 200)).toBe(true);
  });
  it('falls back to Lesson N when no video names an activity', async () => {
    const b = await buildClassCrunchLabsBundle({
      files: memoryClassCrunchLabsSource(
        files.filter((x) => !/\.mp4$/.test(x.path)),
      ),
      pageCounter: async () => 2,
    });
    const sections = b.manifest.sections as Array<{
      lessons: Array<{ title: string }>;
    }>;
    expect(sections.flatMap((x) => x.lessons.map((l) => l.title))).toEqual([
      'Lesson 1',
      'Lesson 3',
    ]);
  });
});

describe('layout and mapping to manifest v2', () => {
  it('maps the lettered files to roles and audiences, lessons and course members', async () => {
    const b = await build();
    expect(b.unit).toBe('Marble Run');
    expect(b.licenseKind).toBe('personal-use-copy');
    expect(b.manifest).toMatchObject({
      version: 2,
      course: { subject: 'Science' },
    });
    const l1 = lessonOf(b, 'lesson-01');
    const role = (d?: Decl) => [d?.role, d?.audience ?? 'default'];
    const byName = (name: string) =>
      l1?.members.find((m) => m.path.includes(name));
    expect(role(byName('Teacher Mission Manual'))).toEqual([
      'teacher-guide',
      'default',
    ]);
    expect(role(byName('Mission Launch Deck'))).toEqual(['slides', 'default']);
    expect(role(byName('Student Mission Log'))).toEqual([
      'learner-pages',
      'default',
    ]);
    expect(role(byName('Assessment_Marble'))).toEqual([
      'assessment',
      'default',
    ]);
    expect(role(byName('(Editable)'))).toEqual(['assessment', 'guardian']);
    expect(role(byName('Guidance'))).toEqual([
      'assessment-guidance',
      'default',
    ]);
    const l2 = lessonOf(b, 'lesson-02');
    expect(l2?.members.map((m) => m.role).sort()).toEqual([
      'assessment',
      'handout',
      'learner-pages',
      'printable',
      'teacher-guide',
    ]);
    // titles are readable, not file names
    expect(byName('Teacher Mission Manual')?.title).toBe(
      'Teacher Mission Manual',
    );
    const course = (b.manifest.courseMembers as Decl[]).map((m) => [
      m.role,
      m.audience ?? 'default',
    ]);
    expect(course).toEqual(
      expect.arrayContaining([
        ['teacher-guide', 'default'],
        ['slides', 'default'],
        ['learner-pages', 'default'],
        ['assessment-guidance', 'default'],
        ['assessment', 'guardian'],
        ['assessment', 'default'],
        ['handout', 'default'],
        ['printable', 'default'],
        ['attachment', 'default'],
      ]),
    );
    expect(
      (b.manifest.courseMembers as Decl[]).find((m) => m.role === 'attachment')
        ?.path,
    ).toBe('unit/Supply List_Marble Run_v1.0.xlsx');
  });

  it('produces a bundle the manifest v2 reader accepts, with guardian-only roles guardian', async () => {
    const b = await build();
    const plan = planCourseBundle(readFileSet(b.bundle.files));
    expect(plan.readerId).toBe('manifest-v2');
    const mats = plan.materials.materials;
    for (const m of mats.filter(
      (x) =>
        x.role === 'assessment-guidance' ||
        x.role === 'teacher-guide' ||
        x.role === 'slides',
    ))
      expect(m.audience).toBe('guardian');
    for (const m of mats.filter((x) => x.role === 'learner-pages'))
      expect(m.audience).toBe('learner');
    expect(plan.materials.skipped).toEqual([]);
    expect(plan.members.some((m) => m.status === 'refused')).toBe(false);
  });

  it('reports what it ignored without reading it', async () => {
    const b = await build();
    expect(b.report.ignored).toEqual(
      expect.arrayContaining([
        {
          path: 'Have Feedback About the Unit_.docx',
          reason: 'outside-unit-folders',
        },
      ]),
    );
    expect(b.report.videos.unitLevel.sort()).toEqual([
      'Marble Run_UnitTeaserVideo.mp4',
      'UnitTeaserVideo_Marble Run.mp4',
    ]);
    const paths = b.bundle.files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith('.mp4'))).toBe(false);
    expect(paths[0]).toBe('manifest.json');
  });

  it('is deterministic', async () => {
    const a = await build();
    const b = await build(unitFiles().reverse());
    expect(Buffer.from(a.bundle.files[0]?.bytes ?? []).toString()).toBe(
      Buffer.from(b.bundle.files[0]?.bytes ?? []).toString(),
    );
  });
});

describe('unit-wide aggregates', () => {
  it('leaves out the combined "(all lessons)" files by default and keeps the supply list, posters and handbook', async () => {
    const b = await build(unitFiles(), { includeUnitWideAggregates: false });
    const course = (b.manifest.courseMembers as Decl[]).map((m) => [
      m.role,
      m.path.split('/').pop(),
    ]);
    expect(course.sort()).toEqual([
      ['attachment', 'Supply List_Marble Run_v1.0.xlsx'],
      ['printable', 'SQIREL Poster_18x24_Marble Run_v1.0.pdf'],
      ['teacher-guide', 'B. Class CrunchLabs_ Teacher Handbook_v1.0.docx'],
    ]);
    const skipped = b.report.ignored.filter(
      (i) => i.reason === 'aggregate-of-lessons',
    );
    expect(skipped.map((i) => i.path.split('/').pop()).sort()).toEqual([
      'Marble Run_Unit-Wide Mission Launch Deck Slides (all lessons)_v1.1_.pptx',
      'Unit Wide Assessment Guidance_Marble Run_v1.0.pdf',
      'Unit Wide Handouts_Marble Run_v1.0.pdf',
      'Unit Wide Status Checks (Editable)_Marble Run_v1.0.docx',
      'Unit Wide Status Checks_Marble Run_v1.0.pdf',
      'Unit Wide Teacher Mission Manual_ALL INCLUSIVE_Marble Run_v1.0.pdf',
      'Unit WideStudent Mission Log_Marble Run v.1.1.docx',
    ]);
    // every lesson keeps its own materials
    expect(lessonOf(b, 'lesson-01')?.members).toHaveLength(6);
  });
});

describe('large units', () => {
  it('splits a unit that does not fit one archive into parts by lesson, course members first', async () => {
    const files = unitFiles().map((f) =>
      f.path.includes('Lesson') && f.path.endsWith('.pdf')
        ? { ...f, bytes: Buffer.concat([f.bytes, Buffer.alloc(3000)]) }
        : f,
    );
    const whole = await build(files);
    expect(whole.parts).toHaveLength(1);
    expect(whole.report.parts).toBe(1);
    const split = await build(files, { maxPartBytes: 25_000 });
    expect(split.parts.length).toBeGreaterThan(1);
    expect(split.report.parts).toBe(split.parts.length);
    expect(split.parts.flatMap((p) => p.lessons)).toEqual([1, 2]);
    // course members only in the first part, every part a valid manifest v2 bundle
    expect(split.parts.filter((p) => p.manifest.courseMembers)).toHaveLength(1);
    for (const part of split.parts) {
      const plan = planCourseBundle(readFileSet(part.bundle.files));
      expect(plan.readerId).toBe('manifest-v2');
      expect(plan.members.some((m) => m.status === 'refused')).toBe(false);
    }
    // together the parts carry exactly the files of the whole
    const names = (parts: typeof split.parts) =>
      parts
        .flatMap((p) => p.bundle.files.map((f) => f.path))
        .filter((p) => p !== 'manifest.json')
        .sort();
    expect(names(split.parts)).toEqual(names(whole.parts));
    expect(split.bundle).toBe(split.parts[0]?.bundle);
    await expect(build(files, { maxPartBytes: 2_000 })).rejects.toMatchObject({
      code: 'too_large',
    });
  });
});

describe('part packing at the archive cap', () => {
  // Scaled down 10x (a "MB" is 100 KiB) so the test stays light; the ratios are the real ones.
  const MB = 100 * 1024;
  const big = (n: number, label = 'x') =>
    Buffer.concat([tinyPdf(label), Buffer.alloc(n * MB)]);
  const sized = (course: number, lesson1: number, lesson2: number) =>
    unitFiles()
      .filter((f) => !/Lesson [3-9]/.test(f.path))
      .map((f) =>
        /Poster_18x24/.test(f.path) && /All Unit/.test(f.path)
          ? { ...f, bytes: big(course) }
          : /Lesson 1\/D\. L01_Status Check Lesson Assessment_/.test(f.path)
            ? { ...f, bytes: big(lesson1, 'one') }
            : /Lesson 2\/A\./.test(f.path)
              ? { ...f, bytes: big(lesson2, 'two') }
              : f,
      );

  it('puts a small lesson beside the course members and the big one in its own part, every part under the cap', async () => {
    const b = await build(sized(60, 45, 20), { maxPartBytes: 90 * MB });
    expect(b.parts.map((p) => p.lessons)).toEqual([[2], [1]]);
    for (const part of b.parts) {
      const total = part.bundle.files.reduce(
        (n, f) => n + f.bytes.byteLength,
        0,
      );
      expect(total).toBeLessThanOrEqual(100 * MB);
      expect(() =>
        planCourseBundle(readFileSet(part.bundle.files)),
      ).not.toThrow();
    }
    expect(b.parts.filter((p) => p.manifest.courseMembers)).toHaveLength(1);
  }, 60_000);

  it('refuses explicitly when the course members and every lesson cannot share a part (60 + 45)', async () => {
    await expect(
      build(sized(60, 45, 45), { maxPartBytes: 90 * MB }),
    ).rejects.toMatchObject({
      code: 'too_large',
      message: expect.stringContaining('leave no room for any lesson'),
    });
  }, 60_000);

  it('refuses unit-wide materials over the budget', async () => {
    await expect(
      build(sized(8, 1, 1), { maxPartBytes: 6 * MB }),
    ).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('de-duplication', () => {
  it('keeps one copy of identical content: the lesson-named file in its lesson, posters unit wide, no "copy"', async () => {
    const b = await build();
    const dup = b.report.duplicates.map((d) => [
      d.path.split('/').pop(),
      d.duplicateOf.split('/').pop(),
    ]);
    expect(dup).toEqual(
      expect.arrayContaining([
        [
          'L02_Trading Cards_Marble Run_v1.0.pdf',
          'F. L02_Trading Cards_Marble Run_v1.0.pdf',
        ],
        [
          'F. SQIREL Poster_18x24_Marble Run_v1.0.pdf',
          'SQIREL Poster_18x24_Marble Run_v1.0.pdf',
        ],
        [
          'D. L02_Status Check Lesson Assessment_Marble Run_v1.0 copy.pdf',
          'D. L02_Status Check Lesson Assessment_Marble Run_v1.0.pdf',
        ],
      ]),
    );
    const l2 = lessonOf(b, 'lesson-02');
    expect(l2?.members.filter((m) => m.role === 'printable')).toHaveLength(1);
    expect(l2?.members.some((m) => /copy/.test(m.path))).toBe(false);
    const poster = (b.manifest.courseMembers as Decl[]).filter((m) =>
      /Poster/.test(m.path),
    );
    expect(poster).toHaveLength(1);
    expect(
      new Set(
        b.bundle.files.map((f) => Buffer.from(f.bytes).toString('base64')),
      ).size,
    ).toBe(b.bundle.files.length);
  });

  it('collapses repeated exports of the same unit, newest wins', async () => {
    const first = unitFiles('20261102T000000Z');
    const second = unitFiles('20261103T000000Z');
    const changed = second.find((f) =>
      f.path.includes('L01_Teacher Mission Manual'),
    );
    if (changed) changed.bytes = tinyPdf('l1 manual REVISED');
    const b = await build([...first, ...second]);
    expect(b.report.duplicateExports).toBeGreaterThan(20);
    expect(b.report.superseded).toBe(1);
    const manual = b.bundle.files.find((f) =>
      f.path.includes('L01_Teacher Mission Manual'),
    );
    expect(Buffer.from(manual?.bytes ?? []).toString()).toContain('REVISED');
    const once = await build();
    expect(b.bundle.files.map((f) => f.path)).toEqual(
      once.bundle.files.map((f) => f.path),
    );
  });

  it('uses crc and size, not bytes, to recognise a repeated export', async () => {
    const source = unitFiles();
    const files = source.flatMap((f, i) => [
      { ...f, size: f.bytes.byteLength, crc32: String(i), exportId: '1' },
      { ...f, size: f.bytes.byteLength, crc32: String(i), exportId: '2' },
    ]);
    const b = await build(files as Entry[]);
    expect(b.report.superseded).toBe(0);
    // every file but the one outside the unit folders is seen in both exports
    expect(b.report.duplicateExports).toBe(source.length - 1);
  });
});

describe('unit selection', () => {
  it('needs a name when a download holds several units, and says which', async () => {
    const solar = unitFiles().map((f) => ({
      ...f,
      path: f.path.replaceAll('Marble Run', 'Solar Oven'),
    }));
    const files = [...unitFiles(), ...solar];
    await expect(build(files)).rejects.toMatchObject({
      code: 'multiple_units',
      detail: ['Marble Run', 'Solar Oven'],
    });
    const picked = await build(files, { unit: 'solar  oven' });
    expect(picked.unit).toBe('Solar Oven');
    expect(picked.bundle.files.every((f) => !f.path.includes('Marble'))).toBe(
      true,
    );
    await expect(build(files, { unit: 'Nope' })).rejects.toMatchObject({
      code: 'no_unit',
    });
  });

  it('refuses a download with no unit folders or no usable material', async () => {
    await expect(
      build([{ path: 'readme.txt', bytes: Buffer.from('x') }]),
    ).rejects.toBeInstanceOf(ClassCrunchLabsError);
    await expect(
      build([
        { path: `${ROOT}/Marble Run_Lesson 1/notes.pdf`, bytes: tinyPdf('n') },
      ]),
    ).rejects.toMatchObject({ code: 'empty_unit' });
  });
});

describe('lesson pages from the mission log', () => {
  it('writes a page range per lesson from the counted pages', async () => {
    const b = await build(unitFiles(), { pageCounter: async () => 6 });
    const l1 = lessonOf(b, 'lesson-01');
    expect(l1?.pages).toEqual([
      {
        member: expect.stringContaining('lesson-01/C. L01_Student Mission Log'),
        from: 1,
        to: 6,
        label: 'Mission log',
      },
    ]);
    expect(b.report.pages).toHaveLength(2);
    const plan = planCourseBundle(readFileSet(b.bundle.files));
    expect(
      plan.materials.pages
        .filter((p) => p.lessonKey === 'lesson-01')
        .map((p) => p.pageKey),
    ).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('writes no pages, and says so, when the count is unknown', async () => {
    const none = await build(unitFiles(), { pageCounter: undefined });
    expect(lessonOf(none, 'lesson-01')?.pages).toBeUndefined();
    expect(
      none.report.warnings.filter((w) => /page count is unknown/.test(w)),
    ).toHaveLength(2);
    const failing = await build(unitFiles(), {
      pageCounter: async () => {
        throw new Error('boom');
      },
    });
    expect(lessonOf(failing, 'lesson-02')?.pages).toBeUndefined();
  });

  it('counts real PDFs, and Word files through the injected converter', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage();
    const three = await doc.save();
    const direct = createClassCrunchLabsPageCounter();
    expect(await direct({ bytes: three, kind: 'pdf' })).toBe(3);
    expect(await direct({ bytes: officeDocx('a'), kind: 'docx' })).toBeNull();
    expect(
      await direct({ bytes: tinyPdf('not really'), kind: 'pdf' }),
    ).toBeNull();
    const viaConverter = createClassCrunchLabsPageCounter({
      converter: new FakeDocumentConverter({ output: three }),
    });
    expect(await viaConverter({ bytes: officeDocx('a'), kind: 'docx' })).toBe(
      3,
    );
    const down = createClassCrunchLabsPageCounter({
      converter: new FakeDocumentConverter({ failWith: 'unavailable' }),
    });
    expect(await down({ bytes: officeDocx('a'), kind: 'docx' })).toBeNull();
  });
});

describe('video names and YouTube playlist matching', () => {
  it('parses Lnn.step_Video_Kind_Title names', () => {
    const parse = (n: string) => parseClassCrunchLabsVideoName(n, 'Marble Run');
    expect(parse('L02.9_Video_MaterialsPrep_ZoomBoom_Marble  Run.mp4')).toEqual(
      {
        lesson: 2,
        step: '9',
        kind: 'MaterialsPrep',
        title: 'Zoom Boom',
      },
    );
    expect(parse('L03.1b_Video_Recap_Marble Run.mp4')).toEqual({
      lesson: 3,
      step: '1b',
      kind: 'Recap',
      title: '',
    });
    expect(
      parse('L01.4 Video_MaterialsPrep_CarnivalGames_Marble Run-005.mp4')
        ?.title,
    ).toBe('Carnival Games');
    expect(parse('L06.14_Video_ZBonus_Marble Run.mp4')?.kind).toBe('ZBonus');
    expect(
      parse('L03.9_Video_StudentHandsOnExploration_SumoSpheres2_Marble Run.mp4')
        ?.title,
    ).toBe('Sumo Spheres 2');
    expect(parse('UnitTeaserVideo_Marble Run.mp4')).toBeNull();
    expect(parse('notes.mp4')).toBeNull();
  });

  it('reads the lesson and step an item title names', () => {
    expect(parsePlaylistItemTitle('Marble Run | L03.6 | Plungers')).toEqual({
      lesson: 3,
      step: '6',
    });
    expect(parsePlaylistItemTitle('Lesson 3, Step 06: Plungers')).toEqual({
      lesson: 3,
      step: '6',
    });
    expect(parsePlaylistItemTitle('L01-2 Anchor')).toEqual({
      lesson: 1,
      step: '2',
    });
    expect(parsePlaylistItemTitle('Lesson 3 recap')).toBeNull();
    expect(parsePlaylistItemTitle('Unit trailer')).toBeNull();
  });

  it('picks the unit playlist by unit, ignoring case and punctuation', () => {
    expect(pickUnitPlaylist([PLAYLIST, OTHER_PLAYLIST], 'marble run')?.id).toBe(
      'PLmarblerun01',
    );
    expect(pickUnitPlaylist([OTHER_PLAYLIST], 'Marble Run')).toBeNull();
    expect(
      pickUnitPlaylist(
        [
          {
            ...OTHER_PLAYLIST,
            unit: 'Marble Run',
            title: 'Marble Run: the whole course',
          },
        ],
        'Marble Run',
      )?.id,
    ).toBe('PLsolaroven01');
  });

  it('matches by unit, lesson and step, as external references on the lesson', async () => {
    const b = await build();
    expect(b.report.videos.playlist).toEqual({
      id: 'PLmarblerun01',
      title: PLAYLIST.title,
    });
    expect(
      b.report.videos.matched.map((v) => [v.lesson, v.step, v.kind, v.videoId]),
    ).toEqual([
      [1, '2', 'AnchorCheckIn', 'AAAAAAAAAA1'],
      [1, '4', 'MaterialsPrep', 'AAAAAAAAAA2'],
      [1, '4', 'StudentHandsOnExploration', 'AAAAAAAAAA3'],
      [2, '1', 'Recap', 'AAAAAAAAAA4'],
    ]);
    // the same step shared by two videos is told apart by the item titles
    expect(b.report.videos.unmatched).toEqual([
      { lesson: 2, step: '9', kind: 'CheckIn', title: '', reason: 'no_item' },
    ]);
    expect(b.report.videos.unusedPlaylistItems).toBe(0);
    expect(lessonOf(b, 'lesson-01')?.videos).toEqual([
      {
        reference: 'AAAAAAAAAA1',
        title: 'Anchor check-in',
        step: { key: '2', order: 2, label: 'Anchor check-in' },
      },
      {
        reference: 'AAAAAAAAAA2',
        title: 'Materials prep: Ramps',
        step: { key: '4', order: 4, label: 'Materials prep: Ramps' },
        audience: 'guardian',
      },
      {
        reference: 'AAAAAAAAAA3',
        title: 'Hands-on exploration: Ramps',
        step: { key: '4', order: 4.001, label: 'Hands-on exploration: Ramps' },
      },
    ]);
    expect(lessonOf(b, 'lesson-02')?.videos).toEqual([
      {
        reference: 'AAAAAAAAAA4',
        title: 'Recap',
        step: { key: '1', order: 1, label: 'Recap' },
      },
    ]);
    const plan = planCourseBundle(readFileSet(b.bundle.files));
    expect(
      plan.materials.videos.map((v) => [
        v.lessonKey,
        v.videoId,
        v.stepOrder,
        v.audience,
      ]),
    ).toEqual([
      ['lesson-01', 'AAAAAAAAAA1', 2, 'learner'],
      ['lesson-01', 'AAAAAAAAAA2', 4, 'guardian'],
      ['lesson-01', 'AAAAAAAAAA3', 4, 'learner'],
      ['lesson-02', 'AAAAAAAAAA4', 1, 'learner'],
    ]);
  });

  it('leaves videos unmatched rather than guessing', () => {
    const video = (kind: string, title: string) => ({
      lesson: 1,
      step: '4',
      kind,
      title,
    });
    const item = (id: string, title: string, position: number) => ({
      videoId: id.padEnd(11, 'x'),
      title,
      position,
    });
    const ambiguous = matchClassCrunchLabsVideos(
      [video('MaterialsPrep', ''), video('Recap', '')],
      {
        id: 'p',
        title: 'p',
        items: [item('a', 'L01.4 one', 1), item('b', 'L01.4 two', 2)],
      },
    );
    expect(ambiguous.matched).toEqual([]);
    expect(ambiguous.unmatched.map((u) => u.reason)).toEqual([
      'ambiguous',
      'ambiguous',
    ]);
    const taken = matchClassCrunchLabsVideos(
      [video('Recap', ''), video('Recap', 'Again')],
      { id: 'p', title: 'p', items: [item('a', 'L01.4 Recap', 1)] },
    );
    expect(taken.matched).toHaveLength(1);
    expect(taken.unmatched.map((u) => u.reason)).toEqual(['item_taken']);
    // an item with a malformed video id is never used
    const bad = matchClassCrunchLabsVideos([video('Recap', '')], {
      id: 'p',
      title: 'p',
      items: [{ videoId: 'short', title: 'L01.4 Recap', position: 1 }],
    });
    expect(bad.unmatched[0]?.reason).toBe('no_item');
  });

  describe('matching without step numbers', () => {
    const v = (lesson: number, step: string, kind: string, title = '') => ({
      lesson,
      step,
      kind,
      title,
    });
    const playlistOf = (titles: string[]): ClassCrunchLabsPlaylist => ({
      id: 'p',
      title: 'Orbit Garden: Gravity',
      items: titles.map((title, i) => ({
        videoId: `vid${String(i).padStart(8, '0')}`,
        title: `Orbit Garden: ${title}`,
        position: i + 1,
      })),
    });
    const pairsOf = (r: ReturnType<typeof matchClassCrunchLabsVideos>) =>
      Object.fromEntries(
        r.matched.map((m) => [
          `${m.lesson}/${m.step} ${m.kind}`,
          m.playlistItem.replace('Orbit Garden: ', ''),
        ]),
      );
    const missesOf = (r: ReturnType<typeof matchClassCrunchLabsVideos>) =>
      r.unmatched.map((m) => `${m.lesson}/${m.step} ${m.kind}:${m.reason}`);
    const prepEx = ['MaterialsPrep', 'StudentHandsOnExploration'];
    const both = (lesson: number, step: string, title: string) =>
      prepEx.map((k) => v(lesson, step, k, title));
    const download = [
      v(1, '2', 'AnchorCheckIn'),
      ...both(1, '4', 'Marble Runs'),
      v(2, '1', 'Recap'),
      v(2, '4', 'ForcesExplainer'),
      ...both(2, '9', 'Sling Shot'),
      v(2, '20', 'CheckIn'),
      v(3, '1b', 'Recap'),
      v(3, '3', 'MaterialsPrep', 'Tower Demo'),
      ...both(3, '6', 'Play With Magnets'),
      ...both(3, '7', 'Comet Rings'),
      ...both(3, '9', 'Comet Rings 2'),
      v(3, '15', 'CheckIn'),
      v(4, '1', 'Recap'),
      v(4, '2', 'LookCloser'),
      v(4, '6', 'LinkUp'),
      v(5, '1', 'Recap'),
      v(5, '12', 'MaterialsPrep', 'Build Challenge'),
      v(5, '12', 'MessageFromMark'),
      v(6, '1', 'Recap'),
      v(6, '5', 'CheckIn'),
      v(6, '14', 'ZBonus'),
      v(6, '14', 'WrapUp'),
    ];
    const items = [
      'Welcome to the Orbit Garden',
      'The Anchor',
      'Marble Run Prep',
      'Marble Run Exploration',
      'Lesson 1 Recap',
      'Forces Explained',
      'Sling & Shot Prep',
      'Sling & Shot Exploration',
      'Rolling Pins',
      'Lesson 2 Recap',
      'Tower Demo',
      'Magnet Playtime Prep',
      'Magnet Playtime',
      'Comet Rings Part 1 Prep',
      'Comet Rings Exploration Part 1',
      'Comet Rings Part 2 Prep',
      'Comet Rings Exploration Part 2',
      'Lesson 3 Recap',
      'More Marbles',
      'Starry Night',
      'Lesson 4 Recap',
      'Build Challenge Prep',
      'Embrace Mistakes',
      'Lesson 5 Recap',
      'Garden Feedback',
      'Garden Wrap Up',
      'Melon Drop',
    ];

    it('pairs a unit by recap anchors, titles, kinds and order', () => {
      const r = matchClassCrunchLabsVideos(download, playlistOf(items));
      expect(pairsOf(r)).toEqual({
        '1/2 AnchorCheckIn': 'The Anchor',
        '1/4 MaterialsPrep': 'Marble Run Prep',
        '1/4 StudentHandsOnExploration': 'Marble Run Exploration',
        '2/1 Recap': 'Lesson 1 Recap',
        '2/4 ForcesExplainer': 'Forces Explained',
        '2/9 MaterialsPrep': 'Sling & Shot Prep',
        '2/9 StudentHandsOnExploration': 'Sling & Shot Exploration',
        '2/20 CheckIn': 'Rolling Pins',
        '3/1b Recap': 'Lesson 2 Recap',
        '3/3 MaterialsPrep': 'Tower Demo',
        '3/6 MaterialsPrep': 'Magnet Playtime Prep',
        '3/6 StudentHandsOnExploration': 'Magnet Playtime',
        '3/7 MaterialsPrep': 'Comet Rings Part 1 Prep',
        '3/7 StudentHandsOnExploration': 'Comet Rings Exploration Part 1',
        '3/9 MaterialsPrep': 'Comet Rings Part 2 Prep',
        '3/9 StudentHandsOnExploration': 'Comet Rings Exploration Part 2',
        '4/1 Recap': 'Lesson 3 Recap',
        '4/2 LookCloser': 'More Marbles',
        '4/6 LinkUp': 'Starry Night',
        '5/1 Recap': 'Lesson 4 Recap',
        '5/12 MaterialsPrep': 'Build Challenge Prep',
        '5/12 MessageFromMark': 'Embrace Mistakes',
        '6/1 Recap': 'Lesson 5 Recap',
        '6/5 CheckIn': 'Garden Feedback',
        '6/14 ZBonus': 'Melon Drop',
        '6/14 WrapUp': 'Garden Wrap Up',
      });
      // the intro item and a lesson's extra video stay unmatched
      expect(missesOf(r)).toEqual(['3/15 CheckIn:no_item']);
      expect(r.unusedItems).toBe(0);
      expect(r.matched.find((m) => m.kind === 'WrapUp')?.videoId).toMatch(
        /^vid\d{8}$/,
      );
    });

    it('never pairs across segments', () => {
      // lesson 1's "Marble Run Prep" is not offered to lesson 2's videos
      const r = matchClassCrunchLabsVideos(
        [v(1, '2', 'AnchorCheckIn'), ...both(2, '4', 'Marble Runs')],
        playlistOf([
          'The Anchor',
          'Marble Run Prep',
          'Lesson 1 Recap',
          'Sling',
          'Boing',
          'Lesson 2 Recap',
        ]),
      );
      expect(pairsOf(r)).toEqual({ '1/2 AnchorCheckIn': 'The Anchor' });
      expect(missesOf(r)).toEqual([
        '2/4 MaterialsPrep:ambiguous',
        '2/4 StudentHandsOnExploration:ambiguous',
      ]);
    });

    it('leaves a segment whose leftovers do not pair one to one', () => {
      const r = matchClassCrunchLabsVideos(
        [
          v(1, '2', 'CheckIn'),
          v(1, '3', 'LinkUp'),
          v(1, '4', 'LookCloser'),
          v(2, '4', 'MaterialsPrep', 'Zed'),
          v(2, '4', 'MessageFromMark'),
        ],
        playlistOf(['Apple', 'Pear', 'Lesson 1 Recap', 'Plum', 'Fig']),
      );
      // three videos, two items: nothing is guessed
      // two videos on one step: order cannot tell them apart
      expect(r.matched).toEqual([]);
      expect(missesOf(r)).toEqual([
        '1/2 CheckIn:ambiguous',
        '1/3 LinkUp:ambiguous',
        '1/4 LookCloser:ambiguous',
        '2/4 MaterialsPrep:ambiguous',
        '2/4 MessageFromMark:ambiguous',
      ]);
    });

    it('leaves lessons without a bounding recap unanchored', () => {
      const r = matchClassCrunchLabsVideos(
        [v(1, '2', 'CheckIn'), v(2, '2', 'CheckIn'), v(3, '2', 'CheckIn')],
        playlistOf(['Apple', 'Lesson 1 Recap', 'Pear', 'Plum']),
      );
      // lesson 1 sits before the first recap; lesson 2 has no closing recap
      // and is not the last lesson, lesson 3 follows no recap.
      expect(pairsOf(r)).toEqual({ '1/2 CheckIn': 'Apple' });
      expect(missesOf(r)).toEqual([
        '2/2 CheckIn:unanchored',
        '3/2 CheckIn:unanchored',
      ]);
    });

    it('uses only title evidence when the playlist has no recap anchors', () => {
      const r = matchClassCrunchLabsVideos(
        [...both(1, '4', 'Marble Runs'), v(2, '5', 'CheckIn')],
        playlistOf([
          'Marble Run Prep',
          'Marble Run Exploration',
          'Rolling Pins',
        ]),
      );
      expect(pairsOf(r)).toEqual({
        '1/4 MaterialsPrep': 'Marble Run Prep',
        '1/4 StudentHandsOnExploration': 'Marble Run Exploration',
      });
      // no order fill across a whole unit
      expect(missesOf(r)).toEqual(['2/5 CheckIn:no_item']);
    });

    it('keeps numbered items first and leaves their videos alone', () => {
      const r = matchClassCrunchLabsVideos(
        [
          v(1, '4', 'MaterialsPrep', 'Marble Runs'),
          v(2, '4', 'MaterialsPrep', 'Marble Runs'),
        ],
        playlistOf(['L01.4 Marble Run Prep', 'Marble Run Prep']),
      );
      expect(pairsOf(r)).toEqual({
        '1/4 MaterialsPrep': 'L01.4 Marble Run Prep',
        '2/4 MaterialsPrep': 'Marble Run Prep',
      });
    });
  });

  it('reports every video unmatched without a playlist source or a playlist for the unit', async () => {
    const none = await build(unitFiles(), { playlists: undefined });
    expect(none.report.videos.matched).toEqual([]);
    expect(
      none.report.videos.unmatched.every((u) => u.reason === 'no_playlist'),
    ).toBe(true);
    expect(none.report.warnings).toContain(
      'No playlist source was given; videos were not matched.',
    );
    expect(lessonOf(none, 'lesson-01')?.videos).toBeUndefined();
    const missing = await build(unitFiles(), {
      playlists: playlists(OTHER_PLAYLIST),
    });
    expect(missing.report.videos.playlist).toBeNull();
    expect(
      missing.report.warnings.some((w) => /No YouTube course playlist/.test(w)),
    ).toBe(true);
  });

  it('never touches the network: the playlist source is the only input and files are never fetched', async () => {
    const calls: string[] = [];
    const b = await build(unitFiles(), {
      playlists: {
        playlists: async () => {
          calls.push('playlists');
          return [PLAYLIST];
        },
      },
    });
    expect(calls).toEqual(['playlists']);
    expect(b.report.videos.matched).toHaveLength(4);
  });
});

describe('through the import service', () => {
  const opened: Array<{ close?: () => Promise<void> }> = [];
  beforeAll(() => enableTenancy());
  afterAll(() => disableTenancy());
  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close?.();
  });
  async function service() {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        ...learnerClasses,
        'CourseBundleImport',
        'CourseBundleMember',
        'CourseBundleRendering',
      ],
    });
    opened.push(db);
    const f = await learnerFixture(db);
    const svc = new CourseBundleImportService(db, () => true, {
      converter: new FakeDocumentConverter(),
    });
    const guardian: CatalogActor = {
      tenantId: f.own.tenantId,
      actorUserId: f.parent.actorUserId,
      roles: ['guardian'],
    };
    return { db, svc, guardian };
  }
  const record = async (
    publicListing?: boolean,
  ): Promise<CatalogSourceRecord> => {
    const page = await createClassCrunchLabsCatalogAdapter({
      playlists: playlists(PLAYLIST),
      ...(publicListing === undefined ? {} : { publicListing }),
    }).enumerate({
      checkpoint: {
        providerId: CLASS_CRUNCHLABS_PROVIDER_ID,
        complete: false,
        importedCount: 0,
        failures: [],
      },
    });
    return page.records[0] as CatalogSourceRecord;
  };

  it('imports a unit into the family course: roles, audience, pages and videos arrive on the evidence', async () => {
    const s = await service();
    const guardian = s.guardian;
    const policy = new CatalogPolicy({
      operatorTenantIds: [guardian.tenantId],
    });
    const received: string[] = [];
    const out = await withTenant(
      { tenantId: guardian.tenantId, userId: guardian.actorUserId },
      async () =>
        addClassCrunchLabsUnit({
          service: s.svc,
          actor: {
            tenantId: guardian.tenantId,
            actorUserId: guardian.actorUserId,
          },
          catalogActor: guardian,
          record: await record(),
          listing: {},
          policy,
          files: memoryClassCrunchLabsSource(unitFiles()),
          playlists: playlists(PLAYLIST, OTHER_PLAYLIST),
          pageCounter: async () => 3,
          receiveMember: (m) => void received.push(`${m.role}:${m.audience}`),
        }),
    );
    expect(out.build.licenseKind).toBe('personal-use-copy');
    expect(out.result.import).toMatchObject({
      readerId: 'manifest-v2',
      manifestVersion: 2,
      unsupportedCount: 0,
      refusedCount: 0,
    });
    expect(out.result.materials.videos).toHaveLength(4);
    expect(out.result.materials.pages).toHaveLength(6);
    expect(received).toContain('teacher-guide:guardian');
    expect(received).toContain('learner-pages:learner');
    expect(received).toContain('slides:guardian');
    expect(received).toContain('assessment-guidance:guardian');
    expect(
      out.result.accepted.find((m) => m.courseLevel && m.role === 'attachment')
        ?.kind,
    ).toBe('xlsx');
  });
});

describe('the catalog provider', () => {
  const checkpoint = {
    providerId: CLASS_CRUNCHLABS_PROVIDER_ID,
    complete: false,
    importedCount: 0,
    failures: [],
  };
  const guardianOf = (tenantId: string): CatalogActor => ({
    tenantId,
    actorUserId: 'u1',
    roles: ['guardian'],
  });
  const sync = (config: { publicListing?: boolean } = {}) =>
    createClassCrunchLabsCatalogAdapter({
      playlists: playlists(PLAYLIST, OTHER_PLAYLIST),
      ...config,
    }).enumerate({ checkpoint });

  it('lists units under Science with their playlist as the preview, operator-only by default', async () => {
    expect(CLASS_CRUNCHLABS_PUBLIC_LISTING_DEFAULT).toBe(false);
    const page = await sync();
    expect(page).toMatchObject({ complete: true });
    expect(
      page.records.map((r) => [r.providerId, r.stableId, r.title]),
    ).toEqual([
      ['class-crunchlabs', 'unit:marble-run', 'Marble Run'],
      ['class-crunchlabs', 'unit:solar-oven', 'Solar Oven'],
    ]);
    const [record] = page.records;
    expect(record).toMatchObject({
      subjects: ['Science'],
      resourceType: 'curriculum-unit',
      author: 'Class CrunchLabs',
      canonicalUrl: 'https://www.youtube.com/playlist?list=PLmarblerun01',
      availableFormats: [],
      visibility: 'operator',
      licenseEvidence: {
        state: 'unknown',
        exceptions: CLASS_CRUNCHLABS_LICENSE_PENDING,
        permittedOperations: [],
      },
    });
    expect(record?.revision).toMatch(/^r1-[0-9a-f]{24}$/);
    expect(classCrunchLabsPreviewEmbedUrl(record as CatalogSourceRecord)).toBe(
      'https://www.youtube-nocookie.com/embed/videoseries?list=PLmarblerun01',
    );
    expect(
      classCrunchLabsPreviewEmbedUrl({
        providerId: 'ck12',
        canonicalUrl: record?.canonicalUrl as string,
      }),
    ).toBeNull();
    expect(
      classCrunchLabsPreviewEmbedUrl({
        providerId: CLASS_CRUNCHLABS_PROVIDER_ID,
        canonicalUrl: 'https://evil.test/playlist?list=PLmarblerun01',
      }),
    ).toBeNull();
  });

  it('is visible only to operator-designated families, and to nobody by default', async () => {
    const [record] = (await sync()).records as [CatalogSourceRecord];
    const operator = new CatalogPolicy({ operatorTenantIds: ['t-operator'] });
    expect(operator.canView(record, guardianOf('t-operator'))).toBe(true);
    expect(operator.canView(record, guardianOf('t-other'))).toBe(false);
    // a teacher role in another family does not help
    expect(
      operator.canView(record, {
        ...guardianOf('t-other'),
        roles: ['teacher'],
      }),
    ).toBe(false);
    expect(new CatalogPolicy().canView(record, guardianOf('t-operator'))).toBe(
      false,
    );
    expect(
      new CatalogPolicy({ operatorTenantIds: [''] }).canView(
        record,
        guardianOf(''),
      ),
    ).toBe(false);
    expect(operator.authorize(record, 'link', guardianOf('t-other'))).toEqual({
      allowed: false,
      reason: 'operator-only',
    });
    // while permission is pending nothing is permitted, even to the operator
    expect(
      operator.authorize(record, 'link', guardianOf('t-operator')),
    ).toMatchObject({
      allowed: false,
      reason: 'unverified-license',
    });
  });

  it('goes public only on the single explicit switch, and only for the literal true', async () => {
    for (const publicListing of [
      undefined,
      false,
      1,
      'true',
      {},
    ] as unknown as boolean[]) {
      const page = await sync({ publicListing });
      expect(page.records.every((r) => r.visibility === 'operator')).toBe(true);
    }
    const open = await sync({ publicListing: true });
    const [record] = open.records as [CatalogSourceRecord];
    expect(record).toMatchObject({
      visibility: 'catalog',
      licenseEvidence: { state: 'verified', permittedOperations: ['link'] },
    });
    expect(new CatalogPolicy().canView(record, guardianOf('t-anyone'))).toBe(
      true,
    );
    expect(
      new CatalogPolicy().authorize(record, 'link', guardianOf('t-anyone')),
    ).toEqual({
      allowed: true,
    });
    // files are never hosted: nothing else is permitted
    expect(
      new CatalogPolicy().authorize(record, 'download', guardianOf('t-anyone'))
        .allowed,
    ).toBe(false);
    // flipping the switch changes the revision so the next sync rewrites the rows
    const closed = (await sync()).records[0] as CatalogSourceRecord;
    expect(closed.revision).not.toBe(record.revision);
  });

  it('keeps the feed honest when the playlist source fails or is given a cursor', async () => {
    const failing = createClassCrunchLabsCatalogAdapter({
      playlists: {
        playlists: async () => {
          throw new Error('quota exceeded');
        },
      },
    });
    expect(await failing.enumerate({ checkpoint })).toMatchObject({
      records: [],
      complete: false,
      paused: true,
      exclusions: [{ code: 'provider_feed_failed', message: 'quota exceeded' }],
    });
    expect(
      await createClassCrunchLabsCatalogAdapter({
        playlists: playlists(PLAYLIST),
      }).enumerate({
        cursor: 'x',
        checkpoint,
      }),
    ).toMatchObject({
      complete: false,
      exclusions: [{ code: 'unsupported_provider_cursor' }],
    });
    const skipped = createClassCrunchLabsCatalogAdapter({
      playlists: playlists(
        { ...PLAYLIST, id: 'bad id!' },
        { ...PLAYLIST, title: '  ' },
        PLAYLIST,
        { ...PLAYLIST, id: 'PLmarblerun02' },
      ),
    });
    expect((await skipped.enumerate({ checkpoint })).records).toHaveLength(1);
  });

  it('names the unit from the playlist', () => {
    expect(
      classCrunchLabsUnitOfPlaylist({ title: 'Marble Run | Class CrunchLabs' }),
    ).toBe('Marble Run');
    expect(
      classCrunchLabsUnitOfPlaylist({ title: 'Marble Run (Motion) - Course' }),
    ).toBe('Marble Run');
    expect(
      classCrunchLabsUnitOfPlaylist({ title: 'x', unit: ' Marble Run ' }),
    ).toBe('Marble Run');
  });

  it('refuses "Add to a course" to families that cannot see the listing, whatever the client sends', async () => {
    const policy = new CatalogPolicy({ operatorTenantIds: ['t-operator'] });
    const [record] = (await sync()).records as [CatalogSourceRecord];
    // visibility comes from the host's listing configuration, not the record
    const closed = {};
    expect(
      canAddClassCrunchLabsUnit(guardianOf('t-operator'), policy, closed),
    ).toBe(true);
    expect(
      canAddClassCrunchLabsUnit(guardianOf('t-other'), policy, closed),
    ).toBe(false);
    for (const publicListing of [false, undefined, 'true', 1] as never[])
      expect(
        canAddClassCrunchLabsUnit(guardianOf('t-other'), policy, {
          publicListing,
        }),
      ).toBe(false);
    expect(
      canAddClassCrunchLabsUnit(guardianOf('t-other'), policy, {
        publicListing: true,
      }),
    ).toBe(true);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'CourseBundleImport',
        'CourseBundleMember',
        'CourseBundleRendering',
      ],
    });
    try {
      const svc = new CourseBundleImportService(db, () => true);
      let read = 0;
      const files = {
        files: async () => {
          read++;
          return [];
        },
      };
      const other = guardianOf('t-other');
      await expect(
        addClassCrunchLabsUnit({
          service: svc,
          actor: { tenantId: other.tenantId, actorUserId: other.actorUserId },
          catalogActor: other,
          record,
          listing: closed,
          policy,
          files,
          playlists: playlists(PLAYLIST),
        }),
      ).rejects.toMatchObject({ code: 'access_denied' });
      // an actor that differs from the catalog identity is refused too
      const operator = guardianOf('t-operator');
      await expect(
        addClassCrunchLabsUnit({
          service: svc,
          actor: { tenantId: 't-other', actorUserId: operator.actorUserId },
          catalogActor: operator,
          record,
          listing: closed,
          policy,
          files,
          playlists: playlists(PLAYLIST),
        }),
      ).rejects.toMatchObject({ code: 'access_denied' });
      // a record the caller swapped to {visibility:'catalog'} changes nothing
      await expect(
        addClassCrunchLabsUnit({
          service: svc,
          actor: { tenantId: other.tenantId, actorUserId: other.actorUserId },
          catalogActor: other,
          record: { ...record, visibility: 'catalog' } as never,
          listing: closed,
          policy,
          files,
          playlists: playlists(PLAYLIST),
        }),
      ).rejects.toMatchObject({ code: 'access_denied' });
      // only the host's own switch opens it to everyone
      await expect(
        addClassCrunchLabsUnit({
          service: svc,
          actor: { tenantId: other.tenantId, actorUserId: other.actorUserId },
          catalogActor: other,
          record,
          listing: { publicListing: true },
          policy,
          files,
          playlists: playlists(PLAYLIST),
        }),
      ).rejects.toMatchObject({ code: 'no_unit' });
      expect(read).toBe(1);
    } finally {
      await db.close?.();
    }
  });
});

describe('reading a download from disk: hostile headers', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });
  it('refuses an entry that claims a huge or out-of-file compressed payload without allocating it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'crunchlabs-'));
    const zip = Buffer.from(
      buildZip([
        { name: `${L1}/A. L01_Manual_v1.0.pdf`, data: tinyPdf('m'), method: 0 },
      ]),
    );
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    for (const claimed of [0xfffffffe, 5 * 1024 * 1024, zip.length]) {
      const bad = Buffer.from(zip);
      bad.writeUInt32LE(claimed, cd + 20);
      await writeFile(join(dir, 'bad.zip'), bad);
      const [file] = await folderClassCrunchLabsSource(dir).files();
      await expect(file?.read()).rejects.toThrow(/implausible|truncated|size/);
    }
  });
});

describe('reading a download from disk', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('reads zip parts lazily, a loose folder, and collapses repeated exports', async () => {
    dir = await mkdtemp(join(tmpdir(), 'crunchlabs-'));
    const entries = unitFiles().filter((f) => !f.path.endsWith('.mp4'));
    // Drive-style parts of two exports, split across zips
    const half = Math.ceil(entries.length / 2);
    const part = (list: Entry[]) =>
      Buffer.from(buildZip(list.map((f) => ({ name: f.path, data: f.bytes }))));
    for (const stamp of ['20261102T164712Z', '20261103T040555Z']) {
      await writeFile(
        join(
          dir,
          `Marble Run Unit Material_Class CrunchLabs-${stamp}-1-001.zip`,
        ),
        part(entries.slice(0, half)),
      );
      await writeFile(
        join(
          dir,
          `Marble Run Unit Material_Class CrunchLabs-${stamp}-1-002.zip`,
        ),
        part(entries.slice(half)),
      );
    }
    // a loose, already-unzipped lesson and junk the reader must skip
    await mkdir(join(dir, 'loose', 'Marble Run_Lesson 3'), { recursive: true });
    await writeFile(
      join(
        dir,
        'loose',
        'Marble Run_Lesson 3',
        'A. L03_Teacher Mission Manual_Marble Run_v1.0.pdf',
      ),
      tinyPdf('l3 manual'),
    );
    await writeFile(join(dir, '.DS_Store'), 'junk');
    await writeFile(
      join(dir, 'L01.4 Video_MaterialsPrep_Ramps_Marble  Run-005.mp4'),
      'mp4',
    );
    await symlink('/etc/passwd', join(dir, 'link.pdf'));

    const listed = await folderClassCrunchLabsSource(dir).files();
    expect(listed.some((f) => f.path.endsWith('.DS_Store'))).toBe(false);
    expect(listed.some((f) => f.path.includes('link.pdf'))).toBe(false);
    const fromZip = listed.find((f) =>
      f.path.includes('L01_Teacher Mission Manual'),
    );
    expect(fromZip?.crc32).toMatch(/^[0-9a-f]{8}$/);
    expect(fromZip?.exportId).toMatch(/^2026110[23]T/);
    expect(Buffer.from((await fromZip?.read()) ?? []).toString()).toContain(
      'l1 manual',
    );

    const b = await buildClassCrunchLabsBundle({
      files: folderClassCrunchLabsSource(dir),
      playlists: playlists(PLAYLIST),
      pageCounter: async () => 2,
    });
    expect(b.report.duplicateExports).toBe(
      entries.filter((f) => /Marble Run_(All|Lesson)/.test(f.path)).length,
    );
    expect(b.report.superseded).toBe(0);
    expect(lessonOf(b, 'lesson-03')?.members).toHaveLength(1);
    // the mission logs and decks are real OOXML and pass the bundle's own checks
    const plan = planCourseBundle(readFileSet(b.bundle.files));
    expect(
      plan.members.filter((m) => m.kind === 'docx').length,
    ).toBeGreaterThan(0);
  });

  it('refuses a zip entry whose checksum or size does not hold', async () => {
    dir = await mkdtemp(join(tmpdir(), 'crunchlabs-'));
    const good = Buffer.from(
      buildZip([
        {
          name: `${L1}/A. L01_Teacher Mission Manual_Marble Run_v1.0.pdf`,
          data: tinyPdf('manual'),
          method: 0,
        },
      ]),
    );
    const bad = Buffer.from(good);
    // flip a byte of the stored payload: the CRC no longer matches
    const at = bad.indexOf('manual');
    bad[at] = bad[at] === 0x6d ? 0x6e : 0x6d;
    await writeFile(join(dir, 'bad.zip'), bad);
    const [file] = await folderClassCrunchLabsSource(dir).files();
    await expect(file?.read()).rejects.toThrow(/checksum|size/);
    await writeFile(join(dir, 'bad.zip'), Buffer.from('not a zip at all'));
    await expect(folderClassCrunchLabsSource(dir).files()).rejects.toThrow(
      /not a readable zip/,
    );
  });
});

describe('lesson steps (SMRT #4656)', () => {
  const U = 'Zoom Boom';
  const R = 'Zoom Boom Unit Material (Motion)_Class CrunchLabs';
  const Z1 = `${R}/${U}_Lesson 1`;
  const W = `${R}/${U}_All Unit Wide Materials`;
  const f = (path: string, label: string) => ({ path, bytes: tinyPdf(label) });
  const files = [
    f(`${Z1}/A. L01_Teacher Mission Manual_${U}_v1.0.pdf`, 'manual'),
    f(`${Z1}/B. L01_Mission Launch Deck Slides_${U}_v1.1_.pdf`, 'deck'),
    f(`${Z1}/C. L01_Student Mission Log_${U} v.1.1.pdf`, 'log'),
    f(
      `${Z1}/D. L01_Status Check Lesson Assessment Guidance_${U}_v1.0..pdf`,
      'g',
    ),
    f(`${Z1}/D. L01_Status Check Lesson Assessment_${U}_v1.0.pdf`, 'check'),
    {
      path: `${Z1}/D. L01_Status Check Lesson Assessment (Editable)_${U}_v1.0.docx`,
      bytes: officeDocx('check editable'),
    },
    f(`${Z1}/E. L01_Handouts_${U}_v1.0.pdf`, 'handout'),
    f(`${Z1}/F. L01_Trading Cards_${U}_v1.0.pdf`, 'cards'),
    f(`${W}/Supply List_${U}_v1.0.pdf`, 'supplies'),
    // Out of order on purpose: 2, 1b, 1.
    ...['2_Video_Recap', '1b_Video_Build', '1_Video_Intro'].map((n) => ({
      path: `${W}/G. ${U}_Videos (all lessons)/L01.${n}_${U}.mp4`,
      bytes: Buffer.from('v'),
    })),
  ];
  const playlist: ClassCrunchLabsPlaylist = {
    id: 'PLzoomboom01',
    title: `${U} | Class CrunchLabs`,
    items: [
      { videoId: 'ZZZZZZZZZZ2', title: `${U} | L01.2 | Recap`, position: 1 },
      { videoId: 'ZZZZZZZZZZ3', title: `${U} | L01.1b | Build`, position: 2 },
      { videoId: 'ZZZZZZZZZZ1', title: `${U} | L01.1 | Intro`, position: 3 },
    ],
  };

  it('puts slides first, each video at its real step code in numeric order, the check last, and the log in setup', async () => {
    const b = await buildClassCrunchLabsBundle({
      files: memoryClassCrunchLabsSource(files),
      playlists: { playlists: async () => [playlist] },
      pageCounter: async () => 3,
    });
    const plan = planCourseBundle(readFileSet(b.bundle.files)).materials;
    const lesson = plan.materials.filter((m) => m.lessonKey === 'lesson-01');
    const stepOf = (role: string) =>
      lesson.filter((m) => m.role === role).map((m) => m.step);
    expect(stepOf('slides')).toEqual([
      { key: 'launch', order: 0, label: 'Launch' },
    ]);
    // The printable PDF and the editable master are both the status check.
    expect(stepOf('assessment')).toEqual([
      { key: 'check', order: 9999, label: 'Status check' },
      { key: 'check', order: 9999, label: 'Status check' },
    ]);
    for (const role of [
      'learner-pages',
      'handout',
      'printable',
      'teacher-guide',
      'assessment-guidance',
    ])
      expect(stepOf(role)).toEqual([null]);
    // Course-level material has no step.
    expect(
      plan.materials.filter((m) => m.scope === 'course').map((m) => m.step),
    ).toEqual([null]);
    const videos = plan.videos.map((v) => [v.videoId, v.step]);
    expect(videos).toEqual(
      expect.arrayContaining([
        ['ZZZZZZZZZZ1', { key: '1', order: 1, label: 'Intro' }],
        ['ZZZZZZZZZZ3', { key: '1b', order: 1.02, label: 'Build' }],
        ['ZZZZZZZZZZ2', { key: '2', order: 2, label: 'Recap' }],
      ]),
    );
    expect(videos).toHaveLength(3);
    const order = (id: string) =>
      plan.videos.find((v) => v.videoId === id)?.step?.order as number;
    expect(order('ZZZZZZZZZZ1')).toBeLessThan(order('ZZZZZZZZZZ3'));
    expect(order('ZZZZZZZZZZ3')).toBeLessThan(order('ZZZZZZZZZZ2'));
  });

  it('orders step codes numerically, a suffix after its number and before the next', () => {
    expect(
      ['10', '2', '1b', '1', '1a'].sort(
        (a, b) => classCrunchLabsStepOrder(a) - classCrunchLabsStepOrder(b),
      ),
    ).toEqual(['1', '1a', '1b', '2', '10']);
  });
});
