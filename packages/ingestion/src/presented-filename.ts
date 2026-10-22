/**
 * Source-presented file names (#4214): untrusted text kept for labels only,
 * never identity. One definition shared by the receipt service's strict check
 * and the source adapters' cleaner, so neither can store a name the other
 * would refuse.
 *
 * Unsafe characters, all removed:
 * - C0 and C1 controls and DEL;
 * - soft hyphen U+00AD and Mongolian vowel separator U+180E;
 * - zero-width and directional marks (U+200B–U+200F, U+061C);
 * - line and paragraph separators (U+2028, U+2029);
 * - bidi embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069);
 * - word joiner and invisible operators (U+2060–U+2064), deprecated format
 *   characters (U+206A–U+206F), interlinear annotation marks (U+FFF9–U+FFFB)
 *   and the byte-order mark (U+FEFF);
 * - tag characters (U+E0000–U+E007F);
 * - lone surrogate halves (invalid text; real pairs such as emoji are kept).
 *
 * Bidi controls let `invoice` + U+202E + `fdp.exe` display as
 * `invoiceexe.pdf`; invisible characters make two different names look
 * identical. Out of scope: Unicode normalization (NFC/NFKC) and confusable
 * look-alike characters; the name stays untrusted display text.
 */
// Escapes, never literal characters: an invisible character in source could
// hide what a reviewer reads. The `u` flag makes the class match by code point
// (needed for the tag block) so surrogate pairs are never split.
const UNSAFE =
  '[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ud800-\\udfff\\ufeff\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}]';
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
