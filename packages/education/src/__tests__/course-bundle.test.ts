import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  type BundleReaderRegistry,
  bundleProposalOutput,
  COURSE_BUNDLE_LIMITS,
  type CourseBundleRefusalReason,
  CourseBundleRefusedError,
  createBundleReaderRegistry,
  naturalCompare,
  normalizeBundlePath,
  planCourseBundle,
  readFileSet,
  readZipArchive,
  resolveCourseBundleLimits,
  unpackBundle,
} from '../index.js';
import {
  buildZip,
  buildZipLayout,
  mulberry32,
  tinyPdf,
  tinyPng,
} from './bundle-zip-writer.js';

/*
 * Course bundle parser matrix (#4578), see docs/test-matrix/4578-course-bundle-import.md.
 * Every hostile archive must raise CourseBundleRefusedError with a stable reason.
 */
function refusal(run: () => unknown): CourseBundleRefusedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CourseBundleRefusedError);
    return error as CourseBundleRefusedError;
  }
  throw new Error('expected the bundle to be refused');
}
const reason = (run: () => unknown): CourseBundleRefusalReason =>
  refusal(run).reason;
const limits = (override = {}) => resolveCourseBundleLimits(override);

describe('zip reader: valid archives', () => {
  it('reads stored and deflated members, sorted, with hashes', () => {
    const zip = buildZip([
      { name: 'b/two.txt', data: 'two', method: 0 },
      { name: 'a.txt', data: 'one'.repeat(40) },
      { name: 'dir/', data: '', method: 0 },
    ]);
    const members = readZipArchive(zip);
    expect(members.map((m) => m.path)).toEqual(['a.txt', 'b/two.txt']);
    expect(members[1]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(members[0]?.bytes as Uint8Array).toString()).toBe(
      'one'.repeat(40),
    );
  });

  it('normalises backslashes in names and an EOCD comment that merely contains the signature', () => {
    const fake = Buffer.alloc(22);
    fake.writeUInt32LE(0x06054b50, 0);
    fake.writeUInt16LE(500, 20); // length does not fit the end of the file
    const zip = buildZip([{ name: 'dir\\file.txt', data: 'hi' }], {
      comment: fake,
    });
    expect(readZipArchive(zip).map((m) => m.path)).toEqual(['dir/file.txt']);
  });

  it('is deterministic across archive member order and timestamps', () => {
    const a = unpackBundle({
      archive: buildZip([
        { name: 'x.txt', data: '1' },
        { name: 'y.txt', data: '2' },
      ]),
    });
    const b = unpackBundle({
      archive: buildZip([
        { name: 'y.txt', data: '2' },
        { name: 'x.txt', data: '1' },
      ]),
    });
    expect(a.map((m) => [m.path, m.sha256])).toEqual(
      b.map((m) => [m.path, m.sha256]),
    );
  });
});

describe('zip reader: hostile archives', () => {
  it('refuses a compression bomb by ratio before inflating', () => {
    const zeros = Buffer.alloc(20 * 1024 * 1024);
    const reasonCode = reason(() =>
      readZipArchive(buildZip([{ name: 'bomb.txt', data: zeros }])),
    );
    expect(reasonCode).toBe('compression_ratio');
  });

  it('refuses a bomb whose central directory lies about its size', () => {
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    // Declares 100 bytes: inflate is capped at the declared size, never the real one.
    expect(
      reason(() =>
        readZipArchive(buildZip([{ name: 'l.txt', data: zeros, size: 100 }])),
      ),
    ).toBe('size_mismatch');
  });

  it('refuses too many entries', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      name: `f${i}.txt`,
      data: 'x',
    }));
    expect(reason(() => readZipArchive(buildZip(many)))).toBe(
      'too_many_entries',
    );
    expect(
      reason(() =>
        readZipArchive(buildZip(many.slice(0, 4)), limits({ maxEntries: 3 })),
      ),
    ).toBe('too_many_entries');
  });

  it('records an honestly oversize member as refused without inflating it', () => {
    const zip = buildZip([
      { name: 'big.pdf', data: tinyPdf('big') },
      { name: 'small.txt', data: 'ok' },
    ]);
    const members = readZipArchive(zip, limits({ maxEntryBytes: 20 }));
    expect(members.find((m) => m.path === 'big.pdf')).toMatchObject({
      refusal: 'entry_too_large',
      bytes: null,
      sha256: null,
    });
    expect(members.find((m) => m.path === 'small.txt')?.refusal).toBeNull();
  });

  it('refuses an oversize total and an oversize archive', () => {
    const zip = buildZip([
      { name: 'a.txt', data: 'a'.repeat(60) },
      { name: 'b.txt', data: 'b'.repeat(60) },
    ]);
    expect(
      reason(() => readZipArchive(zip, limits({ maxTotalBytes: 100 }))),
    ).toBe('total_too_large');
    expect(
      reason(() => readZipArchive(zip, limits({ maxArchiveBytes: 50 }))),
    ).toBe('archive_too_large');
  });

  it('refuses declared sizes that disagree with the real bytes', () => {
    for (const patch of [{ size: 5 }, { size: 500 }]) {
      expect(
        reason(() =>
          readZipArchive(
            buildZip([
              { name: 'a.txt', data: 'hello world'.repeat(5), ...patch },
            ]),
          ),
        ),
      ).toBe('size_mismatch');
    }
    // Stored entry whose compressed and real sizes differ.
    expect(
      reason(() =>
        readZipArchive(
          buildZip([{ name: 's.txt', data: 'abc', method: 0, size: 2 }]),
        ),
      ),
    ).toBe('size_mismatch');
  });

  it('refuses truncated archives', () => {
    const zip = buildZip([{ name: 'a.txt', data: 'hello world'.repeat(20) }]);
    expect(reason(() => readZipArchive(zip.subarray(0, zip.length - 8)))).toBe(
      'truncated',
    );
    expect(reason(() => readZipArchive(zip.subarray(0, 10)))).toBe('not_a_zip');
    expect(
      reason(() => readZipArchive(Buffer.from('not a zip at all, sorry!'))),
    ).toBe('not_a_zip');
    // Valid end record, central directory cut away.
    const layout = buildZipLayout([{ name: 'a.txt', data: 'abc' }]);
    const cut = Buffer.concat([
      layout.bytes.subarray(0, layout.cdOffset),
      layout.bytes.subarray(layout.eocd),
    ]);
    expect(reason(() => readZipArchive(cut))).toBe('invalid_central_directory');
  });

  it('refuses an ambiguous end record forged inside the comment', () => {
    const inner = buildZipLayout([{ name: 'evil.txt', data: 'evil' }]);
    const fake = Buffer.from(inner.bytes.subarray(inner.eocd, inner.eocd + 22));
    // A forged record whose own comment length runs exactly to the file end.
    const comment = Buffer.concat([Buffer.from('xx'), fake]);
    fake.writeUInt16LE(0, 20);
    const zip = buildZip([{ name: 'real.txt', data: 'real' }], { comment });
    expect(reason(() => readZipArchive(zip))).toBe('ambiguous_end_record');
  });

  it('refuses out-of-range and overlapping entry offsets', () => {
    const layout = buildZipLayout([
      { name: 'a.txt', data: 'a'.repeat(200) },
      { name: 'b.txt', data: 'b'.repeat(200) },
    ]);
    const moved = Buffer.from(layout.bytes);
    moved.writeUInt32LE(
      layout.cdOffset + 1000,
      (layout.centrals[1] as number) + 42,
    );
    expect(reason(() => readZipArchive(moved))).toBe('entry_out_of_range');

    const longer = Buffer.from(layout.bytes);
    longer.writeUInt32LE(
      longer.readUInt32LE((layout.centrals[0] as number) + 20) + 30,
      (layout.centrals[0] as number) + 20,
    );
    expect(reason(() => readZipArchive(longer))).toBe('overlapping_entries');

    const beyond = Buffer.from(layout.bytes);
    beyond.writeUInt32LE(0x7fffff00, (layout.centrals[0] as number) + 20);
    expect(['entry_out_of_range', 'compression_ratio']).toContain(
      reason(() => readZipArchive(beyond)),
    );

    const wrongName = buildZip([
      { name: 'a.txt', data: 'a', localName: 'z.txt' },
    ]);
    expect(reason(() => readZipArchive(wrongName))).toBe(
      'local_header_mismatch',
    );
  });

  it('refuses zip64 and multi-disk records', () => {
    const layout = buildZipLayout([{ name: 'a.txt', data: 'a' }]);
    const zip64 = Buffer.from(layout.bytes);
    zip64.writeUInt16LE(0xffff, layout.eocd + 10);
    expect(reason(() => readZipArchive(zip64))).toBe('zip64_unsupported');
    const disks = Buffer.from(layout.bytes);
    disks.writeUInt16LE(1, layout.eocd + 4);
    expect(reason(() => readZipArchive(disks))).toBe('multi_disk');
    const big = Buffer.from(layout.bytes);
    big.writeUInt32LE(0xffffffff, (layout.centrals[0] as number) + 24);
    expect(reason(() => readZipArchive(big))).toBe('zip64_unsupported');
  });

  it('refuses a bad CRC and unsupported compression', () => {
    expect(
      reason(() =>
        readZipArchive(buildZip([{ name: 'a.txt', data: 'abc', crc: 1234 }])),
      ),
    ).toBe('bad_crc');
    expect(
      reason(() =>
        readZipArchive(buildZip([{ name: 'a.txt', data: 'abc', method: 12 }])),
      ),
    ).toBe('unsupported_method');
    expect(
      reason(() =>
        readZipArchive(
          buildZip([
            {
              name: 'a.txt',
              data: 'abc',
              raw: Buffer.from('garbage!'),
              size: 3,
            },
          ]),
        ),
      ),
    ).toBe('inflate_failed');
  });

  it('refuses encrypted entries (traditional, strong, AES)', () => {
    for (const spec of [{ flags: 1 }, { flags: 0x40 }, { method: 99 }]) {
      expect(
        reason(() =>
          readZipArchive(buildZip([{ name: 'a.txt', data: 'x', ...spec }])),
        ),
      ).toBe('encrypted_entry');
    }
  });

  it('refuses symlinks and special files by unix mode', () => {
    const unix = 3 << 8;
    expect(
      reason(() =>
        readZipArchive(
          buildZip([
            {
              name: 'link',
              data: '../../etc/passwd',
              madeBy: unix | 20,
              external: (0o120777 << 16) >>> 0,
            },
          ]),
        ),
      ),
    ).toBe('symlink_entry');
    expect(
      reason(() =>
        readZipArchive(
          buildZip([
            {
              name: 'dev',
              data: '',
              madeBy: unix | 20,
              external: (0o060644 << 16) >>> 0,
            },
          ]),
        ),
      ),
    ).toBe('special_entry');
    // A regular unix file is fine.
    expect(
      readZipArchive(
        buildZip([
          {
            name: 'ok.txt',
            data: 'x',
            madeBy: unix | 20,
            external: (0o100644 << 16) >>> 0,
          },
        ]),
      ),
    ).toHaveLength(1);
  });

  it('refuses duplicate member names, including case and normalisation twins', () => {
    for (const names of [
      ['a.txt', 'a.txt'],
      ['a.txt', 'A.TXT'],
      ['d/a.txt', 'd\\a.txt'],
    ]) {
      expect(
        reason(() =>
          readZipArchive(buildZip(names.map((name) => ({ name, data: 'x' })))),
        ),
      ).toBe('duplicate_name');
    }
  });
});

describe('path validation', () => {
  it.each([
    ['../evil.txt'],
    ['a/../../evil.txt'],
    ['a\\..\\..\\evil.txt'],
    ['/etc/passwd'],
    ['\\\\server\\share\\x.txt'],
    ['C:\\Windows\\x.txt'],
    ['c:/x.txt'],
    ['a/b:stream.txt'],
    ['a//b.txt'],
    ['a/./b.txt'],
    ['a\u0000b.txt'],
    ['a\nb.txt'],
    ['a\u202eb.txt'],
    ['\ud800.txt'],
    [''],
  ])('refuses %j', (name) => {
    expect(() => normalizeBundlePath(name)).toThrow(CourseBundleRefusedError);
    // The same hostile name inside an archive refuses the whole archive.
    // (A lone surrogate cannot be written into an archive: UTF-8 encoding replaces it.)
    if (name.length > 0 && name !== '\ud800.txt')
      expect(() => readZipArchive(buildZip([{ name, data: 'x' }]))).toThrow(
        CourseBundleRefusedError,
      );
  });

  it('refuses over-deep and over-long names', () => {
    expect(reason(() => normalizeBundlePath('a/b/c/d/e/f/g/h/i.txt'))).toBe(
      'path_too_deep',
    );
    expect(reason(() => normalizeBundlePath(`${'a'.repeat(300)}.txt`))).toBe(
      'invalid_path',
    );
  });

  it('applies the same rules to a plain file set', () => {
    expect(
      reason(() =>
        readFileSet([{ path: '../x.txt', bytes: Buffer.from('x') }]),
      ),
    ).toBe('invalid_path');
    expect(
      reason(() =>
        readFileSet([
          { path: 'a.txt', bytes: Buffer.from('x') },
          { path: 'A.txt', bytes: Buffer.from('y') },
        ]),
      ),
    ).toBe('duplicate_name');
    expect(reason(() => readFileSet([]))).toBe('empty_bundle');
  });

  it('enforces a lowered maxTotalBytes on a plain file set like an archive', () => {
    const files = [
      { path: 'a.txt', bytes: Buffer.from('a'.repeat(600)) },
      { path: 'b.txt', bytes: Buffer.from('b'.repeat(600)) },
    ];
    expect(
      reason(() => readFileSet(files, limits({ maxTotalBytes: 1000 }))),
    ).toBe('total_too_large');
    expect(readFileSet(files, limits({ maxTotalBytes: 1200 }))).toHaveLength(2);
  });
});

describe('limits', () => {
  it('can only be lowered, never raised', () => {
    const resolved = resolveCourseBundleLimits({
      maxEntries: 10_000_000,
      maxEntryBytes: 5,
      maxTotalBytes: -1,
    });
    expect(resolved.maxEntries).toBe(COURSE_BUNDLE_LIMITS.maxEntries);
    expect(resolved.maxEntryBytes).toBe(5);
    expect(resolved.maxTotalBytes).toBe(COURSE_BUNDLE_LIMITS.maxTotalBytes);
  });
});

describe('classification and planning', () => {
  const plan = (
    files: Array<[string, Buffer | string]>,
    registry?: BundleReaderRegistry,
  ) =>
    planCourseBundle(
      readFileSet(
        files.map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes) })),
      ),
      registry,
    );

  it('sorts naturally and deterministically, one lesson per accepted member', () => {
    const files: Array<[string, Buffer | string]> = [
      ['unit-1/lesson 10.pdf', tinyPdf('ten')],
      ['unit-1/lesson 2.pdf', tinyPdf('two')],
      ['unit-2/page.png', tinyPng(1)],
      ['intro.txt', 'Welcome to the course.'],
    ];
    const a = plan(files);
    const b = plan([...files].reverse());
    expect(a.members.map((m) => m.path)).toEqual(b.members.map((m) => m.path));
    expect(a.bundleIdentity).toBe(b.bundleIdentity);
    expect(a.members.map((m) => m.path)).toEqual([
      'intro.txt',
      'unit-1/lesson 2.pdf',
      'unit-1/lesson 10.pdf',
      'unit-2/page.png',
    ]);
    expect(JSON.stringify(a.structure)).toBe(JSON.stringify(b.structure));
    expect(a.structure.sections.map((s) => s.title)).toEqual([
      'Files',
      'unit 1',
      'unit 2',
    ]);
    expect(naturalCompare('a2', 'a10')).toBeLessThan(0);
  });

  it('records duplicate content once and keeps the duplicate as evidence', () => {
    const p = plan([
      ['a/first.pdf', tinyPdf('same')],
      ['b/copy.pdf', tinyPdf('same')],
      ['c/other.pdf', tinyPdf('other')],
    ]);
    const copy = p.members.find((m) => m.path === 'b/copy.pdf');
    expect(copy).toMatchObject({
      status: 'duplicate',
      reason: 'duplicate_content',
      duplicateOf: 'a/first.pdf',
      bytes: null,
    });
    expect(
      p.structure.sections.flatMap((s) => s.lessons.flatMap((l) => l.paths)),
    ).toEqual(['a/first.pdf', 'c/other.pdf']);
  });

  it('keeps unsupported, nested-archive, unreadable and encrypted members visible', () => {
    const nested = buildZip([{ name: 'inner.txt', data: 'inner' }]);
    const p = plan([
      ['notes.docx', 'PK-not-really'],
      ['inner.zip', nested],
      ['bad.txt', Buffer.from([0xff, 0xfe, 0xfd])],
      ['locked.pdf', tinyPdf('locked', true)],
      ['ok.pdf', tinyPdf('ok')],
    ]);
    const by = Object.fromEntries(p.members.map((m) => [m.path, m]));
    expect(by['notes.docx']).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported_type',
    });
    expect(by['inner.zip']).toMatchObject({
      status: 'unsupported',
      reason: 'nested_archive',
    });
    expect(by['bad.txt']).toMatchObject({
      status: 'unsupported',
      reason: 'unreadable_text',
    });
    expect(by['locked.pdf']).toMatchObject({
      kind: 'pdf',
      status: 'refused',
      reason: 'encrypted_pdf',
      bytes: null,
    });
    expect(by['ok.pdf']?.status).toBe('accepted');
    // Only the accepted member becomes a lesson.
    expect(p.structure.sections.flatMap((s) => s.lessons)).toHaveLength(1);
  });

  it('records an oversize member as refused', () => {
    const raw = readFileSet(
      [{ path: 'big.pdf', bytes: tinyPdf('x'.repeat(100)) }],
      limits({ maxEntryBytes: 10 }),
    );
    const p = planCourseBundle(raw);
    expect(p.members[0]).toMatchObject({
      status: 'refused',
      reason: 'entry_too_large',
    });
  });

  it('refuses a bundle that would propose more lessons than the schema allows', () => {
    const files = Array.from({ length: 51 }, (_, i) => ({
      path: `f${i}.txt`,
      bytes: Buffer.from(`lesson ${i}`),
    }));
    expect(reason(() => planCourseBundle(readFileSet(files)))).toBe(
      'too_many_lessons',
    );
  });

  it('refuses a lesson whose combined text is over the body cap instead of dropping it', () => {
    const files = [
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
                    key: 'long',
                    title: 'Long',
                    members: [{ path: 'a.txt' }, { path: 'b.txt' }],
                  },
                ],
              },
            ],
          }),
        ),
      },
      { path: 'a.txt', bytes: Buffer.from('a'.repeat(60)) },
      { path: 'b.txt', bytes: Buffer.from('b'.repeat(60)) },
    ];
    const capped = limits({ maxLessonBodyChars: 100 });
    let refused: unknown;
    try {
      planCourseBundle(readFileSet(files, capped), undefined, capped);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(CourseBundleRefusedError);
    expect(refused).toMatchObject({
      reason: 'lesson_too_large',
      entry: 'long',
    });
    // Each member alone fits; together they fit under the default cap.
    const plan = planCourseBundle(readFileSet(files));
    expect(
      (bundleProposalOutput(plan).lessons[0] as { body?: string }).body,
    ).toHaveLength(122);
  });

  describe('manifest', () => {
    const manifest = (value: unknown) =>
      ['manifest.json', JSON.stringify(value)] as [string, string];
    const valid = {
      version: 1,
      course: { subject: 'Math' },
      sections: [
        {
          key: 'unit-1',
          title: 'Unit One',
          lessons: [
            {
              key: 'sums',
              title: 'Sums',
              members: [
                { path: 'sheets/sums.pdf', role: 'exercise' },
                { path: 'keys/sums-key.pdf', role: 'answer_key' },
                { path: 'notes.txt' },
              ],
            },
          ],
        },
      ],
    };
    const files = (): Array<[string, Buffer | string]> => [
      manifest(valid),
      ['sheets/sums.pdf', tinyPdf('sums')],
      ['keys/sums-key.pdf', tinyPdf('key')],
      ['notes.txt', 'Read this first.'],
      ['extra.png', tinyPng(7)],
    ];

    it('lays out declared sections, lessons and page roles', () => {
      const p = plan(files());
      expect(p.readerId).toBe('manifest-v1');
      expect(p.manifestVersion).toBe(1);
      expect(p.structure).toMatchObject({
        subject: 'Math',
        sections: [
          {
            key: 'unit-1',
            lessons: [
              {
                key: 'sums',
                paths: ['sheets/sums.pdf', 'keys/sums-key.pdf', 'notes.txt'],
                roles: ['exercise', 'answer_key', ''],
              },
            ],
          },
        ],
      });
      expect(p.placements.get('keys/sums-key.pdf')).toMatchObject({
        lessonKey: 'sums',
        role: 'answer_key',
      });
      // Unlisted members stay visible, unplaced.
      expect(p.placements.get('extra.png')).toMatchObject({ lessonKey: null });
      expect(p.members.find((m) => m.path === 'manifest.json')?.status).toBe(
        'metadata',
      );
      const output = bundleProposalOutput(p) as {
        lessons: Array<{ body?: string; sectionKey: string }>;
      };
      expect(output.lessons).toHaveLength(1);
      expect(output.lessons[0]?.body).toBe('Read this first.');
    });

    it('withholds answer_key and mixed text from lesson bodies', () => {
      const set: Array<[string, Buffer | string]> = [
        manifest({
          version: 1,
          sections: [
            {
              key: 's',
              title: 'S',
              lessons: [
                {
                  key: 'l',
                  title: 'L',
                  members: [
                    { path: 'a.txt', role: 'instructions' },
                    { path: 'k.txt', role: 'answer_key' },
                    { path: 'm.txt', role: 'mixed' },
                  ],
                },
              ],
            },
          ],
        }),
        ['a.txt', 'Public text.'],
        ['k.txt', 'SENTINEL-KEY'],
        ['m.txt', 'SENTINEL-MIXED'],
      ];
      const p = plan(set);
      const output = bundleProposalOutput(p);
      const json = JSON.stringify(output);
      expect(json).not.toContain('SENTINEL');
      expect(json).toContain('Public text.');
      expect(output.rationale).toContain('2 answer-key or mixed member(s)');
      expect(p.members.filter((m) => m.status === 'accepted')).toHaveLength(3);
    });

    const bad = (
      mutate: (m: typeof valid) => unknown,
      expected: CourseBundleRefusalReason,
    ) => {
      const next = JSON.parse(JSON.stringify(valid));
      const value = mutate(next);
      const set = files();
      set[0] = manifest(value ?? next);
      expect(reason(() => plan(set))).toBe(expected);
    };

    it('refuses unknown keys at every level', () => {
      bad((m) => ({ ...m, extra: 1 }), 'manifest_unknown_key');
      bad((m) => {
        (m.sections[0] as Record<string, unknown>).oops = true;
      }, 'manifest_unknown_key');
      bad((m) => {
        (m.sections[0]?.lessons[0] as Record<string, unknown>).oops = true;
      }, 'manifest_unknown_key');
      bad((m) => {
        (
          m.sections[0]?.lessons[0]?.members[0] as Record<string, unknown>
        ).oops = 1;
      }, 'manifest_unknown_key');
      const poisoned = files();
      poisoned[0] = [
        'manifest.json',
        '{"version":1,"sections":[],"__proto__":{"x":1}}',
      ];
      expect(reason(() => plan(poisoned))).toBe('manifest_unknown_key');
    });

    it('refuses a bad version, shape, role, key and member reference', () => {
      bad((m) => ({ ...m, version: 3 }), 'manifest_version');
      bad((m) => ({ ...m, version: undefined }), 'manifest_version');
      bad(() => [], 'manifest_invalid');
      bad((m) => {
        (m.sections[0]?.lessons[0]?.members[0] as { role: string }).role =
          'solution';
      }, 'manifest_invalid');
      bad((m) => {
        (m.sections[0] as { key: string }).key = 'has space';
      }, 'manifest_invalid');
      bad((m) => {
        (m.sections[0]?.lessons[0]?.members[0] as { path: string }).path =
          'missing.pdf';
      }, 'manifest_missing_member');
      bad((m) => {
        (m.sections[0]?.lessons[0]?.members[0] as { path: string }).path =
          '../x';
      }, 'manifest_invalid');
      bad((m) => {
        m.sections[0]?.lessons[0]?.members.push({ path: 'notes.txt' });
      }, 'manifest_duplicate_member');
      bad((m) => {
        m.sections[0]?.lessons.push({
          key: 'sums',
          title: 'Again',
          members: [],
        });
      }, 'duplicate_key');
      const garbage = files();
      garbage[0] = ['manifest.json', '{not json'];
      expect(reason(() => plan(garbage))).toBe('manifest_invalid');
    });

    it('refuses an oversize manifest', () => {
      const set = files();
      set[0] = ['manifest.json', ' '.repeat(300 * 1024)];
      expect(reason(() => plan(set))).toBe('manifest_invalid');
    });
  });

  it('routes through an open reader registry', () => {
    const registry = createBundleReaderRegistry();
    registry.register(
      {
        formatId: 'custom',
        detect: (members) => members.some((m) => m.path === 'imsmanifest.xml'),
        prepare: (members) => ({
          readerId: 'custom',
          manifestVersion: 0,
          order: members.map((m) => m.path).sort(),
          structure: () => ({ sections: [] }),
        }),
      },
      { first: true },
    );
    expect(registry.formats()).toEqual([
      'custom',
      'manifest-v2',
      'manifest-v1',
      'plain-files',
    ]);
    const p = plan(
      [
        ['imsmanifest.xml', '<manifest/>'],
        ['a.txt', 'a'],
      ],
      registry,
    );
    expect(p.readerId).toBe('custom');
    expect(() =>
      registry.register({ ...registry.resolve([]) } as never),
    ).toThrow();
  });
});

describe('seeded mutation test', () => {
  it('either reads or raises the typed refusal, within the caps', () => {
    const valid = buildZip([
      { name: 'unit/one.pdf', data: tinyPdf('one') },
      { name: 'unit/two.txt', data: 'two two two two two two two two' },
      { name: 'manifest.json', data: '{"version":1,"sections":[]}', method: 0 },
      { name: 'img.png', data: tinyPng(3), method: 0 },
    ]);
    const random = mulberry32(4578);
    const tight = limits({
      maxEntries: 8,
      maxTotalBytes: 4096,
      maxEntryBytes: 2048,
    });
    let refused = 0;
    let read = 0;
    for (let round = 0; round < 1500; round++) {
      const mutated = Buffer.from(valid);
      const flips = 1 + Math.floor(random() * 4);
      for (let i = 0; i < flips; i++)
        mutated[Math.floor(random() * mutated.length)] = Math.floor(
          random() * 256,
        );
      const bytes =
        random() < 0.15
          ? mutated.subarray(0, Math.floor(random() * mutated.length))
          : mutated;
      try {
        const members = readZipArchive(bytes, tight);
        let total = 0;
        for (const m of members) {
          total += m.bytes?.length ?? 0;
          if (!m.refusal)
            expect(m.size).toBeLessThanOrEqual(tight.maxEntryBytes);
        }
        expect(total).toBeLessThanOrEqual(tight.maxTotalBytes);
        read++;
      } catch (error) {
        expect(error).toBeInstanceOf(CourseBundleRefusedError);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(read + refused).toBe(1500);
  });

  it('bounds a deflate stream that expands past its declared size', () => {
    const payload = deflateRawSync(Buffer.alloc(4 * 1024 * 1024));
    const zip = buildZip([
      {
        name: 'a.txt',
        data: 'x'.repeat(10),
        raw: payload,
        size: 10,
        compressed: payload.length,
      },
    ]);
    expect(reason(() => readZipArchive(zip))).toBe('size_mismatch');
  });
});
