/**
 * Class CrunchLabs unit downloads to a course bundle (SMRT #4616).
 *
 * A unit download is a folder (or the zip parts a Drive export splits it into)
 * holding `<Unit>_All Unit Wide Materials` and `<Unit>_Lesson <n>` folders. Files
 * are lettered: A teacher manual, B slides, C student mission log, D status check
 * assessment (plus guidance, editable), E handouts, F extras, G videos. The
 * videos are not read: their names (`Lnn.step_Video_Kind_Title`) are matched,
 * by unit, lesson and step, to the unit's YouTube course playlist and become
 * external references.
 *
 * `buildClassCrunchLabsBundle` reads such a download and returns a manifest
 * version 2 bundle for `CourseBundleImportService`. Nothing here touches the
 * network: the playlist comes from an injected `ClassCrunchLabsPlaylistSource`,
 * and files from an injected `ClassCrunchLabsFileSource` (Node folder and zip
 * readers are in `class-crunchlabs-files.ts`). The files are CrunchLabs' own
 * downloads, never hosted by us.
 */

import { naturalCompare } from '../course-bundle.js';
import {
  COURSE_BUNDLE_LIMITS,
  COURSE_BUNDLE_MANIFEST_PATH,
  COURSE_BUNDLE_MANIFEST_VERSION_2,
} from '../course-bundle-contracts.js';
import { sha256Hex } from '../course-bundle-zip.js';
import type {
  DocumentConverter,
  OfficeDocumentKind,
} from '../document-converter.js';
import {
  LESSON_ASSET_DEFAULT_AUDIENCE,
  type LessonAssetRelationship,
  type MaterialAudience,
} from '../lesson-assets.js';

export const CLASS_CRUNCHLABS_PROVIDER_ID = 'class-crunchlabs' as const;
export const CLASS_CRUNCHLABS_SUBJECT = 'Science';
/** The licence a family's own copy of a CrunchLabs unit carries. */
export const CLASS_CRUNCHLABS_LICENSE_KIND = 'personal-use-copy' as const;

export class ClassCrunchLabsError extends Error {
  constructor(
    readonly code:
      | 'no_unit'
      | 'multiple_units'
      | 'empty_unit'
      | 'too_large'
      | 'access_denied',
    message: string,
    readonly detail: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ClassCrunchLabsError';
  }
}

// -- inputs -------------------------------------------------------------------

/** One file of a unit download. Bytes are read lazily, and only for files that are used. */
export interface ClassCrunchLabsFile {
  /** Path inside its source (folder-relative, or the zip entry name). */
  path: string;
  size: number;
  /** CRC-32 (lower-case hex) when known without reading, used to spot repeated exports. */
  crc32?: string;
  /** Orders repeated exports of the same unit: the larger value is the newer export. */
  exportId?: string;
  read(): Promise<Uint8Array>;
}
export interface ClassCrunchLabsFileSource {
  files(): Promise<ClassCrunchLabsFile[]>;
}

/** An in-memory source (tests, or a host that already holds the files). */
export function memoryClassCrunchLabsSource(
  files: ReadonlyArray<{
    path: string;
    bytes?: Uint8Array;
    size?: number;
    exportId?: string;
    crc32?: string;
  }>,
): ClassCrunchLabsFileSource {
  return {
    files: async () =>
      files.map((f) => ({
        path: f.path,
        size: f.bytes?.byteLength ?? f.size ?? 0,
        ...(f.exportId ? { exportId: f.exportId } : {}),
        ...(f.crc32 ? { crc32: f.crc32 } : {}),
        read: async () => f.bytes ?? new Uint8Array(),
      })),
  };
}

export interface ClassCrunchLabsPlaylistItem {
  videoId: string;
  title: string;
  position: number;
}
/** A YouTube course playlist of the @ClassCrunchLabs channel. */
export interface ClassCrunchLabsPlaylist {
  id: string;
  title: string;
  /** The unit the playlist belongs to when the source knows it; else derived from the title. */
  unit?: string;
  items: ClassCrunchLabsPlaylistItem[];
}
/** Injected: tests use fixtures, a host fetches the channel's playlists. Never called from a test with a network. */
export interface ClassCrunchLabsPlaylistSource {
  playlists(): Promise<ClassCrunchLabsPlaylist[]>;
}

export type ClassCrunchLabsPageCounter = (input: {
  bytes: Uint8Array;
  kind: 'pdf' | OfficeDocumentKind;
}) => Promise<number | null>;

// -- names --------------------------------------------------------------------

const squash = (value: string) => value.replace(/\s+/g, ' ').trim();
/** Case, punctuation and spacing insensitive key. */
export const classCrunchLabsKey = (value: string) =>
  squash(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const compact = (value: string) => classCrunchLabsKey(value).replace(/ /g, '');

const UNIT_WIDE = /^(.*?)[_\s]*All Unit Wide Materials$/i;
const LESSON = /^(.*?)[_\s]*Lesson (\d{1,2})$/i;
const LETTER = /^([A-G])\.\s+/;
const PAGED = new Set(['pdf', 'docx', 'pptx', 'xlsx']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm']);
const extOf = (name: string) =>
  /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? '';

interface Located {
  file: ClassCrunchLabsFile;
  unit: string;
  /** null: unit-wide materials. */
  lesson: number | null;
  dirs: string[];
  fileName: string;
  ext: string;
}

function locate(file: ClassCrunchLabsFile): Located | null {
  const segments = file.path
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map(squash);
  for (const [i, segment] of segments.entries()) {
    const wide = UNIT_WIDE.exec(segment);
    const lesson = wide ? null : LESSON.exec(segment);
    if (!wide && !lesson) continue;
    const rest = segments.slice(i + 1);
    const fileName = rest.at(-1);
    if (!fileName) return null;
    return {
      file,
      unit: squash((wide?.[1] ?? lesson?.[1] ?? '').replace(/_+$/, '')),
      lesson: lesson ? Number(lesson[2]) : null,
      dirs: rest.slice(0, -1),
      fileName,
      ext: extOf(fileName),
    };
  }
  return null;
}

const VERSION = /^v\.?\s*\d+(\.\d+)*[._\s]*(copy)?$/i;
const LESSON_CODE = /^L0*\d{1,2}(\.\d+)?[\s_.-]+/i;
/** A part that is the unit name, allowing a version suffix or a one-letter typo of the end. */
function isUnitPart(part: string, unitKey: string): boolean {
  // Only a syntactically valid version suffix (`v1`, `v2.0`, `v.1.1`, `copy`) is set aside.
  const key = compact(part.replace(/\s*v\.?\s*\d+(\.\d+)*[.\s]*(copy)?$/i, ''));
  if (!unitKey || !key) return false;
  return (
    key === unitKey ||
    (key.length >= 8 &&
      key.length >= unitKey.length - 2 &&
      unitKey.startsWith(key))
  );
}
/**
 * A readable title from a CrunchLabs file name: the letter prefix, lesson code,
 * unit name, version, `copy` and stray dots are dropped
 * (`A. L01_Teacher Mission Manual_Unit_v1.0.pdf` -> `Teacher Mission Manual`),
 * and a trailing ` - detail` becomes `(detail)` (`Poster - 8.5x11` ->
 * `Poster (8.5×11)`).
 */
function titleOf(fileName: string, unit: string): string {
  const stem = fileName
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .replace(LETTER, '')
    .replace(LESSON_CODE, '');
  const unitKey = compact(unit);
  const parts = stem
    .split('_')
    .map((part) => squash(part).replace(/^[.\s]+|[.\s]+$/g, ''))
    .filter((part) => part && !VERSION.test(part) && !isUnitPart(part, unitKey))
    .map((part) =>
      part
        .replace(/\s*\bv\.?\s*\d+(\.\d+)*[.\s]*(copy)?$/i, '')
        .replace(/\s*\bcopy$/i, '')
        .replace(/^(.+?)\s+-\s+(.+)$/, '$1 ($2)')
        .replace(/(\d)\s*x\s*(\d)/gi, '$1\u00d7$2')
        .trim(),
    )
    .filter(Boolean);
  const title = parts.join(' - ');
  return squash(title).slice(0, 200) || squash(stem).slice(0, 200);
}

const SMALL_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'in',
  'of',
  'on',
  'the',
  'to',
  'with',
]);

const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  Recap: 'Recap',
  CheckIn: 'Check-in',
  AnchorCheckIn: 'Anchor check-in',
  MaterialsPrep: 'Materials prep',
  StudentHandsOnExploration: 'Hands-on exploration',
  LookCloser: 'Look closer',
  LinkUp: 'Link up',
  ForcesExplainer: 'Forces explainer',
  MessageFromMark: 'Message from Mark',
  WrapUp: 'Wrap-up',
  ZBonus: 'Bonus',
  DesignChallenge: 'Design challenge',
});
function humanize(value: string): string {
  return squash(
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .replace(/[-_]+/g, ' '),
  );
}

/** An activity name in title case with small words lower: `PlayWithPlungers` -> `Play with Plungers`. */
function activityTitle(value: string): string {
  return humanize(value)
    .split(' ')
    .map((w, i) =>
      i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w,
    )
    .join(' ');
}

/** Whether a video file name's terminal part (ignoring `-NNN` and a version) is the unit. */
function endsWithUnit(fileName: string, unit: string): boolean {
  const parts = fileName
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .split('_')
    .map((p) => squash(p).replace(/-\d{3}$/, ''))
    .filter((p) => p && !VERSION.test(p));
  const last = parts.at(-1);
  return !!last && isUnitPart(last, compact(unit));
}

/** A cover headline as a title: all capitals fold to title case; blank or absurd text is none. */
function headlineTitle(text: string): string {
  const t = squash(text);
  if (t.length < 2 || t.length > 80 || !/[A-Za-z]{2}/.test(t)) return '';
  if (t !== t.toUpperCase()) return t;
  return t
    .toLowerCase()
    .split(' ')
    .map((w, i) =>
      i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(' ');
}

// -- videos -------------------------------------------------------------------

export interface ClassCrunchLabsVideoName {
  lesson: number;
  /** Lower-case step such as `6` or `1b`. */
  step: string;
  /** The kind token as named, for example `MaterialsPrep`. */
  kind: string;
  /** Humanized title, `''` when the name has none. */
  title: string;
}
const VIDEO_NAME = /^L0*(\d{1,2})\.0*(\d{1,3}[a-z]?)[ _]+Video_(.+)$/i;
/** Parse `Lnn.step_Video_Kind_Title_Unit.mp4`; null when the name is not a lesson video. */
export function parseClassCrunchLabsVideoName(
  fileName: string,
  unit: string,
): ClassCrunchLabsVideoName | null {
  const stem = fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const m = VIDEO_NAME.exec(squash(stem));
  if (!m) return null;
  const parts = (m[3] as string)
    .split('_')
    .map((p) => squash(p).replace(/-\d{3}$/, ''))
    .filter(Boolean);
  const kind = parts.shift();
  if (!kind) return null;
  const unitKey = compact(unit);
  // Drive adds `-003` style suffixes to repeated exports; drop that and the unit.
  const rest = parts.filter((p) => !isUnitPart(p, unitKey) && !VERSION.test(p));
  return {
    lesson: Number(m[1]),
    step: (m[2] as string).toLowerCase(),
    kind,
    title: humanize(rest.join(' ')),
  };
}

export interface ClassCrunchLabsVideoMatch {
  lesson: number;
  step: string;
  kind: string;
  title: string;
  videoId: string;
  playlistItem: string;
}
export interface ClassCrunchLabsVideoMiss {
  lesson: number;
  step: string;
  kind: string;
  title: string;
  reason: 'no_playlist' | 'no_item' | 'ambiguous' | 'item_taken' | 'unanchored';
}

const ITEM_CODE = /\bL0*(\d{1,2})[.\-\s]0*(\d{1,3}[a-z]?)\b/i;
const ITEM_LESSON = /\bLesson\s*0*(\d{1,2})\b/i;
const ITEM_STEP = /\bStep\s*0*(\d{1,3}[a-z]?)\b/i;
/** The (lesson, step) a playlist item title names: `L03.6`, `Lesson 3 ... Step 6`. */
export function parsePlaylistItemTitle(
  title: string,
): { lesson: number; step: string } | null {
  const code = ITEM_CODE.exec(title);
  if (code)
    return { lesson: Number(code[1]), step: (code[2] as string).toLowerCase() };
  const lesson = ITEM_LESSON.exec(title);
  const step = ITEM_STEP.exec(title);
  return lesson && step
    ? { lesson: Number(lesson[1]), step: (step[1] as string).toLowerCase() }
    : null;
}

/** The playlist for a unit: its title (or `unit`) names the unit; the shortest title wins. */
export function pickUnitPlaylist(
  playlists: readonly ClassCrunchLabsPlaylist[],
  unit: string,
): ClassCrunchLabsPlaylist | null {
  const key = classCrunchLabsKey(unit);
  const hits = playlists.filter((p) => {
    const named = classCrunchLabsKey(p.unit ?? p.title);
    return (
      named === key ||
      named.startsWith(`${key} `) ||
      classCrunchLabsKey(p.title).startsWith(key)
    );
  });
  hits.sort(
    (a, b) =>
      (classCrunchLabsKey(a.unit ?? '') === key ? 0 : 1) -
        (classCrunchLabsKey(b.unit ?? '') === key ? 0 : 1) ||
      a.title.length - b.title.length ||
      (a.id < b.id ? -1 : 1),
  );
  return hits[0] ?? null;
}

interface VideoCandidate extends ClassCrunchLabsVideoName {
  index: number;
}
const miss = (v: ClassCrunchLabsVideoName) => ({
  lesson: v.lesson,
  step: v.step,
  kind: v.kind,
  title: v.title,
});
/**
 * Match lesson videos to playlist items by lesson and step. Two videos that
 * share a step (a materials-prep and a hands-on video) are told apart by the
 * item title naming their title or kind; if that cannot decide, they are left
 * unmatched as `ambiguous` rather than guessed. Each item is used once.
 */
export function matchClassCrunchLabsVideos(
  videos: readonly ClassCrunchLabsVideoName[],
  playlist: ClassCrunchLabsPlaylist | null,
): {
  matched: ClassCrunchLabsVideoMatch[];
  unmatched: ClassCrunchLabsVideoMiss[];
  unusedItems: number;
} {
  const matched: ClassCrunchLabsVideoMatch[] = [];
  const unmatched: ClassCrunchLabsVideoMiss[] = [];
  if (!playlist) {
    for (const v of videos)
      unmatched.push({ ...miss(v), reason: 'no_playlist' });
    return { matched, unmatched, unusedItems: 0 };
  }
  const items = playlist.items
    .map((item) => ({ item, code: parsePlaylistItemTitle(item.title) }))
    .filter(
      (
        x,
      ): x is {
        item: ClassCrunchLabsPlaylistItem;
        code: { lesson: number; step: string };
      } => x.code !== null && /^[A-Za-z0-9_-]{11}$/.test(x.item.videoId),
    );
  const used = new Set<ClassCrunchLabsPlaylistItem>();
  const pending: VideoCandidate[] = [];
  const groups = new Map<string, VideoCandidate[]>();
  videos.forEach((v, index) => {
    const key = `${v.lesson}:${v.step}`;
    groups.set(key, [...(groups.get(key) ?? []), { ...v, index }]);
  });
  for (const [key, group] of groups) {
    const pool = items.filter((x) => `${x.code.lesson}:${x.code.step}` === key);
    if (pool.length === 0) {
      pending.push(...group);
      continue;
    }
    const score = (v: VideoCandidate, itemTitle: string) => {
      const hay = compact(itemTitle);
      const title = compact(v.title);
      const kind = compact(KIND_LABELS[v.kind] ?? humanize(v.kind));
      return (
        (title && hay.includes(title) ? 2 : 0) +
        (kind && hay.includes(kind) ? 1 : 0)
      );
    };
    const ranked = group
      .map((v) => ({
        v,
        scores: pool
          .map((x) => ({ x, s: score(v, x.item.title) }))
          .sort((a, b) => b.s - a.s || a.x.item.position - b.x.item.position),
      }))
      .sort((a, b) => (b.scores[0]?.s ?? 0) - (a.scores[0]?.s ?? 0));
    for (const { v, scores } of ranked) {
      const free = scores.filter((c) => !used.has(c.x.item));
      const best = free[0];
      if (!best) {
        unmatched.push({ ...miss(v), reason: 'item_taken' });
        continue;
      }
      const alone = group.length === 1 && pool.length === 1;
      const tied = free[1] !== undefined && free[1].s === best.s;
      if (!alone && tied) {
        unmatched.push({ ...miss(v), reason: 'ambiguous' });
        continue;
      }
      used.add(best.x.item);
      matched.push({
        lesson: v.lesson,
        step: v.step,
        kind: v.kind,
        title: v.title,
        videoId: best.x.item.videoId,
        playlistItem: best.x.item.title,
      });
    }
  }
  // Only numbered items count as unused; unnumbered ones are not in `items`.
  const unusedItems = items.length - used.size;
  if (pending.length > 0) {
    // Videos no numbered item names: try titles and kinds, anchored by recaps.
    const pool = playlist.items
      .filter(
        (item) =>
          /^[A-Za-z0-9_-]{11}$/.test(item.videoId) &&
          parsePlaylistItemTitle(item.title) === null,
      )
      .sort((a, b) => a.position - b.position);
    const fallback = matchWithoutStepNumbers(
      pending,
      pool,
      playlist,
      Math.max(...videos.map((v) => v.lesson)),
    );
    for (const m of fallback.matched) {
      matched.push(m.match);
    }
    unmatched.push(...fallback.unmatched);
  }
  const order = (
    a: { lesson: number; step: string },
    b: { lesson: number; step: string },
  ) => a.lesson - b.lesson || naturalCompare(a.step, b.step);
  matched.sort(order);
  unmatched.sort(order);
  return { matched, unmatched, unusedItems };
}

// -- matching without step numbers --------------------------------------------

const KIND_WORDS = new Set([
  'prep',
  'exploration',
  'anchor',
  'explained',
  'wrapup',
  'recap',
  'checkin',
  'linkup',
  'lookcloser',
]);
const VIDEO_KIND_WORD: Readonly<Record<string, string>> = {
  MaterialsPrep: 'prep',
  StudentHandsOnExploration: 'exploration',
  AnchorCheckIn: 'anchor',
  ForcesExplainer: 'explained',
  WrapUp: 'wrapup',
  Recap: 'recap',
  CheckIn: 'checkin',
  LinkUp: 'linkup',
  LookCloser: 'lookcloser',
};
const TITLE_STOP = new Set([
  'a',
  'an',
  'the',
  'and',
  'of',
  'to',
  'with',
  'in',
  'on',
  'for',
  'part',
  'lesson',
]);
const JOINED_WORDS: Readonly<Record<string, string>> = {
  'wrap up': 'wrapup',
  'check in': 'checkin',
  'link up': 'linkup',
  'look closer': 'lookcloser',
};

interface TitleTokens {
  words: Set<string>;
  numbers: Set<string>;
  kinds: Set<string>;
}
/** Normalized evidence of a title: `&` is `and`, simple plurals are singular, `Part 2` is `2`. */
function titleTokens(title: string): TitleTokens {
  const joined = classCrunchLabsKey(title.replace(/&/g, ' and ')).replace(
    /wrap up|check in|link up|look closer/g,
    (m) => JOINED_WORDS[m] as string,
  );
  const out: TitleTokens = {
    words: new Set(),
    numbers: new Set(),
    kinds: new Set(),
  };
  for (let w of joined.split(' ').filter(Boolean)) {
    if (w === 'explainer') w = 'explained';
    if (KIND_WORDS.has(w)) out.kinds.add(w);
    else if (/^\d+$/.test(w)) out.numbers.add(String(Number(w)));
    else if (TITLE_STOP.has(w)) continue;
    else
      out.words.add(
        w.length > 3 && w.endsWith('s') && !w.endsWith('ss')
          ? w.slice(0, -1)
          : w,
      );
  }
  return out;
}
/** The unit prefix of `<Unit>: <name>` items is not evidence. */
function stripUnitPrefix(title: string, playlist: ClassCrunchLabsPlaylist) {
  const at = title.indexOf(':');
  if (at < 0) return title;
  const head = classCrunchLabsKey(title.slice(0, at));
  const names = [playlist.unit ?? '', playlist.title].map(classCrunchLabsKey);
  return head && names.some((n) => n === head || n.startsWith(`${head} `))
    ? title.slice(at + 1)
    : title;
}
const RECAP_ITEM = /\bLesson\s*0*(\d{1,2})\s+Recap\b/i;

interface FallbackItem {
  item: ClassCrunchLabsPlaylistItem;
  tokens: TitleTokens;
}
/** Score of a video against an item; null when they contradict each other. */
function evidence(
  v: { tokens: TitleTokens; kind: string | null },
  i: FallbackItem,
): { score: number; title: number } | null {
  if (v.tokens.numbers.size > 0 && i.tokens.numbers.size > 0) {
    if (![...v.tokens.numbers].some((n) => i.tokens.numbers.has(n)))
      return null;
  }
  const kindMatch = v.kind !== null && i.tokens.kinds.has(v.kind);
  if (i.tokens.kinds.size > 0 && !kindMatch) return null;
  const title = [...v.tokens.words].filter((w) => i.tokens.words.has(w)).length;
  const numberMatch =
    v.tokens.numbers.size > 0 &&
    [...v.tokens.numbers].some((n) => i.tokens.numbers.has(n));
  return {
    title,
    score: title * 2 + (kindMatch ? 3 : 0) + (numberMatch && title > 0 ? 2 : 0),
  };
}

/**
 * Fallback for playlists without step numbers. "Lesson N Recap" items are
 * anchors: lesson N's recap video (the download's `Recap` at the start of lesson
 * N+1) pairs with it, and the anchors cut the playlist into one segment per
 * lesson. Inside a segment a video and an item pair when each is the other's
 * single best title/kind match; what is left pairs by order only when videos and
 * items are equally many, the videos sit on distinct steps and nothing
 * contradicts. Anything else stays unmatched; no pair crosses a segment. A
 * playlist without any anchor is not segmented: only title evidence pairs, and
 * nothing is filled by order.
 */
function matchWithoutStepNumbers(
  pending: readonly VideoCandidate[],
  pool: readonly ClassCrunchLabsPlaylistItem[],
  playlist: ClassCrunchLabsPlaylist,
  lastLesson: number,
): {
  matched: Array<{
    item: ClassCrunchLabsPlaylistItem;
    match: ClassCrunchLabsVideoMatch;
  }>;
  unmatched: ClassCrunchLabsVideoMiss[];
} {
  const matched: Array<{
    item: ClassCrunchLabsPlaylistItem;
    match: ClassCrunchLabsVideoMatch;
  }> = [];
  const unmatched: ClassCrunchLabsVideoMiss[] = [];
  const taken = new Set<ClassCrunchLabsPlaylistItem>();
  const entries = pool.map((item) => ({
    item,
    tokens: titleTokens(stripUnitPrefix(item.title, playlist)),
  }));
  const pair = (v: VideoCandidate, i: FallbackItem) => {
    taken.add(i.item);
    matched.push({
      item: i.item,
      match: {
        lesson: v.lesson,
        step: v.step,
        kind: v.kind,
        title: v.title,
        videoId: i.item.videoId,
        playlistItem: i.item.title,
      },
    });
  };
  const byStep = (a: VideoCandidate, b: VideoCandidate) =>
    a.lesson - b.lesson || naturalCompare(a.step, b.step) || a.index - b.index;

  // Anchors: unique "Lesson N Recap" items.
  const anchors = new Map<number, number>();
  const duplicate = new Set<number>();
  entries.forEach((e, at) => {
    const m = RECAP_ITEM.exec(stripUnitPrefix(e.item.title, playlist));
    if (!m) return;
    const n = Number(m[1]);
    if (anchors.has(n)) duplicate.add(n);
    anchors.set(n, at);
  });
  for (const n of duplicate) anchors.delete(n);
  const isAnchor = new Set(anchors.values());

  const run = (
    videos: VideoCandidate[],
    items: FallbackItem[],
    options: { orderFill: boolean; reason: ClassCrunchLabsVideoMiss['reason'] },
  ) => {
    const vs = videos.sort(byStep).map((v) => ({
      v,
      tokens: titleTokens(v.title),
      kind: VIDEO_KIND_WORD[v.kind] ?? null,
    }));
    let free = items.filter((i) => !taken.has(i.item));
    let left = vs;
    const cell = (x: (typeof vs)[number], i: FallbackItem) => {
      const e = evidence(x, i);
      // Without segments a kind alone is far too weak to pair across a unit.
      return e && e.score > 0 && (options.orderFill || e.title > 0)
        ? e.score
        : null;
    };
    const best = <T>(rows: Array<[T, number | null]>): T | null => {
      const scored = rows
        .filter((r): r is [T, number] => r[1] !== null)
        .sort((a, b) => b[1] - a[1]);
      return scored[0] && (!scored[1] || scored[0][1] > scored[1][1])
        ? scored[0][0]
        : null;
    };
    for (let changed = true; changed && left.length > 0 && free.length > 0; ) {
      changed = false;
      const found: Array<[(typeof vs)[number], FallbackItem]> = [];
      for (const x of left) {
        const i = best(free.map((f) => [f, cell(x, f)]));
        if (i && best(left.map((l) => [l, cell(l, i)])) === x)
          found.push([x, i]);
      }
      for (const [x, i] of found) {
        pair(x.v, i);
        changed = true;
      }
      left = left.filter((x) => !found.some(([f]) => f === x));
      free = free.filter((i) => !taken.has(i.item));
    }
    if (left.length === 0) return;
    const steps = new Set(left.map((x) => `${x.v.lesson}:${x.v.step}`));
    if (
      options.orderFill &&
      left.length === free.length &&
      steps.size === left.length &&
      left.every((x, at) => evidence(x, free[at] as FallbackItem) !== null)
    ) {
      left.forEach((x, at) => {
        pair(x.v, free[at] as FallbackItem);
      });
      return;
    }
    for (const x of left)
      unmatched.push({
        ...miss(x.v),
        reason: free.length === 0 ? 'no_item' : options.reason,
      });
  };

  if (anchors.size === 0) {
    run([...pending], entries, { orderFill: false, reason: 'no_item' });
  } else {
    const lessons = [...new Set(pending.map((v) => v.lesson))].sort(
      (a, b) => a - b,
    );
    for (const lesson of lessons) {
      const mine = pending.filter((v) => v.lesson === lesson);
      const lower = lesson === 1 ? -1 : anchors.get(lesson - 1);
      const upper =
        anchors.get(lesson) ??
        (lesson >= lastLesson ? entries.length : undefined);
      if (lower === undefined || upper === undefined || lower >= upper) {
        for (const v of [...mine].sort(byStep))
          unmatched.push({ ...miss(v), reason: 'unanchored' });
        continue;
      }
      // The recap that opens this lesson is the previous lesson's anchor item.
      let videos = mine;
      const recaps = mine.filter((v) => v.kind === 'Recap');
      if (lesson > 1 && recaps.length === 1) {
        const anchor = entries[lower] as FallbackItem;
        if (!taken.has(anchor.item)) {
          pair(recaps[0] as VideoCandidate, anchor);
          videos = mine.filter((v) => v !== recaps[0]);
        }
      }
      const segment = entries.filter(
        (_, at) => at > lower && at < upper && !isAnchor.has(at),
      );
      run(videos, segment, { orderFill: true, reason: 'ambiguous' });
    }
  }
  return { matched, unmatched };
}

// -- materials ----------------------------------------------------------------

interface Mapped {
  role: LessonAssetRelationship;
  audience: MaterialAudience;
  title: string;
  /** Sort key within a place: letter, then name. */
  rank: string;
}
type Ignored = { ignored: string };

function mapMaterial(located: Located): Mapped | Ignored {
  const { fileName, dirs, unit, lesson } = located;
  // A lettered directory (unit wide folders) wins over the file's own letter.
  const dirLetter = dirs.map((d) => LETTER.exec(d)?.[1]).find(Boolean);
  const letter = dirLetter ?? LETTER.exec(fileName)?.[1] ?? null;
  const lower = fileName.toLowerCase();
  const editable = /editable/.test(lower);
  let role: LessonAssetRelationship | null = null;
  let audience: MaterialAudience | null = null;
  switch (letter) {
    case 'A':
      role = 'teacher-guide';
      break;
    case 'B':
      role = 'slides';
      break;
    case 'C':
      role = 'learner-pages';
      break;
    case 'D':
      if (/guidance/.test(lower)) role = 'assessment-guidance';
      else {
        role = 'assessment';
        // The editable master is for the adult; the printable PDF is for the learner.
        if (editable) audience = 'guardian';
      }
      break;
    case 'E':
      role = 'handout';
      break;
    case 'F':
      role = 'printable';
      break;
    case 'G':
      return { ignored: 'video-folder-file' };
    default:
      if (lesson === null && /supply list/.test(lower)) role = 'attachment';
  }
  if (!role) return { ignored: 'unclassified' };
  return {
    role,
    audience: audience ?? LESSON_ASSET_DEFAULT_AUDIENCE[role],
    title: titleOf(fileName, unit),
    rank: `${letter ?? 'Z'}|${fileName}`,
  };
}

/** A unit-wide file in the lettered A-E folders that is named for the whole unit. */
function isUnitWideAggregate(l: Located): boolean {
  const letter =
    l.dirs.map((d) => LETTER.exec(d)?.[1]).find(Boolean) ??
    LETTER.exec(l.fileName)?.[1];
  return (
    letter !== undefined &&
    'ABCDE'.includes(letter) &&
    /unit[- ]?wide/i.test(l.fileName)
  );
}

// -- bundle -------------------------------------------------------------------

export interface ClassCrunchLabsBuildOptions {
  files: ClassCrunchLabsFileSource;
  /** Without one, videos are reported unmatched (`no_playlist`) and no reference is written. */
  playlists?: ClassCrunchLabsPlaylistSource;
  /** Which unit when the download holds several; matched ignoring case and punctuation. */
  unit?: string;
  /**
   * How many pages a mission log has, to write its lesson page range. Without
   * one, or when it returns null, the lesson gets no page rows (a warning says so).
   */
  pageCounter?: ClassCrunchLabsPageCounter;
  /**
   * The unit-wide "(all lessons)" files (the combined manual, deck, mission log,
   * status checks and handouts) repeat the per-lesson files and are large, so they
   * are left out by default. The supply list, posters and other unit-wide extras
   * are always course members.
   */
  includeUnitWideAggregates?: boolean;
  /**
   * The most prominent text (largest type, its lines joined by a space) on the
   * first page of a PDF, for a lesson's teacher mission manual, whose cover
   * names the lesson. The host supplies it (the package carries no PDF text
   * reader). When it returns text, that names the lesson; else the lesson's
   * hands-on activity video does, else `Lesson N`. A throw or null is ignored.
   */
  readFirstPageHeadline?: (input: {
    bytes: Uint8Array;
    kind: 'pdf';
  }) => Promise<string | null>;
  /** Largest bundle part in bytes; default 90 MiB, never above the bundle archive limit. */
  maxPartBytes?: number;
}

export interface ClassCrunchLabsReport {
  unit: string;
  lessons: number;
  members: number;
  courseMembers: number;
  /** Bundles the unit was split into (1 unless it is large). */
  parts: number;
  pages: Array<{ lesson: number; path: string; pages: number }>;
  videos: {
    playlist: { id: string; title: string } | null;
    matched: ClassCrunchLabsVideoMatch[];
    unmatched: ClassCrunchLabsVideoMiss[];
    unusedPlaylistItems: number;
    /** Unit-level videos (a teaser): a course has no video of its own, so none is written. */
    unitLevel: string[];
  };
  /** Same bytes under another name or place: only the preferred copy is bundled. */
  duplicates: Array<{ path: string; duplicateOf: string }>;
  /** The same file in more than one export of the unit. */
  duplicateExports: number;
  /** A file that differs between exports: the newer export is used. */
  superseded: number;
  ignored: Array<{ path: string; reason: string }>;
  warnings: string[];
}
/** One importable bundle: a manifest version 2 and the files it names. */
export interface ClassCrunchLabsBundlePart {
  bundle: { files: Array<{ path: string; bytes: Uint8Array }> };
  manifest: Record<string, unknown>;
  /** The lesson numbers this part carries. */
  lessons: number[];
}
/**
 * The stable unit key every part of a unit carries (`course.key`): the
 * provider and the unit name folded to a manifest key.
 */
export function classCrunchLabsUnitKey(unitName: string): string {
  const slug = unitName
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 100);
  return `${CLASS_CRUNCHLABS_PROVIDER_ID}:${slug || 'unit'}`;
}
export interface ClassCrunchLabsBuild {
  unit: string;
  /** The unit key in every part's manifest (`course.key`). */
  unitKey: string;
  /**
   * The bundles to import, in order, each with `CourseBundleImportService`. A
   * unit that fits one archive is one part; a large one is split by lesson
   * (course-level members go in the first part), never by file.
   */
  parts: ClassCrunchLabsBundlePart[];
  /** The first part, for the usual single-bundle unit. */
  bundle: ClassCrunchLabsBundlePart['bundle'];
  manifest: Record<string, unknown>;
  /** A family's own copy of a unit is a personal-use copy. */
  licenseKind: typeof CLASS_CRUNCHLABS_LICENSE_KIND;
  report: ClassCrunchLabsReport;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: file names may carry control characters
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f:\\]/g;
const safeName = (name: string) =>
  name.replace(UNSAFE_NAME_CHARS, '-').replace(/\s+/g, ' ').trim();
const lessonKey = (n: number) => `lesson-${String(n).padStart(2, '0')}`;
const DEFAULT_PART_BYTES = 90 * 1024 * 1024;
const VIDEO_AUDIENCE_GUARDIAN = new Set(['MaterialsPrep']);

function stepOrder(a: string, b: string) {
  return naturalCompare(a, b);
}

/**
 * The numeric order of a step code (SMRT #4656): its number, plus a small
 * fraction for a letter suffix so `1` < `1b` < `2` (`1a` is 1.01, `1b` 1.02).
 */
export function classCrunchLabsStepOrder(code: string): number {
  const m = /^0*(\d+)([a-z]?)$/i.exec(code.trim());
  if (!m) return 0;
  const letter = m[2] ? (m[2].toLowerCase().charCodeAt(0) - 96) / 100 : 0;
  return Number(m[1]) + letter;
}
/** The launch slides open the lesson; the status check closes it. */
const LAUNCH_STEP = { key: 'launch', order: 0, label: 'Launch' } as const;
const CHECK_STEP = {
  key: 'check',
  order: 9999,
  label: 'Status check',
} as const;

/** Read a Class CrunchLabs unit download and build a manifest version 2 bundle. */
export async function buildClassCrunchLabsBundle(
  options: ClassCrunchLabsBuildOptions,
): Promise<ClassCrunchLabsBuild> {
  const listed = await options.files.files();
  const located = listed.map(locate);
  // Unit selection from the lettered folders only (loose files name other things).
  const units = new Map<string, string>();
  for (const l of located)
    if (l?.unit) units.set(classCrunchLabsKey(l.unit), l.unit);
  let unitName: string;
  if (options.unit) {
    const found = units.get(classCrunchLabsKey(options.unit));
    if (!found)
      throw new ClassCrunchLabsError(
        'no_unit',
        `The download has no unit named ${options.unit}.`,
        [...units.values()].sort(),
      );
    unitName = found;
  } else if (units.size === 1) unitName = [...units.values()][0] as string;
  else if (units.size === 0)
    throw new ClassCrunchLabsError(
      'no_unit',
      'No All Unit Wide Materials or Lesson folders were found.',
    );
  else
    throw new ClassCrunchLabsError(
      'multiple_units',
      'The download holds more than one unit; name the unit.',
      [...units.values()].sort(),
    );
  const unitKey = classCrunchLabsKey(unitName);
  // Loose lesson videos at the download's root (outside the folders) belong to
  // the unit their name ends with.
  for (const [i, l] of located.entries()) {
    if (l) continue;
    const file = listed[i] as ClassCrunchLabsFile;
    const fileName = squash(
      file.path.replace(/\\/g, '/').split('/').at(-1) ?? '',
    );
    if (
      !VIDEO_EXT.has(extOf(fileName)) ||
      !VIDEO_NAME.test(fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '')) ||
      !endsWithUnit(fileName, unitName)
    )
      continue;
    located[i] = {
      file,
      unit: unitName,
      lesson: null,
      dirs: [],
      fileName,
      ext: extOf(fileName),
    };
  }

  const report: ClassCrunchLabsReport = {
    unit: unitName,
    lessons: 0,
    members: 0,
    courseMembers: 0,
    parts: 1,
    pages: [],
    videos: {
      playlist: null,
      matched: [],
      unmatched: [],
      unusedPlaylistItems: 0,
      unitLevel: [],
    },
    duplicates: [],
    duplicateExports: 0,
    superseded: 0,
    ignored: [],
    warnings: [],
  };
  for (const [i, l] of located.entries())
    if (!l)
      report.ignored.push({
        path: (listed[i] as ClassCrunchLabsFile).path,
        reason: 'outside-unit-folders',
      });

  // Repeated exports: one logical path, newest export wins.
  const mine = located.filter(
    (l): l is Located =>
      l !== null && (l.unit === '' || classCrunchLabsKey(l.unit) === unitKey),
  );
  const logical = new Map<string, Located[]>();
  for (const l of mine) {
    const key = `${l.lesson ?? 'unit'}/${l.dirs.join('/')}/${l.fileName}`;
    logical.set(key, [...(logical.get(key) ?? []), l]);
  }
  const current: Located[] = [];
  for (const group of logical.values()) {
    const newest = [...group].sort((a, b) =>
      (a.file.exportId ?? '') < (b.file.exportId ?? '')
        ? 1
        : (a.file.exportId ?? '') > (b.file.exportId ?? '')
          ? -1
          : 0,
    )[0] as Located;
    for (const other of group) {
      if (other === newest) continue;
      const same =
        other.file.size === newest.file.size &&
        (other.file.crc32 ?? '') === (newest.file.crc32 ?? '');
      if (same) report.duplicateExports++;
      else report.superseded++;
    }
    current.push(newest);
  }

  // Videos by name (never read); materials by letter.
  const videoNames: ClassCrunchLabsVideoName[] = [];
  const seenVideos = new Set<string>();
  type Material = Located & Mapped & { bytes: Uint8Array; sha256: string };
  const candidates: Array<Located & Mapped> = [];
  for (const l of current) {
    if (VIDEO_EXT.has(l.ext)) {
      const name = parseClassCrunchLabsVideoName(l.fileName, unitName);
      if (!name) report.videos.unitLevel.push(l.fileName);
      else {
        const key = `${name.lesson}.${name.step}.${compact(name.kind)}.${compact(name.title)}`;
        if (!seenVideos.has(key)) {
          seenVideos.add(key);
          videoNames.push(name);
        }
      }
      continue;
    }
    if (!PAGED.has(l.ext)) {
      report.ignored.push({ path: l.file.path, reason: 'unsupported-type' });
      continue;
    }
    const mapped = mapMaterial(l);
    if (
      !('ignored' in mapped) &&
      l.lesson === null &&
      !options.includeUnitWideAggregates &&
      isUnitWideAggregate(l)
    ) {
      report.ignored.push({
        path: l.file.path,
        reason: 'aggregate-of-lessons',
      });
      continue;
    }
    if ('ignored' in mapped) {
      report.ignored.push({ path: l.file.path, reason: mapped.ignored });
      continue;
    }
    candidates.push({ ...l, ...mapped });
  }

  // Read the files that are used; the same bytes are bundled once.
  const total = { bytes: 0 };
  const read: Material[] = [];
  for (const c of candidates.sort((a, b) => naturalCompare(a.rank, b.rank))) {
    const bytes = await c.file.read();
    total.bytes += bytes.byteLength;
    if (total.bytes > COURSE_BUNDLE_LIMITS.maxTotalBytes)
      throw new ClassCrunchLabsError(
        'too_large',
        'The unit materials exceed the bundle size limit.',
      );
    read.push({ ...c, bytes, sha256: sha256Hex(bytes) });
  }
  const bySha = new Map<string, Material[]>();
  for (const m of read)
    bySha.set(m.sha256, [...(bySha.get(m.sha256) ?? []), m]);
  const kept: Material[] = [];
  for (const group of bySha.values()) {
    const prefix = (m: Material) =>
      /^(?:[A-G]\.\s+)?L0*(\d{1,2})[_\s.]/.exec(m.fileName)?.[1];
    const preferred = [...group].sort((a, b) => {
      // A file named for its lesson belongs to that lesson; anything else is unit wide.
      const home = (m: Material) => {
        const n = prefix(m);
        return n ? (m.lesson === Number(n) ? 0 : 1) : m.lesson === null ? 0 : 1;
      };
      const copy = (m: Material) => (/\bcopy\b/i.test(m.fileName) ? 1 : 0);
      return (
        home(a) - home(b) ||
        copy(a) - copy(b) ||
        naturalCompare(a.file.path, b.file.path)
      );
    })[0] as Material;
    kept.push(preferred);
    for (const other of group)
      if (other !== preferred)
        report.duplicates.push({
          path: other.file.path,
          duplicateOf: preferred.file.path,
        });
  }
  kept.sort((a, b) => naturalCompare(a.rank, b.rank));

  // Bundle paths and members.
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const taken = new Set<string>();
  const bundlePath = (m: Material) => {
    const dir = m.lesson === null ? 'unit' : lessonKey(m.lesson);
    const name = safeName(m.fileName).slice(0, 200);
    let candidate = `${dir}/${name}`;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      candidate = `${dir}/${name.replace(/(\.[A-Za-z0-9]+)?$/, ` (${n})$1`)}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  };
  type Decl = {
    path: string;
    role: LessonAssetRelationship;
    audience?: MaterialAudience;
    title: string;
    step?: { key: string; order: number; label: string };
  };
  // Two different files that tidy to one title in a place are told apart, not shown twice.
  const usedTitles = new Set<string>();
  const uniqueTitle = (m: Material) => {
    const place = m.lesson === null ? 'unit' : lessonKey(m.lesson);
    let title = m.title;
    for (let n = 2; usedTitles.has(`${place}|${title.toLowerCase()}`); n++) {
      const suffix = ` (${n})`;
      // Truncate the base, never the counter, so each attempt is distinct.
      title = `${m.title.slice(0, 200 - suffix.length)}${suffix}`;
    }
    usedTitles.add(`${place}|${title.toLowerCase()}`);
    return title;
  };
  const decl = (m: Material, path: string): Decl => ({
    path,
    role: m.role,
    ...(m.audience !== LESSON_ASSET_DEFAULT_AUDIENCE[m.role]
      ? { audience: m.audience }
      : {}),
    title: uniqueTitle(m),
    // Slides open the lesson and the status check closes it; handouts, the
    // mission log and printables are prepared beforehand, guides are the adult's.
    ...(m.lesson !== null && m.role === 'slides'
      ? { step: LAUNCH_STEP }
      : m.lesson !== null && m.role === 'assessment'
        ? { step: CHECK_STEP }
        : {}),
  });
  const courseMembers: Decl[] = [];
  const lessons = new Map<
    number,
    {
      members: Decl[];
      logs: Array<{
        path: string;
        kind: 'pdf' | OfficeDocumentKind;
        bytes: Uint8Array;
      }>;
      manual?: Uint8Array;
    }
  >();
  const lessonOf = (n: number) => {
    let entry = lessons.get(n);
    if (!entry) {
      entry = { members: [], logs: [] };
      lessons.set(n, entry);
    }
    return entry;
  };
  for (const m of kept) {
    const path = bundlePath(m);
    files.push({ path, bytes: m.bytes });
    if (m.lesson === null) courseMembers.push(decl(m, path));
    else {
      const entry = lessonOf(m.lesson);
      entry.members.push(decl(m, path));
      if (m.role === 'teacher-guide' && m.ext === 'pdf' && !entry.manual)
        entry.manual = m.bytes;
      if (m.role === 'learner-pages')
        entry.logs.push({
          path,
          kind: m.ext as 'pdf' | OfficeDocumentKind,
          bytes: m.bytes,
        });
    }
  }

  // Videos against the playlist.
  let playlist: ClassCrunchLabsPlaylist | null = null;
  if (options.playlists && videoNames.length > 0)
    playlist = pickUnitPlaylist(await options.playlists.playlists(), unitName);
  if (!options.playlists && videoNames.length > 0)
    report.warnings.push(
      'No playlist source was given; videos were not matched.',
    );
  const matches = matchClassCrunchLabsVideos(
    videoNames,
    options.playlists ? playlist : null,
  );
  if (options.playlists && videoNames.length > 0 && !playlist)
    report.warnings.push(
      `No YouTube course playlist was found for ${unitName}.`,
    );
  report.videos.playlist = playlist
    ? { id: playlist.id, title: playlist.title }
    : null;
  report.videos.matched = matches.matched;
  report.videos.unmatched = matches.unmatched;
  report.videos.unusedPlaylistItems = matches.unusedItems;
  const videosByLesson = new Map<number, ClassCrunchLabsVideoMatch[]>();
  for (const v of matches.matched)
    videosByLesson.set(v.lesson, [...(videosByLesson.get(v.lesson) ?? []), v]);
  for (const n of videosByLesson.keys()) lessonOf(n);

  // Lesson pages from the mission log.
  const pageRanges = new Map<
    number,
    Array<{ member: string; from: number; to: number; label: string }>
  >();
  for (const [n, entry] of lessons) {
    const log = entry.logs[0];
    if (!log) continue;
    const counted = options.pageCounter
      ? await options
          .pageCounter({ bytes: log.bytes, kind: log.kind })
          .catch(() => null)
      : null;
    if (!counted || counted < 1) {
      report.warnings.push(
        `Lesson ${n}: the mission log page count is unknown, so no lesson pages were written.`,
      );
      continue;
    }
    const to = Math.min(counted, 500);
    pageRanges.set(n, [
      { member: log.path, from: 1, to, label: 'Mission log' },
    ]);
    report.pages.push({ lesson: n, path: log.path, pages: to });
  }

  // `Lesson N: Name`. The name is the headline on the cover of the lesson's
  // teacher manual when the host can read it, else the lesson's first
  // hands-on activity video (lowest step), else there is none.
  const headlines = new Map<number, string>();
  if (options.readFirstPageHeadline)
    for (const [n, entry] of lessons) {
      if (!entry.manual) continue;
      let text: unknown = null;
      try {
        text = await options.readFirstPageHeadline({
          bytes: entry.manual,
          kind: 'pdf',
        });
      } catch {
        text = null;
      }
      const name = typeof text === 'string' ? headlineTitle(text) : '';
      if (name) headlines.set(n, name);
    }
  const lessonTitle = (n: number) => {
    const named = videoNames
      .filter((v) => v.lesson === n && v.title)
      .sort((a, b) => stepOrder(a.step, b.step));
    const source = named.find((v) => v.kind === 'StudentHandsOnExploration');
    const name =
      headlines.get(n) ?? (source ? activityTitle(source.title) : '');
    return name ? `Lesson ${n}: ${name}`.slice(0, 200) : `Lesson ${n}`;
  };

  const manifestLessons = [...lessons.keys()]
    .sort((a, b) => a - b)
    .map((n) => {
      const entry = lessons.get(n) as NonNullable<
        ReturnType<typeof lessons.get>
      >;
      const seenCodes = new Map<string, number>();
      const videos = (videosByLesson.get(n) ?? [])
        .sort(
          (a, b) => stepOrder(a.step, b.step) || a.kind.localeCompare(b.kind),
        )
        .map((v) => {
          const label = KIND_LABELS[v.kind] ?? humanize(v.kind);
          // Videos sharing a code keep their order within the step by a tiny offset.
          const nth = seenCodes.get(v.step) ?? 0;
          seenCodes.set(v.step, nth + 1);
          return {
            reference: v.videoId,
            title: (v.title ? `${label}: ${v.title}` : label).slice(0, 200),
            // The video's real step code names its lesson step; videos sharing a
            // code (materials prep and hands-on) share the step.
            step: {
              key: v.step,
              order:
                Math.round(
                  (classCrunchLabsStepOrder(v.step) + nth / 1000) * 1000,
                ) / 1000,
              label: (v.title ? `${label}: ${v.title}` : label).slice(0, 200),
            },
            ...(VIDEO_AUDIENCE_GUARDIAN.has(v.kind)
              ? { audience: 'guardian' }
              : {}),
          };
        });
      return {
        key: lessonKey(n),
        title: lessonTitle(n),
        // Unit-wide position, so parts of a split unit merge in lesson order.
        order: n,
        members: entry.members,
        ...(pageRanges.has(n) ? { pages: pageRanges.get(n) } : {}),
        ...(videos.length ? { videos } : {}),
      };
    });
  if (manifestLessons.length === 0)
    throw new ClassCrunchLabsError(
      'empty_unit',
      courseMembers.length
        ? 'The unit has no lessons.'
        : 'The unit has no usable materials.',
    );

  // One bundle when it fits; otherwise lessons are split across parts that each
  // stay under the part budget (the bundle reader caps one archive at 100 MiB).
  const maxPartBytes = Math.min(
    options.maxPartBytes ?? DEFAULT_PART_BYTES,
    COURSE_BUNDLE_LIMITS.maxArchiveBytes - 1024 * 1024,
  );
  const byPath = new Map(files.map((f) => [f.path, f]));
  const weigh = (members: Decl[]) =>
    members.reduce(
      (n, m) => n + (byPath.get(m.path)?.bytes.byteLength ?? 0),
      0,
    );
  // The first part carries the course-level members; lessons go into the first
  // part with room (so a small lesson can share it), else start a new part.
  const courseBytes = weigh(courseMembers);
  if (courseBytes > maxPartBytes)
    throw new ClassCrunchLabsError(
      'too_large',
      'The unit-wide materials alone exceed the bundle size limit.',
    );
  const groups: Array<{
    lessons: typeof manifestLessons;
    course: Decl[];
    bytes: number;
  }> = [{ lessons: [], course: courseMembers, bytes: courseBytes }];
  for (const lesson of manifestLessons) {
    const bytes = weigh(lesson.members);
    if (bytes > maxPartBytes)
      throw new ClassCrunchLabsError(
        'too_large',
        `${lesson.title} alone exceeds the bundle size limit.`,
      );
    let group = groups.find((g) => g.bytes + bytes <= maxPartBytes);
    if (!group) {
      group = { lessons: [], course: [], bytes: 0 };
      groups.push(group);
    }
    group.lessons.push(lesson);
    group.bytes += bytes;
  }
  // A manifest needs a lesson, so the course-level members cannot be a part alone.
  if (groups[0]?.lessons.length === 0)
    throw new ClassCrunchLabsError(
      'too_large',
      'The unit-wide materials leave no room for any lesson in the same bundle part.',
    );
  const courseKey = classCrunchLabsUnitKey(unitName);
  const parts: ClassCrunchLabsBundlePart[] = groups.map((group, index) => {
    const manifest = {
      version: COURSE_BUNDLE_MANIFEST_VERSION_2,
      course: {
        subject: CLASS_CRUNCHLABS_SUBJECT,
        key: courseKey,
        title: unitName.slice(0, 300),
      },
      // Every part names the unit, so `attachCourse` merges them into one course.
      part: { index: index + 1, count: groups.length },
      ...(group.course.length ? { courseMembers: group.course } : {}),
      sections: [
        {
          key: 'unit',
          title: unitName.slice(0, 300),
          order: 0,
          lessons: group.lessons,
        },
      ],
    };
    const used = new Set(
      [...group.course, ...group.lessons.flatMap((l) => l.members)].map(
        (m) => m.path,
      ),
    );
    const partFiles = [
      {
        path: COURSE_BUNDLE_MANIFEST_PATH,
        bytes: Buffer.from(JSON.stringify(manifest)) as Uint8Array,
      },
      ...files.filter((f) => used.has(f.path)),
    ];
    const actual = partFiles.reduce((n, f) => n + f.bytes.byteLength, 0);
    if (actual > COURSE_BUNDLE_LIMITS.maxArchiveBytes)
      throw new ClassCrunchLabsError(
        'too_large',
        'A part of the unit exceeds the bundle size limit.',
      );
    if (partFiles.length > COURSE_BUNDLE_LIMITS.maxEntries)
      throw new ClassCrunchLabsError(
        'too_large',
        'A part of the unit has too many files for one bundle.',
      );
    return {
      bundle: { files: partFiles },
      manifest,
      lessons: group.lessons.map((l) => Number(l.key.slice('lesson-'.length))),
    };
  });
  const first = parts[0] as ClassCrunchLabsBundlePart;
  report.lessons = manifestLessons.length;
  report.members = kept.length;
  report.courseMembers = courseMembers.length;
  report.parts = parts.length;
  return {
    unit: unitName,
    unitKey: courseKey,
    parts,
    bundle: first.bundle,
    manifest: first.manifest,
    licenseKind: CLASS_CRUNCHLABS_LICENSE_KIND,
    report,
  };
}

/**
 * A page counter for mission logs: PDFs are counted directly (`pdf-lib`), Word
 * and PowerPoint files by asking the injected converter to render them. Without
 * a converter, only PDFs are counted. The count is a convenience for the page
 * range; the importer still renders the member itself.
 */
export function createClassCrunchLabsPageCounter(
  options: {
    converter?: DocumentConverter;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): ClassCrunchLabsPageCounter {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  return async ({ bytes, kind }) => {
    const { PDFDocument } = await import('pdf-lib');
    let pdf: Uint8Array | null = null;
    if (kind === 'pdf') pdf = bytes;
    else if (options.converter) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        pdf = (
          await options.converter.convertToPdf({
            bytes,
            kind,
            fileName: `document.${kind}`,
            limits: {
              maxInputBytes: maxBytes,
              maxOutputBytes: maxBytes,
              timeoutMs,
            },
            signal: controller.signal,
          })
        ).pdf;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!pdf) return null;
    try {
      const doc = await PDFDocument.load(pdf, { updateMetadata: false });
      return doc.getPageCount();
    } catch {
      return null;
    }
  };
}
