import { withPrivateAssetAccess } from '@happyvertical/smrt-assets';
import type { DatabaseInterface } from '@happyvertical/sql';
import { LessonAssetCollection } from './collections.js';
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
import {
  CourseBundleImportCollection,
  CourseBundleMemberCollection,
  CourseBundleRenderingCollection,
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
  looksLikePdf,
  type OfficeDocumentKind,
  type OfficeText,
  type OfficeTextReader,
} from './document-converter.js';
import {
  CourseAssetCollection,
  LessonExternalVideoCollection,
  type MaterialAudience,
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
}
/** An accepted member handed to the host, in memory only, for ingestion. */
export interface AcceptedCourseBundleMember {
  path: string;
  sha256: string;
  mediaType: string;
  kind: 'pdf' | 'image' | 'text' | 'docx' | 'pptx';
  /** Declared role: a page role (`exercise`, ...) under v1, a material role (`slides`, ...) under v2. */
  role: string | null;
  /** Manifest v2: who the material is for; null otherwise. */
  audience: MaterialAudience | null;
  /** Manifest v2: true for a course-level member (no lesson). */
  courseLevel: boolean;
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
  } | null;
  /**
   * Word/PowerPoint only: text read by the injected `OfficeTextReader` (slide text
   * and speaker notes per slide for PPTX), or null. It is never copied into a
   * proposed lesson body: audience belongs to the manifest v2 roles.
   */
  officeText: OfficeText | null;
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
  assets: Record<string, { original?: string; rendered?: string }>;
  limits?: Partial<CourseBundleLimits>;
  onProgress?: CourseBundleProgressListener;
}
export interface ApplyBundleMaterialsResult {
  courseAssets: number;
  lessonAssets: number;
  lessonPages: number;
  lessonVideos: number;
  /** Rows that already existed with the same details (a replay). */
  unchanged: number;
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
      | 'conflict',
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
      (m.kind !== 'docx' && m.kind !== 'pptx') ||
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
    if (
      !view.replayed ||
      !row ||
      (member.kind !== 'docx' && member.kind !== 'pptx')
    ) {
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
  (m.kind === 'docx' || m.kind === 'pptx') &&
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
          (m.kind !== 'docx' && m.kind !== 'pptx') ||
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
    if (reader) {
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
    return {
      ok: true,
      rendered: { bytes: pdf, sha256: sha256Hex(pdf) },
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
    const accepted = plan.members
      .filter(
        (m): m is ClassifiedBundleMember & { bytes: Uint8Array } =>
          m.status === 'accepted' &&
          m.bytes !== null &&
          (m.kind === 'pdf' ||
            m.kind === 'image' ||
            m.kind === 'text' ||
            m.kind === 'docx' ||
            m.kind === 'pptx'),
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
          sectionKey: placed?.sectionKey ?? null,
          lessonKey: placed?.lessonKey ?? null,
          bytes: m.bytes,
          rendered: m.rendered
            ? {
                ...m.rendered,
                mediaType: 'application/pdf',
                converterId: this.serviceOptions.converter?.id ?? '',
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
        (recorded.kind === 'docx' || recorded.kind === 'pptx') &&
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
    const accepted = plan.members
      .filter(
        (m): m is ClassifiedBundleMember & { bytes: Uint8Array } =>
          m.status === 'accepted' &&
          m.bytes !== null &&
          (m.kind === 'docx' || m.kind === 'pptx') &&
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
          kind: m.kind as 'docx' | 'pptx',
          role: placed?.role || null,
          audience: placed?.audience || null,
          courseLevel: Boolean(placed?.role) && !placed?.lessonKey,
          sectionKey: placed?.sectionKey ?? null,
          lessonKey: placed?.lessonKey ?? null,
          bytes: m.bytes,
          rendered: outcome?.rendered
            ? {
                ...outcome.rendered,
                mediaType: 'application/pdf',
                converterId: this.serviceOptions.converter?.id ?? '',
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
    const { materials } = plan;
    const result: ApplyBundleMaterialsResult = {
      courseAssets: 0,
      lessonAssets: 0,
      lessonPages: 0,
      lessonVideos: 0,
      unchanged: 0,
      skipped: materials.skipped,
    };
    return this.run(async (tx) => {
      await authorize(tx);
      const course = (await tx.get('courses', {
        id: request.courseId,
        tenant_id: request.tenantId,
      })) as Row | null;
      if (!course) throw new CourseBundleMaterialsError('course-not-found');
      if (['authored', 'authored-release'].includes(String(course.source_key)))
        throw new CourseBundleMaterialsError('authored-course');
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
      const withAccess = async <T>(assetId: string, work: () => Promise<T>) => {
        const asset = (await tx.get('assets', {
          id: assetId,
          tenant_id: request.tenantId,
        })) as Row | null;
        if (!asset)
          throw new CourseBundleMaterialsError('asset-missing', assetId);
        return asset.owner_profile_id
          ? withPrivateAssetAccess(
              {
                tenantId: request.tenantId,
                actorUserId: request.actorUserId,
                ownerProfileId: String(asset.owner_profile_id),
                assetIds: [assetId],
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
        const office = material.kind === 'docx' || material.kind === 'pptx';
        const joins: string[] = [];
        if (office) {
          if (!supplied?.rendered)
            throw new CourseBundleMaterialsError(
              'asset-missing',
              material.path,
            );
          if (material.kind === 'pptx' && material.role === 'slides') {
            if (!supplied.original)
              throw new CourseBundleMaterialsError(
                'asset-missing',
                material.path,
              );
            joins.push(supplied.original);
          }
          joins.push(supplied.rendered);
        } else if (supplied?.original) joins.push(supplied.original);
        else if (material.kind === 'text') continue;
        else
          throw new CourseBundleMaterialsError('asset-missing', material.path);
        for (const assetId of joins) {
          const where =
            material.scope === 'course'
              ? {
                  tenantId: request.tenantId,
                  courseId: request.courseId,
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
          const existing = await (collection as typeof courseAssets).get(
            where,
            { cache: false },
          );
          if (existing) {
            if (
              existing.audience !== material.audience ||
              existing.sortOrder !== material.sortOrder ||
              (material.scope === 'course' &&
                (existing as { title?: string }).title !== material.title)
            )
              throw new CourseBundleMaterialsError('conflict', material.path);
            result.unchanged++;
            continue;
          }
          await withAccess(assetId, () =>
            (collection as typeof courseAssets).create({
              _insertOnly: true,
              ...where,
              audience: material.audience,
              sortOrder: material.sortOrder,
              ...(material.scope === 'course' ? { title: material.title } : {}),
            }),
          );
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
          )
            throw new CourseBundleMaterialsError(
              'conflict',
              `${page.lessonKey}:${page.pageKey}`,
            );
          result.unchanged++;
          continue;
        }
        await pages.create({
          _insertOnly: true,
          ...where,
          courseId: request.courseId,
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
          if (
            existing.title !== video.title ||
            existing.stepOrder !== video.stepOrder ||
            existing.audience !== video.audience
          )
            throw new CourseBundleMaterialsError(
              'conflict',
              `${video.lessonKey}:${video.videoId}`,
            );
          result.unchanged++;
          continue;
        }
        await videos.create({
          _insertOnly: true,
          ...where,
          title: video.title,
          stepOrder: video.stepOrder,
          audience: video.audience,
        });
        result.lessonVideos++;
      }
      return result;
    });
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
    };
  }
}
