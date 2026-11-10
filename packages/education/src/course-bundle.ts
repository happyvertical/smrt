/**
 * Course bundle classification, manifest and structure planning (SMRT #4578).
 * Pure functions over already-bounded members from `course-bundle-zip.ts`.
 */
import {
  COURSE_BUNDLE_LIMITS,
  COURSE_BUNDLE_MANIFEST_PATH,
  COURSE_BUNDLE_MANIFEST_VERSION,
  COURSE_BUNDLE_MANIFEST_VERSION_2,
  COURSE_BUNDLE_PAGE_ROLES,
  type CourseBundleInput,
  type CourseBundleLimits,
  type CourseBundleMemberKind,
  type CourseBundleMemberReason,
  type CourseBundleMemberStatus,
  type CourseBundlePageRole,
  CourseBundleRefusedError,
} from './course-bundle-contracts.js';
import {
  closedObject as closed,
  manifestKey as key,
  manifestVersionOf,
  refuse,
  manifestText as text,
} from './course-bundle-manifest-util.js';
import {
  type ManifestV2,
  type ManifestV2Step,
  parseBundleManifestV2,
} from './course-bundle-manifest-v2.js';
import {
  isWellFormedString,
  normalizeBundlePath,
  type RawBundleMember,
  readFileSet,
  readZipArchive,
  sha256Hex,
} from './course-bundle-zip.js';
import {
  isOfficeDocumentKind,
  OFFICE_MEDIA_TYPES,
  type OfficeDocumentKind,
  type OfficeText,
} from './document-converter.js';
import type {
  LessonAssetRelationship,
  MaterialAudience,
} from './lesson-assets.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters in text
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** A member after sniffing its bytes. `bytes` is present only for `accepted` members. */
export interface ClassifiedBundleMember {
  path: string;
  size: number;
  sha256: string | null;
  kind: CourseBundleMemberKind;
  mediaType: string;
  status: CourseBundleMemberStatus;
  reason: CourseBundleMemberReason | null;
  /** Path of the earlier member with identical bytes. */
  duplicateOf: string | null;
  bytes: Uint8Array | null;
  /** Decoded body of a readable text member. */
  text: string | null;
  /** Word/PowerPoint only: the PDF the converter rendered (set before the evidence is written). */
  rendered: {
    bytes: Uint8Array;
    sha256: string;
    /** First-page image when the converter drew one; null otherwise. */
    thumbnail?: RenderedThumbnail | null;
  } | null;
  /** Word/PowerPoint only: text read by the injected `OfficeTextReader`, when available. */
  officeText: OfficeText | null;
}

export interface BundleStructureLesson {
  key: string;
  title: string;
  /** Unit-wide position; defaults to the position in the bundle. */
  order?: number;
  /** Member paths in declared order. */
  paths: string[];
  /**
   * Role per path, `''` when none was declared: a page role under manifest
   * version 1, a material role under version 2.
   */
  roles: Array<CourseBundlePageRole | LessonAssetRelationship | ''>;
  /** Version 2: the effective audience per path (parallel to `paths`). */
  audiences?: Array<MaterialAudience | ''>;
  /** Version 2: member titles per path (`''` when none). */
  titles?: string[];
  /** Version 2: the lesson step per path (`null` when none; SMRT #4656). */
  steps?: Array<ManifestV2Step | null>;
  /** Version 2: page ranges and external videos. */
  pages?: ManifestV2['sections'][number]['lessons'][number]['pages'];
  videos?: ManifestV2['sections'][number]['lessons'][number]['videos'];
}
export interface BundleStructureSection {
  key: string;
  title: string;
  /** Unit-wide position; defaults to the position in the bundle. */
  order?: number;
  lessons: BundleStructureLesson[];
}
export interface BundleStructure {
  subject?: string;
  /** Version 2: the unit this bundle is (a part of), when the manifest names one. */
  unit?: ManifestV2['unit'];
  sections: BundleStructureSection[];
  /** Version 2: members that belong to the course rather than a lesson. */
  courseMembers?: ManifestV2['courseMembers'];
}
export interface PreparedBundle {
  readerId: string;
  manifestVersion: number;
  /** Canonical member order: declared members first, then the rest by natural path order. */
  order: string[];
  /** Build the section/lesson tree once duplicate evidence has been marked. */
  structure(members: readonly ClassifiedBundleMember[]): BundleStructure;
}
/**
 * Open reader interface keyed by format id. Hosts register more formats (for
 * example SCORM or Common Cartridge) ahead of the built-ins; none ships here.
 * A reader sees only bounded, classified members and must be deterministic.
 */
export interface BundleReader {
  readonly formatId: string;
  detect(members: readonly ClassifiedBundleMember[]): boolean;
  prepare(
    members: readonly ClassifiedBundleMember[],
    limits: CourseBundleLimits,
  ): PreparedBundle;
}
export class BundleReaderRegistry {
  private readonly readers: BundleReader[] = [];
  register(reader: BundleReader, options: { first?: boolean } = {}): this {
    if (this.readers.some((r) => r.formatId === reader.formatId))
      throw new Error(`Bundle reader ${reader.formatId} is already registered`);
    if (options.first) this.readers.unshift(reader);
    else this.readers.push(reader);
    return this;
  }
  resolve(members: readonly ClassifiedBundleMember[]): BundleReader {
    const reader = this.readers.find((r) => r.detect(members));
    if (!reader) throw new CourseBundleRefusedError('empty_bundle');
    return reader;
  }
  formats(): string[] {
    return this.readers.map((r) => r.formatId);
  }
}

// -- classification -----------------------------------------------------------

/** True when the file carries an `/Encrypt` token anywhere (trailer, xref stream or dictionary). */
export function pdfIsEncrypted(bytes: Uint8Array): boolean {
  return (
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(
      '/Encrypt',
    ) !== -1
  );
}
function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0) {
  return signature.every((b, i) => bytes[at + i] === b);
}
/** PNG, JPEG or WebP by signature (a thumbnail check), else null. */
export function sniffImageMediaType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return 'image/webp';
  return null;
}
function sniff(
  bytes: Uint8Array,
): { kind: 'pdf' | 'image'; mediaType: string } | 'archive' | null {
  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.length, 1024),
  );
  if (head.indexOf('%PDF-') !== -1)
    return { kind: 'pdf', mediaType: 'application/pdf' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: 'image', mediaType: 'image/png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff]))
    return { kind: 'image', mediaType: 'image/jpeg' };
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return { kind: 'image', mediaType: 'image/webp' };
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
  )
    return 'archive';
  return null;
}
const TEXT_NAME = /\.(txt|md|markdown)$/i;
const OFFICE_NAME = /\.(docx|pptx|xlsx)$/i;
const OFFICE_MAIN_PART: Record<OfficeDocumentKind, string> = {
  docx: 'word/document.xml',
  pptx: 'ppt/presentation.xml',
  xlsx: 'xl/workbook.xml',
};
/**
 * Bounds for the OOXML package inside a Word/PowerPoint member. These are the
 * bundle's own zip checks (bomb ratio, overlap, paths, CRC) applied once more
 * before the bytes go anywhere near a reader or converter; they are not host
 * lowerable and a nested archive in the bundle is still never expanded.
 */
const OFFICE_PACKAGE_LIMITS: CourseBundleLimits = {
  ...COURSE_BUNDLE_LIMITS,
  maxEntries: 2_000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxPathDepth: 12,
};

/** `docx`/`pptx`/`xlsx` when the member is a sound OOXML package; `'unsafe'` when it fails the zip bounds. */
function officeKind(
  path: string,
  bytes: Uint8Array,
): OfficeDocumentKind | 'unsafe' | null {
  const ext = OFFICE_NAME.exec(path)?.[1]?.toLowerCase() as
    | OfficeDocumentKind
    | undefined;
  if (!ext || !startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return null;
  try {
    const parts = readZipArchive(bytes, OFFICE_PACKAGE_LIMITS);
    // An inner part skipped as oversize was never inflated, CRC-checked or
    // counted: the package is not sound, so it never reaches a reader.
    if (parts.some((p) => p.refusal || !p.bytes)) return 'unsafe';
    const names = new Set(parts.map((p) => p.path));
    return names.has('[Content_Types].xml') && names.has(OFFICE_MAIN_PART[ext])
      ? ext
      : null;
  } catch (error) {
    if (error instanceof CourseBundleRefusedError) return 'unsafe';
    throw error;
  }
}

export function classifyBundleMember(
  raw: RawBundleMember,
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
): ClassifiedBundleMember {
  const base = {
    path: raw.path,
    size: raw.size,
    sha256: raw.sha256,
    duplicateOf: null,
    bytes: null,
    text: null,
    rendered: null,
    officeText: null,
  };
  const out = (
    kind: CourseBundleMemberKind,
    status: CourseBundleMemberStatus,
    reason: CourseBundleMemberReason | null,
    mediaType = '',
    extra: Partial<ClassifiedBundleMember> = {},
  ): ClassifiedBundleMember => ({
    ...base,
    kind,
    status,
    reason,
    mediaType,
    ...extra,
  });
  if (raw.path === COURSE_BUNDLE_MANIFEST_PATH) {
    if (!raw.bytes || raw.size > limits.maxManifestBytes)
      throw new CourseBundleRefusedError('manifest_invalid', raw.path);
    return out('manifest', 'metadata', null, 'application/json', {
      bytes: raw.bytes,
    });
  }
  if (raw.refusal || !raw.bytes)
    return out('unsupported', 'refused', 'entry_too_large');
  const bytes = raw.bytes;
  const found = sniff(bytes);
  if (found === 'archive') {
    const office = officeKind(raw.path, bytes);
    if (office === 'unsafe')
      return out('unsupported', 'refused', 'unsafe_office');
    if (office)
      return out(office, 'accepted', null, OFFICE_MEDIA_TYPES[office], {
        bytes,
      });
  }
  if (found === 'archive')
    return out('unsupported', 'unsupported', 'nested_archive');
  if (found?.kind === 'pdf') {
    if (pdfIsEncrypted(bytes))
      return out('pdf', 'refused', 'encrypted_pdf', found.mediaType);
    return out('pdf', 'accepted', null, found.mediaType, { bytes });
  }
  if (found?.kind === 'image')
    return out('image', 'accepted', null, found.mediaType, { bytes });
  if (TEXT_NAME.test(raw.path)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (
        text.trim() &&
        text.length <= limits.maxLessonBodyChars &&
        !CONTROL.test(text) &&
        isWellFormedString(text)
      )
        return out('text', 'accepted', null, 'text/plain', { bytes, text });
    } catch {
      // fall through: visible as unreadable
    }
    return out('unsupported', 'unsupported', 'unreadable_text');
  }
  return out('unsupported', 'unsupported', 'unsupported_type');
}

/** Natural, locale-free ordering: digit runs compare numerically, the rest by code unit. */
export function naturalCompare(a: string, b: string): number {
  const chunk = /(\d+)|(\D+)/g;
  const left = a.match(chunk) ?? [];
  const right = b.match(chunk) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i] as string;
    const y = right[i] as string;
    if (x === y) continue;
    const xd = /^\d/.test(x);
    const yd = /^\d/.test(y);
    if (xd && yd) {
      const xs = x.replace(/^0+(?=\d)/, '');
      const ys = y.replace(/^0+(?=\d)/, '');
      if (xs.length !== ys.length) return xs.length - ys.length;
      if (xs !== ys) return xs < ys ? -1 : 1;
      if (x !== y) return x.length - y.length; // 01 before 001 is arbitrary but stable
    } else return x < y ? -1 : 1;
  }
  return left.length - right.length || (a < b ? -1 : a > b ? 1 : 0);
}
const byPath = (a: string, b: string) => naturalCompare(a, b);

// -- manifest -----------------------------------------------------------------

interface Manifest {
  subject?: string;
  sections: Array<{
    key: string;
    title: string;
    lessons: Array<{
      key: string;
      title: string;
      members: Array<{ path: string; role: CourseBundlePageRole | '' }>;
    }>;
  }>;
}
/** Closed, versioned manifest schema: any unknown key is refused. */
export function parseBundleManifest(
  bytes: Uint8Array,
  paths: ReadonlySet<string>,
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    return refuse('manifest_invalid', COURSE_BUNDLE_MANIFEST_PATH);
  }
  const root = closed(parsed, ['version', 'course', 'sections'], 'manifest');
  if (root.version !== COURSE_BUNDLE_MANIFEST_VERSION)
    return refuse('manifest_version', 'manifest.version');
  const manifest: Manifest = { sections: [] };
  if (root.course !== undefined) {
    const course = closed(root.course, ['subject'], 'manifest.course');
    if (course.subject !== undefined)
      manifest.subject = text(course.subject, 'manifest.course.subject', 200);
  }
  if (!Array.isArray(root.sections) || root.sections.length === 0)
    return refuse('manifest_invalid', 'manifest.sections');
  if (root.sections.length > limits.maxLessons)
    return refuse('too_many_lessons');
  const sectionKeys = new Set<string>();
  const lessonKeys = new Set<string>();
  const listed = new Set<string>();
  let lessons = 0;
  for (const [s, rawSection] of (root.sections as unknown[]).entries()) {
    const sp = `manifest.sections.${s}`;
    const section = closed(rawSection, ['key', 'title', 'lessons'], sp);
    const sectionKey = key(section.key, `${sp}.key`);
    if (sectionKeys.has(sectionKey)) refuse('duplicate_key', `${sp}.key`);
    sectionKeys.add(sectionKey);
    if (!Array.isArray(section.lessons) || section.lessons.length === 0)
      refuse('manifest_invalid', `${sp}.lessons`);
    const outLessons: Manifest['sections'][number]['lessons'] = [];
    for (const [l, rawLesson] of (section.lessons as unknown[]).entries()) {
      const lp = `${sp}.lessons.${l}`;
      const lesson = closed(rawLesson, ['key', 'title', 'members'], lp);
      const lessonKey = key(lesson.key, `${lp}.key`);
      if (lessonKeys.has(lessonKey)) refuse('duplicate_key', `${lp}.key`);
      lessonKeys.add(lessonKey);
      if (++lessons > limits.maxLessons) refuse('too_many_lessons');
      const members: Array<{ path: string; role: CourseBundlePageRole | '' }> =
        [];
      const rawMembers = lesson.members ?? [];
      if (!Array.isArray(rawMembers))
        refuse('manifest_invalid', `${lp}.members`);
      for (const [m, rawMember] of (rawMembers as unknown[]).entries()) {
        const mp = `${lp}.members.${m}`;
        const member = closed(rawMember, ['path', 'role'], mp);
        if (typeof member.path !== 'string')
          refuse('manifest_invalid', `${mp}.path`);
        let normal: string;
        try {
          normal = normalizeBundlePath(member.path, limits).path;
        } catch {
          return refuse('manifest_invalid', `${mp}.path`);
        }
        if (!paths.has(normal) || normal === COURSE_BUNDLE_MANIFEST_PATH)
          refuse('manifest_missing_member', `${mp}.path`);
        if (listed.has(normal))
          refuse('manifest_duplicate_member', `${mp}.path`);
        listed.add(normal);
        let role: CourseBundlePageRole | '' = '';
        if (member.role !== undefined) {
          if (
            typeof member.role !== 'string' ||
            !COURSE_BUNDLE_PAGE_ROLES.includes(member.role as never)
          )
            refuse('manifest_invalid', `${mp}.role`);
          role = member.role as CourseBundlePageRole;
        }
        members.push({ path: normal, role });
      }
      outLessons.push({
        key: lessonKey,
        title: text(lesson.title, `${lp}.title`, 300),
        members,
      });
    }
    manifest.sections.push({
      key: sectionKey,
      title: text(section.title, `${sp}.title`, 300),
      lessons: outLessons,
    });
  }
  return manifest;
}

// -- built-in readers ---------------------------------------------------------

const manifestOf = (members: readonly ClassifiedBundleMember[]) =>
  members.find((m) => m.kind === 'manifest');
const hasManifest = (members: readonly ClassifiedBundleMember[]) =>
  members.some((m) => m.kind === 'manifest');
const isManifestV2 = (members: readonly ClassifiedBundleMember[]) => {
  const bytes = manifestOf(members)?.bytes;
  return (
    bytes != null &&
    manifestVersionOf(bytes) === COURSE_BUNDLE_MANIFEST_VERSION_2
  );
};

/**
 * Reader for a root `manifest.json` version 2: material roles and audience,
 * lesson pages, course-level members and external video references.
 */
export const manifestV2BundleReader: BundleReader = {
  formatId: 'manifest-v2',
  detect: isManifestV2,
  prepare(members, limits) {
    const manifest = parseBundleManifestV2(
      manifestOf(members)?.bytes as Uint8Array,
      new Set(members.map((m) => m.path)),
      limits,
    );
    const declared = [
      ...manifest.sections.flatMap((s) =>
        s.lessons.flatMap((l) => l.members.map((m) => m.path)),
      ),
      ...manifest.courseMembers.map((m) => m.path),
    ];
    const listed = new Set(declared);
    const rest = members
      .map((m) => m.path)
      .filter((p) => p !== COURSE_BUNDLE_MANIFEST_PATH && !listed.has(p))
      .sort(byPath);
    return {
      readerId: 'manifest-v2',
      manifestVersion: COURSE_BUNDLE_MANIFEST_VERSION_2,
      order: [COURSE_BUNDLE_MANIFEST_PATH, ...declared, ...rest],
      structure: () => ({
        ...(manifest.subject ? { subject: manifest.subject } : {}),
        ...(manifest.unit ? { unit: manifest.unit } : {}),
        courseMembers: manifest.courseMembers,
        sections: manifest.sections.map((s) => ({
          key: s.key,
          title: s.title,
          ...(s.order !== undefined ? { order: s.order } : {}),
          lessons: s.lessons.map((l) => ({
            key: l.key,
            title: l.title,
            ...(l.order !== undefined ? { order: l.order } : {}),
            paths: l.members.map((m) => m.path),
            roles: l.members.map((m) => m.role),
            audiences: l.members.map((m) => m.audience),
            titles: l.members.map((m) => m.title),
            steps: l.members.map((m) => m.step ?? null),
            pages: l.pages,
            videos: l.videos,
          })),
        })),
      }),
    };
  },
};

/** Reader for a root `manifest.json` (version 1): declared sections, lessons, roles. */
export const manifestBundleReader: BundleReader = {
  formatId: 'manifest-v1',
  detect: hasManifest,
  prepare(members, limits) {
    const manifestMember = members.find((m) => m.kind === 'manifest');
    const manifest = parseBundleManifest(
      manifestMember?.bytes as Uint8Array,
      new Set(members.map((m) => m.path)),
      limits,
    );
    const declared = manifest.sections.flatMap((s) =>
      s.lessons.flatMap((l) => l.members.map((m) => m.path)),
    );
    const rest = members
      .map((m) => m.path)
      .filter((p) => p !== COURSE_BUNDLE_MANIFEST_PATH && !declared.includes(p))
      .sort(byPath);
    return {
      readerId: 'manifest-v1',
      manifestVersion: COURSE_BUNDLE_MANIFEST_VERSION,
      order: [COURSE_BUNDLE_MANIFEST_PATH, ...declared, ...rest],
      structure: () => ({
        ...(manifest.subject ? { subject: manifest.subject } : {}),
        sections: manifest.sections.map((s) => ({
          key: s.key,
          title: s.title,
          lessons: s.lessons.map((l) => ({
            key: l.key,
            title: l.title,
            paths: l.members.map((m) => m.path),
            roles: l.members.map((m) => m.role),
          })),
        })),
      }),
    };
  },
};

const humanize = (name: string) => {
  const stem = name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const spaced = stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (spaced || name).slice(0, 300);
};
const short = (value: string) => sha256Hex(value).slice(0, 12);

/**
 * Reader for a plain file set: one lesson per accepted member, sections from
 * the top-level directory, everything in deterministic natural path order.
 */
export const plainBundleReader: BundleReader = {
  formatId: 'plain-files',
  detect: () => true,
  prepare(members, limits) {
    const order = members.map((m) => m.path).sort(byPath);
    return {
      readerId: 'plain-files',
      manifestVersion: 0,
      order,
      structure(classified) {
        const lessonable = new Set(
          classified
            .filter(
              (m) =>
                m.status === 'accepted' &&
                (m.kind === 'pdf' ||
                  m.kind === 'image' ||
                  m.kind === 'text' ||
                  isOfficeDocumentKind(m.kind)),
            )
            .map((m) => m.path),
        );
        const sections = new Map<string, BundleStructureSection>();
        const keys = new Set<string>();
        for (const path of order) {
          if (!lessonable.has(path)) continue;
          const slash = path.indexOf('/');
          const directory = slash === -1 ? '' : path.slice(0, slash);
          let section = sections.get(directory);
          if (!section) {
            section = {
              key: `s-${short(`dir:${directory}`)}`,
              title: directory ? humanize(directory) : 'Files',
              lessons: [],
            };
            sections.set(directory, section);
          }
          const lessonKey = `l-${short(`path:${path}`)}`;
          if (keys.has(lessonKey)) refuse('duplicate_key', path);
          keys.add(lessonKey);
          section.lessons.push({
            key: lessonKey,
            title: humanize(path.slice(path.lastIndexOf('/') + 1)),
            paths: [path],
            roles: [''],
          });
        }
        const out = [...sections.values()];
        if (out.reduce((n, s) => n + s.lessons.length, 0) > limits.maxLessons)
          refuse('too_many_lessons');
        return { sections: out };
      },
    };
  },
};

export function createBundleReaderRegistry(): BundleReaderRegistry {
  return new BundleReaderRegistry()
    .register(manifestV2BundleReader)
    .register(manifestBundleReader)
    .register(plainBundleReader);
}

// -- unpack + plan ------------------------------------------------------------

/** Read the raw members of a bundle input (bounded). Sorted by path. */
export function unpackBundle(
  input: CourseBundleInput,
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
  onProgress?: (completed: number, total: number) => void,
): RawBundleMember[] {
  if (input && 'archive' in input)
    return readZipArchive(input.archive, limits, onProgress);
  if (input && 'files' in input)
    return readFileSet(input.files, limits, onProgress);
  return refuse('empty_bundle');
}

export interface CourseBundlePlan {
  readerId: string;
  manifestVersion: number;
  /** Content identity: stable across re-zipping, timestamps and member order. */
  bundleIdentity: string;
  members: ClassifiedBundleMember[];
  structure: BundleStructure;
  /** Where each member was placed. */
  placements: Map<
    string,
    {
      sectionKey: string | null;
      lessonKey: string | null;
      role: string;
      /** Version 2: the effective audience, `''` when none was declared. */
      audience: MaterialAudience | '';
    }
  >;
  /** Version 2: what the bundle contributes as lesson and course material. */
  materials: BundleMaterialsPlan;
}

/** One file material: a member placed under a lesson or the course with a role and audience. */
export interface BundleMaterial {
  scope: 'course' | 'lesson';
  sectionKey: string | null;
  lessonKey: string | null;
  /** The member as declared. */
  path: string;
  /** The member that holds the bytes: `path`, or the earlier identical member when `path` is a duplicate. */
  assetPath: string;
  kind: ClassifiedBundleMember['kind'];
  sha256: string;
  role: LessonAssetRelationship;
  audience: MaterialAudience;
  title: string;
  sortOrder: number;
  /** The lesson step this material belongs to, null when it is not part of one. */
  step: ManifestV2Step | null;
}
/** One lesson page: page `sourcePageNumber` of a paged member (the rendered PDF for Office). */
export interface BundlePage {
  sectionKey: string;
  lessonKey: string;
  pageKey: string;
  label: string;
  sortOrder: number;
  /** The member as declared. */
  path: string;
  assetPath: string;
  sourcePageNumber: number;
}
export interface BundleVideo {
  sectionKey: string;
  lessonKey: string;
  provider: 'youtube';
  videoId: string;
  title: string;
  stepOrder: number;
  /** The lesson step this video belongs to, null when it is not part of one. */
  step: ManifestV2Step | null;
  audience: MaterialAudience;
}
/** The materials a version 2 manifest asks for. Empty for version 1 and plain file sets. */
export interface BundleMaterialsPlan {
  materials: BundleMaterial[];
  pages: BundlePage[];
  videos: BundleVideo[];
  /** Declared members that could not be used (unsupported, refused), with the member's reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/** Stable identity of the bundle's contents: sorted (path, hash) pairs. */
export function courseBundleIdentity(
  members: ReadonlyArray<{ path: string; sha256: string | null; size: number }>,
): string {
  const pairs = [...members]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((m) => [m.path, m.sha256 ?? `oversize:${m.size}`]);
  return `cbi1-${sha256Hex(JSON.stringify(pairs)).slice(0, 40)}`;
}

/** Classify every raw member (sync, no network). */
export function classifyBundle(
  raw: readonly RawBundleMember[],
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
  onProgress?: (completed: number, total: number) => void,
): ClassifiedBundleMember[] {
  if (raw.length === 0) return refuse('empty_bundle');
  onProgress?.(0, raw.length);
  const classified = raw.map((m) => classifyBundleMember(m, limits));
  onProgress?.(raw.length, raw.length);
  return classified;
}

/**
 * What became of one Office member's rendering (keyed by content sha256).
 * `rendered`/`officeText` are present on a fresh render, absent when the outcome
 * is only recalled from recorded evidence.
 */
/** A first-page image of a rendered member, as the converter drew it. */
export interface RenderedThumbnail {
  bytes: Uint8Array;
  sha256: string;
  mediaType: string;
}
export type OfficeOutcome =
  | {
      ok: true;
      rendered?: {
        bytes: Uint8Array;
        sha256: string;
        thumbnail?: RenderedThumbnail | null;
      };
      officeText?: OfficeText | null;
    }
  | { ok: false; reason: CourseBundleMemberReason };

/** Classify, order, mark duplicate content and lay out the proposed structure. */
export function planCourseBundle(
  raw: readonly RawBundleMember[],
  registry: BundleReaderRegistry = createBundleReaderRegistry(),
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
  onProgress?: (completed: number, total: number) => void,
): CourseBundlePlan {
  return planClassifiedBundle(
    raw,
    classifyBundle(raw, limits, onProgress),
    registry,
    limits,
  );
}

/**
 * Plan already-classified members. `officeOutcomes` (by sha256) settles
 * Word/PowerPoint members before duplicates and the structure are decided, so
 * a member that could not be rendered never becomes a lesson.
 */
export function planClassifiedBundle(
  raw: readonly RawBundleMember[],
  classified: ClassifiedBundleMember[],
  registry: BundleReaderRegistry = createBundleReaderRegistry(),
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
  officeOutcomes?: ReadonlyMap<string, OfficeOutcome>,
): CourseBundlePlan {
  if (raw.length === 0) return refuse('empty_bundle');
  for (const member of classified) {
    if (
      member.status !== 'accepted' ||
      !isOfficeDocumentKind(member.kind) ||
      !member.sha256
    )
      continue;
    const outcome = officeOutcomes?.get(member.sha256);
    if (!outcome) continue;
    if (!outcome.ok) {
      member.status = 'unsupported';
      member.reason = outcome.reason;
      member.bytes = null;
    } else {
      member.rendered = outcome.rendered ?? null;
      member.officeText = outcome.officeText ?? null;
    }
  }
  const prepared = registry.resolve(classified).prepare(classified, limits);
  const byName = new Map(classified.map((m) => [m.path, m]));
  const ordered = prepared.order.map(
    (p) => byName.get(p) as ClassifiedBundleMember,
  );
  const firstSeen = new Map<string, string>();
  for (const member of ordered) {
    if (member.status !== 'accepted' || !member.sha256) continue;
    const earlier = firstSeen.get(member.sha256);
    if (earlier) {
      member.status = 'duplicate';
      member.reason = 'duplicate_content';
      member.duplicateOf = earlier;
      member.bytes = null;
      member.rendered = null;
      member.officeText = null;
    } else firstSeen.set(member.sha256, member.path);
  }
  const structure = prepared.structure(ordered);
  const placements: CourseBundlePlan['placements'] = new Map(
    ordered.map((m) => [
      m.path,
      { sectionKey: null, lessonKey: null, role: '', audience: '' },
    ]),
  );
  for (const section of structure.sections)
    for (const lesson of section.lessons)
      lesson.paths.forEach((path, i) => {
        placements.set(path, {
          sectionKey: section.key,
          lessonKey: lesson.key,
          role: lesson.roles[i] ?? '',
          audience: lesson.audiences?.[i] ?? '',
        });
      });
  for (const member of structure.courseMembers ?? [])
    placements.set(member.path, {
      sectionKey: null,
      lessonKey: null,
      role: member.role,
      audience: member.audience,
    });
  const plan: CourseBundlePlan = {
    readerId: prepared.readerId,
    manifestVersion: prepared.manifestVersion,
    bundleIdentity: courseBundleIdentity(raw),
    members: ordered,
    structure,
    placements,
    materials: planBundleMaterials(structure, ordered),
  };
  // Check lesson bodies at import time so an over-cap lesson writes nothing.
  bundleProposalOutput(plan, limits);
  return plan;
}

const PAGEABLE = new Set<ClassifiedBundleMember['kind']>([
  'pdf',
  'docx',
  'pptx',
  'xlsx',
]);

/**
 * Resolve a version 2 structure into material, page and video rows. A declared
 * member that did not survive classification (unsupported, refused, failed
 * rendering) is skipped, never half-applied; a duplicate member resolves to the
 * earlier identical member's bytes. A page range over a member that cannot be
 * paged (text, image) is a refusal of the bundle.
 */
export function planBundleMaterials(
  structure: BundleStructure,
  ordered: readonly ClassifiedBundleMember[],
): BundleMaterialsPlan {
  const plan: BundleMaterialsPlan = {
    materials: [],
    pages: [],
    videos: [],
    skipped: [],
  };
  const byName = new Map(ordered.map((m) => [m.path, m]));
  const usable = (path: string): ClassifiedBundleMember | null => {
    const member = byName.get(path);
    if (!member) return null;
    if (member.status === 'accepted') return member;
    if (member.status === 'duplicate' && member.duplicateOf) {
      const original = byName.get(member.duplicateOf);
      return original?.status === 'accepted' ? original : null;
    }
    // A member named twice (a material and its page range) is skipped once.
    if (!plan.skipped.some((x) => x.path === path))
      plan.skipped.push({ path, reason: member.reason ?? member.status });
    return null;
  };
  const add = (
    scope: BundleMaterial['scope'],
    where: { sectionKey: string; lessonKey: string } | null,
    decl: ManifestV2['courseMembers'][number],
    sortOrder: number,
    step: ManifestV2Step | null = null,
  ) => {
    const holder = usable(decl.path);
    if (!holder?.sha256) return;
    // The same bytes under the same role in the same place are one material.
    if (
      plan.materials.some(
        (m) =>
          m.scope === scope &&
          m.lessonKey === (where?.lessonKey ?? null) &&
          m.role === decl.role &&
          m.sha256 === holder.sha256,
      )
    )
      return;
    plan.materials.push({
      scope,
      sectionKey: where?.sectionKey ?? null,
      lessonKey: where?.lessonKey ?? null,
      path: decl.path,
      assetPath: holder.path,
      kind: holder.kind,
      sha256: holder.sha256,
      role: decl.role,
      audience: decl.audience,
      title: decl.title,
      sortOrder,
      step: scope === 'lesson' ? step : null,
    });
  };
  for (const [i, decl] of (structure.courseMembers ?? []).entries())
    add('course', null, decl, i);
  for (const section of structure.sections)
    for (const lesson of section.lessons) {
      const where = { sectionKey: section.key, lessonKey: lesson.key };
      lesson.paths.forEach((path, i) => {
        const role = lesson.roles[i];
        if (!role || !lesson.audiences?.[i]) return;
        add(
          'lesson',
          where,
          {
            path,
            role: role as LessonAssetRelationship,
            audience: lesson.audiences[i] as MaterialAudience,
            title: lesson.titles?.[i] ?? '',
          },
          i,
          lesson.steps?.[i] ?? null,
        );
      });
      const keys = new Set<string>();
      let order = 0;
      for (const range of lesson.pages ?? []) {
        const member = byName.get(range.member);
        if (
          member &&
          (member.status === 'accepted' || member.status === 'duplicate') &&
          !PAGEABLE.has(member.kind)
        )
          refuse('manifest_pages', `${lesson.key}:${range.member}`);
        const holder = usable(range.member);
        for (let n = range.from; n <= range.to; n++) {
          const pageKey = `p${n}`;
          if (keys.has(pageKey))
            refuse('manifest_pages', `${lesson.key}:${pageKey}`);
          keys.add(pageKey);
          if (!holder) continue;
          plan.pages.push({
            ...where,
            pageKey,
            label: range.label ? `${range.label} ${n}` : `Page ${n}`,
            sortOrder: order++,
            path: range.member,
            assetPath: holder.path,
            sourcePageNumber: n,
          });
        }
      }
      for (const video of lesson.videos ?? [])
        plan.videos.push({ ...where, ...video, step: video.step ?? null });
    }
  return plan;
}

/** Closed proposal output (`validateCourseGenerationOutput` shape) for a structure. */
export function bundleProposalOutput(
  plan: CourseBundlePlan,
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
) {
  const byName = new Map(plan.members.map((m) => [m.path, m]));
  // Answer-key and mixed members stay recorded evidence but never become
  // learner-visible lesson text, whatever the manifest says about the lesson.
  // Under manifest version 2 audience decides: only learner-audience text may
  // reach a lesson body, so teacher guides and guidance never do.
  const withheldRole = (path: string) => {
    const placed = plan.placements.get(path);
    if (placed?.audience) return placed.audience !== 'learner';
    return placed?.role === 'answer_key' || placed?.role === 'mixed';
  };
  let withheld = 0;
  const lessons = plan.structure.sections.flatMap((section) =>
    section.lessons.map((lesson) => {
      const body = lesson.paths
        .map((p) => byName.get(p))
        .filter((m) => m?.status === 'accepted' && m.kind === 'text')
        .filter((m) => {
          if (!withheldRole((m as ClassifiedBundleMember).path)) return true;
          withheld++;
          return false;
        })
        .map((m) => (m as ClassifiedBundleMember).text as string)
        .join('\n\n');
      // Refuse, never trim: a lesson whose combined text is over the cap
      // would otherwise be proposed with its supplied content silently lost.
      if (body.length > limits.maxLessonBodyChars)
        throw new CourseBundleRefusedError('lesson_too_large', lesson.key);
      return {
        sectionKey: section.key,
        sectionTitle: section.title,
        title: lesson.title,
        ...(body ? { body } : {}),
      };
    }),
  );
  return {
    course: plan.structure.subject ? { subject: plan.structure.subject } : {},
    lessons,
    rationale: `Proposed from a course bundle (${plan.readerId}, ${plan.bundleIdentity}). The host reviews and accepts; nothing is published.${withheld ? ` ${withheld} answer-key or mixed member(s) were withheld from lesson text.` : ''}`,
  };
}
