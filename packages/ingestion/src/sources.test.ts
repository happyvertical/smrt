import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';
import { describe, expect, it } from 'vitest';
import { presentedFilename } from './sources/common.js';
import { sourcesSuite } from './test-support/sources.js';

describe('presentedFilename (#4214)', () => {
  it('keeps a plain name and trims it', () => {
    expect(presentedFilename('  Acme March.pdf ')).toBe('Acme March.pdf');
  });
  it('removes control characters instead of failing the receipt', () => {
    expect(presentedFilename('Acme\u0000 March\n.pdf\u007f')).toBe(
      'Acme March.pdf',
    );
  });
  // Built from code points: invisible characters never appear literally in
  // source, where they could hide what a reviewer reads.
  const char = (codePoint: number) => String.fromCodePoint(codePoint);
  it('removes bidi controls so a name cannot display as another extension', () => {
    // U+202E (right-to-left override) would render this as `invoiceexe.pdf`.
    expect(presentedFilename(`invoice${char(0x202e)}fdp.exe`)).toBe(
      'invoicefdp.exe',
    );
    for (const codePoint of [
      0x202a, 0x202b, 0x202c, 0x202d, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c,
    ])
      expect(presentedFilename(`a${char(codePoint)}b.pdf`)).toBe('ab.pdf');
  });
  it('removes zero-width characters, separators, BOM and C1 controls', () => {
    for (const codePoint of [
      0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff, 0x2028, 0x2029, 0x0085,
      0x009f,
    ])
      expect(presentedFilename(`report${char(codePoint)}.pdf`)).toBe(
        'report.pdf',
      );
    // Ordinary non-ASCII text is kept.
    expect(presentedFilename('Rechnung M\u00e4rz \u2014 2026.pdf')).toBe(
      'Rechnung M\u00e4rz \u2014 2026.pdf',
    );
  });
  it('removes other invisible format characters, including astral tag characters', () => {
    for (const codePoint of [
      0x00ad, 0x180e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206f,
      0xfff9, 0xfffa, 0xfffb, 0xe0000, 0xe0001, 0xe0041, 0xe007f,
    ])
      expect(presentedFilename(`scan${char(codePoint)}.pdf`)).toBe('scan.pdf');
    // A lone surrogate half is invalid text and is removed...
    expect(presentedFilename(`scan${'\ud83d'}.pdf`)).toBe('scan.pdf');
    // ...but a real surrogate pair (an emoji, outside the BMP) stays intact.
    const page = char(0x1f4c4);
    expect(page.length).toBe(2);
    expect(presentedFilename(`${page} scan.pdf`)).toBe(`${page} scan.pdf`);
    // A tag sequence next to a pair removes only the tags.
    expect(
      presentedFilename(`${page}${char(0xe0067)}${char(0xe007f)}.pdf`),
    ).toBe(`${page}.pdf`);
  });
  it('removes default-ignorable characters the old hand list missed', () => {
    for (const codePoint of [
      0x034f, // combining grapheme joiner
      0x115f, // Hangul choseong filler
      0x1160, // Hangul jungseong filler
      0x3164, // Hangul filler
      0xffa0, // halfwidth Hangul filler
      0x180b, // Mongolian free variation selector
      0xfe0f, // variation selector-16
      0xe0100, // variation selector-17 (astral)
    ])
      expect(presentedFilename(`scan${char(codePoint)}.pdf`)).toBe('scan.pdf');
    // Ordinary spaces and visible punctuation are not default-ignorable.
    expect(presentedFilename('Q1 report (final).pdf')).toBe(
      'Q1 report (final).pdf',
    );
  });
  it('drops names that are not text, empty after cleaning, or too long', () => {
    expect(presentedFilename(undefined)).toBeUndefined();
    expect(presentedFilename(42)).toBeUndefined();
    expect(presentedFilename(' \t\r\n ')).toBeUndefined();
    expect(presentedFilename('a'.repeat(513))).toBeUndefined();
    expect(presentedFilename('a'.repeat(512))).toBe('a'.repeat(512));
  });
});

@smrt({ api: false, cli: false, mcp: false })
class SourceTestWorker extends SmrtObject {
  @backgroundEligible()
  async process(): Promise<void> {}
}
sourcesSuite('sqlite', 'SourceTestWorker');
