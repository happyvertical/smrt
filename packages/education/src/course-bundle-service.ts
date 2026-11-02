import type { DatabaseInterface } from '@happyvertical/sql';
import type {
  CourseAuthoringActor,
  CourseAuthoringAuthorizer,
} from './course-authoring-contracts.js';
import { CourseAuthoringService } from './course-authoring-service.js';
import {
  type BundleReaderRegistry,
  bundleProposalOutput,
  type ClassifiedBundleMember,
  type CourseBundlePlan,
  createBundleReaderRegistry,
  planCourseBundle,
  unpackBundle,
} from './course-bundle.js';
import {
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
} from './course-bundle-models.js';
import type {
  CourseGenerationView,
  CourseMaterialGenerator,
} from './course-generation-contracts.js';
import {
  CourseGenerationReviewService,
  type CourseGenerationReviewServiceOptions,
} from './course-generation-review-service.js';

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
  role: string | null;
  sectionKey: string | null;
  lessonKey: string | null;
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
  kind: 'pdf' | 'image' | 'text';
  /** Declared page role (`exercise`, `answer_key`, ...), or null. */
  role: string | null;
  sectionKey: string | null;
  lessonKey: string | null;
  bytes: Uint8Array;
}
export interface CourseBundleImportResult {
  import: CourseBundleImportView;
  /** Accepted members in canonical order; duplicates and unsupported ones are absent. */
  accepted: AcceptedCourseBundleMember[];
  /** What `receiveMember` returned per path. */
  receipts: Record<string, unknown>;
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
export interface CourseBundleImportServiceOptions
  extends Omit<CourseGenerationReviewServiceOptions, 'generator'> {
  readers?: BundleReaderRegistry;
  limits?: Partial<CourseBundleLimits>;
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
    sectionKey: orNull(row.section_key),
    lessonKey: orNull(row.lesson_key),
  };
}

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

  private plan(
    bundle: CourseBundleInput,
    limits: CourseBundleLimits,
    listener?: CourseBundleProgressListener,
  ): CourseBundlePlan {
    const unpack = emit(listener, 'unpack');
    const raw = unpackBundle(bundle, limits, unpack);
    const classify = emit(listener, 'classify');
    return planCourseBundle(raw, this.readers, limits, classify);
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
    const plan = this.plan(request.bundle, limits, request.onProgress);
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
            sectionKey: placed?.sectionKey ?? '',
            lessonKey: placed?.lessonKey ?? '',
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
    const accepted = plan.members
      .filter(
        (m): m is ClassifiedBundleMember & { bytes: Uint8Array } =>
          m.status === 'accepted' &&
          m.bytes !== null &&
          (m.kind === 'pdf' || m.kind === 'image' || m.kind === 'text'),
      )
      .map((m): AcceptedCourseBundleMember => {
        const placed = plan.placements.get(m.path);
        return {
          path: m.path,
          sha256: m.sha256 as string,
          mediaType: m.mediaType,
          kind: m.kind as 'pdf' | 'image' | 'text',
          role: placed?.role || null,
          sectionKey: placed?.sectionKey ?? null,
          lessonKey: placed?.lessonKey ?? null,
          bytes: m.bytes,
        };
      });
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
    return { import: view, accepted, receipts };
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
    const plan = this.plan(request.bundle, limits, request.onProgress);
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
    const members = (
      (await tx.list('course_bundle_members', {
        tenant_id: String(row.tenant_id),
        import_id: String(row.id),
      })) as Row[]
    )
      .map(memberView)
      .sort((a, b) => a.ordinal - b.ordinal);
    return {
      importId: String(row.id),
      bundleIdentity: String(row.bundle_identity),
      format: String(row.format) as 'zip' | 'files',
      readerId: String(row.reader_id),
      manifestVersion: Number(row.manifest_version),
      entryCount: Number(row.entry_count),
      acceptedCount: Number(row.accepted_count),
      duplicateCount: Number(row.duplicate_count),
      unsupportedCount: Number(row.unsupported_count),
      refusedCount: Number(row.refused_count),
      totalBytes: Number(row.total_bytes),
      members,
    };
  }
}
