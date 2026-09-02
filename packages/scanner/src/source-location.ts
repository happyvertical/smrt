/**
 * Source-offset helpers shared by the OXC class parser and the agent-surface
 * matcher.
 *
 * Lives in its own module so `agent-surface.ts` can resolve a diagnostic's
 * line/column without importing `oxc-parser.ts`, which imports it back.
 */

/**
 * Extract line/column from offset in source text.
 *
 * Note: oxc-parser v0.108+ removed magicString, so this is computed manually.
 *
 * @param sourceText - Full source text the offset indexes into.
 * @param offset - 0-based character offset.
 * @returns 1-based line and column, or `undefined` when the offset is out of
 *   range.
 */
export function getLineColumn(
  sourceText: string,
  offset: number,
): { line: number; column: number } | undefined {
  if (offset < 0 || offset > sourceText.length) {
    return undefined;
  }

  let line = 1;
  let lastNewlinePos = -1;

  for (let i = 0; i < offset; i++) {
    if (sourceText[i] === '\n') {
      line++;
      lastNewlinePos = i;
    }
  }

  return {
    line,
    column: offset - lastNewlinePos, // 1-based column
  };
}
