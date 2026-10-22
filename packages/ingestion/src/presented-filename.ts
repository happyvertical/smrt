/**
 * Source-presented file names (#4214): untrusted text kept for labels only,
 * never identity. One definition shared by the receipt service's strict check
 * and the source adapters' normalizer, so neither can store a name the other
 * would refuse.
 *
 * Unsafe characters: C0 and C1 controls and DEL; zero-width and directional
 * marks (U+200B–U+200F, U+061C); line and paragraph separators (U+2028,
 * U+2029); bidi embeddings, overrides and isolates (U+202A–U+202E,
 * U+2066–U+2069); and the byte-order mark (U+FEFF). Bidi controls let
 * `invoice` + U+202E + `fdp.exe` display as `invoiceexe.pdf`; zero-width characters
 * make two different names look identical.
 */
// Escapes, never literal characters: an invisible character in source could
// hide what a reviewer reads.
const UNSAFE =
  '[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]';
const UNSAFE_CHARACTER = new RegExp(UNSAFE);
const UNSAFE_CHARACTERS = new RegExp(UNSAFE, 'g');

/** The receipt service's bound on a stored filename. */
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
 * Normalize a source-presented name: unsafe characters removed and the result
 * trimmed; a name that is then empty or over the bound is dropped, so an odd
 * name falls back to the default label instead of failing the whole receipt.
 */
export function presentedFilename(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(UNSAFE_CHARACTERS, '').trim();
  return isStorableFilename(name) ? name : undefined;
}
