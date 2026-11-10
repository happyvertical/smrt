import { withPrivateAssetAccess } from '@happyvertical/smrt-assets';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CourseLicenseKind } from './catalog.js';
import {
  CourseCollection,
  CourseSectionCollection,
  LessonAssetCollection,
  LessonCollection,
} from './collections.js';
import {
  type CourseAuthoringActor,
  type CourseAuthoringAuthorizer,
  CourseAuthoringError,
} from './course-authoring-contracts.js';
import { CourseAuthoringService } from './course-authoring-service.js';
import {
  type BundleMaterialsPlan,
  type BundleReaderRegistry,
  bundleProposalOutput,
  type ClassifiedBundleMember,
  type CourseBundlePlan,
  classifyBundle,
  courseBundleIdentity,
  createBundleReaderRegistry,
  naturalCompare,
  type OfficeOutcome,
  pdfIsEncrypted,
  planClassifiedBundle,
  type RenderedThumbnail,
  sniffImageMediaType,
  unpackBundle,
} from './course-bundle.js';
import {
  COURSE_BUNDLE_RETRYABLE_REASONS,
  type CourseBundleInput,
  type CourseBundleLimits,
  type CourseBundleMemberKind,
  type CourseBundleMemberReason,
  type CourseBundleMemberStatus,
  CourseBundleNotFoundError,
  type CourseBundleProgressListener,
  type CourseBundleStage,
  resolveCourseBundleLimits,
} from './course-bundle-contracts.js';
import { MANIFEST_KEY } from './course-bundle-manifest-util.js';
import { COURSE_BUNDLE_MATERIAL_ROLES } from './course-bundle-manifest-v2.js';
import {
  CourseBundleAttachmentCollection,
  CourseBundleAudienceChoiceCollection,
  CourseBundleImportCollection,
  CourseBundleMemberCollection,
  CourseBundlePlacementCollection,
  CourseBundleRenderingCollection,
  CourseBundleSupersessionCollection,
  CourseBundleUnitCollection,
} from './course-bundle-models.js';
import { sha256Hex } from './course-bundle-zip.js';
import type {
  CourseGenerationView,
  CourseMaterialGenerator,
} from './course-generation-contracts.js';
import {
  CourseGenerationReviewService,
  type CourseGenerationReviewServiceOptions,
} from './course-generation-review-service.js';
import {
  DocumentConversionError,
  type DocumentConverter,
  isOfficeDocumentKind,
  looksLikePdf,
  type OfficeDocumentKind,
  type OfficeText,
  type OfficeTextReader,
} from './document-converter.js';
import {
  CourseAssetCollection,
  LessonExternalVideoCollection,
  type MaterialAudience,
  type MaterialRendition,
  materialAudience,
} from './lesson-assets.js';
import { LessonPageCollection } from './lesson-pages.js';

type Row = Record<string, unknown>;

/** One bundle member as evidence. Never carries bytes, storage locators or text. */
export interface CourseBundleMemberView {
  path: string;
  ordinal: number;
  sha256: string | null;
  sizeBytes: number;
  mediaType: string;
  kind: CourseBundleMemberKind;
  status: CourseBundleMemberStatus;
  reason: CourseBundleMemberReason | null;
  duplicateOfPath: string | null;
  /** The declared role: a page role (manifest v1) or a material role (v2). */
  role: string | null;
  /** Manifest v2: the effective audience. */
  audience: MaterialAudience | null;
  sectionKey: string | null;
  lessonKey: string | null;
  /** sha256 of the PDF rendered from a Word/PowerPoint member, null otherwise. */
  renderedSha256: string | null;
  renderedSizeBytes: number;
}
export interface CourseBundleImportView {
  importId: string;
  bundleIdentity: string;
  format: 'zip' | 'files';
  readerId: string;
  manifestVersion: number;
  /** True when this bundle was already imported and nothing new was recorded. */
  replayed: boolean;
  entryCount: number;
  acceptedCount: number;
  duplicateCount: number;
  unsupportedCount: number;
  refusedCount: number;
  totalBytes: number;
  members: CourseBundleMemberView[];
  /** Audience choices made in review before attach (`chooseMaterialAudience`). */
  audienceChoices: CourseBundleAudienceChoiceView[];
  /** The family course this import was attached to, or null before attach. */
  attachment: {
    courseId: string;
    unitKey: string;
    partIndex: number;
    partCount: number;
  } | null;
}
/** A review choice: who one material of an import is for once it is attached. */
export interface CourseBundleAudienceChoiceView {
  /** `file:<member path>` or `video:<lesson key>:<video id>`. */
  target: string;
  path: string | null;
  lessonKey: string | null;
  videoId: string | null;
  audience: MaterialAudience;
}
/** An accepted member handed to the host, in memory only, for ingestion. */
export interface AcceptedCourseBundleMember {
  path: string;
  sha256: string;
  mediaType: string;
  kind: 'pdf' | 'image' | 'text' | OfficeDocumentKind;
  /** Declared role: a page role (`exercise`, ...) under v1, a material role (`slides`, ...) under v2. */
  role: string | null;
  /** Manifest v2: who the material is for; null otherwise. */
  audience: MaterialAudience | null;
  /** Manifest v2: true for a course-level member (no lesson). */
  courseLevel: boolean;
  /**
   * Manifest v2: the readable title of the one material this member holds (for
   * example "Teacher Mission Manual"), so a host can name the assets it stores.
   * Omitted when the manifest gave none, or when the member backs several
   * materials with different titles.
   */
  title?: string;
  sectionKey: string | null;
  lessonKey: string | null;
  /** The original bytes. For Word/PowerPoint, keep these as the private original asset. */
  bytes: Uint8Array;
  /**
   * Word/PowerPoint only: the PDF the converter rendered. Store it as a private
   * asset beside the original (pages for reading or "Present"); null for other kinds.
   */
  rendered: {
    bytes: Uint8Array;
    sha256: string;
    mediaType: 'application/pdf';
    converterId: string;
    /**
     * First-page image when the converter drew one (validated PNG/JPEG/WebP,
     * within `maxThumbnailBytes`); null otherwise. Store it as an asset and pass
     * it as `assets[path].thumbnail`.
     */
    thumbnail: RenderedThumbnail | null;
  } | null;
  /**
   * Word/PowerPoint only: text read by the injected `OfficeTextReader` (slide text
   * and speaker notes per slide for PPTX), or null. It is never copied into a
   * proposed lesson body: audience belongs to the manifest v2 roles.
   */
  officeText: OfficeText | null;
}
/** Lesson rows keep no title as null; course rows (a non-null column) as ''. */
function setMaterialTitle(
  row: object,
  scope: 'course' | 'lesson',
  title: string,
) {
  (row as { title: string | null }).title =
    scope === 'course' ? title : title || null;
}
/** A row's recorded lesson step (`orderField` is `stepOrder` on files, `stepPosition` on videos). */
type StepRow = {
  stepKey?: string | null;
  stepLabel?: string | null;
} & Record<string, unknown>;
type StepValue = { key: string; order: number; label: string };
function rowStep(row: object, orderField: string): StepValue | null {
  const r = row as StepRow;
  if (!r.stepKey) return null;
  return {
    key: r.stepKey,
    order: Number(r[orderField]),
    label: r.stepLabel ?? '',
  };
}
function setRowStep(row: object, orderField: string, step: StepValue | null) {
  const r = row as StepRow;
  r.stepKey = step?.key ?? null;
  r[orderField] = step ? step.order : null;
  r.stepLabel = step?.label ? step.label : null;
}
const sameStep = (a: StepValue | null, b: StepValue | null) =>
  (a?.key ?? null) === (b?.key ?? null) &&
  (a?.order ?? null) === (b?.order ?? null) &&
  (a?.label ?? '') === (b?.label ?? '');
/**
 * How a row's recorded step compares with the bundle's: `fill` when the row has
 * none yet (gained without a conflict), `moved` when it differs (a change of the
 * newer build), else unchanged.
 */
function stepChange(
  row: object,
  orderField: string,
  declared: StepValue | null,
): { fill: boolean; moved: boolean } {
  const current = rowStep(row, orderField);
  if (sameStep(current, declared)) return { fill: false, moved: false };
  if (!current && declared) return { fill: true, moved: false };
  return { fill: false, moved: true };
}
/** The one non-empty material title per member path (by holder or declared path); none when ambiguous. */
function memberTitles(plan: BundleMaterialsPlan): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const m of plan.materials)
    for (const path of new Set([m.path, m.assetPath])) {
      const titles = seen.get(path) ?? new Set<string>();
      titles.add(m.title);
      seen.set(path, titles);
    }
  const out = new Map<string, string>();
  for (const [path, titles] of seen)
    if (titles.size === 1) {
      const [only] = titles;
      if (only) out.set(path, only);
    }
  return out;
}
export interface CourseBundleImportResult {
  import: CourseBundleImportView;
  /** Accepted members in canonical order; duplicates and unsupported ones are absent. */
  accepted: AcceptedCourseBundleMember[];
  /** What `receiveMember` returned per path. */
  receipts: Record<string, unknown>;
  /** Manifest v2: the lesson pages, course members and videos the bundle asks for. */
  materials: BundleMaterialsPlan;
}
export interface ImportCourseBundleRequest extends CourseAuthoringActor {
  bundle: CourseBundleInput;
  /** Can only lower the hard ceilings in `COURSE_BUNDLE_LIMITS`. */
  limits?: Partial<CourseBundleLimits>;
  onProgress?: CourseBundleProgressListener;
  /**
   * Hand each accepted member to ingestion (for example `IngestionService.receive`
   * with `sourceKind: 'course_import'`). Runs after the evidence commits and
   * outside any transaction; it is also called on a replay, because ingestion
   * dedups by content hash, so an interrupted first run can be driven again.
   */
  receiveMember?: (
    member: AcceptedCourseBundleMember,
    context: { replayed: boolean },
  ) => unknown | Promise<unknown>;
}
export interface ProposeBundleStructureRequest extends CourseAuthoringActor {
  importId: string;
  /** The same bundle again: bytes are never retained by this service. */
  bundle: CourseBundleInput;
  courseId: string;
  expectedHeadRevisionId: string;
  instruction?: string;
  limits?: Partial<CourseBundleLimits>;
  onProgress?: CourseBundleProgressListener;
}
export interface RetryBundleRenderingRequest extends CourseAuthoringActor {
  importId: string;
  /** The same bundle again: bytes are never retained by this service. */
  bundle: CourseBundleInput;
  /** Limit the retry to these member paths; omitted retries every retryable failure. */
  paths?: string[];
  limits?: Partial<CourseBundleLimits>;
  onProgress?: CourseBundleProgressListener;
  /** Called for each member that rendered on this retry, as on a replayed import. */
  receiveMember?: ImportCourseBundleRequest['receiveMember'];
}
export interface RetryBundleRenderingResult {
  import: CourseBundleImportView;
  /**
   * Per requested member: `rendered` (recorded now), `failed` (still failing,
   * nothing recorded; `reason` names why), or `unchanged` (not a retryable
   * failure, for example already rendered or rejected by the converter).
   */
  retried: Array<{
    path: string;
    outcome: 'rendered' | 'failed' | 'unchanged';
    reason: CourseBundleMemberReason | null;
  }>;
  /** Members that rendered on this retry, as handed to `receiveMember`. */
  accepted: AcceptedCourseBundleMember[];
  receipts: Record<string, unknown>;
  materials: BundleMaterialsPlan;
}

export interface ApplyBundleMaterialsRequest extends CourseAuthoringActor {
  importId: string;
  /** The same bundle again: bytes are never retained by this service. */
  bundle: CourseBundleInput;
  /** A family-owned course (not an authored one; authored material goes through authoring). */
  courseId: string;
  /** Manifest lesson key to the `Lesson` id in `courseId` that the host created for it. */
  lessons: Record<string, string>;
  /**
   * Member path to the private assets the host stored from `receiveMember`:
   * the original, and the rendered PDF for Word/PowerPoint members. Slides
   * join both; every other Office member joins only its rendered PDF, so a
   * learner is never handed an editable original.
   */
  assets: Record<string, BundleMemberAssets>;
  limits?: Partial<CourseBundleLimits>;
  onProgress?: CourseBundleProgressListener;
}
/** The assets a host stored for one accepted member. */
export interface BundleMemberAssets {
  /** The member's own bytes (for Word/PowerPoint: the editable original). */
  original?: string;
  /** Word/PowerPoint: the rendered PDF. */
  rendered?: string;
  /**
   * Optional first-page image (for example `rendered.thumbnail` from the
   * import). Recorded on the rendered join (Office) or the file's own join.
   */
  thumbnail?: string;
}
export interface AttachBundleCourseRequest extends CourseAuthoringActor {
  importId: string;
  /** The same bundle again: bytes are never retained by this service. */
  bundle: CourseBundleInput;
  assets: Record<string, BundleMemberAssets>;
  /**
   * The course an earlier part created, when the host wants to assert it. A
   * course of another unit is `unit-mismatch`; nothing is written.
   */
  courseId?: string;
  /** Title of a course this call creates (default: manifest `course.title`, subject, first section). */
  title?: string;
  /** Licence of a course this call creates; default `personal-use-copy`. */
  licenseKind?: CourseLicenseKind;
  /**
   * Explicit opt-in (SMRT #4645): when another import is already attached as
   * this part, bring the part up to this import instead of refusing with
   * `part-conflict`. Only a later-recorded import of the same unit and part
   * count may do so (`stale-build` otherwise). Lessons and sections keep their
   * identity by key; titles and order follow this build; its materials are
   * attached and the previous build's materials it dropped are retired, never
   * deleted. Without it, nothing about attach changes.
   */
  supersede?: boolean;
  limits?: Partial<CourseBundleLimits>;
  onProgress?: CourseBundleProgressListener;
}
export interface AttachBundleCourseResult extends ApplyBundleMaterialsResult {
  courseId: string;
  /** True when this call created the course (the first part attached). */
  created: boolean;
  /** True when this import was already attached (a replay). */
  replayed: boolean;
  unitKey: string;
  /** The import this call replaced as the part's build (`supersede`), else null. */
  superseded: { importId: string; partIndex: number } | null;
  /** Materials of the replaced build that this build dropped, now retired. */
  retired: { lessonAssets: number; courseAssets: number; lessonVideos: number };
  /** Sections and lessons whose title this call changed. */
  renamed: number;
  /** Section key and lesson key to the rows of the course. */
  sections: Record<string, string>;
  lessons: Record<string, string>;
  part: {
    index: number;
    count: number;
    /** Part numbers attached so far, ascending. */
    attached: number[];
    complete: boolean;
  };
}
export interface ChooseMaterialAudienceRequest extends CourseAuthoringActor {
  importId: string;
  /** A file material: the member path as declared in the manifest. */
  path?: string;
  /** An external video: its lesson key and video id. */
  video?: { lessonKey: string; videoId: string };
  audience: MaterialAudience;
}
export interface ApplyBundleMaterialsResult {
  courseAssets: number;
  lessonAssets: number;
  lessonPages: number;
  lessonVideos: number;
  /** Rows that already existed with the same details (a replay). */
  unchanged: number;
  /** Original-deck joins whose audience was corrected to guardian-only. */
  repaired: number;
  /** Existing joins whose rendition marker or thumbnail was filled in. */
  updated: number;
  skipped: BundleMaterialsPlan['skipped'];
}
/** The materials could not be applied; nothing was written. */
export class CourseBundleMaterialsError extends CourseAuthoringError {
  constructor(
    readonly reason:
      | 'authored-course'
      | 'course-not-found'
      | 'lesson-missing'
      | 'asset-missing'
      /** A thumbnail stored under another owner than its material. */
      | 'asset-owner'
      | 'conflict'
      /** The part names another unit, or another part count, than the course it would join. */
      | 'unit-mismatch'
      /** Another import is already attached as this part of the unit. */
      | 'part-conflict'
      /** `supersede` with an import recorded no later than the build it would replace. */
      | 'stale-build'
      /** An audience choice outside the material's role bounds, or for no material. */
      | 'invalid-audience'
      /** The import is attached: change audience with `setMaterialAudience`. */
      | 'already-attached',
    readonly entry?: string,
  ) {
    super(
      'course-bundle-materials',
      `Course bundle materials were not applied: ${reason}.`,
    );
  }
}

export interface CourseBundleImportServiceOptions
  extends Omit<CourseGenerationReviewServiceOptions, 'generator'> {
  readers?: BundleReaderRegistry;
  limits?: Partial<CourseBundleLimits>;
  /**
   * Renders Word/PowerPoint members to PDF in an isolated service. Without one,
   * every Office member is recorded `unsupported / converter_unavailable`.
   */
  converter?: DocumentConverter;
  /** Reads Office text (see `OfficeTextReader`); optional and best effort. */
  officeTextReader?: OfficeTextReader;
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === '23505' ||
    /unique|duplicate key|constraint failed/i.test(String(e?.message ?? ''))
  );
}
/** Which import wrote material rows, and what a replaced build had (SMRT #4645). */
interface MaterialProvenance {
  importId: string;
  /** True while a newer build replaces the part: rows are restated, not conflicts. */
  supersede: boolean;
  /** The import being replaced, or null. */
  replacing: string | null;
  /** Imports this part's chain has replaced, plus `replacing`: rows they own are this part's. */
  lineage: Set<string>;
  /** Ids of the material rows the current build wrote or confirmed. */
  touched: Set<string>;
}
/** `Course.sourceKey` of a family course built from course bundles. */
export const BUNDLE_COURSE_SOURCE = 'course-bundle';

/** Deterministic UUID of a bundle course row: parts of one unit find the same rows. */
function bundleUuid(...parts: string[]): string {
  const hex = sha256Hex(
    new TextEncoder().encode(
      JSON.stringify(['smrt.education.course-bundle.v1', ...parts]),
    ),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function choiceView(
  target: string,
  audience: MaterialAudience,
): CourseBundleAudienceChoiceView {
  if (target.startsWith('file:'))
    return {
      target,
      path: target.slice('file:'.length),
      lessonKey: null,
      videoId: null,
      audience,
    };
  // A lesson key may itself contain ':'; a video id is always 11 characters.
  return {
    target,
    path: null,
    lessonKey: target.slice('video:'.length, -12),
    videoId: target.slice(-11),
    audience,
  };
}

/** Apply review choices to the planned audiences (within each role's bounds). */
function withChoices(
  plan: BundleMaterialsPlan,
  choices: ReadonlyMap<string, MaterialAudience>,
): BundleMaterialsPlan {
  const pick = (role: string, declared: MaterialAudience, target: string) => {
    const chosen = choices.get(target);
    if (!chosen) return declared;
    try {
      return materialAudience(role, chosen);
    } catch {
      return declared;
    }
  };
  return {
    ...plan,
    materials: plan.materials.map((m) => ({
      ...m,
      audience: pick(m.role, m.audience, `file:${m.path}`),
    })),
    videos: plan.videos.map((v) => ({
      ...v,
      audience: pick('video', v.audience, `video:${v.lessonKey}:${v.videoId}`),
    })),
  };
}

const orNull = (value: unknown) =>
  value === null || value === undefined || value === '' ? null : String(value);

function emit(
  listener: CourseBundleProgressListener | undefined,
  stage: CourseBundleStage,
) {
  return (completed: number, total: number) => {
    try {
      listener?.({ stage, completed, total });
    } catch {
      // an observer must never change the import
    }
  };
}

function memberView(row: Row): CourseBundleMemberView {
  return {
    path: String(row.path),
    ordinal: Number(row.ordinal),
    sha256: orNull(row.sha256),
    sizeBytes: Number(row.size_bytes),
    mediaType: String(row.media_type ?? ''),
    kind: String(row.kind) as CourseBundleMemberKind,
    status: String(row.status) as CourseBundleMemberStatus,
    reason: orNull(row.reason) as CourseBundleMemberReason | null,
    duplicateOfPath: orNull(row.duplicate_of_path),
    role: orNull(row.role),
    audience: orNull(row.audience) as MaterialAudience | null,
    sectionKey: orNull(row.section_key),
    lessonKey: orNull(row.lesson_key),
    renderedSha256: orNull(row.rendered_sha256),
    renderedSizeBytes: Number(row.rendered_size_bytes ?? 0),
  };
}

/**
 * Overlay deliberate rendering retries (`course_bundle_renderings`) on the
 * first-import member evidence: a Word/PowerPoint member whose rendering failed
 * for a retryable reason and was later rendered reads as accepted (identical
 * copies as duplicates). The recorded rows themselves are never rewritten.
 */
function overlayRenderings(
  members: CourseBundleMemberView[],
  renderings: ReadonlyMap<string, Row>,
) {
  const first = new Map<string, string>();
  const moved = { accepted: 0, duplicate: 0, unsupported: 0 };
  const out = members.map((m): CourseBundleMemberView => {
    const rendering = m.sha256 ? renderings.get(m.sha256) : undefined;
    if (
      !rendering ||
      !isOfficeDocumentKind(m.kind) ||
      m.status !== 'unsupported' ||
      !m.reason ||
      !COURSE_BUNDLE_RETRYABLE_REASONS.has(m.reason)
    )
      return m;
    moved.unsupported++;
    const original = first.get(m.sha256 as string);
    if (original) {
      moved.duplicate++;
      return {
        ...m,
        status: 'duplicate',
        reason: 'duplicate_content',
        duplicateOfPath: original,
      };
    }
    first.set(m.sha256 as string, m.path);
    moved.accepted++;
    return {
      ...m,
      status: 'accepted',
      reason: null,
      renderedSha256: String(rendering.rendered_sha256),
      renderedSizeBytes: Number(rendering.rendered_size_bytes),
    };
  });
  return { members: out, moved };
}

const REASON_BY_FAILURE: Record<
  DocumentConversionError['code'],
  CourseBundleMemberReason
> = {
  unavailable: 'converter_failed',
  timeout: 'converter_timeout',
  too_large: 'converter_too_large',
  rejected: 'converter_rejected',
  invalid_output: 'converter_rejected',
};
/** Reject after `ms`, aborting `controller`, even if the work ignores the signal. */
async function withTimeout<T>(
  ms: number,
  controller: AbortController,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DocumentConversionError('timeout'));
    }, ms);
  });
  try {
    return await Promise.race([work(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function recalledOutcomes(
  office: ClassifiedBundleMember[],
  recorded: Map<string, { status: string; reason: string }> | null,
): Map<string, OfficeOutcome> {
  const out = new Map<string, OfficeOutcome>();
  for (const m of office) {
    const prior = recorded?.get(m.sha256 as string);
    if (!prior) continue;
    out.set(
      m.sha256 as string,
      prior.status === 'accepted'
        ? { ok: true }
        : { ok: false, reason: prior.reason as CourseBundleMemberReason },
    );
  }
  return out;
}

/**
 * When the write found an existing import (a replay, or a concurrent first
 * import that won the unique index), the recorded Word/PowerPoint outcomes are
 * authoritative: a member recorded unsupported is never handed to the host, and
 * one recorded accepted that this call could not render fails the call rather
 * than silently disappearing. Returns the paths that may be handed over.
 */
function reconcileWithRecorded(
  plan: CourseBundlePlan,
  view: CourseBundleImportView,
): Set<string> {
  const recorded = new Map(view.members.map((m) => [m.path, m]));
  const allowed = new Set<string>();
  for (const member of plan.members) {
    const row = recorded.get(member.path);
    if (!view.replayed || !row || !isOfficeDocumentKind(member.kind)) {
      allowed.add(member.path);
      continue;
    }
    if (row.status !== 'accepted') continue;
    if (member.status !== 'accepted' || !member.rendered)
      throw new DocumentConversionError(
        'unavailable',
        'A recorded-accepted Office member could not be rendered again.',
      );
    allowed.add(member.path);
  }
  return allowed;
}

const isOffice = (m: ClassifiedBundleMember) =>
  m.status === 'accepted' &&
  isOfficeDocumentKind(m.kind) &&
  Boolean(m.sha256) &&
  m.bytes !== null;

/**
 * Import a course bundle (zip with an optional closed manifest, or a plain file
 * set) as evidence, and propose its structure through
 * `CourseGenerationReviewService` (SMRT #4578). Untrusted input is parsed with
 * hard bounds before anything is written; accepted members are handed to the
 * host for ingestion extraction and nothing is published. Reuses the course
 * authorizer: import needs `education.course.author`, reads need
 * `education.course.read-draft`, proposals need `education.course.generate`.
 */
export class CourseBundleImportService extends CourseAuthoringService {
  private readonly serviceDb: DatabaseInterface;
  private readonly serviceAuthorizer: CourseAuthoringAuthorizer;
  private readonly serviceOptions: CourseBundleImportServiceOptions;
  private readonly readers: BundleReaderRegistry;

  constructor(
    db: DatabaseInterface,
    authorizer: CourseAuthoringAuthorizer,
    options: CourseBundleImportServiceOptions = {},
  ) {
    super(db, authorizer, options);
    this.serviceDb = db;
    this.serviceAuthorizer = authorizer;
    this.serviceOptions = options;
    this.readers = options.readers ?? createBundleReaderRegistry();
  }

  /** The same service bound to a host-owned transaction executor. */
  withExecutor(executor: DatabaseInterface): CourseBundleImportService {
    return new CourseBundleImportService(
      executor,
      this.serviceAuthorizer,
      this.serviceOptions,
    );
  }

  private limits(request: { limits?: Partial<CourseBundleLimits> }) {
    return resolveCourseBundleLimits({
      ...this.serviceOptions.limits,
      ...request.limits,
    });
  }

  /**
   * Unpack and classify (sync), settle Word/PowerPoint members, then plan.
   * `render` runs the converter (import); otherwise only the recorded outcome
   * is recalled (proposals), so both see the same structure.
   */
  private async plan(
    bundle: CourseBundleInput,
    limits: CourseBundleLimits,
    listener: CourseBundleProgressListener | undefined,
    mode: { tenantId: string; render: boolean },
  ): Promise<CourseBundlePlan> {
    const raw = unpackBundle(bundle, limits, emit(listener, 'unpack'));
    const classified = classifyBundle(raw, limits, emit(listener, 'classify'));
    const office = classified.filter(isOffice);
    let outcomes: Map<string, OfficeOutcome> | undefined;
    if (office.length > 0) {
      const recorded = await this.recordedOffice(
        mode.tenantId,
        courseBundleIdentity(raw),
      );
      outcomes = mode.render
        ? await this.renderOffice(office, limits, listener, recorded)
        : recalledOutcomes(office, recorded);
    }
    return planClassifiedBundle(
      raw,
      classified,
      this.readers,
      limits,
      outcomes,
    );
  }

  /** Recorded Word/PowerPoint outcomes of an earlier import of the same bundle, by sha256. */
  private async recordedOffice(
    tenantId: string,
    identity: string,
  ): Promise<Map<string, { status: string; reason: string }> | null> {
    return this.run(async (tx) => {
      const existing = (await tx.get('course_bundle_imports', {
        tenant_id: tenantId,
        bundle_identity: identity,
      })) as Row | null;
      if (!existing) return null;
      const out = new Map<string, { status: string; reason: string }>();
      for (const m of (await this.view(tx, existing)).members) {
        if (
          !isOfficeDocumentKind(m.kind) ||
          m.status === 'duplicate' ||
          !m.sha256
        )
          continue;
        out.set(m.sha256, { status: m.status, reason: m.reason ?? '' });
      }
      return out;
    });
  }

  /**
   * Render each distinct Word/PowerPoint document once, in natural path order.
   * Every failure fails closed for that member (recorded unsupported with a
   * reason). A first import records the outcome; a replay of a recorded-accepted
   * member that can no longer be rendered throws, because its evidence says it
   * was accepted and the host still needs the bytes.
   */
  private async renderOffice(
    office: ClassifiedBundleMember[],
    limits: CourseBundleLimits,
    listener: CourseBundleProgressListener | undefined,
    recorded: Map<string, { status: string; reason: string }> | null,
  ): Promise<Map<string, OfficeOutcome>> {
    const bySha = new Map<string, ClassifiedBundleMember>();
    for (const m of [...office].sort((a, b) => naturalCompare(a.path, b.path)))
      if (!bySha.has(m.sha256 as string)) bySha.set(m.sha256 as string, m);
    const outcomes = new Map<string, OfficeOutcome>();
    const progress = emit(listener, 'render');
    progress(0, bySha.size);
    let position = 0;
    for (const [sha, member] of bySha) {
      position++;
      const prior = recorded?.get(sha);
      if (prior && prior.status !== 'accepted') {
        outcomes.set(sha, {
          ok: false,
          reason: prior.reason as CourseBundleMemberReason,
        });
      } else if (!prior && position > limits.maxOfficeMembers) {
        outcomes.set(sha, { ok: false, reason: 'office_limit' });
      } else if (!this.serviceOptions.converter) {
        if (prior) throw new DocumentConversionError('unavailable');
        outcomes.set(sha, { ok: false, reason: 'converter_unavailable' });
      } else {
        try {
          outcomes.set(sha, await this.convert(member, limits));
        } catch (error) {
          if (prior) throw error;
          const code =
            error instanceof DocumentConversionError
              ? error.code
              : 'unavailable';
          outcomes.set(sha, { ok: false, reason: REASON_BY_FAILURE[code] });
        }
      }
      progress(position, bySha.size);
    }
    return outcomes;
  }

  private async convert(
    member: ClassifiedBundleMember,
    limits: CourseBundleLimits,
  ): Promise<OfficeOutcome> {
    const converter = this.serviceOptions.converter as DocumentConverter;
    const kind = member.kind as OfficeDocumentKind;
    const bytes = member.bytes as Uint8Array;
    const controller = new AbortController();
    const result = await withTimeout(
      limits.conversionTimeoutMs,
      controller,
      () =>
        converter.convertToPdf({
          bytes,
          kind,
          fileName: `document.${kind}`,
          limits: {
            maxInputBytes: limits.maxEntryBytes,
            maxOutputBytes: limits.maxRenderedBytes,
            timeoutMs: limits.conversionTimeoutMs,
          },
          signal: controller.signal,
        }),
    );
    const pdf = result?.pdf;
    if (!(pdf instanceof Uint8Array))
      throw new DocumentConversionError('invalid_output');
    if (pdf.byteLength > limits.maxRenderedBytes)
      throw new DocumentConversionError('too_large');
    if (!looksLikePdf(pdf) || pdfIsEncrypted(pdf))
      throw new DocumentConversionError('invalid_output');
    let officeText: OfficeText | null = null;
    const reader = this.serviceOptions.officeTextReader;
    if (reader && kind !== 'xlsx') {
      try {
        officeText = await withTimeout(
          limits.conversionTimeoutMs,
          new AbortController(),
          () => reader.read({ bytes, kind }),
        );
      } catch {
        // text is best effort: a reader failure never costs the member its pages
        officeText = null;
      }
    }
    // A thumbnail is optional: anything unusable reads as none, never a failure.
    let thumbnail: RenderedThumbnail | null = null;
    const image = result?.thumbnail;
    if (
      image instanceof Uint8Array &&
      image.byteLength > 0 &&
      image.byteLength <= limits.maxThumbnailBytes
    ) {
      const mediaType = sniffImageMediaType(image);
      if (mediaType)
        thumbnail = { bytes: image, sha256: sha256Hex(image), mediaType };
    }
    return {
      ok: true,
      rendered: { bytes: pdf, sha256: sha256Hex(pdf), thumbnail },
      officeText,
    };
  }

  /**
   * Unpack, classify and record a bundle, then hand accepted members to the
   * host. Authorization is checked before any bytes are parsed and again in the
   * write transaction. Idempotent per (tenant, bundle content identity).
   */
  async importBundle(
    request: ImportCourseBundleRequest,
  ): Promise<CourseBundleImportResult> {
    await this.run((tx) =>
      this.authorize(
        tx,
        request,
        'education.course.author',
        'import-course-bundle',
      ),
    );
    const limits = this.limits(request);
    const plan = await this.plan(request.bundle, limits, request.onProgress, {
      tenantId: request.tenantId,
      render: true,
    });
    const format = 'archive' in request.bundle ? 'zip' : 'files';
    const write = () =>
      this.run(async (tx) => {
        await this.authorize(
          tx,
          request,
          'education.course.author',
          'import-course-bundle',
        );
        const existing = (await tx.get('course_bundle_imports', {
          tenant_id: request.tenantId,
          bundle_identity: plan.bundleIdentity,
        })) as Row | null;
        if (existing)
          return { ...(await this.view(tx, existing)), replayed: true };
        const count = (status: CourseBundleMemberStatus) =>
          plan.members.filter((m) => m.status === status).length;
        const now = new Date();
        const row = await (
          await CourseBundleImportCollection.create({ db: tx })
        ).create({
          _insertOnly: true,
          tenantId: request.tenantId,
          bundleIdentity: plan.bundleIdentity,
          format,
          readerId: plan.readerId,
          manifestVersion: plan.manifestVersion,
          entryCount: plan.members.length,
          acceptedCount: count('accepted'),
          duplicateCount: count('duplicate'),
          unsupportedCount: count('unsupported'),
          refusedCount: count('refused'),
          totalBytes: plan.members.reduce((n, m) => n + m.size, 0),
          importedByUserId: request.actorUserId,
          recordedAt: now,
        });
        const members = await CourseBundleMemberCollection.create({ db: tx });
        for (const [ordinal, member] of plan.members.entries()) {
          const placed = plan.placements.get(member.path);
          await members.create({
            _insertOnly: true,
            tenantId: request.tenantId,
            importId: String(row.id),
            ordinal,
            path: member.path,
            sha256: member.sha256 ?? '',
            sizeBytes: member.size,
            mediaType: member.mediaType,
            kind: member.kind,
            status: member.status,
            reason: member.reason ?? '',
            duplicateOfPath: member.duplicateOf ?? '',
            role: placed?.role ?? '',
            audience: placed?.audience ?? '',
            sectionKey: placed?.sectionKey ?? '',
            lessonKey: placed?.lessonKey ?? '',
            renderedSha256: member.rendered?.sha256 ?? '',
            renderedSizeBytes: member.rendered?.bytes.byteLength ?? 0,
            recordedAt: now,
          });
        }
        return {
          ...(await this.view(
            tx,
            (await tx.get('course_bundle_imports', {
              id: String(row.id),
              tenant_id: request.tenantId,
            })) as Row,
          )),
          replayed: false,
        };
      });
    let view: CourseBundleImportView;
    try {
      view = await write();
    } catch (error) {
      // A concurrent first import lost the unique-index race: replay once.
      if (!isUniqueViolation(error)) throw error;
      view = await write();
    }
    const settled = reconcileWithRecorded(plan, view);
    const titles = memberTitles(plan.materials);
    const accepted = plan.members
      .filter(
        (m): m is ClassifiedBundleMember & { bytes: Uint8Array } =>
          m.status === 'accepted' &&
          m.bytes !== null &&
          (m.kind === 'pdf' ||
            m.kind === 'image' ||
            m.kind === 'text' ||
            isOfficeDocumentKind(m.kind)),
      )
      .map((m): AcceptedCourseBundleMember => {
        const placed = plan.placements.get(m.path);
        return {
          path: m.path,
          sha256: m.sha256 as string,
          mediaType: m.mediaType,
          kind: m.kind as AcceptedCourseBundleMember['kind'],
          role: placed?.role || null,
          audience: placed?.audience || null,
          courseLevel: Boolean(placed?.role) && !placed?.lessonKey,
          ...(titles.get(m.path) ? { title: titles.get(m.path) } : {}),
          sectionKey: placed?.sectionKey ?? null,
          lessonKey: placed?.lessonKey ?? null,
          bytes: m.bytes,
          rendered: m.rendered
            ? {
                bytes: m.rendered.bytes,
                sha256: m.rendered.sha256,
                mediaType: 'application/pdf',
                converterId: this.serviceOptions.converter?.id ?? '',
                thumbnail: m.rendered.thumbnail ?? null,
              }
            : null,
          officeText: m.officeText,
        };
      })
      .filter((m) => settled.has(m.path));
    const receipts: Record<string, unknown> = {};
    if (request.receiveMember) {
      const progress = emit(request.onProgress, 'extract');
      progress(0, accepted.length);
      for (const member of accepted) {
        receipts[member.path] = await request.receiveMember(member, {
          replayed: view.replayed,
        });
        progress(Object.keys(receipts).length, accepted.length);
      }
    }
    return { import: view, accepted, receipts, materials: plan.materials };
  }

  /**
   * Deliberately retry the rendering of Word/PowerPoint members whose first
   * import recorded a retryable converter failure (`converter_unavailable`,
   * `converter_failed`, `converter_timeout`). Safe and idempotent: the first
   * import's evidence is append-only and is never rewritten; a success is one
   * extra `course_bundle_renderings` row per (import, content hash), after which
   * readers (and a replayed import or proposal) see the member as accepted. A
   * failure records nothing, so asking again is always allowed. Rejections,
   * size limits and the Office member cap are not retryable: change the bundle.
   * Needs `education.course.author` and a configured converter.
   */
  async retryRendering(
    request: RetryBundleRenderingRequest,
  ): Promise<RetryBundleRenderingResult> {
    const authorize = (tx: DatabaseInterface) =>
      this.authorize(
        tx,
        request,
        'education.course.author',
        'retry-course-bundle-rendering',
      );
    const imported = await this.run(async (tx) => {
      await authorize(tx);
      return this.record(tx, request);
    });
    if (!this.serviceOptions.converter)
      throw new DocumentConversionError('unavailable');
    const limits = this.limits(request);
    const raw = unpackBundle(
      request.bundle,
      limits,
      emit(request.onProgress, 'unpack'),
    );
    if (courseBundleIdentity(raw) !== String(imported.bundle_identity))
      throw new CourseBundleNotFoundError();
    const classified = classifyBundle(
      raw,
      limits,
      emit(request.onProgress, 'classify'),
    );
    const before = await this.run(async (tx) => this.view(tx, imported));
    const wanted = request.paths ? new Set(request.paths) : null;
    const byPath = new Map(classified.map((m) => [m.path, m]));
    const retried: RetryBundleRenderingResult['retried'] = [];
    const attempts = new Map<string, ClassifiedBundleMember>();
    for (const recorded of before.members) {
      if (wanted && !wanted.has(recorded.path)) continue;
      const retryable =
        isOfficeDocumentKind(recorded.kind) &&
        recorded.status === 'unsupported' &&
        recorded.reason !== null &&
        COURSE_BUNDLE_RETRYABLE_REASONS.has(recorded.reason);
      const member = byPath.get(recorded.path);
      if (
        !retryable ||
        !member ||
        !isOffice(member) ||
        member.sha256 !== recorded.sha256
      ) {
        retried.push({
          path: recorded.path,
          outcome: 'unchanged',
          reason: recorded.reason,
        });
        continue;
      }
      if (!attempts.has(recorded.sha256 as string))
        attempts.set(recorded.sha256 as string, member);
      retried.push({
        path: recorded.path,
        outcome: 'failed',
        reason: recorded.reason,
      });
    }
    const progress = emit(request.onProgress, 'render');
    progress(0, attempts.size);
    const fresh = new Map<string, OfficeOutcome & { ok: true }>();
    const failures = new Map<string, CourseBundleMemberReason>();
    let done = 0;
    for (const [sha, member] of attempts) {
      try {
        const outcome = await this.convert(member, limits);
        if (outcome.ok) fresh.set(sha, outcome);
      } catch (error) {
        const code =
          error instanceof DocumentConversionError ? error.code : 'unavailable';
        failures.set(sha, REASON_BY_FAILURE[code]);
      }
      progress(++done, attempts.size);
    }
    if (fresh.size > 0)
      await this.run(async (tx) => {
        await authorize(tx);
        const renderings = await CourseBundleRenderingCollection.create({
          db: tx,
        });
        for (const [sha, outcome] of fresh) {
          const existing = await tx.get('course_bundle_renderings', {
            tenant_id: request.tenantId,
            import_id: String(imported.id),
            sha256: sha,
          });
          if (existing) continue;
          await renderings.create({
            _insertOnly: true,
            tenantId: request.tenantId,
            importId: String(imported.id),
            sha256: sha,
            renderedSha256: outcome.rendered?.sha256 ?? '',
            renderedSizeBytes: outcome.rendered?.bytes.byteLength ?? 0,
            converterId: this.serviceOptions.converter?.id ?? '',
            retriedByUserId: request.actorUserId,
            recordedAt: new Date(),
          });
        }
      });
    for (const entry of retried) {
      if (entry.outcome !== 'failed') continue;
      const sha = byPath.get(entry.path)?.sha256 as string;
      if (fresh.has(sha)) {
        entry.outcome = 'rendered';
        entry.reason = null;
      } else entry.reason = failures.get(sha) ?? entry.reason;
    }
    const view = {
      ...(await this.run(async (tx) => this.view(tx, imported))),
      replayed: false,
    };
    const plan = await this.plan(request.bundle, limits, undefined, {
      tenantId: request.tenantId,
      render: false,
    });
    const handed = new Set(
      retried.filter((r) => r.outcome === 'rendered').map((r) => r.path),
    );
    const titles = memberTitles(plan.materials);
    const accepted = plan.members
      .filter(
        (m): m is ClassifiedBundleMember & { bytes: Uint8Array } =>
          m.status === 'accepted' &&
          m.bytes !== null &&
          isOfficeDocumentKind(m.kind) &&
          Boolean(m.sha256 && fresh.has(m.sha256)),
      )
      .filter((m) => handed.has(m.path))
      .map((m): AcceptedCourseBundleMember => {
        const placed = plan.placements.get(m.path);
        const outcome = fresh.get(m.sha256 as string);
        return {
          path: m.path,
          sha256: m.sha256 as string,
          mediaType: m.mediaType,
          kind: m.kind as OfficeDocumentKind,
          role: placed?.role || null,
          audience: placed?.audience || null,
          courseLevel: Boolean(placed?.role) && !placed?.lessonKey,
          ...(titles.get(m.path) ? { title: titles.get(m.path) } : {}),
          sectionKey: placed?.sectionKey ?? null,
          lessonKey: placed?.lessonKey ?? null,
          bytes: m.bytes,
          rendered: outcome?.rendered
            ? {
                bytes: outcome.rendered.bytes,
                sha256: outcome.rendered.sha256,
                mediaType: 'application/pdf',
                converterId: this.serviceOptions.converter?.id ?? '',
                thumbnail: outcome.rendered.thumbnail ?? null,
              }
            : null,
          officeText: outcome?.officeText ?? null,
        };
      });
    const receipts: Record<string, unknown> = {};
    if (request.receiveMember)
      for (const member of accepted)
        receipts[member.path] = await request.receiveMember(member, {
          replayed: true,
        });
    return {
      import: view,
      retried,
      accepted,
      receipts,
      materials: plan.materials,
    };
  }

  /**
   * Turn a bundle's version 2 materials into rows of a family-owned course:
   * `CourseAsset` (course members), `LessonAsset` (lesson members, slides as
   * original plus rendered pages), `LessonPage` (page ranges, sourced from the
   * paged member's PDF) and `LessonExternalVideo` (allowlisted YouTube
   * references; never downloaded). The host has already stored each accepted
   * member as a private asset and created the course's lessons. All or nothing,
   * idempotent: a row that exists with the same details is left alone, one that
   * exists with other details is a conflict. Needs `education.course.author`.
   */
  async applyMaterials(
    request: ApplyBundleMaterialsRequest,
  ): Promise<ApplyBundleMaterialsResult> {
    const authorize = (tx: DatabaseInterface) =>
      this.authorize(
        tx,
        request,
        'education.course.author',
        'apply-course-bundle-materials',
      );
    const imported = await this.run(async (tx) => {
      await authorize(tx);
      return this.record(tx, request);
    });
    const limits = this.limits(request);
    const plan = await this.plan(request.bundle, limits, request.onProgress, {
      tenantId: request.tenantId,
      render: false,
    });
    if (plan.bundleIdentity !== String(imported.bundle_identity))
      throw new CourseBundleNotFoundError();
    return this.run(async (tx) => {
      await authorize(tx);
      // Choices are read under the import lock, like attach and choose.
      await this.lockImport(tx, request.tenantId, String(imported.id));
      const course = (await tx.get('courses', {
        id: request.courseId,
        tenant_id: request.tenantId,
      })) as Row | null;
      if (!course) throw new CourseBundleMaterialsError('course-not-found');
      if (['authored', 'authored-release'].includes(String(course.source_key)))
        throw new CourseBundleMaterialsError('authored-course');
      const choices = await this.choiceMap(
        tx,
        request.tenantId,
        String(imported.id),
      );
      const lessonId = async (key: string) => {
        const id = request.lessons[key];
        const lesson = id
          ? ((await tx.get('lessons', {
              id,
              tenant_id: request.tenantId,
            })) as Row | null)
          : null;
        const section = lesson
          ? await tx.get('course_sections', {
              id: lesson.section_id,
              tenant_id: request.tenantId,
              course_id: request.courseId,
            })
          : null;
        if (!lesson || !section)
          throw new CourseBundleMaterialsError('lesson-missing', key);
        return String(id);
      };
      return this.writeMaterials(
        tx,
        request,
        request.courseId,
        withChoices(plan.materials, choices),
        lessonId,
        {
          importId: String(imported.id),
          supersede: false,
          replacing: null,
          lineage: new Set(),
          touched: new Set(),
        },
      );
    });
  }

  /**
   * Write material rows for a course: course members, lesson materials (an
   * Office member as its rendering, slides also as the guardian-only original),
   * pages and videos. Idempotent; an existing row keeps its audience (the
   * family's own later choice) except an original, which is always repaired to
   * guardian. Other differing details are a conflict.
   */
  private async writeMaterials(
    tx: DatabaseInterface,
    request: CourseAuthoringActor & {
      assets: Record<string, BundleMemberAssets>;
    },
    courseId: string,
    materials: BundleMaterialsPlan,
    lessonId: (key: string) => Promise<string>,
    prov: MaterialProvenance,
  ): Promise<ApplyBundleMaterialsResult> {
    const result: ApplyBundleMaterialsResult = {
      courseAssets: 0,
      lessonAssets: 0,
      lessonPages: 0,
      lessonVideos: 0,
      unchanged: 0,
      repaired: 0,
      updated: 0,
      skipped: materials.skipped,
    };
    /** Run `work` under the exact capability for the private assets it saves. */
    const withAccess = async <T>(
      assetIds: string[],
      work: () => Promise<T>,
    ): Promise<T> => {
      let owner: string | null = null;
      const owned: string[] = [];
      for (const assetId of assetIds) {
        const asset = (await tx.get('assets', {
          id: assetId,
          tenant_id: request.tenantId,
        })) as Row | null;
        if (!asset)
          throw new CourseBundleMaterialsError('asset-missing', assetId);
        if (!asset.owner_profile_id) continue;
        if (owner && owner !== String(asset.owner_profile_id))
          throw new CourseBundleMaterialsError('asset-owner', assetId);
        owner = String(asset.owner_profile_id);
        owned.push(assetId);
      }
      return owner
        ? withPrivateAssetAccess(
            {
              tenantId: request.tenantId,
              actorUserId: request.actorUserId,
              ownerProfileId: owner,
              assetIds: owned,
            },
            work,
          )
        : work();
    };
    const lessonAssets = await LessonAssetCollection.create({ db: tx });
    const courseAssets = await CourseAssetCollection.create({ db: tx });
    const pages = await LessonPageCollection.create({ db: tx });
    const videos = await LessonExternalVideoCollection.create({ db: tx });

    for (const material of materials.materials) {
      const supplied = request.assets[material.assetPath];
      const office = isOfficeDocumentKind(material.kind);
      const joins: Array<{
        assetId: string;
        audience: MaterialAudience;
        rendition: MaterialRendition | '';
        renditionOf: string | null;
        thumbnail: string | null;
      }> = [];
      const thumbnail = supplied?.thumbnail || null;
      if (office) {
        if (!supplied?.rendered)
          throw new CourseBundleMaterialsError('asset-missing', material.path);
        if (material.kind === 'pptx' && material.role === 'slides') {
          if (!supplied.original)
            throw new CourseBundleMaterialsError(
              'asset-missing',
              material.path,
            );
          // The editable original is for the adult whatever the deck's declared audience.
          joins.push({
            assetId: supplied.original,
            audience: 'guardian',
            rendition: 'original',
            renditionOf: null,
            thumbnail: null,
          });
        }
        joins.push({
          assetId: supplied.rendered,
          audience: material.audience,
          rendition: 'rendered',
          renditionOf: supplied.original || null,
          thumbnail,
        });
      } else if (supplied?.original)
        joins.push({
          assetId: supplied.original,
          audience: material.audience,
          rendition: '',
          renditionOf: null,
          thumbnail,
        });
      else if (material.kind === 'text') continue;
      else throw new CourseBundleMaterialsError('asset-missing', material.path);
      for (const join of joins) {
        const { assetId, audience, rendition } = join;
        const where =
          material.scope === 'course'
            ? {
                tenantId: request.tenantId,
                courseId,
                assetId,
                relationship: material.role,
              }
            : {
                tenantId: request.tenantId,
                lessonId: await lessonId(material.lessonKey as string),
                assetId,
                relationship: material.role,
              };
        const collection =
          material.scope === 'course' ? courseAssets : lessonAssets;
        const access = [assetId, ...(join.thumbnail ? [join.thumbnail] : [])];
        const existing = await (collection as typeof courseAssets).get(where, {
          cache: false,
        });
        if (existing) {
          // A row without a title (older build, or none given) simply gains
          // the manifest's; a different title is a change of the newer build.
          const currentTitle = (existing as { title?: string | null }).title;
          const titleFill = !currentTitle && Boolean(material.title);
          // Course rows carry no step (SMRT #4656).
          const stepDiff =
            material.scope === 'lesson'
              ? stepChange(existing, 'stepOrder', material.step)
              : { fill: false, moved: false };
          const moved =
            existing.sortOrder !== material.sortOrder ||
            stepDiff.moved ||
            (!titleFill && (currentTitle || '') !== material.title);
          if (
            (moved && !prov.supersede) ||
            (existing.rendition && existing.rendition !== rendition) ||
            (existing.renditionOfAssetId &&
              join.renditionOf &&
              existing.renditionOfAssetId !== join.renditionOf)
          )
            throw new CourseBundleMaterialsError('conflict', material.path);
          prov.touched.add(String(existing.id));
          // A newer build re-states the row: order, title, current again, and
          // its provenance (unless another part's build wrote it).
          const restate =
            prov.supersede &&
            (moved ||
              Boolean(existing.retiredAt) ||
              (existing.sourceImportId !== prov.importId &&
                (!existing.sourceImportId ||
                  prov.lineage.has(existing.sourceImportId))));
          if (restate) {
            existing.sortOrder = material.sortOrder;
            setMaterialTitle(existing, material.scope, material.title);
            if (material.scope === 'lesson')
              setRowStep(existing, 'stepOrder', material.step);
            existing.retiredAt = null;
            if (
              !existing.sourceImportId ||
              prov.lineage.has(existing.sourceImportId)
            )
              existing.sourceImportId = prov.importId;
          }
          // Audience after attach is the family's (`setMaterialAudience`);
          // only an original with a wider audience is repaired.
          const repair =
            rendition === 'original' && existing.audience !== 'guardian';
          if (titleFill)
            setMaterialTitle(existing, material.scope, material.title);
          if (stepDiff.fill) setRowStep(existing, 'stepOrder', material.step);
          const fill =
            titleFill ||
            stepDiff.fill ||
            existing.rendition !== rendition ||
            (Boolean(join.renditionOf) && !existing.renditionOfAssetId) ||
            (Boolean(join.thumbnail) &&
              existing.thumbnailAssetId !== join.thumbnail);
          if (repair) existing.audience = 'guardian';
          if (fill) {
            existing.rendition = rendition;
            existing.renditionOfAssetId =
              existing.renditionOfAssetId || join.renditionOf;
            if (join.thumbnail) existing.thumbnailAssetId = join.thumbnail;
          }
          if (repair || fill || restate)
            await withAccess(access, () => existing.save());
          if (repair) result.repaired++;
          else if (fill || restate) result.updated++;
          else result.unchanged++;
          continue;
        }
        const written = await withAccess(access, () =>
          (collection as typeof courseAssets).create({
            _insertOnly: true,
            sourceImportId: prov.importId,
            ...where,
            audience,
            sortOrder: material.sortOrder,
            rendition,
            renditionOfAssetId: join.renditionOf,
            thumbnailAssetId: join.thumbnail,
            ...(material.scope === 'course' || material.title
              ? { title: material.title }
              : {}),
            ...(material.scope === 'lesson' && material.step
              ? {
                  stepKey: material.step.key,
                  stepOrder: material.step.order,
                  ...(material.step.label
                    ? { stepLabel: material.step.label }
                    : {}),
                }
              : {}),
          }),
        );
        prov.touched.add(String(written.id));
        if (material.scope === 'course') result.courseAssets++;
        else result.lessonAssets++;
      }
    }
    for (const page of materials.pages) {
      const supplied = request.assets[page.assetPath];
      const sourceAssetId = supplied?.rendered ?? supplied?.original;
      if (!sourceAssetId)
        throw new CourseBundleMaterialsError('asset-missing', page.path);
      const where = {
        tenantId: request.tenantId,
        lessonId: await lessonId(page.lessonKey),
        pageKey: page.pageKey,
      };
      const existing = await pages.get(where, { cache: false });
      if (existing) {
        if (
          existing.label !== page.label ||
          existing.sortOrder !== page.sortOrder ||
          existing.sourceAssetId !== sourceAssetId ||
          existing.sourcePageNumber !== page.sourcePageNumber
        ) {
          if (!prov.supersede)
            throw new CourseBundleMaterialsError(
              'conflict',
              `${page.lessonKey}:${page.pageKey}`,
            );
          // Pages are lesson structure learner work points at: restated, never retired.
          existing.label = page.label;
          existing.sortOrder = page.sortOrder;
          existing.sourceAssetId = sourceAssetId;
          existing.sourcePageNumber = page.sourcePageNumber;
          await existing.save();
          result.updated++;
          continue;
        }
        result.unchanged++;
        continue;
      }
      await pages.create({
        _insertOnly: true,
        ...where,
        courseId,
        label: page.label,
        sortOrder: page.sortOrder,
        sourceAssetId,
        sourcePageNumber: page.sourcePageNumber,
      });
      result.lessonPages++;
    }
    for (const video of materials.videos) {
      const where = {
        tenantId: request.tenantId,
        lessonId: await lessonId(video.lessonKey),
        provider: video.provider,
        videoId: video.videoId,
      };
      const existing = await videos.get(where, { cache: false });
      if (existing) {
        // Step order and title come from the bundle; audience is the family's after attach.
        const stepDiff = stepChange(existing, 'stepPosition', video.step);
        const moved =
          existing.title !== video.title ||
          existing.stepOrder !== video.stepOrder ||
          stepDiff.moved;
        if (moved && !prov.supersede)
          throw new CourseBundleMaterialsError(
            'conflict',
            `${video.lessonKey}:${video.videoId}`,
          );
        prov.touched.add(String(existing.id));
        if (
          prov.supersede &&
          (moved ||
            Boolean(existing.retiredAt) ||
            (existing.sourceImportId !== prov.importId &&
              (!existing.sourceImportId ||
                prov.lineage.has(existing.sourceImportId))))
        ) {
          existing.title = video.title;
          existing.stepOrder = video.stepOrder;
          setRowStep(existing, 'stepPosition', video.step);
          existing.retiredAt = null;
          if (
            !existing.sourceImportId ||
            prov.lineage.has(existing.sourceImportId)
          )
            existing.sourceImportId = prov.importId;
          await existing.save();
          result.updated++;
          continue;
        }
        // A row without a step simply gains the bundle's.
        if (stepDiff.fill) {
          setRowStep(existing, 'stepPosition', video.step);
          await existing.save();
          result.updated++;
          continue;
        }
        result.unchanged++;
        continue;
      }
      const madeVideo = await videos.create({
        _insertOnly: true,
        sourceImportId: prov.importId,
        ...where,
        title: video.title,
        stepOrder: video.stepOrder,
        ...(video.step
          ? {
              stepKey: video.step.key,
              stepPosition: video.step.order,
              ...(video.step.label ? { stepLabel: video.step.label } : {}),
            }
          : {}),
        audience: video.audience,
      });
      prov.touched.add(String(madeVideo.id));
      result.lessonVideos++;
    }
    return result;
  }

  /**
   * Retire what a replaced build attached and the newer build no longer has:
   * file materials and external videos get `retiredAt`; rows stay, so learner
   * work that points at them still resolves. Rows from before provenance was
   * recorded (no `sourceImportId`) belong to the replaced build when their
   * lesson is one of its lessons, and, for course materials, when it had
   * course members. Rows another source or part wrote are never touched.
   */
  private async retireDropped(
    tx: DatabaseInterface,
    request: CourseAuthoringActor,
    courseId: string,
    prov: MaterialProvenance,
  ): Promise<AttachBundleCourseResult['retired']> {
    const retired = { lessonAssets: 0, courseAssets: 0, lessonVideos: 0 };
    const old = prov.replacing as string;
    const members = (
      (await tx.list('course_bundle_members', {
        tenant_id: request.tenantId,
        import_id: old,
      })) as Row[]
    ).filter((m) => m.status === 'accepted' || m.status === 'duplicate');
    const oldLessonKeys = new Set(
      members.map((m) => String(m.lesson_key ?? '')).filter(Boolean),
    );
    const oldHadCourseMaterial = members.some(
      (m) => m.role && !String(m.lesson_key ?? ''),
    );
    const sections = (await tx.list('course_sections', {
      tenant_id: request.tenantId,
      course_id: courseId,
    })) as Row[];
    const lessonIds = new Map<string, string>();
    for (const section of sections)
      for (const lesson of (await tx.list('lessons', {
        tenant_id: request.tenantId,
        section_id: String(section.id),
      })) as Row[])
        lessonIds.set(String(lesson.id), String(lesson.external_ref ?? ''));
    const belongs = (row: Row, inScope: boolean) =>
      !row.retired_at &&
      !prov.touched.has(String(row.id)) &&
      (row.source_import_id ? String(row.source_import_id) === old : inScope);
    const access = async <T>(ids: Array<unknown>, work: () => Promise<T>) => {
      let owner: string | null = null;
      const owned: string[] = [];
      for (const raw of ids) {
        if (!raw) continue;
        const asset = (await tx.get('assets', {
          id: String(raw),
          tenant_id: request.tenantId,
        })) as Row | null;
        if (!asset?.owner_profile_id) continue;
        owner = String(asset.owner_profile_id);
        owned.push(String(raw));
      }
      return owner
        ? withPrivateAssetAccess(
            {
              tenantId: request.tenantId,
              actorUserId: request.actorUserId,
              ownerProfileId: owner,
              assetIds: owned,
            },
            work,
          )
        : work();
    };
    const lessonAssets = await LessonAssetCollection.create({ db: tx });
    const courseAssets = await CourseAssetCollection.create({ db: tx });
    const videos = await LessonExternalVideoCollection.create({ db: tx });
    const now = new Date();
    for (const lessonId of lessonIds.keys()) {
      const inScope = oldLessonKeys.has(lessonIds.get(lessonId) as string);
      for (const row of (await tx.list('lesson_assets', {
        tenant_id: request.tenantId,
        lesson_id: lessonId,
      })) as Row[])
        if (belongs(row, inScope)) {
          const item = await lessonAssets.get(String(row.id), {
            cache: false,
          });
          if (!item) continue;
          item.retiredAt = now;
          await access([item.assetId, item.thumbnailAssetId], () =>
            item.save(),
          );
          retired.lessonAssets++;
        }
      for (const row of (await tx.list('lesson_external_videos', {
        tenant_id: request.tenantId,
        lesson_id: lessonId,
      })) as Row[])
        if (belongs(row, inScope)) {
          const item = await videos.get(String(row.id), { cache: false });
          if (!item) continue;
          item.retiredAt = now;
          await item.save();
          retired.lessonVideos++;
        }
    }
    for (const row of (await tx.list('course_assets', {
      tenant_id: request.tenantId,
      course_id: courseId,
    })) as Row[])
      if (belongs(row, oldHadCourseMaterial)) {
        const item = await courseAssets.get(String(row.id), { cache: false });
        if (!item) continue;
        item.retiredAt = now;
        await access([item.assetId, item.thumbnailAssetId], () => item.save());
        retired.courseAssets++;
      }
    return retired;
  }

  /**
   * Record who one material of an import is for, in review before it is
   * attached. Within the role's bounds (keys and assessment guidance stay
   * guardian). A later choice replaces the earlier one. Once the import is
   * attached this is `already-attached`: change the material itself with
   * `SubmissionService.setMaterialAudience`. Needs `education.course.author`.
   */
  async chooseMaterialAudience(
    request: ChooseMaterialAudienceRequest,
  ): Promise<CourseBundleAudienceChoiceView> {
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.author',
        'choose-course-bundle-audience',
      );
      // Lock first: nothing that decides the choice is read before it.
      await this.lockImport(
        tx,
        request.tenantId,
        String(request.importId ?? ''),
      );
      const imported = await this.record(tx, request);
      const importId = String(imported.id);
      if (
        (await tx.tableExists('course_bundle_attachments')) &&
        (await tx.get('course_bundle_attachments', {
          tenant_id: request.tenantId,
          import_id: importId,
        }))
      )
        throw new CourseBundleMaterialsError('already-attached');
      const invalid = (entry?: string): never => {
        throw new CourseBundleMaterialsError('invalid-audience', entry);
      };
      const audienceFor = (role: string) => {
        try {
          return materialAudience(role, request.audience) === request.audience;
        } catch {
          return false;
        }
      };
      let target: string;
      if (request.path !== undefined && request.video === undefined) {
        const member = (await tx.get('course_bundle_members', {
          tenant_id: request.tenantId,
          import_id: importId,
          path: request.path,
        })) as Row | null;
        const role = String(member?.role ?? '');
        if (
          Number(imported.manifest_version) < 2 ||
          !(COURSE_BUNDLE_MATERIAL_ROLES as readonly string[]).includes(role)
        )
          invalid(request.path);
        if (!audienceFor(role)) invalid(request.path);
        target = `file:${request.path}`;
      } else if (request.video && request.path === undefined) {
        const { lessonKey, videoId } = request.video;
        if (
          typeof lessonKey !== 'string' ||
          !MANIFEST_KEY.test(lessonKey) ||
          typeof videoId !== 'string' ||
          !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
          Number(imported.manifest_version) < 2
        )
          invalid();
        if (!audienceFor('video')) invalid(`${lessonKey}:${videoId}`);
        target = `video:${lessonKey}:${videoId}`;
      } else return invalid();
      const choices = await CourseBundleAudienceChoiceCollection.create({
        db: tx,
      });
      const existing = await choices.get(
        { tenantId: request.tenantId, importId, target },
        { cache: false },
      );
      if (existing) {
        existing.audience = request.audience;
        existing.chosenByUserId = request.actorUserId;
        existing.chosenAt = new Date();
        await existing.save();
      } else
        await choices.create({
          tenantId: request.tenantId,
          importId,
          target,
          audience: request.audience,
          chosenByUserId: request.actorUserId,
          chosenAt: new Date(),
        });
      return choiceView(target, request.audience);
    });
  }

  /**
   * Turn an imported bundle (or one part of a unit split across bundles) into a
   * family course: the course, its sections and lessons, and the bundle's
   * materials, pages and videos with role, audience (review choices applied)
   * and rendition. Every part of a unit (manifest `course.key`, `part`) lands in
   * the same course: ids derive from (family, unit key), so parts attach in any
   * order and a retry replays. A part of another unit, another part count, or a
   * second import for the same part fails closed and writes nothing. Nothing is
   * published: the course is a family draft. Needs `education.course.author`.
   */
  async attachCourse(
    request: AttachBundleCourseRequest,
  ): Promise<AttachBundleCourseResult> {
    const authorize = (tx: DatabaseInterface) =>
      this.authorize(
        tx,
        request,
        'education.course.author',
        'attach-course-bundle',
      );
    const imported = await this.run(async (tx) => {
      await authorize(tx);
      return this.record(tx, request);
    });
    const importId = String(imported.id);
    const limits = this.limits(request);
    const plan = await this.plan(request.bundle, limits, request.onProgress, {
      tenantId: request.tenantId,
      render: false,
    });
    if (plan.bundleIdentity !== String(imported.bundle_identity))
      throw new CourseBundleNotFoundError();
    const { structure } = plan;
    const unit = structure.unit ?? {
      key: `bundle:${plan.bundleIdentity}`,
      title: '',
      part: 1,
      parts: 1,
    };
    const courseId = bundleUuid('course', request.tenantId, unit.key);
    const write = () =>
      this.run(async (tx): Promise<AttachBundleCourseResult> => {
        await authorize(tx);
        // Before any read: a concurrent review choice lands first or sees this attach.
        await this.lockImport(tx, request.tenantId, importId);
        // Then every attach of this unit serializes on its unit row, created if
        // absent and locked before anything that decides the outcome is read.
        await this.lockUnit(tx, request.tenantId, unit.key, courseId);
        if (request.courseId && request.courseId !== courseId) {
          const asserted = await tx.get('courses', {
            id: request.courseId,
            tenant_id: request.tenantId,
          });
          throw new CourseBundleMaterialsError(
            asserted ? 'unit-mismatch' : 'course-not-found',
          );
        }
        const attached = (await tx.list('course_bundle_attachments', {
          tenant_id: request.tenantId,
          course_id: courseId,
        })) as Row[];
        const mine = (await tx.get('course_bundle_attachments', {
          tenant_id: request.tenantId,
          import_id: importId,
        })) as Row | null;
        if (mine && String(mine.course_id) !== courseId)
          throw new CourseBundleMaterialsError('unit-mismatch');
        let replacing: Row | null = null;
        for (const row of attached) {
          if (
            String(row.unit_key) !== unit.key ||
            Number(row.part_count) !== unit.parts
          )
            throw new CourseBundleMaterialsError('unit-mismatch');
          if (
            Number(row.part_index) === unit.part &&
            String(row.import_id) !== importId
          ) {
            if (!request.supersede)
              throw new CourseBundleMaterialsError(
                'part-conflict',
                String(unit.part),
              );
            replacing = row;
          }
        }
        if (replacing) {
          // "Newer" is the import record: this build was recorded strictly
          // after the one it replaces (manifests carry no build stamp).
          const older = (await tx.get('course_bundle_imports', {
            id: String(replacing.import_id),
            tenant_id: request.tenantId,
          })) as Row | null;
          const at = (row: Row | null) =>
            new Date(row?.recorded_at as string | number | Date).getTime();
          if (!older || !(at(imported) > at(older)))
            throw new CourseBundleMaterialsError(
              'stale-build',
              String(unit.part),
            );
        }
        let created = false;
        const course = (await tx.get('courses', {
          id: courseId,
          tenant_id: request.tenantId,
        })) as Row | null;
        if (course) {
          if (
            String(course.source_key) !== BUNDLE_COURSE_SOURCE ||
            String(course.source_ref) !== unit.key
          )
            throw new CourseBundleMaterialsError('unit-mismatch');
        } else {
          await (await CourseCollection.create({ db: tx })).create({
            _insertOnly: true,
            id: courseId,
            tenantId: request.tenantId,
            title: (
              request.title?.trim() ||
              unit.title ||
              structure.subject ||
              structure.sections[0]?.title ||
              'Imported course'
            ).slice(0, 300),
            subject: structure.subject ?? '',
            sourceKey: BUNDLE_COURSE_SOURCE,
            sourceRef: unit.key,
            licenseKind: request.licenseKind ?? 'personal-use-copy',
            status: 'draft',
          });
          created = true;
        }
        const choices = await this.choiceMap(tx, request.tenantId, importId);
        // Lesson text honours the review choices: only learner text is inlined.
        const chosen = new Map(plan.placements);
        for (const [path, placed] of chosen) {
          const audience = choices.get(`file:${path}`);
          if (audience && placed.audience)
            chosen.set(path, { ...placed, audience });
        }
        const bodies = bundleProposalOutput(
          { ...plan, placements: chosen },
          limits,
        ).lessons;
        const sectionRows = await CourseSectionCollection.create({ db: tx });
        const lessonRows = await LessonCollection.create({ db: tx });
        const placements = await CourseBundlePlacementCollection.create({
          db: tx,
        });
        /**
         * Settle a shared section or lesson against what earlier parts placed.
         * Titles must match; declared orders must match; declared against
         * implicit conflicts; between implicit positions the lowest part index
         * decides. Returns the sort order to write, or null to keep the row's.
         */
        const place = async (
          kind: 'section' | 'lesson',
          key: string,
          title: string,
          declared: number | undefined,
          position: number,
          rowExists: boolean,
        ): Promise<number | null> => {
          const existing = await placements.get(
            { tenantId: request.tenantId, courseId, kind, key },
            { cache: false },
          );
          // A row this path did not place cannot be settled against: refuse.
          if (!existing && rowExists)
            throw new CourseBundleMaterialsError('part-conflict', key);
          if (!existing) {
            await placements.create({
              tenantId: request.tenantId,
              courseId,
              kind,
              key,
              title,
              declaredOrder: declared ?? null,
              implicitOrder: position,
              partIndex: unit.part,
            });
            return declared ?? position;
          }
          const was = existing.declaredOrder;
          if (
            existing.title !== title ||
            (was === null) !== (declared === undefined) ||
            (was !== null && was !== declared)
          ) {
            // A newer build of this part may retitle and reorder what it
            // placed; a key a lower part decided must still agree.
            if (!replacing || existing.partIndex < unit.part)
              throw new CourseBundleMaterialsError('part-conflict', key);
            existing.title = title;
            existing.declaredOrder = declared ?? null;
            existing.implicitOrder = position;
            existing.partIndex = unit.part;
            await existing.save();
            return declared ?? position;
          }
          if (
            replacing &&
            was === null &&
            unit.part === existing.partIndex &&
            existing.implicitOrder !== position
          ) {
            existing.implicitOrder = position;
            await existing.save();
            return position;
          }
          if (was !== null || unit.part >= existing.partIndex)
            return rowExists ? null : (was ?? existing.implicitOrder);
          existing.implicitOrder = position;
          existing.partIndex = unit.part;
          await existing.save();
          return position;
        };
        const sections: Record<string, string> = {};
        const lessons: Record<string, string> = {};
        let renamed = 0;
        let flat = 0;
        for (const [s, section] of structure.sections.entries()) {
          const sectionId = bundleUuid('section', courseId, section.key);
          const existingSection = (await tx.get('course_sections', {
            id: sectionId,
            tenant_id: request.tenantId,
          })) as Row | null;
          if (existingSection && String(existingSection.course_id) !== courseId)
            throw new CourseBundleMaterialsError('unit-mismatch', section.key);
          const sectionOrder = await place(
            'section',
            section.key,
            section.title,
            section.order,
            s,
            Boolean(existingSection),
          );
          if (!existingSection)
            await sectionRows.create({
              _insertOnly: true,
              id: sectionId,
              tenantId: request.tenantId,
              courseId,
              title: section.title,
              sortOrder: sectionOrder ?? s,
            });
          else if (
            (sectionOrder !== null &&
              Number(existingSection.sort_order) !== sectionOrder) ||
            (replacing && String(existingSection.title) !== section.title)
          ) {
            const row = await sectionRows.get(sectionId, { cache: false });
            if (!row) throw new CourseBundleMaterialsError('unit-mismatch');
            if (sectionOrder !== null) row.sortOrder = sectionOrder;
            if (replacing && row.title !== section.title) {
              row.title = section.title;
              renamed++;
            }
            await row.save();
          }
          sections[section.key] = sectionId;
          for (const [l, lesson] of section.lessons.entries()) {
            const body = bodies[flat++]?.body ?? '';
            const id = bundleUuid('lesson', courseId, lesson.key);
            const existingLesson = (await tx.get('lessons', {
              id,
              tenant_id: request.tenantId,
            })) as Row | null;
            if (
              existingLesson &&
              String(existingLesson.section_id) !== sectionId
            )
              throw new CourseBundleMaterialsError('conflict', lesson.key);
            const lessonOrder = await place(
              'lesson',
              lesson.key,
              lesson.title,
              lesson.order,
              l,
              Boolean(existingLesson),
            );
            if (!existingLesson)
              await lessonRows.create({
                _insertOnly: true,
                id,
                tenantId: request.tenantId,
                sectionId,
                title: lesson.title,
                body,
                sortOrder: lessonOrder ?? l,
                externalRef: lesson.key,
              });
            else if (
              (lessonOrder !== null &&
                Number(existingLesson.sort_order) !== lessonOrder) ||
              (replacing && String(existingLesson.title) !== lesson.title)
            ) {
              const row = await lessonRows.get(id, { cache: false });
              if (!row) throw new CourseBundleMaterialsError('conflict');
              if (lessonOrder !== null) row.sortOrder = lessonOrder;
              if (replacing && row.title !== lesson.title) {
                row.title = lesson.title;
                renamed++;
              }
              await row.save();
            }
            lessons[lesson.key] = id;
          }
        }
        const provenance: MaterialProvenance = {
          importId,
          supersede: Boolean(replacing),
          replacing: replacing ? String(replacing.import_id) : null,
          lineage: new Set(
            replacing
              ? [
                  String(replacing.import_id),
                  ...(
                    (await tx.list('course_bundle_supersessions', {
                      tenant_id: request.tenantId,
                      course_id: courseId,
                      unit_key: unit.key,
                      part_index: unit.part,
                    })) as Row[]
                  ).map((r) => String(r.superseded_import_id)),
                ]
              : [],
          ),
          touched: new Set(),
        };
        const materials = await this.writeMaterials(
          tx,
          request,
          courseId,
          withChoices(plan.materials, choices),
          async (key) => {
            const id = lessons[key];
            if (!id)
              throw new CourseBundleMaterialsError('lesson-missing', key);
            return id;
          },
          provenance,
        );
        const retired = replacing
          ? await this.retireDropped(tx, request, courseId, provenance)
          : { lessonAssets: 0, courseAssets: 0, lessonVideos: 0 };
        if (replacing) {
          // The newer build takes over the part; the audit row says from whom.
          const row = await (
            await CourseBundleAttachmentCollection.create({ db: tx })
          ).get(
            {
              tenantId: request.tenantId,
              importId: String(replacing.import_id),
            },
            { cache: false },
          );
          if (!row) throw new CourseBundleMaterialsError('part-conflict');
          await row.supersedeWith(importId, request.actorUserId);
          await (
            await CourseBundleSupersessionCollection.create({ db: tx })
          ).create({
            _insertOnly: true,
            tenantId: request.tenantId,
            courseId,
            unitKey: unit.key,
            partIndex: unit.part,
            importId,
            supersededImportId: String(replacing.import_id),
            supersededByUserId: request.actorUserId,
            recordedAt: new Date(),
          });
        } else if (!mine)
          await (
            await CourseBundleAttachmentCollection.create({ db: tx })
          ).create({
            _insertOnly: true,
            tenantId: request.tenantId,
            importId,
            courseId,
            unitKey: unit.key,
            partIndex: unit.part,
            partCount: unit.parts,
            attachedByUserId: request.actorUserId,
            recordedAt: new Date(),
          });
        const parts = [
          ...new Set([
            ...attached.map((row) => Number(row.part_index)),
            unit.part,
          ]),
        ].sort((a, b) => a - b);
        return {
          ...materials,
          courseId,
          created,
          replayed: Boolean(mine),
          unitKey: unit.key,
          superseded: replacing
            ? { importId: String(replacing.import_id), partIndex: unit.part }
            : null,
          retired,
          renamed,
          sections,
          lessons,
          part: {
            index: unit.part,
            count: unit.parts,
            attached: parts,
            complete: parts.length === unit.parts,
          },
        };
      });
    try {
      return await write();
    } catch (error) {
      // Two parts attached at once both created the course: replay once.
      if (!isUniqueViolation(error)) throw error;
      return write();
    }
  }

  /**
   * Create-if-absent, then lock, the unit row all attaches of a unit serialize
   * on. Exists before any decision read, so a first attach cannot slip past
   * an uncommitted one (on PostgreSQL the second create waits for the first).
   */
  private async lockUnit(
    tx: DatabaseInterface,
    tenantId: string,
    unitKey: string,
    courseId: string,
  ) {
    const units = await CourseBundleUnitCollection.create({ db: tx });
    if (!(await units.get({ tenantId, unitKey }, { cache: false })))
      await units.create({ tenantId, unitKey, courseId });
    await tx.query(
      'UPDATE course_bundle_units SET id = id WHERE tenant_id = ? AND unit_key = ?',
      [tenantId, unitKey],
    );
  }

  /**
   * Serialize writers of one import (attach and review choices) on its row, so
   * a choice either lands before an attach reads it or sees the attachment.
   * A no-op update takes the row lock on PostgreSQL; embedded databases
   * already serialize write transactions.
   */
  private async lockImport(
    tx: DatabaseInterface,
    tenantId: string,
    importId: string,
  ) {
    await tx.query(
      'UPDATE course_bundle_imports SET id = id WHERE id = ? AND tenant_id = ?',
      [importId, tenantId],
    );
  }

  /** Review choices of one import, by target. */
  private async choiceMap(
    tx: DatabaseInterface,
    tenantId: string,
    importId: string,
  ): Promise<Map<string, MaterialAudience>> {
    if (!(await tx.tableExists('course_bundle_audience_choices')))
      return new Map();
    return new Map(
      (
        (await tx.list('course_bundle_audience_choices', {
          tenant_id: tenantId,
          import_id: importId,
        })) as Row[]
      ).map((r) => [String(r.target), String(r.audience) as MaterialAudience]),
    );
  }

  /** The recorded evidence of one import; needs `education.course.read-draft`. */
  async readImport(
    request: CourseAuthoringActor & { importId: string },
  ): Promise<CourseBundleImportView> {
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-course-bundle',
      );
      return {
        ...(await this.view(tx, await this.record(tx, request))),
        replayed: false,
      };
    });
  }

  /**
   * Propose the bundle's sections and lessons as a generation proposal on a
   * course draft. The host reviews and accepts (`decideProposal`); fills land in
   * a new draft revision, conflicts wait, and nothing is released or published.
   * Idempotent per (course, bundle): a retry returns the same job and proposal.
   */
  async proposeStructure(
    request: ProposeBundleStructureRequest,
  ): Promise<CourseGenerationView> {
    const imported = await this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-course-bundle',
      );
      return this.record(tx, request);
    });
    const limits = this.limits(request);
    const progress = emit(request.onProgress, 'propose');
    const plan = await this.plan(request.bundle, limits, request.onProgress, {
      tenantId: request.tenantId,
      render: false,
    });
    if (plan.bundleIdentity !== String(imported.bundle_identity))
      throw new CourseBundleNotFoundError();
    progress(0, 1);
    const generator: CourseMaterialGenerator = {
      identity: {
        provider: 'smrt-bundle-import',
        model: plan.readerId,
        version: '1',
      },
      generate: async () => ({
        output: bundleProposalOutput(plan, limits),
        completion: 'complete',
      }),
    };
    const reviewer = new CourseGenerationReviewService(
      this.serviceDb,
      this.serviceAuthorizer,
      { ...this.serviceOptions, generator },
    );
    const job = await reviewer.requestGeneration({
      ...request,
      requestKey: `bundle:${request.courseId}:${plan.bundleIdentity}`,
      instruction:
        request.instruction ??
        'Propose course structure from an imported bundle.',
    });
    const done = await reviewer.runGeneration({
      ...request,
      jobId: job.jobId,
    });
    progress(1, 1);
    return done;
  }

  private async record(
    tx: DatabaseInterface,
    request: CourseAuthoringActor & { importId: string },
  ): Promise<Row> {
    const row =
      typeof request.importId === 'string' && request.importId
        ? ((await tx.get('course_bundle_imports', {
            id: request.importId,
            tenant_id: request.tenantId,
          })) as Row | null)
        : null;
    if (!row) throw new CourseBundleNotFoundError();
    return row;
  }

  private async view(
    tx: DatabaseInterface,
    row: Row,
  ): Promise<Omit<CourseBundleImportView, 'replayed'>> {
    const rows = (
      (await tx.list('course_bundle_members', {
        tenant_id: String(row.tenant_id),
        import_id: String(row.id),
      })) as Row[]
    )
      .map(memberView)
      .sort((a, b) => a.ordinal - b.ordinal);
    const renderings = new Map(
      (
        ((await tx.tableExists('course_bundle_renderings'))
          ? await tx.list('course_bundle_renderings', {
              tenant_id: String(row.tenant_id),
              import_id: String(row.id),
            })
          : []) as Row[]
      ).map((r) => [String(r.sha256), r]),
    );
    const { members, moved } = overlayRenderings(rows, renderings);
    const tenant = String(row.tenant_id);
    const choices = (await tx.tableExists('course_bundle_audience_choices'))
      ? ((await tx.list('course_bundle_audience_choices', {
          tenant_id: tenant,
          import_id: String(row.id),
        })) as Row[])
      : [];
    const attachment = (await tx.tableExists('course_bundle_attachments'))
      ? ((await tx.get('course_bundle_attachments', {
          tenant_id: tenant,
          import_id: String(row.id),
        })) as Row | null)
      : null;
    return {
      importId: String(row.id),
      bundleIdentity: String(row.bundle_identity),
      format: String(row.format) as 'zip' | 'files',
      readerId: String(row.reader_id),
      manifestVersion: Number(row.manifest_version),
      entryCount: Number(row.entry_count),
      acceptedCount: Number(row.accepted_count) + moved.accepted,
      duplicateCount: Number(row.duplicate_count) + moved.duplicate,
      unsupportedCount: Number(row.unsupported_count) - moved.unsupported,
      refusedCount: Number(row.refused_count),
      totalBytes: Number(row.total_bytes),
      members,
      audienceChoices: choices
        .map((c) =>
          choiceView(String(c.target), String(c.audience) as MaterialAudience),
        )
        .sort((a, b) =>
          a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
        ),
      attachment: attachment
        ? {
            courseId: String(attachment.course_id),
            unitKey: String(attachment.unit_key),
            partIndex: Number(attachment.part_index),
            partCount: Number(attachment.part_count),
          }
        : null,
    };
  }
}
