/**
 * Text matching for the command palette: accent- and case-insensitive,
 * multi-term, with word-start and in-order (fuzzy) matches, and the matched
 * ranges of the original text for highlighting. Pure; no DOM, no Svelte.
 */
import type { MatchRange, PaletteItem } from './types.js';

interface Folded {
  /** Lower-cased, accent-stripped text. */
  text: string;
  /** For each folded character, the index in the original it came from. */
  origin: number[];
  /** For each folded character, the exclusive end index in the original. */
  originEnd: number[];
}

const MARKS = /\p{M}/gu;

/** Fold one code point; may yield 0..n characters (marks vanish, `İ` splits). */
function foldChar(char: string): string {
  return char.normalize('NFD').replace(MARKS, '').toLowerCase();
}

function fold(source: string): Folded {
  let text = '';
  const origin: number[] = [];
  const originEnd: number[] = [];
  let index = 0;
  for (const char of source) {
    const folded = foldChar(char);
    for (let i = 0; i < folded.length; i += 1) {
      origin.push(index);
      originEnd.push(index + char.length);
    }
    text += folded;
    index += char.length;
  }
  return { text, origin, originEnd };
}

/** Lower-case and strip accents; the form both sides of a match are compared in. */
export function foldForMatch(source: string): string {
  return fold(source).text;
}

/** Split a query into its terms (whitespace separated, folded, de-duplicated). */
export function queryTerms(query: string): string[] {
  const terms = foldForMatch(query)
    .split(/\s+/)
    .filter((term) => term.length > 0);
  return [...new Set(terms)];
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

interface TermMatch {
  score: number;
  /** Ranges in folded coordinates. */
  ranges: Array<[number, number]>;
}

/** Best match of one term in folded text, or null. */
function matchTerm(term: string, text: string): TermMatch | null {
  let best: TermMatch | null = null;
  let at = text.indexOf(term);
  while (at !== -1) {
    const wordStart = at === 0 || !isWordChar(text[at - 1]);
    const score = wordStart ? (at === 0 ? 150 : 100) : 60;
    if (!best || score > best.score) {
      best = { score, ranges: [[at, at + term.length]] };
    }
    at = text.indexOf(term, at + 1);
  }
  if (best) return best;

  // In-order subsequence ("nwinv" -> "New Invoice"), compact spans only so
  // short terms do not match everything.
  if (term.length < 2) return null;
  const hits: number[] = [];
  let cursor = 0;
  for (const char of term) {
    const found = text.indexOf(char, cursor);
    if (found === -1) return null;
    hits.push(found);
    cursor = found + 1;
  }
  const span = hits[hits.length - 1] - hits[0] + 1;
  if (span > term.length * 4) return null;
  const ranges: Array<[number, number]> = [];
  for (const hit of hits) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === hit) last[1] = hit + 1;
    else ranges.push([hit, hit + 1]);
  }
  const startsWord = hits[0] === 0 || !isWordChar(text[hits[0] - 1]);
  return {
    score: Math.max(5, 30 - (span - term.length) + (startsWord ? 10 : 0)),
    ranges,
  };
}

function mergeRanges(ranges: Array<[number, number]>): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function toOriginal(folded: Folded, ranges: Array<[number, number]>) {
  return mergeRanges(
    ranges.map(
      ([start, end]) =>
        [folded.origin[start], folded.originEnd[end - 1]] as [number, number],
    ),
  );
}

/** Result of matching a query against one text. */
export interface TextMatch {
  score: number;
  /** Ranges of the original text that matched. */
  ranges: MatchRange[];
}

/**
 * Match every term of `query` against `text`. All terms must match somewhere
 * (a missing term is no match). An empty query matches everything with score 0.
 */
export function matchText(query: string, text: string): TextMatch | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return { score: 0, ranges: [] };
  const folded = fold(text);
  let score = 0;
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    const match = matchTerm(term, folded.text);
    if (!match) return null;
    score += match.score;
    ranges.push(...match.ranges);
  }
  const whole = foldForMatch(query).trim();
  if (folded.text === whole) score += 200;
  else if (folded.text.startsWith(whole)) score += 50;
  // Of equal matches, the shorter text is the closer one.
  score -= Math.min(folded.text.length, 100) * 0.1;
  return { score, ranges: toOriginal(folded, ranges) };
}

/** Result of matching a query against a palette item. */
export interface ItemMatch {
  score: number;
  /** Ranges of `item.title` that matched. */
  titleRanges: MatchRange[];
}

/**
 * Match `query` against an item's title (full weight), and its subtitle and
 * keywords (half weight). Each term may match any of them; all must match.
 */
export function matchItem(query: string, item: PaletteItem): ItemMatch | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return { score: 0, titleRanges: [] };

  const title = fold(item.title);
  const secondary = foldForMatch(
    [item.subtitle ?? '', ...(item.keywords ?? [])].join(' '),
  );

  let score = 0;
  const titleRanges: Array<[number, number]> = [];
  for (const term of terms) {
    const inTitle = matchTerm(term, title.text);
    if (inTitle) {
      score += inTitle.score;
      titleRanges.push(...inTitle.ranges);
      continue;
    }
    const inSecondary = matchTerm(term, secondary);
    if (!inSecondary) return null;
    score += inSecondary.score * 0.5;
  }
  const whole = foldForMatch(query).trim();
  if (title.text === whole) score += 200;
  else if (title.text.startsWith(whole)) score += 50;
  score -= Math.min(title.text.length, 100) * 0.1;
  return { score, titleRanges: toOriginal(title, titleRanges) };
}

/** Split `text` into alternating plain and matched segments for rendering. */
export function highlightSegments(
  text: string,
  ranges: readonly MatchRange[],
): Array<{ text: string; match: boolean }> {
  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), match: false });
    }
    if (end > start) {
      segments.push({ text: text.slice(start, end), match: true });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: false });
  }
  return segments;
}
