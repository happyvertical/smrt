import { describe, expect, it } from 'vitest';
import {
  bundleProposalOutput,
  COURSE_BUNDLE_MATERIAL_ROLES,
  type CourseBundleRefusalReason,
  CourseBundleRefusedError,
  planCourseBundle,
  readFileSet,
} from '../index.js';
import { tinyPdf } from './bundle-zip-writer.js';

/*
 * Manifest version 2 (#4615), see docs/test-matrix/4615-manifest-v2.md:
 *  closed schema ........................................ 'closed'
 *  roles and audience defaults ......................... 'audience'
 *  lesson pages, course members, videos ................ 'materials'
 */
const VIDEO = 'dQw4w9WgXcQ';
const files = (manifest: unknown, extra: Record<string, string> = {}) => {
  const entries: Array<{ path: string; bytes: Uint8Array }> = [
    {
      path: 'manifest.json',
      bytes: Buffer.from(
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
      ),
    },
    { path: 'l1/log.pdf', bytes: tinyPdf('log') },
    { path: 'l1/guide.pdf', bytes: tinyPdf('guide') },
    { path: 'l1/check.pdf', bytes: tinyPdf('check') },
    { path: 'l1/guidance.pdf', bytes: tinyPdf('guidance') },
    { path: 'l1/handout.pdf', bytes: tinyPdf('handout') },
    { path: 'l1/notes.txt', bytes: Buffer.from('Learner reading.') },
    { path: 'l1/teacher-notes.txt', bytes: Buffer.from('Answers: 42.') },
    { path: 'unit/supplies.pdf', bytes: tinyPdf('supplies') },
    { path: 'unit/poster.pdf', bytes: tinyPdf('poster') },
  ];
  for (const [path, text] of Object.entries(extra))
    entries.push({ path, bytes: Buffer.from(text) });
  return entries;
};
const valid = () => ({
  version: 2,
  course: { subject: 'Science' },
  courseMembers: [
    { path: 'unit/supplies.pdf', role: 'attachment', title: 'Supply list' },
    { path: 'unit/poster.pdf', role: 'printable', audience: 'learner' },
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
            { path: 'l1/log.pdf', role: 'learner-pages' },
            { path: 'l1/guide.pdf', role: 'teacher-guide' },
            { path: 'l1/check.pdf', role: 'assessment' },
            { path: 'l1/guidance.pdf', role: 'assessment-guidance' },
            { path: 'l1/handout.pdf', role: 'handout', audience: 'guardian' },
            { path: 'l1/notes.txt', role: 'attachment' },
            { path: 'l1/teacher-notes.txt', role: 'teacher-guide' },
          ],
          pages: [
            { member: 'l1/log.pdf', from: 1, to: 3, label: 'Mission log' },
            { member: 'l1/log.pdf', from: 5, to: 5 },
          ],
          videos: [
            { reference: VIDEO, title: 'Recap', step: 1 },
            {
              reference: `https://youtu.be/AAAAAAAAAAA?t=4`,
              title: 'Materials',
              step: 2,
              audience: 'guardian',
            },
          ],
        },
      ],
    },
  ],
});
const plan = (manifest: unknown, extra: Record<string, string> = {}) =>
  planCourseBundle(readFileSet(files(manifest, extra)));
function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CourseBundleRefusedError);
    return error as CourseBundleRefusedError;
  }
  throw new Error('expected the manifest to be refused');
}
const refused = (
  mutate: (m: ReturnType<typeof valid>) => unknown,
  reason: CourseBundleRefusalReason,
  entry?: string,
) => {
  const manifest = valid();
  const out = mutate(manifest) ?? manifest;
  const error = refusal(() => plan(out));
  expect(error.reason).toBe(reason);
  if (entry) expect(error.entry).toBe(entry);
};
type Lesson = ReturnType<typeof valid>['sections'][number]['lessons'][number];
const lesson = (m: ReturnType<typeof valid>): Lesson =>
  m.sections[0]?.lessons[0] as Lesson;

describe('manifest version 2', () => {
  it('is detected by the manifest-v2 reader and keeps v1 on its own reader', () => {
    const p = plan(valid());
    expect(p.readerId).toBe('manifest-v2');
    expect(p.manifestVersion).toBe(2);
    const v1 = planCourseBundle(
      readFileSet([
        {
          path: 'manifest.json',
          bytes: Buffer.from(
            JSON.stringify({
              version: 1,
              sections: [
                {
                  key: 's',
                  title: 'S',
                  lessons: [
                    {
                      key: 'a',
                      title: 'A',
                      members: [{ path: 'a.pdf', role: 'exercise' }],
                    },
                  ],
                },
              ],
            }),
          ),
        },
        { path: 'a.pdf', bytes: tinyPdf('a') },
      ]),
    );
    expect(v1.readerId).toBe('manifest-v1');
    expect(v1.materials).toEqual({
      materials: [],
      pages: [],
      videos: [],
      skipped: [],
    });
  });

  describe('closed', () => {
    it('refuses an unknown key at every level with its path', () => {
      refused(
        (m) => ({ ...m, extra: 1 }),
        'manifest_unknown_key',
        'manifest.extra',
      );
      refused(
        (m) => ({ ...m, course: { subject: 'x', grade: 4 } }),
        'manifest_unknown_key',
        'manifest.course.grade',
      );
      refused(
        (m) => {
          (m.sections[0] as Record<string, unknown>).oops = 1;
        },
        'manifest_unknown_key',
        'manifest.sections.0.oops',
      );
      refused(
        (m) => {
          (lesson(m) as Record<string, unknown>).oops = 1;
        },
        'manifest_unknown_key',
        'manifest.sections.0.lessons.0.oops',
      );
      refused(
        (m) => {
          (lesson(m).members[0] as Record<string, unknown>).oops = 1;
        },
        'manifest_unknown_key',
        'manifest.sections.0.lessons.0.members.0.oops',
      );
      refused(
        (m) => {
          (lesson(m).pages[0] as Record<string, unknown>).oops = 1;
        },
        'manifest_unknown_key',
        'manifest.sections.0.lessons.0.pages.0.oops',
      );
      refused(
        (m) => {
          (lesson(m).videos[0] as Record<string, unknown>).oops = 1;
        },
        'manifest_unknown_key',
        'manifest.sections.0.lessons.0.videos.0.oops',
      );
      refused(
        (m) => {
          (m.courseMembers[0] as Record<string, unknown>).oops = 1;
        },
        'manifest_unknown_key',
        'manifest.courseMembers.0.oops',
      );
    });

    it('refuses a version 1 page role and unknown or non-file roles on a v2 member', () => {
      for (const role of ['exercise', 'answer_key', 'poster', 'video', 5])
        refused(
          (m) => {
            lesson(m).members[0] = { path: 'l1/log.pdf', role } as never;
          },
          'manifest_role',
          'manifest.sections.0.lessons.0.members.0.role',
        );
      refused((m) => {
        lesson(m).members[0] = { path: 'l1/log.pdf' } as never;
      }, 'manifest_role');
    });

    it('refuses a member that is missing, listed twice, or the manifest itself', () => {
      refused((m) => {
        lesson(m).members.push({ path: 'nope.pdf', role: 'handout' } as never);
      }, 'manifest_missing_member');
      refused((m) => {
        m.courseMembers.push({ path: 'l1/log.pdf', role: 'handout' } as never);
      }, 'manifest_duplicate_member');
      refused((m) => {
        lesson(m).members.push({
          path: 'manifest.json',
          role: 'handout',
        } as never);
      }, 'manifest_missing_member');
    });

    it('refuses duplicate keys, a bad key and a missing section list', () => {
      refused((m) => {
        m.sections.push({ ...m.sections[0] } as never);
      }, 'duplicate_key');
      refused((m) => {
        lesson(m).key = 'bad key!';
      }, 'manifest_invalid');
      refused((m) => ({ ...m, sections: [] }), 'manifest_invalid');
    });

    it('refuses an unreadable document', () => {
      expect(refusal(() => plan('{ nope')).reason).toBe('manifest_invalid');
      expect(refusal(() => plan('{"version":2}')).reason).toBe(
        'manifest_invalid',
      );
    });
  });

  describe('audience', () => {
    it('defaults by role, and a stated audience wins within the role bounds', () => {
      const p = plan(valid());
      const audience = Object.fromEntries(
        p.materials.materials.map((m) => [m.path, m.audience]),
      );
      expect(audience).toMatchObject({
        'l1/log.pdf': 'learner',
        'l1/guide.pdf': 'guardian',
        'l1/check.pdf': 'learner',
        'l1/guidance.pdf': 'guardian',
        'l1/handout.pdf': 'guardian',
        'l1/notes.txt': 'learner',
        'unit/supplies.pdf': 'learner',
        'unit/poster.pdf': 'learner',
      });
      for (const member of p.members.filter((m) => m.path.startsWith('l1/')))
        expect(p.placements.get(member.path)?.audience).toBe(
          audience[member.path],
        );
      // slides default to guardian, and may be shown to the learner by choice
      expect(
        plan({
          ...valid(),
          sections: [
            {
              key: 'unit',
              title: 'Unit',
              lessons: [
                {
                  key: 'l1',
                  title: 'L',
                  members: [
                    { path: 'l1/log.pdf', role: 'slides' },
                    {
                      path: 'l1/guide.pdf',
                      role: 'slides',
                      audience: 'learner',
                    },
                  ],
                },
              ],
            },
          ],
          courseMembers: [],
        }).materials.materials.map((m) => m.audience),
      ).toEqual(['guardian', 'learner']);
    });

    it.each([
      'answer-key',
      'assessment-guidance',
    ])('keeps %s guardian-only: a learner audience is refused', (role) => {
      refused(
        (m) => {
          lesson(m).members[0] = {
            path: 'l1/log.pdf',
            role,
            audience: 'learner',
          } as never;
        },
        'manifest_audience',
        'manifest.sections.0.lessons.0.members.0.audience',
      );
      const p = plan({
        ...valid(),
        sections: [
          {
            key: 'unit',
            title: 'Unit',
            lessons: [
              {
                key: 'l1',
                title: 'L',
                members: [{ path: 'l1/log.pdf', role }],
              },
            ],
          },
        ],
        courseMembers: [],
      });
      expect(p.materials.materials[0]?.audience).toBe('guardian');
    });

    it('refuses an unknown audience', () => {
      refused((m) => {
        lesson(m).members[0] = {
          path: 'l1/log.pdf',
          role: 'handout',
          audience: 'everyone',
        } as never;
      }, 'manifest_audience');
      refused((m) => {
        lesson(m).videos[0] = {
          ...lesson(m).videos[0],
          audience: 'x',
        } as never;
      }, 'manifest_audience');
    });

    it('offers every material role except video', () => {
      expect(COURSE_BUNDLE_MATERIAL_ROLES).toEqual([
        'teacher-guide',
        'slides',
        'learner-pages',
        'assessment',
        'assessment-guidance',
        'handout',
        'printable',
        'answer-key',
        'attachment',
      ]);
    });

    it('never lets guardian-audience text into a lesson body', () => {
      const body = (
        bundleProposalOutput(plan(valid())).lessons[0] as { body?: string }
      ).body;
      expect(body).toBe('Learner reading.');
      expect(body).not.toContain('Answers');
    });
  });

  describe('lesson steps (SMRT #4656)', () => {
    const withStep = (step: unknown) => (m: ReturnType<typeof valid>) => {
      (lesson(m).members[2] as Record<string, unknown>).step = step;
    };
    it('carries a member step and a video step object into the plan', () => {
      const manifest = valid();
      withStep({ key: '1b', order: 1.02, label: 'Status check' })(manifest);
      (lesson(manifest).videos[0] as Record<string, unknown>).step = {
        key: '6',
        order: 6.5,
      };
      const p = plan(manifest).materials;
      expect(p.materials.find((m) => m.path === 'l1/check.pdf')?.step).toEqual({
        key: '1b',
        order: 1.02,
        label: 'Status check',
      });
      expect(p.materials.find((m) => m.path === 'l1/log.pdf')?.step).toBeNull();
      const video = p.videos.find((v) => v.title === 'Recap');
      expect(video?.step).toEqual({ key: '6', order: 6.5, label: '' });
      expect(video?.stepOrder).toBe(6);
    });
    it.each([
      [{ key: '', order: 1 }],
      [{ key: 'k'.repeat(33), order: 1 }],
      [{ key: 'bad key', order: 1 }],
      [{ key: 'a', order: Number.NaN }],
      [{ key: 'a', order: '1' }],
      [{ key: 'a' }],
      [{ key: 'a', order: 1, label: '' }],
      ['launch'],
    ])('refuses the step %j', (step) => {
      refused(withStep(step), 'manifest_invalid');
    });
    it('refuses an unknown step key', () => {
      refused(
        withStep({ key: 'a', order: 1, extra: true }),
        'manifest_unknown_key',
      );
    });
    it('accepts a key of 32 characters and refuses a step on a course member', () => {
      expect(() =>
        plan(
          (() => {
            const m = valid();
            withStep({ key: 'k'.repeat(32), order: 0 })(m);
            return m;
          })(),
        ),
      ).not.toThrow();
      refused((m) => {
        (m.courseMembers[0] as Record<string, unknown>).step = {
          key: 'a',
          order: 1,
        };
      }, 'manifest_unknown_key');
    });
  });

  describe('materials', () => {
    it('places lesson members in declared order and course members apart', () => {
      const p = plan(valid());
      const lessonMaterials = p.materials.materials.filter(
        (m) => m.scope === 'lesson',
      );
      expect(lessonMaterials.map((m) => [m.path, m.role, m.sortOrder])).toEqual(
        [
          ['l1/log.pdf', 'learner-pages', 0],
          ['l1/guide.pdf', 'teacher-guide', 1],
          ['l1/check.pdf', 'assessment', 2],
          ['l1/guidance.pdf', 'assessment-guidance', 3],
          ['l1/handout.pdf', 'handout', 4],
          ['l1/notes.txt', 'attachment', 5],
          ['l1/teacher-notes.txt', 'teacher-guide', 6],
        ],
      );
      expect(lessonMaterials.every((m) => m.lessonKey === 'l1')).toBe(true);
      const course = p.materials.materials.filter((m) => m.scope === 'course');
      expect(course.map((m) => [m.path, m.role, m.title, m.lessonKey])).toEqual(
        [
          ['unit/supplies.pdf', 'attachment', 'Supply list', null],
          ['unit/poster.pdf', 'printable', '', null],
        ],
      );
      expect(p.placements.get('unit/supplies.pdf')).toMatchObject({
        lessonKey: null,
        role: 'attachment',
        audience: 'learner',
      });
    });

    it('turns page ranges into numbered lesson pages sourced from the member', () => {
      const { pages } = plan(valid()).materials;
      expect(
        pages.map((p) => [p.pageKey, p.label, p.sortOrder, p.sourcePageNumber]),
      ).toEqual([
        ['p1', 'Mission log 1', 0, 1],
        ['p2', 'Mission log 2', 1, 2],
        ['p3', 'Mission log 3', 2, 3],
        ['p5', 'Page 5', 3, 5],
      ]);
      expect(new Set(pages.map((p) => p.path))).toEqual(
        new Set(['l1/log.pdf']),
      );
      expect(new Set(pages.map((p) => p.lessonKey))).toEqual(new Set(['l1']));
    });

    it('refuses malformed, unlisted, overlapping and unpageable page ranges', () => {
      const withPages = (
        pages: unknown[],
        extra?: (m: ReturnType<typeof valid>) => void,
      ) =>
        refused((m) => {
          lesson(m).pages = pages as never;
          extra?.(m);
        }, 'manifest_pages');
      withPages([{ member: 'l1/guide.pdf', from: 3, to: 2 }]);
      withPages([{ member: 'unit/poster.pdf', from: 1, to: 1 }]); // course member, not in the lesson
      withPages([
        { member: 'l1/log.pdf', from: 1, to: 3 },
        { member: 'l1/log.pdf', from: 3, to: 4 },
      ]);
      withPages([{ member: 'l1/log.pdf', from: 1, to: 600 }]);
      withPages([{ member: 'l1/notes.txt', from: 1, to: 1 }]); // text cannot be paged
      refused((m) => {
        lesson(m).pages = [{ member: 'l1/log.pdf', from: 0, to: 1 }] as never;
      }, 'manifest_invalid');
      refused((m) => {
        lesson(m).pages = [{ member: 'l1/log.pdf', from: 1.5, to: 2 }] as never;
      }, 'manifest_invalid');
    });

    it('turns allowlisted video references into YouTube ids with title and step', () => {
      const { videos } = plan(valid()).materials;
      expect(videos).toEqual([
        {
          sectionKey: 'unit',
          lessonKey: 'l1',
          provider: 'youtube',
          videoId: VIDEO,
          title: 'Recap',
          stepOrder: 1,
          step: null,
          audience: 'learner',
        },
        {
          sectionKey: 'unit',
          lessonKey: 'l1',
          provider: 'youtube',
          videoId: 'AAAAAAAAAAA',
          title: 'Materials',
          stepOrder: 2,
          step: null,
          audience: 'guardian',
        },
      ]);
    });

    it.each([
      'https://vimeo.com/123456789',
      'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/playlist?list=PL1',
      'short',
      '',
    ])('refuses the video reference %j', (reference) => {
      refused((m) => {
        lesson(m).videos[0] = { reference, title: 'x', step: 1 } as never;
      }, 'manifest_video');
    });

    it('refuses a repeated video, a missing title and a bad step', () => {
      refused((m) => {
        lesson(m).videos.push({
          reference: VIDEO,
          title: 'again',
          step: 3,
        } as never);
      }, 'duplicate_key');
      refused((m) => {
        lesson(m).videos[0] = { reference: VIDEO, step: 1 } as never;
      }, 'manifest_invalid');
      for (const step of [-1, 1.5, '1', 10_000])
        refused((m) => {
          lesson(m).videos[0] = { reference: VIDEO, title: 'x', step } as never;
        }, 'manifest_invalid');
    });

    it('resolves a duplicate member to the earlier identical bytes and joins it once per place', () => {
      const m = valid();
      lesson(m).members.push({
        path: 'l1/copy-of-log.pdf',
        role: 'learner-pages',
      } as never);
      const entries = files(m);
      entries.push({ path: 'l1/copy-of-log.pdf', bytes: tinyPdf('log') });
      const p = planCourseBundle(readFileSet(entries));
      const copy = p.members.find((x) => x.path === 'l1/copy-of-log.pdf');
      expect(copy).toMatchObject({
        status: 'duplicate',
        duplicateOf: 'l1/log.pdf',
      });
      expect(
        p.materials.materials
          .filter((x) => x.role === 'learner-pages')
          .map((x) => x.assetPath),
      ).toEqual(['l1/log.pdf']);
    });

    it('records an unusable declared member as skipped instead of half-applying it', () => {
      const m = valid();
      lesson(m).members.push({ path: 'l1/blob.bin', role: 'handout' } as never);
      const entries = files(m);
      entries.push({
        path: 'l1/blob.bin',
        bytes: Buffer.from([1, 2, 3, 0, 255]),
      });
      const p = planCourseBundle(readFileSet(entries));
      expect(p.materials.skipped).toEqual([
        { path: 'l1/blob.bin', reason: 'unsupported_type' },
      ]);
      expect(p.materials.materials.some((x) => x.path === 'l1/blob.bin')).toBe(
        false,
      );
    });
  });
});
