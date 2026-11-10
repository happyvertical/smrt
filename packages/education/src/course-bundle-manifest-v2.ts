/**
 * Course bundle manifest version 2 (SMRT #4615): a closed schema that places
 * members with a material role and an audience, names the pages of a lesson
 * (a member plus page ranges), carries course-level members, and references
 * allowlisted external videos. Pure parsing; nothing here reads bytes.
 *
 * ```json
 * { "version": 2, "course": { "subject": "Science", "key": "unit-a", "title": "Unit A" },
 *   "part": { "index": 1, "count": 2 },
 *   "courseMembers": [ { "path": "unit/supplies.pdf", "role": "attachment" } ],
 *   "sections": [ { "key": "unit", "title": "Unit", "lessons": [ {
 *     "key": "l1", "title": "Lesson 1",
 *     "members": [ { "path": "l1/log.pdf", "role": "learner-pages" },
 *                  { "path": "l1/guide.pdf", "role": "teacher-guide" } ],
 *     "pages": [ { "member": "l1/log.pdf", "from": 1, "to": 4, "label": "Mission log" } ],
 *     "videos": [ { "reference": "dQw4w9WgXcQ", "title": "Recap", "step": 1 } ] } ] } ] }
 * ```
 *
 * A lesson member or video may also name the lesson step it belongs to
 * (SMRT #4656): `"step": { "key": "launch", "order": 0, "label": "Launch" }`.
 * A video's `step` stays a whole number, or takes this object form too.
 * ```
 * ```
 */
import {
  COURSE_BUNDLE_LIMITS,
  COURSE_BUNDLE_MANIFEST_PATH,
  COURSE_BUNDLE_MANIFEST_VERSION_2,
  type CourseBundleLimits,
} from './course-bundle-contracts.js';
import {
  closedObject,
  manifestKey,
  manifestText,
  refuse,
} from './course-bundle-manifest-util.js';
import { normalizeBundlePath } from './course-bundle-zip.js';
import {
  GUARDIAN_ONLY_RELATIONSHIPS,
  LESSON_ASSET_DEFAULT_AUDIENCE,
  LESSON_ASSET_RELATIONSHIPS,
  LESSON_STEP_KEY_MAX,
  LESSON_STEP_LABEL_MAX,
  LESSON_STEP_ORDER_MAX,
  type LessonAssetRelationship,
  type LessonStepDeclaration,
  type MaterialAudience,
  parseYouTubeReference,
} from './lesson-assets.js';

/** Roles a bundle file member may take. A video is an external reference, never a file member. */
export const COURSE_BUNDLE_MATERIAL_ROLES: readonly LessonAssetRelationship[] =
  Object.freeze(LESSON_ASSET_RELATIONSHIPS.filter((role) => role !== 'video'));

/** Most pages one lesson may declare, and the highest page number a range may name. */
export const COURSE_BUNDLE_MAX_LESSON_PAGES = 500;
export const COURSE_BUNDLE_MAX_PAGE_NUMBER = 5_000;
export const COURSE_BUNDLE_MAX_STEP = 9_999;

/** A declared lesson step: key, order and the label ('' when none). */
export type ManifestV2Step = Required<LessonStepDeclaration>;
export interface ManifestV2Member {
  path: string;
  /** The lesson step this material belongs to (lesson members only). */
  step?: ManifestV2Step;
  role: LessonAssetRelationship;
  /** Effective audience: stated, else the role default. */
  audience: MaterialAudience;
  title: string;
}
export interface ManifestV2PageRange {
  /** Path of a member declared in the same lesson. */
  member: string;
  from: number;
  to: number;
  /** Label prefix; pages are labelled `<label> <n>` (default `Page <n>`). */
  label: string;
}
export interface ManifestV2Video {
  provider: 'youtube';
  videoId: string;
  title: string;
  stepOrder: number;
  /** The lesson step this video belongs to, when declared as an object. */
  step?: ManifestV2Step;
  audience: MaterialAudience;
}
export interface ManifestV2Lesson {
  key: string;
  title: string;
  /** Declared unit-wide position; absent means the position in this manifest. */
  order?: number;
  members: ManifestV2Member[];
  pages: ManifestV2PageRange[];
  videos: ManifestV2Video[];
}
/**
 * The unit a bundle belongs to: a stable key shared by every part of a unit
 * split across bundles, the course title, and which part this bundle is.
 */
export interface ManifestV2Unit {
  key: string;
  title: string;
  /** 1-based part number. */
  part: number;
  /** How many parts the unit has. */
  parts: number;
}
export interface ManifestV2 {
  subject?: string;
  /** Present when the manifest names its unit (`course.key`). */
  unit?: ManifestV2Unit;
  sections: Array<{
    key: string;
    title: string;
    /** Declared unit-wide position; absent means the position in this manifest. */
    order?: number;
    lessons: ManifestV2Lesson[];
  }>;
  courseMembers: ManifestV2Member[];
}

/** Most parts one unit may be split into. */
export const COURSE_BUNDLE_MAX_PARTS = 50;
/** Highest explicit section or lesson `order`. */
export const COURSE_BUNDLE_MAX_ORDER = 9_999;

function audienceOf(
  role: LessonAssetRelationship,
  value: unknown,
  path: string,
): MaterialAudience {
  if (value === undefined) return LESSON_ASSET_DEFAULT_AUDIENCE[role];
  if (value !== 'learner' && value !== 'guardian')
    return refuse('manifest_audience', path);
  if (value === 'learner' && GUARDIAN_ONLY_RELATIONSHIPS.has(role))
    return refuse('manifest_audience', path);
  return value;
}

function integer(value: unknown, path: string, min: number, max: number) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return refuse('manifest_invalid', path);
  return value;
}

const STEP_KEY = /^[A-Za-z0-9._:-]+$/;
function stepOf(raw: unknown, path: string): ManifestV2Step {
  const decl = closedObject(raw, ['key', 'order', 'label'], path);
  if (
    typeof decl.key !== 'string' ||
    decl.key.length > LESSON_STEP_KEY_MAX ||
    !STEP_KEY.test(decl.key)
  )
    return refuse('manifest_invalid', `${path}.key`);
  if (
    typeof decl.order !== 'number' ||
    !Number.isFinite(decl.order) ||
    Math.abs(decl.order) > LESSON_STEP_ORDER_MAX
  )
    return refuse('manifest_invalid', `${path}.order`);
  return {
    key: decl.key,
    order: decl.order,
    label:
      decl.label === undefined
        ? ''
        : manifestText(decl.label, `${path}.label`, LESSON_STEP_LABEL_MAX),
  };
}

/** Closed, versioned manifest schema: any unknown key is refused. */
export function parseBundleManifestV2(
  bytes: Uint8Array,
  paths: ReadonlySet<string>,
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
): ManifestV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    return refuse('manifest_invalid', COURSE_BUNDLE_MANIFEST_PATH);
  }
  const root = closedObject(
    parsed,
    ['version', 'course', 'part', 'sections', 'courseMembers'],
    'manifest',
  );
  if (root.version !== COURSE_BUNDLE_MANIFEST_VERSION_2)
    return refuse('manifest_version', 'manifest.version');
  const manifest: ManifestV2 = { sections: [], courseMembers: [] };
  let unitKey: string | null = null;
  let unitTitle = '';
  if (root.course !== undefined) {
    const course = closedObject(
      root.course,
      ['subject', 'key', 'title'],
      'manifest.course',
    );
    if (course.subject !== undefined)
      manifest.subject = manifestText(
        course.subject,
        'manifest.course.subject',
        200,
      );
    if (course.key !== undefined)
      unitKey = manifestKey(course.key, 'manifest.course.key');
    if (course.title !== undefined)
      unitTitle = manifestText(course.title, 'manifest.course.title', 300);
  }
  // A part of a split unit must name the unit, so its parts can be merged.
  let part = 1;
  let parts = 1;
  if (root.part !== undefined) {
    const decl = closedObject(root.part, ['index', 'count'], 'manifest.part');
    parts = integer(
      decl.count,
      'manifest.part.count',
      1,
      COURSE_BUNDLE_MAX_PARTS,
    );
    part = integer(decl.index, 'manifest.part.index', 1, parts);
    if (unitKey === null) return refuse('manifest_invalid', 'manifest.part');
  }
  if (unitKey !== null)
    manifest.unit = { key: unitKey, title: unitTitle, part, parts };
  // Kept only when declared, so merged parts compare declared orders alone.
  const order = (value: unknown, path: string) =>
    value === undefined
      ? {}
      : { order: integer(value, path, 0, COURSE_BUNDLE_MAX_ORDER) };
  const listed = new Set<string>();
  const member = (
    raw: unknown,
    mp: string,
    lessonLevel: boolean,
  ): ManifestV2Member => {
    const decl = closedObject(
      raw,
      lessonLevel
        ? ['path', 'role', 'audience', 'title', 'step']
        : ['path', 'role', 'audience', 'title'],
      mp,
    );
    if (typeof decl.path !== 'string')
      return refuse('manifest_invalid', `${mp}.path`);
    let normal: string;
    try {
      normal = normalizeBundlePath(decl.path, limits).path;
    } catch {
      return refuse('manifest_invalid', `${mp}.path`);
    }
    if (!paths.has(normal) || normal === COURSE_BUNDLE_MANIFEST_PATH)
      return refuse('manifest_missing_member', `${mp}.path`);
    if (listed.has(normal))
      return refuse('manifest_duplicate_member', `${mp}.path`);
    listed.add(normal);
    if (
      typeof decl.role !== 'string' ||
      !(COURSE_BUNDLE_MATERIAL_ROLES as readonly string[]).includes(decl.role)
    )
      return refuse('manifest_role', `${mp}.role`);
    const role = decl.role as LessonAssetRelationship;
    return {
      path: normal,
      role,
      ...(decl.step === undefined
        ? {}
        : { step: stepOf(decl.step, `${mp}.step`) }),
      audience: audienceOf(role, decl.audience, `${mp}.audience`),
      title:
        decl.title === undefined
          ? ''
          : manifestText(decl.title, `${mp}.title`, 200),
    };
  };
  const members = (
    raw: unknown,
    path: string,
    lessonLevel: boolean,
  ): ManifestV2Member[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return refuse('manifest_invalid', path);
    return raw.map((m, i) => member(m, `${path}.${i}`, lessonLevel));
  };

  if (!Array.isArray(root.sections) || root.sections.length === 0)
    return refuse('manifest_invalid', 'manifest.sections');
  if (root.sections.length > limits.maxLessons)
    return refuse('too_many_lessons');
  const sectionKeys = new Set<string>();
  const lessonKeys = new Set<string>();
  let lessons = 0;
  for (const [s, rawSection] of (root.sections as unknown[]).entries()) {
    const sp = `manifest.sections.${s}`;
    const section = closedObject(
      rawSection,
      ['key', 'title', 'order', 'lessons'],
      sp,
    );
    const sectionKey = manifestKey(section.key, `${sp}.key`);
    if (sectionKeys.has(sectionKey)) refuse('duplicate_key', `${sp}.key`);
    sectionKeys.add(sectionKey);
    if (!Array.isArray(section.lessons) || section.lessons.length === 0)
      return refuse('manifest_invalid', `${sp}.lessons`);
    const outLessons: ManifestV2Lesson[] = [];
    for (const [l, rawLesson] of (section.lessons as unknown[]).entries()) {
      const lp = `${sp}.lessons.${l}`;
      const lesson = closedObject(
        rawLesson,
        ['key', 'title', 'order', 'members', 'pages', 'videos'],
        lp,
      );
      const lessonKey = manifestKey(lesson.key, `${lp}.key`);
      if (lessonKeys.has(lessonKey)) refuse('duplicate_key', `${lp}.key`);
      lessonKeys.add(lessonKey);
      if (++lessons > limits.maxLessons) refuse('too_many_lessons');
      const lessonMembers = members(lesson.members, `${lp}.members`, true);
      const memberPaths = new Set(lessonMembers.map((m) => m.path));

      const pages: ManifestV2PageRange[] = [];
      if (lesson.pages !== undefined) {
        if (!Array.isArray(lesson.pages))
          return refuse('manifest_invalid', `${lp}.pages`);
        let total = 0;
        for (const [i, rawPage] of (lesson.pages as unknown[]).entries()) {
          const pp = `${lp}.pages.${i}`;
          const range = closedObject(
            rawPage,
            ['member', 'from', 'to', 'label'],
            pp,
          );
          if (typeof range.member !== 'string')
            return refuse('manifest_pages', `${pp}.member`);
          let target: string;
          try {
            target = normalizeBundlePath(range.member, limits).path;
          } catch {
            return refuse('manifest_pages', `${pp}.member`);
          }
          if (!memberPaths.has(target))
            return refuse('manifest_pages', `${pp}.member`);
          const from = integer(
            range.from,
            `${pp}.from`,
            1,
            COURSE_BUNDLE_MAX_PAGE_NUMBER,
          );
          const to = integer(
            range.to,
            `${pp}.to`,
            1,
            COURSE_BUNDLE_MAX_PAGE_NUMBER,
          );
          if (to < from) return refuse('manifest_pages', `${pp}.to`);
          total += to - from + 1;
          if (total > COURSE_BUNDLE_MAX_LESSON_PAGES)
            return refuse('manifest_pages', `${lp}.pages`);
          pages.push({
            member: target,
            from,
            to,
            label:
              range.label === undefined
                ? ''
                : manifestText(range.label, `${pp}.label`, 100),
          });
        }
      }

      const videos: ManifestV2Video[] = [];
      if (lesson.videos !== undefined) {
        if (!Array.isArray(lesson.videos))
          return refuse('manifest_invalid', `${lp}.videos`);
        const seen = new Set<string>();
        for (const [i, rawVideo] of (lesson.videos as unknown[]).entries()) {
          const vp = `${lp}.videos.${i}`;
          const video = closedObject(
            rawVideo,
            ['reference', 'title', 'step', 'audience'],
            vp,
          );
          const videoId =
            typeof video.reference === 'string'
              ? parseYouTubeReference(video.reference)
              : null;
          if (!videoId) return refuse('manifest_video', `${vp}.reference`);
          if (seen.has(videoId))
            return refuse('duplicate_key', `${vp}.reference`);
          seen.add(videoId);
          // A whole number is the long-standing video rank; an object also
          // names the lesson step (SMRT #4656), ranking the video by its floor.
          const step =
            video.step !== null && typeof video.step === 'object'
              ? stepOf(video.step, `${vp}.step`)
              : undefined;
          videos.push({
            provider: 'youtube',
            videoId,
            title: manifestText(video.title, `${vp}.title`, 200),
            stepOrder: step
              ? Math.min(
                  COURSE_BUNDLE_MAX_STEP,
                  Math.max(0, Math.floor(step.order)),
                )
              : integer(video.step, `${vp}.step`, 0, COURSE_BUNDLE_MAX_STEP),
            ...(step ? { step } : {}),
            audience: audienceOf('video', video.audience, `${vp}.audience`),
          });
        }
      }
      outLessons.push({
        key: lessonKey,
        title: manifestText(lesson.title, `${lp}.title`, 300),
        ...order(lesson.order, `${lp}.order`),
        members: lessonMembers,
        pages,
        videos,
      });
    }
    manifest.sections.push({
      key: sectionKey,
      title: manifestText(section.title, `${sp}.title`, 300),
      ...order(section.order, `${sp}.order`),
      lessons: outLessons,
    });
  }
  manifest.courseMembers = members(
    root.courseMembers,
    'manifest.courseMembers',
    false,
  );
  return manifest;
}
