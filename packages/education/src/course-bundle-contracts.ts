import { CourseAuthoringError } from './course-authoring-contracts.js';

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Hard ceilings for untrusted course bundles (SMRT #4578). A host may lower any
 * of them per call (`resolveCourseBundleLimits`) but never raise them. Declared
 * sizes in an archive are never trusted: every cap is enforced on the bytes
 * actually produced.
 */
export interface CourseBundleLimits {
  /** Largest accepted archive (or total input of a plain file set), in bytes. */
  maxArchiveBytes: number;
  /** Most entries (files and directories) in one archive or file set. */
  maxEntries: number;
  /** Largest single inflated member. A larger honest member is recorded refused. */
  maxEntryBytes: number;
  /** Largest sum of inflated members. */
  maxTotalBytes: number;
  /** Largest inflated/compressed ratio for a member above `ratioFloorBytes`. */
  maxCompressionRatio: number;
  /** Members at or below this inflated size skip the ratio check. */
  ratioFloorBytes: number;
  /** Longest normalised path, in UTF-8 bytes. */
  maxPathBytes: number;
  /** Longest path segment, in UTF-8 bytes. */
  maxSegmentBytes: number;
  /** Deepest directory path (segments, including the file name). */
  maxPathDepth: number;
  /** Largest `manifest.json`. */
  maxManifestBytes: number;
  /** Most lessons one bundle may propose (matches the proposal schema). */
  maxLessons: number;
  /** Longest text member used as a lesson body, in characters. */
  maxLessonBodyChars: number;
  /** Most Word/PowerPoint members rendered per bundle; later ones are recorded unsupported. */
  maxOfficeMembers: number;
  /** Largest rendered PDF accepted back from the converter, in bytes. */
  maxRenderedBytes: number;
  /** Wall-clock budget for rendering one Office member, in milliseconds. */
  conversionTimeoutMs: number;
  /** Largest first-page thumbnail accepted back from the converter, in bytes. */
  maxThumbnailBytes: number;
}

export const COURSE_BUNDLE_LIMITS: Readonly<CourseBundleLimits> = Object.freeze(
  {
    maxArchiveBytes: 100 * MiB,
    maxEntries: 200,
    maxEntryBytes: 50 * MiB,
    maxTotalBytes: 200 * MiB,
    maxCompressionRatio: 100,
    ratioFloorBytes: 64 * KiB,
    maxPathBytes: 512,
    maxSegmentBytes: 255,
    maxPathDepth: 8,
    maxManifestBytes: 256 * KiB,
    maxLessons: 50,
    maxLessonBodyChars: 100_000,
    maxOfficeMembers: 50,
    maxRenderedBytes: 50 * MiB,
    conversionTimeoutMs: 60_000,
    maxThumbnailBytes: 5 * MiB,
  },
);

/** Nested archives are never expanded: depth is one, and a zip member is unsupported evidence. */
export const COURSE_BUNDLE_MAX_ARCHIVE_DEPTH = 1;
/** The original manifest schema version (page roles, no materials). */
export const COURSE_BUNDLE_MANIFEST_VERSION = 1;
/** Manifest version 2: material roles and audience, lesson pages, course members, videos. */
export const COURSE_BUNDLE_MANIFEST_VERSION_2 = 2;
/** Manifest location: the archive (or file set) root. */
export const COURSE_BUNDLE_MANIFEST_PATH = 'manifest.json';

/** Clamp a host override to the hard ceilings; invalid values fall back to the ceiling. */
export function resolveCourseBundleLimits(
  override: Partial<CourseBundleLimits> = {},
): CourseBundleLimits {
  const out = { ...COURSE_BUNDLE_LIMITS };
  for (const key of Object.keys(out) as Array<keyof CourseBundleLimits>) {
    const value = override[key];
    if (
      value !== undefined &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= COURSE_BUNDLE_LIMITS[key]
    )
      out[key] = value;
  }
  return out;
}

export type CourseBundleRefusalReason =
  | 'archive_too_large'
  | 'not_a_zip'
  | 'truncated'
  | 'ambiguous_end_record'
  | 'zip64_unsupported'
  | 'multi_disk'
  | 'too_many_entries'
  | 'invalid_central_directory'
  | 'invalid_entry'
  | 'unsupported_method'
  | 'encrypted_entry'
  | 'symlink_entry'
  | 'special_entry'
  | 'invalid_path'
  | 'path_too_deep'
  | 'duplicate_name'
  | 'entry_out_of_range'
  | 'overlapping_entries'
  | 'local_header_mismatch'
  | 'compression_ratio'
  | 'total_too_large'
  | 'size_mismatch'
  | 'bad_crc'
  | 'inflate_failed'
  | 'empty_bundle'
  | 'manifest_invalid'
  | 'manifest_version'
  | 'manifest_unknown_key'
  /** v2: a member role that is not a material role. */
  | 'manifest_role'
  /** v2: a learner audience on a guardian-only role, or an unknown audience. */
  | 'manifest_audience'
  /** v2: a page range that is malformed or names a member that cannot be paged. */
  | 'manifest_pages'
  /** v2: a video reference that is not an allowlisted YouTube id or URL. */
  | 'manifest_video'
  | 'manifest_missing_member'
  | 'manifest_duplicate_member'
  | 'duplicate_key'
  | 'too_many_lessons'
  | 'lesson_too_large';

/**
 * The whole bundle is refused: it is hostile, damaged or outside the contract.
 * `reason` is stable; `entry` names the offending member path when one applies
 * (untrusted text, never rendered as markup).
 */
export class CourseBundleRefusedError extends CourseAuthoringError {
  constructor(
    readonly reason: CourseBundleRefusalReason,
    readonly entry?: string,
  ) {
    super('course-bundle-refused', `Course bundle refused: ${reason}.`);
  }
}
export class CourseBundleNotFoundError extends CourseAuthoringError {
  constructor() {
    super('course-bundle-not-found', 'Course bundle import was not found.');
  }
}

/** What the bytes of a bundle member turned out to be (by content, never by name alone). */
export type CourseBundleMemberKind =
  | 'pdf'
  | 'image'
  | 'text'
  /** Word (`.docx`): rendered to PDF by the converter, text read by the SDK processor. */
  | 'docx'
  /** PowerPoint (`.pptx`): the deck is kept as the original and as rendered pages. */
  | 'pptx'
  /** Excel (`.xlsx`): rendered to PDF by the converter; no text reader. */
  | 'xlsx'
  | 'manifest'
  | 'unsupported';
export type CourseBundleMemberStatus =
  /** Supported, unique content: handed to extraction and eligible for a lesson. */
  | 'accepted'
  /** Identical bytes to an earlier accepted member: evidence only, never extracted twice. */
  | 'duplicate'
  /** Visible but not understood (unknown type, nested archive, unreadable text). */
  | 'unsupported'
  /** Understood and refused (encrypted PDF, oversize member). */
  | 'refused'
  /** The bundle manifest itself. */
  | 'metadata';
export type CourseBundleMemberReason =
  | 'unsupported_type'
  | 'nested_archive'
  | 'unreadable_text'
  | 'encrypted_pdf'
  | 'entry_too_large'
  | 'duplicate_content'
  /** The OOXML package failed the bounded zip checks (bomb, bad paths, damaged). */
  | 'unsafe_office'
  /** More Office members than `maxOfficeMembers`. */
  | 'office_limit'
  /** No `DocumentConverter` is configured: the member cannot be rendered. */
  | 'converter_unavailable'
  /** The converter could not be reached or failed (server side). */
  | 'converter_failed'
  | 'converter_timeout'
  | 'converter_too_large'
  /** The converter refused the file, or returned something that is not a PDF. */
  | 'converter_rejected';

/**
 * Converter outcomes that a deliberate retry may repair. A bundle that was
 * never rendered or whose converter was unreachable can be rendered later;
 * a file the converter rejected, or a limit, cannot be fixed by asking again.
 */
export const COURSE_BUNDLE_RETRYABLE_REASONS: ReadonlySet<CourseBundleMemberReason> =
  new Set(['converter_unavailable', 'converter_failed', 'converter_timeout']);

export const COURSE_BUNDLE_PAGE_ROLES = [
  'exercise',
  'example',
  'instructions',
  'cover',
  'answer_key',
  'mixed',
  'unknown',
] as const;
export type CourseBundlePageRole = (typeof COURSE_BUNDLE_PAGE_ROLES)[number];

/** Named progress stages, in order. */
export const COURSE_BUNDLE_STAGES = [
  'unpack',
  'classify',
  'render',
  'extract',
  'propose',
] as const;
export type CourseBundleStage = (typeof COURSE_BUNDLE_STAGES)[number];
/** One progress event. A stage emits `completed: 0` first and `completed === total` last. */
export interface CourseBundleProgress {
  stage: CourseBundleStage;
  completed: number;
  total: number;
}
/** Observer only: a throwing listener never changes the import. */
export type CourseBundleProgressListener = (
  event: CourseBundleProgress,
) => void;

/** A bundle supplied as one zip archive or as a plain set of files. */
export type CourseBundleInput =
  | { archive: Uint8Array }
  | { files: ReadonlyArray<{ path: string; bytes: Uint8Array }> };
