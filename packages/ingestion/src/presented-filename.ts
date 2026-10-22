/**
 * Source-presented file names (#4214): untrusted text kept for labels only,
 * never identity. One definition shared by the receipt service's strict check
 * and the sources' cleaner (`deliver`), so neither can store a name the other
 * would refuse.
 *
 * Unsafe characters, all removed, are defined by Unicode properties rather
 * than a hand-kept list:
 * - `Cc` control characters (C0, C1, DEL);
 * - `Cf` format characters (bidi embeddings, overrides, isolates and marks,
 *   zero-width characters, the BOM, soft hyphen, tag characters, interlinear
 *   annotation marks, ...);
 * - `Cs` lone surrogate halves (invalid text; real pairs such as emoji are
 *   kept, since the `u` flag matches whole code points);
 * - `Zl`/`Zp` line and paragraph separators (U+2028, U+2029);
 * - `Default_Ignorable_Code_Point` (U+034F, Hangul fillers, variation
 *   selectors, U+180E, U+2060-U+206F, ...): characters that render as
 *   nothing. Consequences, all display-only (nothing uses the name as
 *   identity): emoji ZWJ sequences and emoji presentation selectors are
 *   flattened (a family emoji shows as its members); ZWNJ/ZWJ (U+200C,
 *   U+200D) are removed from Persian and Indic text, which can change how
 *   letters join; and ideographic variation selectors are removed, so a CJK
 *   glyph variant shows its base form.
 *
 * Bidi controls let `invoice` + U+202E + `fdp.exe` display as
 * `invoiceexe.pdf`; invisible characters make two different names look
 * identical. Out of scope: Unicode normalization (NFC/NFKC) and confusable
 * look-alike characters; the name stays untrusted display text.
 */
const UNSAFE =
  '[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}]';
const UNSAFE_CHARACTER = new RegExp(UNSAFE, 'u');
const UNSAFE_CHARACTERS = new RegExp(UNSAFE, 'gu');

/** The receipt service's bound on a stored filename, in UTF-16 code units. */
export const MAX_FILENAME_LENGTH = 512;

/** Whether a filename may be stored as-is (no unsafe characters, bounded). */
export function isStorableFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_FILENAME_LENGTH &&
    !UNSAFE_CHARACTER.test(value)
  );
}

/**
 * Clean a source-presented name: unsafe characters removed and the result
 * trimmed; a name that is then empty or over the bound is dropped, so an odd
 * name falls back to the default label instead of failing the whole receipt.
 */
export function presentedFilename(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(UNSAFE_CHARACTERS, '').trim();
  return isStorableFilename(name) ? name : undefined;
}
