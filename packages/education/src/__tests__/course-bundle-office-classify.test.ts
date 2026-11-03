import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  COURSE_BUNDLE_LIMITS,
  classifyBundle,
  planClassifiedBundle,
  readFileSet,
  resolveCourseBundleLimits,
} from '../index.js';
import { buildZip, tinyPdf } from './bundle-zip-writer.js';
import { officeDocx, officePptx, officeXlsx } from './office-fixtures.js';

const classify = (files: Array<{ path: string; bytes: Uint8Array }>) =>
  classifyBundle(
    readFileSet(files, COURSE_BUNDLE_LIMITS),
    COURSE_BUNDLE_LIMITS,
  );

describe('Office member classification', () => {
  it('recognises OOXML packages by content and name together', () => {
    const [docx, pptx] = classify([
      { path: 'a.docx', bytes: officeDocx('a') },
      { path: 'b.PPTX', bytes: officePptx('b') },
    ]);
    expect(docx).toMatchObject({
      kind: 'docx',
      status: 'accepted',
      reason: null,
    });
    expect(pptx).toMatchObject({ kind: 'pptx', status: 'accepted' });
    expect(docx?.rendered).toBeNull();
    expect(docx?.officeText).toBeNull();
  });

  it('recognises an Excel workbook by its main part and refuses a mismatch', () => {
    const members = classify([
      { path: 'supplies.xlsx', bytes: officeXlsx('supplies') },
      { path: 'fake.xlsx', bytes: officeDocx('a') },
      { path: 'sheet.docx', bytes: officeXlsx('a') },
    ]);
    const [xlsx, wrong, asDocx] = [
      'supplies.xlsx',
      'fake.xlsx',
      'sheet.docx',
    ].map((path) => members.find((m) => m.path === path));
    expect(xlsx).toMatchObject({
      kind: 'xlsx',
      status: 'accepted',
      mediaType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(wrong).toMatchObject({
      status: 'unsupported',
      reason: 'nested_archive',
    });
    expect(asDocx).toMatchObject({
      status: 'unsupported',
      reason: 'nested_archive',
    });
  });

  it('does not treat a zip as Word by extension alone, or by content alone', () => {
    const [wrongExt, wrongName, ppt] = classify([
      { path: 'a.zip', bytes: officeDocx('a') },
      { path: 'a.pptx', bytes: officeDocx('a') }, // a Word package named .pptx
      { path: 'old.ppt', bytes: Buffer.from('legacy binary') },
    ]);
    expect(wrongExt).toMatchObject({
      status: 'unsupported',
      reason: 'nested_archive',
    });
    expect(wrongName).toMatchObject({
      status: 'unsupported',
      reason: 'nested_archive',
    });
    expect(ppt).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported_type',
    });
  });

  it('refuses a package whose entries break the zip bounds', () => {
    const bomb = officeDocx('x', [
      { name: 'word/media/a.bin', data: Buffer.alloc(8 * 1024 * 1024) },
    ]);
    const traversal = Buffer.from(
      buildZip([
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'word/document.xml', data: '<d/>' },
        { name: '../evil.xml', data: 'x' },
      ]),
    );
    const [a, b] = classify([
      { path: 'bomb.docx', bytes: bomb },
      { path: 'trav.docx', bytes: traversal },
    ]);
    expect(a).toMatchObject({ status: 'refused', reason: 'unsafe_office' });
    expect(b).toMatchObject({ status: 'refused', reason: 'unsafe_office' });
  });

  it('refuses a package with an inner part too large to be inflated and checked', () => {
    // Half random, half zeros: 51 MiB inflated, about 26 MiB compressed, ratio ~2.
    const inner = Buffer.concat([
      randomBytes(26 * 1024 * 1024),
      Buffer.alloc(25 * 1024 * 1024),
    ]);
    const big = officeDocx('x', [{ name: 'word/media/big.bin', data: inner }]);
    expect(big.byteLength).toBeLessThan(COURSE_BUNDLE_LIMITS.maxEntryBytes);
    const [member] = classify([{ path: 'big.docx', bytes: big }]);
    expect(member).toMatchObject({
      status: 'refused',
      reason: 'unsafe_office',
    });
  });

  it('settles outcomes before duplicates and structure, so a failed member is no lesson', () => {
    const files = [
      { path: 'a.pdf', bytes: tinyPdf('a') },
      { path: 'b.docx', bytes: officeDocx('b') },
    ];
    const raw = readFileSet(files, COURSE_BUNDLE_LIMITS);
    const classified = classifyBundle(raw, COURSE_BUNDLE_LIMITS);
    const docx = classified.find((m) => m.kind === 'docx');
    const plan = planClassifiedBundle(
      raw,
      classified,
      undefined,
      COURSE_BUNDLE_LIMITS,
      new Map([
        [docx?.sha256 as string, { ok: false, reason: 'converter_failed' }],
      ]),
    );
    expect(plan.members.find((m) => m.kind === 'docx')).toMatchObject({
      status: 'unsupported',
      reason: 'converter_failed',
      bytes: null,
    });
    expect(
      plan.structure.sections.flatMap((s) => s.lessons.map((l) => l.paths)),
    ).toEqual([['a.pdf']]);
  });

  it('only lets a host lower the Office limits', () => {
    const lowered = resolveCourseBundleLimits({
      maxOfficeMembers: 5,
      conversionTimeoutMs: 1_000,
      maxRenderedBytes: 1_024,
    });
    expect(lowered).toMatchObject({
      maxOfficeMembers: 5,
      conversionTimeoutMs: 1_000,
      maxRenderedBytes: 1_024,
    });
    const raised = resolveCourseBundleLimits({
      maxOfficeMembers: 5_000,
      conversionTimeoutMs: 10 ** 9,
      maxRenderedBytes: 10 ** 12,
    });
    expect(raised.maxOfficeMembers).toBe(COURSE_BUNDLE_LIMITS.maxOfficeMembers);
    expect(raised.conversionTimeoutMs).toBe(
      COURSE_BUNDLE_LIMITS.conversionTimeoutMs,
    );
    expect(raised.maxRenderedBytes).toBe(COURSE_BUNDLE_LIMITS.maxRenderedBytes);
  });
});
