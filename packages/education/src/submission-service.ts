import {
  type Asset,
  type AssetRuntime,
  type AssetRuntimeOptions,
  createAssetRuntime,
  withPrivateAssetAccess,
} from '@happyvertical/smrt-assets';
import type { DatabaseInterface } from '@happyvertical/sql';
import { PDFDocument } from 'pdf-lib';
import type { CatalogAuthorizer } from './catalog-service.js';
import {
  AttestationCollection,
  GradeCollection,
  LessonAssetCollection,
  LessonCollection,
  LessonProgressCollection,
  LessonSelfAttestationCollection,
  ScannedSubmissionCollection,
  SubmissionAssetCollection,
  SubmissionCollection,
  SubmissionIntakeBindingCollection,
} from './collections.js';
import {
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  LearnerHistoryUnavailableError,
  type LearnerRequest,
  LearnerService,
  LearnerValidationError,
  requirePolicyBasis,
} from './learner-service.js';
import {
  CourseAssetCollection,
  type ExternalVideoProvider,
  externalVideoEmbedUrl,
  type LessonAssetRelationship,
  LessonExternalVideoCollection,
  type MaterialAudience,
  type MaterialRendition,
  materialAudience,
  parseYouTubeReference,
} from './lesson-assets.js';
import { validLessonPageKey } from './lesson-pages.js';
import {
  readWorkCompletion,
  WorkCompletionDecisionCollection,
} from './lesson-work-completion.js';
import type { WorkAssistance } from './lesson-work-contracts.js';
import {
  type LessonActivity,
  LessonActivityCollection,
  WorkAttemptCollection,
} from './lesson-work-models.js';
import type { Grade, Submission, SubmissionKind } from './submissions.js';

/** A single captured page. No model patches or pre-existing asset IDs are accepted. */
export interface SubmissionPage {
  name: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  data: Buffer;
  /**
   * The lesson page this file is (`p1`, `p12-back`); default `p<position>`.
   * A correction may carry only the pages it replaces: a page keeps its key
   * across the correction chain, so a host can show "page 2: v1, v2".
   */
  pageKey?: string;
}
export interface SubmissionAssetClaim {
  enrollmentId: string;
  tenantId: string;
  actorUserId: string;
  learnerId: string;
  submissionId: string;
  assetId: string;
  expiresAt: Date;
}
/** Immutable external receipt binding for a scan; supplied only by a trusted host. */
export interface SubmissionIntake {
  intakeItemId: string;
  kind: SubmissionKind;
  previousSubmissionId?: string;
}
/** Server configuration; never populate this from request JSON. */
export interface SubmissionServiceOptions {
  storage: AssetRuntimeOptions['storage'];
  storeOptions?: AssetRuntimeOptions['storeOptions'];
  /** Sign a short-lived route claim. Its serving endpoint must verify every claim. */
  signAsset?: (claim: Readonly<SubmissionAssetClaim>) => Promise<string>;
  /**
   * Lesson kinds a learner may self-report with `attestOwnLesson`: a list of
   * kind names, or `'*'` for every kind. Defaults to
   * `SELF_ATTESTABLE_LESSON_KINDS` (Reading, Video).
   */
  selfAttestableKinds?: '*' | ReadonlyArray<string>;
}
export type SubmissionView = Readonly<{
  id: string;
  learnerId: string;
  lessonId: string;
  progressId: string;
  status: Submission['status'];
  submittedAt: Date;
  notes: string;
  kind: SubmissionKind;
  previousSubmissionId: string | null;
  intakeItemId: string | null;
  pages: ReadonlyArray<{ assetId: string; sortOrder: number; pageKey: string }>;
  /** Guardian-origin photo work remains private until explicit feedback release. */
  awaitingParentRelease?: boolean;
  /** Effective source privacy: every derived revision needs explicit release. */
  sourceRequiresParentRelease?: boolean;
  /**
   * True for a learner's own attestation (`attestOwnLesson`). A guardian
   * grade on it means the guardian confirmed it; without one it is only the
   * learner's statement and must not be read as completion.
   */
  selfReported?: boolean;
  grade: null | {
    id: string;
    graderKind: Grade['graderKind'];
    score: number | null;
    feedback: string;
  };
}>;
/** Lesson kinds a learner may attest on their own: nothing to photograph. */
export const SELF_ATTESTABLE_LESSON_KINDS: ReadonlyArray<string> =
  Object.freeze(['Reading', 'Video']);

/** `attestOwnLesson` was asked for a lesson kind the host does not allow (default Reading or Video). */
export class OwnAttestationLessonKindError extends LearnerValidationError {
  constructor(readonly kind: string) {
    super(`A ${kind} lesson cannot be self-attested`);
    this.name = 'OwnAttestationLessonKindError';
  }
}

/** `attestOwnLesson` refused because the lesson already has other evidence or is finished. */
export class OwnAttestationConflictError extends LearnerValidationError {
  constructor(readonly status: string) {
    super(`A ${status} lesson cannot be self-attested`);
    this.name = 'OwnAttestationConflictError';
  }
}

type LessonRequest = LearnerRequest & {
  enrollmentId: string;
  lessonId: string;
};
type SubmissionRequest = LearnerRequest & {
  enrollmentId: string;
  submissionId: string;
};

type CaptureRequest = LessonRequest & {
  requestKey: string;
  pages: readonly SubmissionPage[];
  notes?: string;
  intake?: SubmissionIntake;
};

/**
 * Book and loose-page work is captured only through `LessonWorkService`, which
 * owns its receipt, correction-identity and release checks.
 */
export class LessonWorkWorkflowRequiredError extends Error {
  constructor() {
    super('Lesson work workflow required');
    this.name = 'LessonWorkWorkflowRequiredError';
  }
}

/** An external video reference is not an allowlisted YouTube id or URL. */
export class ExternalVideoReferenceError extends LearnerValidationError {
  constructor() {
    super('Videos must be a YouTube video id or youtube.com / youtu.be link');
    this.name = 'ExternalVideoReferenceError';
  }
}

/** Lesson file roles `signLessonPrintable` signs for printing. */
const PRINTABLE_RELATIONSHIPS = [
  'printable',
  'handout',
  'learner-pages',
] as const satisfies readonly LessonAssetRelationship[];

/** One material as a learner or guardian may see it. */
export type LessonMaterialView = Readonly<{
  id: string;
  kind: 'file' | 'external-video';
  scope: 'lesson' | 'course';
  relationship: LessonAssetRelationship;
  audience: MaterialAudience;
  title: string;
  /** Sort order for files, step order for videos. */
  order: number;
  /** Files only; sign with `signLessonMaterial` / `signCourseMaterial`. */
  assetId: string | null;
  provider: ExternalVideoProvider | null;
  videoId: string | null;
  /** Privacy-enhanced embed URL for an external video. */
  embedUrl: string | null;
  /** Files only: the stored asset's MIME type, null when the host recorded none. */
  mimeType: string | null;
  /**
   * Files only: `original` (the editable Word/PowerPoint file, guardian-only),
   * `rendered` (the PDF rendered from an original), or null for a file as supplied.
   */
  rendition: MaterialRendition | null;
  /** The other half of an original/rendered pair when this actor may see it. */
  pairedMaterialId: string | null;
  /**
   * Files only: a first-page image recorded by the rendering step, null when
   * none was (no converter, or it drew none). Sign with `thumbnail: true`.
   */
  thumbnailAssetId: string | null;
}>;

/** What a lesson step asks of the learner (SMRT #4656). */
export type LessonStepKind = 'present' | 'watch' | 'do' | 'check';

/** One step of a lesson, in order, with the materials it carries. */
export type LessonStepView = Readonly<{
  /** The bundle's step key (a step code such as `6` or `1b`, or `launch`). */
  key: string;
  /** The step's readable label; the key when the bundle gave none. */
  label: string;
  /** `present` slides, `watch` an external video, `check` an assessment, else `do`. */
  kind: LessonStepKind;
  /** Position in the lesson; fractions order `1b` after `1`. */
  order: number;
  /** Every visible material of the step, files then videos, original and rendered halves together. */
  materials: LessonMaterialView[];
}>;

/** A lesson walked in order: what to prepare, then the steps. */
export type LessonStepsView = Readonly<{
  /** Printed or prepared before the lesson: stepless handouts, learner pages and printables. */
  setup: LessonMaterialView[];
  /** Ordered by step order then key; empty when the lesson declares no steps. */
  steps: LessonStepView[];
}>;

type FileRow = Record<string, unknown>;
type StepInfo = { key: string; order: number; label: string };
const stepOfRow = (row: FileRow, orderField: string): StepInfo | null =>
  row.step_key
    ? {
        key: String(row.step_key),
        order: Number(row[orderField]) || 0,
        label: row.step_label ? String(row.step_label) : '',
      }
    : null;
/** Relationships prepared or printed before a lesson when they belong to no step. */
const SETUP_RELATIONSHIPS: ReadonlySet<LessonAssetRelationship> = new Set([
  'printable',
  'handout',
  'learner-pages',
]);
/** Pair visible originals with their renderings (same role, `rendition_of_asset_id`). */
function pairRenditions(rows: FileRow[], views: LessonMaterialView[]) {
  const out = views.map((v) => ({ ...v })) as Array<{
    -readonly [K in keyof LessonMaterialView]: LessonMaterialView[K];
  }>;
  rows.forEach((row, i) => {
    const of = row.rendition_of_asset_id;
    if (row.rendition !== 'rendered' || !of) return;
    const j = rows.findIndex(
      (r) =>
        r.rendition === 'original' &&
        r.asset_id === of &&
        r.relationship === row.relationship,
    );
    const a = out[i];
    const b = out[j];
    if (j < 0 || !a || !b) return;
    a.pairedMaterialId = b.id;
    b.pairedMaterialId = a.id;
  });
  return out as LessonMaterialView[];
}

/** The page key a file carries: its own, or `p<position>` for older rows. */
export function submissionPageKey(pageKey: string, sortOrder: number): string {
  return pageKey || `p${sortOrder + 1}`;
}

/** Failure includes fresh asset identities only, for explicit storage reconciliation. */
export class SubmissionStorageCleanupError extends Error {
  constructor(
    public readonly assetIds: readonly string[],
    cause: unknown,
  ) {
    super(
      `Submission rollback could not remove fresh assets: ${assetIds.join(', ')}`,
      { cause },
    );
    this.name = 'SubmissionStorageCleanupError';
  }
}

/** Actor-bound capture, private packets, and authoritative guardian review. */
export class SubmissionService extends LearnerService {
  private resources: Array<{ runtime: AssetRuntime; asset: Asset }> = [];
  private runtime: Promise<AssetRuntime> | undefined;
  constructor(
    db: DatabaseInterface,
    authorize: LearnerAuthorizer,
    authorizeCatalog: CatalogAuthorizer,
    private readonly options: SubmissionServiceOptions,
  ) {
    super(db, authorize, authorizeCatalog);
  }
  protected override createTransactionService(db: DatabaseInterface): this {
    return new SubmissionService(
      db,
      this.authorize,
      this.authorizeCatalog,
      this.options,
    ) as this;
  }
  protected override async rollbackResources(
    cause: unknown,
    rootDb: DatabaseInterface,
  ): Promise<void> {
    const failures: string[] = [];
    for (const { runtime, asset } of this.resources.reverse()) {
      try {
        // A commit error can have an uncertain outcome. Never remove bytes if
        // their owner committed, or if the root database cannot confirm absence.
        if (await rootDb.get('assets', { id: asset.id })) continue;
        await runtime.store.removeFile(asset);
      } catch {
        failures.push(String(asset.id));
      }
    }
    this.resources = [];
    if (failures.length)
      throw new SubmissionStorageCleanupError(failures, cause);
  }
  protected assets(): Promise<AssetRuntime> {
    this.runtime ??= createAssetRuntime({
      db: this.db,
      storage: this.options.storage,
      storeOptions: this.options.storeOptions,
    });
    return this.runtime;
  }
  protected async storePage(
    request: Pick<LearnerRequest, 'tenantId' | 'actorUserId'>,
    profileId: string,
    page: SubmissionPage,
  ): Promise<Asset> {
    const runtime = await this.assets();
    const id = globalThis.crypto.randomUUID();
    return withPrivateAssetAccess(
      {
        tenantId: request.tenantId,
        actorUserId: request.actorUserId,
        ownerProfileId: profileId,
        assetIds: [id],
      },
      async () => {
        const asset = await runtime.collection.create({
          id,
          accessMode: 'private',
          name: page.name,
          tenantId: request.tenantId,
          ownerProfileId: profileId,
          mimeType: page.mimeType,
          typeSlug: 'education-page',
          statusSlug: 'active',
        });
        const options = { mimeType: page.mimeType, typeSlug: 'education-page' };
        asset.sourceUri = await runtime.store.planFile(asset, options);
        const extension = {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'application/pdf': 'pdf',
        }[page.mimeType];
        // A configured resolver may select a provider/directory, but cannot adopt a
        // shared locator into this fresh-file compensation ledger.
        if (
          new URL(asset.sourceUri).pathname.split('/').at(-1) !==
          `${asset.id}.${extension}`
        )
          throw new Error(
            'Storage resolver must preserve the fresh asset filename',
          );
        await asset.save();
        // Ledger before write: a provider may write bytes and then reject.
        this.resources.push({ runtime, asset });
        await runtime.store.preserveFile(asset, page.data, options);
        return asset;
      },
    );
  }
  protected validatePages(pages: readonly SubmissionPage[]): void {
    if (!Array.isArray(pages) || !pages.length || pages.length > 100)
      throw new Error('Capture requires one to 100 pages');
    for (const page of pages) {
      if (
        !page ||
        typeof page.name !== 'string' ||
        !page.name.trim() ||
        !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(
          page.mimeType,
        ) ||
        !Buffer.isBuffer(page.data) ||
        !page.data.length ||
        page.data.length > 25 * 1024 * 1024
      )
        throw new Error('Invalid capture page');
    }
    const keys = pages.map((page, i) =>
      page.pageKey === undefined ? `p${i + 1}` : page.pageKey,
    );
    if (
      keys.some((key) => !validLessonPageKey(key)) ||
      new Set(keys).size !== keys.length
    )
      throw new Error('Capture page keys must be distinct page keys');
  }
  private async lockProgressOwner(
    request: LearnerRequest & { enrollmentId: string },
  ): Promise<void> {
    // Match LessonWorkService's lock order so generic guardian grading cannot race
    // capture or an explicit completion decision on the same learner.
    if (
      await this.findLessonActivity(request, {
        enrollmentId: request.enrollmentId,
      })
    )
      await this.db.query(
        'UPDATE learners SET id = id WHERE id = ? AND tenant_id = ?',
        [request.learnerId, request.tenantId],
      );
    await this.lock('enrollments', request.enrollmentId, request.tenantId);
  }
  private async progress(
    request: LessonRequest,
    action: Parameters<LearnerAuthorizer>[0]['action'],
  ) {
    const enrollment = await this.requireEnrollment(request, action);
    await this.lockProgressOwner(request);
    if (!(await this.lessonInScope(request, enrollment, request.lessonId)))
      throw new LearnerAuthorizationError();
    const collection = await LessonProgressCollection.create({ db: this.db });
    let progress = await collection.get(
      {
        enrollmentId: request.enrollmentId,
        lessonId: request.lessonId,
        tenantId: request.tenantId,
      },
      { cache: false },
    );
    if (progress && progress.learnerId !== request.learnerId)
      throw new LearnerAuthorizationError();
    progress ??= await collection.create({
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      enrollmentId: request.enrollmentId,
      lessonId: request.lessonId,
      status: 'in_progress',
      startedAt: new Date(),
      _insertOnly: true,
    });
    return progress;
  }
  private async requireSubmission(
    request: SubmissionRequest,
    action: Parameters<LearnerAuthorizer>[0]['action'],
  ) {
    const enrollment = await this.requireEnrollment(request, action);
    const row = await (await SubmissionCollection.create({ db: this.db })).get(
      {
        id: request.submissionId,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
      },
      { cache: false },
    );
    if (!row) throw new LearnerAuthorizationError();
    const progress = await (
      await LessonProgressCollection.create({ db: this.db })
    ).get(
      {
        id: row.progressId,
        enrollmentId: enrollment.id,
        learnerId: request.learnerId,
        lessonId: row.lessonId,
        tenantId: request.tenantId,
      },
      { cache: false },
    );
    if (
      !progress ||
      !(await this.lessonInScope(request, enrollment, row.lessonId))
    )
      throw new LearnerAuthorizationError();
    return { row, progress };
  }
  /** Persisted origin/release evidence, shared by base submission and workbook
   * projections. Call only after normal actor/resource authorization. Old hosts
   * without photo tables preserve ordinary submission behavior. */
  protected async workbookPhotoSource(
    request: Pick<LearnerRequest, 'tenantId' | 'learnerId'>,
    selector: { intakeItemId?: string | null; submissionId?: string },
  ): Promise<{ guardianOrigin: boolean; released: boolean }> {
    const ordinary = { guardianOrigin: false, released: false };
    if (!(await this.db.tableExists('workbook_photo_intakes'))) return ordinary;
    let submission = selector.submissionId
      ? await this.db.get('submissions', {
          id: selector.submissionId,
          tenant_id: request.tenantId,
          learner_id: request.learnerId,
        })
      : null;
    const itemId = selector.intakeItemId ?? submission?.intake_item_id;
    if (!itemId) return ordinary;
    if (submission && submission.intake_item_id !== itemId)
      throw new LearnerAuthorizationError();
    const photo = await this.db.get('workbook_photo_intakes', {
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
      item_id: itemId,
    });
    if (!photo) return ordinary;
    const learner = await this.db.get('learners', {
      id: request.learnerId,
      tenant_id: request.tenantId,
    });
    if (!learner) throw new LearnerAuthorizationError();
    if (photo.actor_user_id === learner.user_id) return ordinary;
    const withheld = { guardianOrigin: true, released: false };
    submission ??= await this.db.get('submissions', {
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
      intake_item_id: itemId,
    });
    if (
      !submission ||
      !(await this.db.tableExists('workbook_attempts')) ||
      !(await this.db.tableExists('workbook_feedback_releases'))
    )
      return withheld;
    const attempt = await this.db.get('workbook_attempts', {
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
      submission_id: submission.id,
    });
    if (!attempt) return withheld;
    const release = await this.db.get('workbook_feedback_releases', {
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
      attempt_id: attempt.id,
    });
    return { guardianOrigin: true, released: !!release };
  }
  /**
   * A submission's learner-owned page files and whether they are withheld
   * from this actor (guardian-origin source awaiting release). The caller has
   * already authorized the submission's learner and enrollment.
   */
  protected async submissionPages(
    row: Submission,
    actorUserId: string,
    // Pages only: skip the source-origin lookup when the actor is not the
    // learner, since only the learner's own view is ever redacted.
    pagesOnly = false,
  ): Promise<{
    pages: Array<{ assetId: string; sortOrder: number; pageKey: string }>;
    awaitingParentRelease: boolean;
    guardianOrigin: boolean;
    learnerUserId: string;
  }> {
    const links = await (
      await SubmissionAssetCollection.create({ db: this.db })
    ).list({
      where: { submissionId: String(row.id), tenantId: row.tenantId },
      orderBy: 'sortOrder',
    });
    const learner = await this.db.get('learners', {
      id: row.learnerId,
      tenant_id: row.tenantId,
    });
    if (!learner) throw new LearnerAuthorizationError();
    const pages: Array<{
      assetId: string;
      sortOrder: number;
      pageKey: string;
    }> = [];
    for (const link of links) {
      if (
        await this.db.get('assets', {
          id: link.assetId,
          tenant_id: row.tenantId,
          owner_profile_id: learner.profile_id,
        })
      )
        pages.push({
          assetId: link.assetId,
          sortOrder: link.sortOrder,
          pageKey: submissionPageKey(link.pageKey, link.sortOrder),
        });
    }
    const photo =
      pagesOnly && learner.user_id !== actorUserId
        ? { guardianOrigin: false, released: false }
        : await this.workbookPhotoSource(
            { tenantId: row.tenantId, learnerId: row.learnerId },
            { intakeItemId: row.intakeItemId, submissionId: String(row.id) },
          );
    const awaitingParentRelease =
      learner.user_id === actorUserId &&
      photo.guardianOrigin &&
      !photo.released;
    return {
      pages: awaitingParentRelease ? [] : pages,
      awaitingParentRelease,
      guardianOrigin: photo.guardianOrigin,
      learnerUserId: String(learner.user_id ?? ''),
    };
  }
  private async view(
    row: Submission,
    actorUserId: string,
  ): Promise<SubmissionView> {
    const projected = await this.submissionPages(row, actorUserId);
    const pages = projected.pages;
    const learner = { user_id: projected.learnerUserId };
    const grades = await (await GradeCollection.create({ db: this.db })).list({
      where: { submissionId: String(row.id), tenantId: row.tenantId },
    });
    // Guardian review wins over every proposal, irrespective of insertion order.
    grades.sort(
      (a, b) =>
        Number(b.graderKind === 'guardian') -
          Number(a.graderKind === 'guardian') ||
        new Date(b.gradedAt).getTime() - new Date(a.gradedAt).getTime() ||
        String(b.id).localeCompare(String(a.id)),
    );
    const grade = grades[0];
    const photo = { guardianOrigin: projected.guardianOrigin };
    const awaitingParentRelease = projected.awaitingParentRelease;
    // Book and loose-page work deliver feedback only through release;
    // ordinary lesson grades remain the learner's feedback.
    const activity = await this.findLessonActivity(
      { tenantId: row.tenantId, learnerId: row.learnerId, actorUserId },
      { lessonId: row.lessonId },
    );
    const withheld =
      learner.user_id === actorUserId &&
      Boolean(activity && (await this.isReleaseGatedWork(activity)));
    const selfReported =
      (await this.db.tableExists('lesson_self_attestations')) &&
      Boolean(
        await this.db.get('lesson_self_attestations', {
          tenant_id: row.tenantId,
          submission_id: String(row.id),
        }),
      );
    return {
      id: String(row.id),
      learnerId: row.learnerId,
      lessonId: row.lessonId,
      progressId: row.progressId,
      status:
        awaitingParentRelease || (withheld && row.status === 'graded')
          ? 'captured'
          : row.status,
      submittedAt: row.submittedAt,
      notes: awaitingParentRelease ? '' : row.notes,
      kind: row.kind,
      previousSubmissionId: row.previousSubmissionId,
      intakeItemId: row.intakeItemId,
      pages: awaitingParentRelease ? [] : pages,
      ...(awaitingParentRelease ? { awaitingParentRelease: true } : {}),
      ...(photo.guardianOrigin ? { sourceRequiresParentRelease: true } : {}),
      ...(selfReported ? { selfReported: true } : {}),
      grade:
        grade && !withheld && !awaitingParentRelease
          ? {
              id: String(grade.id),
              graderKind: grade.graderKind,
              score: grade.score,
              feedback: grade.feedback,
            }
          : null,
    };
  }
  /** Recheck the exact assignment without creating progress or accepting bytes.
   * Trusted intake bridges call this before reading retained evidence.
   */
  async assertLessonAssignment(request: LessonRequest): Promise<void> {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.submit',
    );
    if (!(await this.lessonInScope(request, enrollment, request.lessonId)))
      throw new LearnerAuthorizationError();
  }

  /**
   * Refuse generic upload entry points for book and loose-page work, using
   * the authoritative enrollment, lesson and predecessor. Hosts call this
   * before creating a generic intake receipt.
   */
  async assertOrdinarySubmissionScope(
    request: LearnerRequest & {
      enrollmentId: string;
      lessonId?: string;
      previousSubmissionId?: string;
    },
  ): Promise<void> {
    await this.requireEnrollment(request, 'education.learner.read');
    if (
      await this.isReleaseGatedEnrollment(
        request.tenantId,
        request.enrollmentId,
      )
    )
      throw new LessonWorkWorkflowRequiredError();
    let lessonId = request.lessonId;
    if (request.previousSubmissionId) {
      const previous = await (
        await SubmissionCollection.create({ db: this.db })
      ).get(
        {
          id: request.previousSubmissionId,
          tenantId: request.tenantId,
          learnerId: request.learnerId,
        },
        { cache: false },
      );
      if (previous) lessonId = previous.lessonId;
    }
    if (!lessonId) return;
    const activity = await this.findLessonActivity(request, {
      enrollmentId: request.enrollmentId,
      lessonId,
    });
    if (activity && (await this.isReleaseGatedWork(activity)))
      throw new LessonWorkWorkflowRequiredError();
  }

  async captureSubmission(request: CaptureRequest): Promise<SubmissionView> {
    return this.captureSubmissionInScope(request);
  }

  /** Owning workflow extension; no browser input can grant this scoped path. */
  protected async captureActivitySubmission(
    request: CaptureRequest,
    scope: { activityId: string; assistance: WorkAssistance },
  ): Promise<SubmissionView> {
    return this.captureSubmissionInScope(request, scope);
  }

  private async captureSubmissionInScope(
    request: CaptureRequest,
    scope?: { activityId: string; assistance: WorkAssistance },
  ): Promise<SubmissionView> {
    return this.mutate(async (service) => {
      await service.requireEnrollment(request, 'education.learner.submit');
      // One pipeline: every hand-in belongs to the learner's activity on
      // this lesson. Unfiled photo routing is reachable only by its receipt.
      const activity = await service.findLessonActivity(request, {
        enrollmentId: request.enrollmentId,
        lessonId: request.lessonId,
      });
      if (scope) {
        if (!activity || String(activity.id) !== scope.activityId)
          throw new LearnerAuthorizationError();
      } else if (
        (activity && (await service.isReleaseGatedWork(activity))) ||
        // Gate on the course too: a book page with no activity yet is book work.
        (await service.isReleaseGatedEnrollment(
          request.tenantId,
          request.enrollmentId,
        ))
      )
        throw new LessonWorkWorkflowRequiredError();
      service.validatePages(request.pages);
      if (request.notes !== undefined && typeof request.notes !== 'string')
        throw new Error('Notes must be text');
      if (
        request.intake &&
        (!request.intake.intakeItemId?.trim() ||
          !['blank_reference', 'completed_work'].includes(request.intake.kind))
      )
        throw new Error('Invalid submission intake binding');
      if (
        typeof request.requestKey !== 'string' ||
        !request.requestKey.trim() ||
        request.requestKey.length > 200
      )
        throw new Error('Capture requestKey is required');
      const progress = await service.progress(
        request,
        'education.learner.submit',
      );
      const kind = request.intake?.kind ?? 'completed_work';
      const crypto =
        typeof process !== 'undefined' &&
        process.getBuiltinModule?.('node:crypto');
      if (!crypto) throw new Error('Submission capture requires a Node server');
      const digest = crypto.createHash('sha256');
      for (const page of request.pages)
        digest
          .update(JSON.stringify([page.name, page.mimeType, page.data.length]))
          .update(page.data);
      digest.update(JSON.stringify(request.notes ?? ''));
      digest.update(JSON.stringify(request.intake ?? null));
      const captureDigest = digest.digest('hex');
      const submissions = await ScannedSubmissionCollection.create({
        db: service.db,
      });
      const intakeRequest = request.intake;
      if (intakeRequest) {
        const bindings = await SubmissionIntakeBindingCollection.create({
          db: service.db,
        });
        const binding = await bindings.get(
          {
            tenantId: request.tenantId,
            intakeItemId: intakeRequest.intakeItemId,
          },
          { cache: false },
        );
        const intake = binding
          ? await submissions.get(
              { id: binding.submissionId, tenantId: request.tenantId },
              { cache: false },
            )
          : await (async () => {
              const legacy = await submissions.list({
                where: {
                  tenantId: request.tenantId,
                  intakeItemId: intakeRequest.intakeItemId,
                },
                limit: 2,
              });
              if (legacy.length > 1)
                throw new Error('Legacy intake item has ambiguous submissions');
              return legacy[0];
            })();
        if (binding && !intake)
          throw new Error('Submission intake binding is corrupt');
        if (intake) {
          // Backfill a legacy pre-binding receipt atomically before returning
          // it. A conflicting winner fails closed instead of rebinding it.
          if (!binding)
            await bindings.create({
              tenantId: request.tenantId,
              intakeItemId: intakeRequest.intakeItemId,
              submissionId: String(intake.id),
              _insertOnly: true,
            });
          if (
            intake.kind !== kind ||
            intake.progressId !== String(progress.id) ||
            intake.learnerId !== request.learnerId ||
            intake.lessonId !== request.lessonId ||
            intake.previousSubmissionId !==
              (intakeRequest.previousSubmissionId ?? null)
          )
            throw new Error(
              'Intake item is already bound to another assignment',
            );
          if (intake.captureDigest !== captureDigest)
            throw new Error('Capture retry changed its content');
          return service.view(intake, request.actorUserId);
        }
      }
      if (request.intake?.previousSubmissionId) {
        const predecessor = await (
          await SubmissionCollection.create({ db: service.db })
        ).get(
          {
            id: request.intake.previousSubmissionId,
            tenantId: request.tenantId,
            progressId: String(progress.id),
            learnerId: request.learnerId,
            lessonId: request.lessonId,
          },
          { cache: false },
        );
        if (predecessor?.kind !== 'completed_work')
          throw new Error(
            'Submission predecessor is not current progress evidence',
          );
        const successors = await (
          await SubmissionCollection.create({ db: service.db })
        ).list({
          where: {
            tenantId: request.tenantId,
            previousSubmissionId: String(predecessor.id),
          },
        });
        if (successors.length)
          throw new Error('Submission predecessor is stale');
      }
      const prior = await submissions.get(
        {
          progressId: String(progress.id),
          tenantId: request.tenantId,
          captureKey: request.requestKey,
        },
        { cache: false },
      );
      if (prior) {
        if (
          prior.captureDigest !== captureDigest ||
          prior.learnerId !== request.learnerId ||
          prior.lessonId !== request.lessonId
        )
          throw new Error('Capture retry changed its content');
        return service.view(prior, request.actorUserId);
      }
      if (
        kind === 'completed_work' &&
        !request.intake?.previousSubmissionId &&
        ['submitted', 'needs_review', 'complete', 'skipped'].includes(
          progress.status,
        )
      )
        throw new Error('Progress is not accepting another capture');
      const learner = await service.getLearner(request);
      const row = await submissions.create({
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        lessonId: request.lessonId,
        progressId: String(progress.id),
        pageCount: request.pages.length,
        notes: request.notes ?? '',
        captureKey: request.requestKey,
        captureDigest,
        kind,
        previousSubmissionId: request.intake?.previousSubmissionId ?? null,
        intakeItemId: request.intake?.intakeItemId ?? null,
      });
      if (request.intake) {
        // INSERT-only lets the database arbitrate concurrent captures across
        // different enrollments. The transaction rolls this attempt back on a
        // collision, so no pages or progress mutations escape.
        await (
          await SubmissionIntakeBindingCollection.create({ db: service.db })
        ).create({
          tenantId: request.tenantId,
          intakeItemId: request.intake.intakeItemId,
          submissionId: String(row.id),
          _insertOnly: true,
        });
      }
      const links = await SubmissionAssetCollection.create({ db: service.db });
      const assetIds: string[] = [];
      for (const [sortOrder, page] of request.pages.entries()) {
        const asset = await service.storePage(request, learner.profileId, page);
        assetIds.push(String(asset.id));
        await links.create({
          tenantId: request.tenantId,
          submissionId: String(row.id),
          assetId: String(asset.id),
          relationship: 'page',
          sortOrder,
          pageKey: page.pageKey ?? `p${sortOrder + 1}`,
        });
      }
      if (kind === 'completed_work') {
        progress.status = 'submitted';
        progress.attempts += 1;
        await progress.save();
        await service.recordAttempt(request, row, request.pages, assetIds, {
          activity,
          assistance: scope?.assistance ?? 'unknown',
        });
      }
      return service.view(row, request.actorUserId);
    });
  }
  /** Capture a blank workbook scan without claiming completion or a grade. */
  async captureBlankReference(
    request: LessonRequest & {
      requestKey: string;
      pages: readonly SubmissionPage[];
      notes?: string;
      intakeItemId: string;
    },
  ): Promise<SubmissionView> {
    return this.captureSubmission({
      ...request,
      intake: { intakeItemId: request.intakeItemId, kind: 'blank_reference' },
    });
  }
  /** Rescan corrections as a new immutable completed-work attempt. */
  async resubmitSubmission(
    request: LessonRequest & {
      previousSubmissionId: string;
      requestKey: string;
      pages: readonly SubmissionPage[];
      notes?: string;
      intakeItemId: string;
    },
  ): Promise<SubmissionView> {
    return this.captureSubmission({
      ...request,
      intake: {
        intakeItemId: request.intakeItemId,
        kind: 'completed_work',
        previousSubmissionId: request.previousSubmissionId,
      },
    });
  }
  async getSubmission(request: SubmissionRequest): Promise<SubmissionView> {
    return this.view(
      (await this.requireSubmission(request, 'education.learner.read')).row,
      request.actorUserId,
    );
  }
  /** Latest retained completed-work evidence; lesson completion is independent. */
  async getLatestLessonSubmission(
    request: LessonRequest,
  ): Promise<SubmissionView | null> {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.read',
    );
    if (!(await this.lessonInScope(request, enrollment, request.lessonId)))
      throw new LearnerAuthorizationError();
    const progress = await (
      await LessonProgressCollection.create({ db: this.db })
    ).get(
      {
        enrollmentId: request.enrollmentId,
        learnerId: request.learnerId,
        lessonId: request.lessonId,
        tenantId: request.tenantId,
      },
      { cache: false },
    );
    if (!progress) return null;
    const [row] = await (
      await SubmissionCollection.create({ db: this.db })
    ).list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        lessonId: request.lessonId,
        progressId: String(progress.id),
        kind: 'completed_work',
        'status in': ['captured', 'needs_review', 'graded'],
      },
      orderBy: ['submittedAt DESC', 'id DESC'],
      limit: 1,
    });
    return row
      ? this.getSubmission({ ...request, submissionId: String(row.id) })
      : null;
  }
  /** The course work policy a new attempt snapshots (its enrollment's course). */
  protected async workPolicy(
    activity: LessonActivity,
  ): Promise<{ reviewRequired: boolean; policyVersion: number }> {
    const enrollment = await this.db.get('enrollments', {
      id: activity.enrollmentId,
      tenant_id: activity.tenantId,
    });
    const course =
      enrollment &&
      (await this.db.get('courses', { id: enrollment.course_id }));
    return {
      reviewRequired: ![false, 0, '0', 'f', 'false'].includes(
        course?.work_review_required as never,
      ),
      policyVersion: Number(course?.work_policy_version ?? 1) || 1,
    };
  }
  /**
   * Record a completed-work hand-in in the lesson work pipeline: the learner's
   * activity on this lesson (created on first capture) and one immutable
   * attempt bound to the submission, continuing its predecessor's episode.
   */
  protected async recordAttempt(
    request: LessonRequest,
    row: Submission,
    pages: readonly SubmissionPage[],
    assetIds: readonly string[],
    scope: { activity: LessonActivity | null; assistance: WorkAssistance },
  ): Promise<void> {
    if (!['independent', 'assisted', 'unknown'].includes(scope.assistance))
      throw new Error('Invalid assistance');
    for (const table of ['workbook_activities', 'workbook_attempts'])
      if (!(await this.db.tableExists(table)))
        throw new LearnerHistoryUnavailableError(table);
    const activities = await LessonActivityCollection.create({ db: this.db });
    const activity =
      scope.activity ??
      (await activities.create({
        _insertOnly: true,
        slug: `lesson-activity-${String(row.progressId)}`,
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        enrollmentId: request.enrollmentId,
        lessonId: request.lessonId,
      }));
    const attempts = await WorkAttemptCollection.create({ db: this.db });
    const previous = row.previousSubmissionId
      ? await attempts.get(
          {
            tenantId: request.tenantId,
            learnerId: request.learnerId,
            submissionId: row.previousSubmissionId,
          },
          { cache: false },
        )
      : null;
    if (previous && previous.activityId !== String(activity.id))
      throw new Error('Lesson work correction identity mismatch');
    const crypto = process.getBuiltinModule?.('node:crypto');
    if (!crypto) throw new Error('Lesson work capture requires a Node server');
    const sourceHashes = [];
    for (const [i, page] of pages.entries())
      sourceHashes.push({
        assetId: assetIds[i],
        sha256: crypto.createHash('sha256').update(page.data).digest('hex'),
        pageCount:
          page.mimeType === 'application/pdf'
            ? (await PDFDocument.load(page.data)).getPageCount()
            : 1,
      });
    const policy = await this.workPolicy(activity);
    const id = globalThis.crypto.randomUUID();
    const prior = await attempts.list({
      where: {
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        activityId: String(activity.id),
      },
    });
    await attempts.create({
      _insertOnly: true,
      id,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      activityId: String(activity.id),
      submissionId: String(row.id),
      previousAttemptId: previous ? String(previous.id) : null,
      episodeId: previous?.episodeId ?? id,
      reviewRequired: policy.reviewRequired,
      policyVersion: policy.policyVersion,
      assistance: scope.assistance,
      actorUserId: request.actorUserId,
      // Independent practice episodes have no predecessor edge. Preserve their
      // capture order even when the server clock ties or moves backwards.
      capturedAt: new Date(
        Math.max(
          new Date(row.submittedAt).getTime(),
          ...prior.map((p) => new Date(p.capturedAt).getTime() + 1),
        ),
      ),
      sourceHashes: JSON.stringify(sourceHashes),
    });
  }
  /** A guardian grade on an ordinary lesson's current attempt completes it. */
  private async recordGradeCompletion(
    request: LearnerRequest,
    activity: LessonActivity,
    row: Submission,
  ): Promise<void> {
    const state = await readWorkCompletion(this.db, {
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      activityId: String(activity.id),
    });
    if (state.currentAttempt?.submissionId !== String(row.id) || state.decision)
      return;
    await (
      await WorkCompletionDecisionCollection.create({ db: this.db })
    ).create({
      _insertOnly: true,
      tenantId: request.tenantId,
      learnerId: request.learnerId,
      activityId: String(activity.id),
      attemptId: String(state.currentAttempt.id),
      submissionId: String(row.id),
      feedbackHeadId: state.feedbackHeadId,
      actorUserId: request.actorUserId,
      requestKey: `grade:${row.id}`,
    });
  }
  private async grade(
    request: LearnerRequest,
    row: Submission,
    progress: Awaited<ReturnType<SubmissionService['progress']>>,
    score: number | null,
    feedback: string,
  ) {
    if (typeof feedback !== 'string') throw new Error('Feedback must be text');
    if (
      score !== null &&
      (typeof score !== 'number' ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1)
    )
      throw new Error('Score must be null or a number from zero to one');
    const actor = await this.db.get('users', { id: request.actorUserId });
    if (!actor?.profile_id) throw new LearnerAuthorizationError();
    const grades = await GradeCollection.create({ db: this.db });
    const priorGrades = await grades.list({
      where: {
        submissionId: String(row.id),
        tenantId: request.tenantId,
        graderKind: 'guardian',
      },
    });
    const gradedAt = new Date(
      Math.max(
        Date.now(),
        ...priorGrades.map((prior) => new Date(prior.gradedAt).getTime() + 1),
      ),
    );
    await grades.create({
      tenantId: request.tenantId,
      submissionId: String(row.id),
      graderKind: 'guardian',
      graderProfileId: String(actor.profile_id),
      score,
      feedback,
      gradedAt,
    });
    row.status = 'graded';
    await row.save();
    const activity = await this.findLessonActivity(request, {
      enrollmentId: progress.enrollmentId,
      lessonId: row.lessonId,
    });
    // Ordinary lessons: the guardian's grade decides completion, recorded as
    // the pipeline's completion decision on the graded current attempt. Book
    // and loose-page work keep their explicit parent completion decision.
    if (activity && !(await this.isReleaseGatedWork(activity)))
      await this.recordGradeCompletion(request, activity, row);
    const completion =
      activity && (await this.isReleaseGatedWork(activity))
        ? await readWorkCompletion(this.db, {
            tenantId: request.tenantId,
            learnerId: request.learnerId,
            activityId: String(activity.id),
          })
        : null;
    progress.status = completion
      ? completion.completion.status === 'complete'
        ? 'complete'
        : 'in_progress'
      : 'complete';
    progress.completedAt = completion
      ? completion.completion.completedAt
      : new Date();
    // The authoritative guardian score supersedes any automated proposal.
    progress.bestScore = score;
    await progress.save();
    return this.view(row, request.actorUserId);
  }
  async reviewSubmission(
    request: SubmissionRequest & { score?: number | null; feedback?: string },
  ): Promise<SubmissionView> {
    return this.mutate(async (service) => {
      await service.requireEnrollment(request, 'education.learner.grade');
      await service.lockProgressOwner(request);
      const { row, progress } = await service.requireSubmission(
        request,
        'education.learner.grade',
      );
      if (row.kind !== 'completed_work')
        throw new Error('Blank workbook references cannot be graded');
      const successors = await (
        await SubmissionCollection.create({ db: service.db })
      ).list({
        where: {
          tenantId: request.tenantId,
          previousSubmissionId: String(row.id),
        },
      });
      if (successors.some((successor) => successor.kind === 'completed_work'))
        throw new Error('Only the current submission attempt can be graded');
      return service.grade(
        request,
        row,
        progress,
        request.score ?? null,
        request.feedback ?? '',
      );
    });
  }
  /** Bridge-only alias: uses the same guardian authorization and current-attempt checks. */
  async applyReviewedSubmission(
    request: SubmissionRequest & { score?: number | null; feedback?: string },
  ): Promise<SubmissionView> {
    if (!this.executorBorrowed) return this.reviewSubmission(request);
    return this.reviewSubmission(request);
  }
  /** Record a non-authoritative automated proposal; it never completes progress. */
  async proposeSubmissionGrade(
    request: SubmissionRequest & { score?: number | null; feedback?: string },
  ): Promise<SubmissionView> {
    return this.mutate(async (service) => {
      const { row } = await service.requireSubmission(
        request,
        'education.learner.grade',
      );
      if (row.kind !== 'completed_work')
        throw new Error(
          'Blank workbook references cannot be proposed for grading',
        );
      const score = request.score ?? null;
      if (
        score !== null &&
        (typeof score !== 'number' ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 1)
      )
        throw new Error('Score must be null or a number from zero to one');
      if (
        request.feedback !== undefined &&
        typeof request.feedback !== 'string'
      )
        throw new Error('Feedback must be text');
      await (await GradeCollection.create({ db: service.db })).create({
        tenantId: request.tenantId,
        submissionId: String(row.id),
        graderKind: 'ai',
        score,
        feedback: request.feedback ?? '',
      });
      row.status = 'needs_review';
      await row.save();
      return service.view(row, request.actorUserId);
    });
  }
  async attestLesson(
    request: LessonRequest & { score?: number | null; feedback?: string },
  ): Promise<SubmissionView> {
    return this.mutate(async (service) => {
      const progress = await service.progress(
        request,
        'education.learner.grade',
      );
      const attestations = await AttestationCollection.create({
        db: service.db,
      });
      let row = await attestations.get(
        { progressId: String(progress.id), tenantId: request.tenantId },
        { cache: false },
      );
      row ??= await attestations.create({
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        lessonId: request.lessonId,
        progressId: String(progress.id),
      });
      return service.grade(
        request,
        row,
        progress,
        request.score ?? null,
        request.feedback ?? '',
      );
    });
  }
  /**
   * The learner's own "I read it" / "I watched it" for a Reading or Video
   * lesson, under `education.learner.attest-own` (refused for any other actor
   * before the host is asked). Writes an ungraded `Attestation` marked by a
   * `LessonSelfAttestation` with the learner as actor and the host's
   * `policyBasis`, and moves progress to `submitted` (one attempt) to await
   * guardian confirmation through `attestLesson` or `reviewSubmission`. It is
   * not a grade and never completes the lesson. A repeat returns the same
   * attestation; submitted, review, complete or skipped progress without one
   * refuses with `OwnAttestationConflictError`.
   */
  async attestOwnLesson(
    request: LessonRequest & { policyBasis: string; notes?: string },
  ): Promise<SubmissionView> {
    const policyBasis = requirePolicyBasis(request.policyBasis);
    const notes = request.notes ?? '';
    if (typeof notes !== 'string' || notes.length > 2000)
      throw new LearnerValidationError('Attestation notes must be short text');
    return this.mutate(async (service) => {
      const progress = await service.progress(
        request,
        'education.learner.attest-own',
      );
      const lesson = await (
        await LessonCollection.create({ db: service.db })
      ).get({ id: request.lessonId }, { cache: false });
      const kind = lesson?.constructor.name ?? 'unknown';
      const allowed =
        this.options.selfAttestableKinds ?? SELF_ATTESTABLE_LESSON_KINDS;
      if (allowed !== '*' && !allowed.includes(kind))
        throw new OwnAttestationLessonKindError(kind);
      if (!(await service.db.tableExists('lesson_self_attestations')))
        throw new LearnerHistoryUnavailableError('lesson_self_attestations');
      const marks = await LessonSelfAttestationCollection.create({
        db: service.db,
      });
      const prior = await marks.get(
        { tenantId: request.tenantId, progressId: String(progress.id) },
        { cache: false },
      );
      const attestations = await AttestationCollection.create({
        db: service.db,
      });
      if (prior) {
        const replay = await attestations.get(
          { id: prior.submissionId, tenantId: request.tenantId },
          { cache: false },
        );
        if (!replay) throw new LearnerAuthorizationError();
        return service.view(replay, request.actorUserId);
      }
      if (
        progress.status !== 'in_progress' &&
        progress.status !== 'not_started'
      )
        throw new OwnAttestationConflictError(progress.status);
      if (
        await attestations.get(
          { progressId: String(progress.id), tenantId: request.tenantId },
          { cache: false },
        )
      )
        throw new OwnAttestationConflictError('attested');
      const row = await attestations.create({
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        lessonId: request.lessonId,
        progressId: String(progress.id),
        notes,
        submittedAt: new Date(),
      });
      await marks.create({
        _insertOnly: true,
        tenantId: request.tenantId,
        submissionId: String(row.id),
        progressId: String(progress.id),
        learnerId: request.learnerId,
        lessonId: request.lessonId,
        actorUserId: request.actorUserId,
        policyBasis,
        recordedAt: new Date(),
      });
      progress.status = 'submitted';
      progress.startedAt ??= new Date();
      progress.attempts += 1;
      await progress.save();
      return service.view(row, request.actorUserId);
    });
  }
  async signSubmissionAsset(
    request: SubmissionRequest & { assetId: string },
  ): Promise<{ url: string; expiresAt: Date }> {
    const { row } = await this.requireSubmission(
      request,
      'education.learner.read',
    );
    const learnerRow = await this.requireActor(
      request,
      'education.learner.read',
    );
    const photo = await this.workbookPhotoSource(request, {
      intakeItemId: row.intakeItemId,
      submissionId: String(row.id),
    });
    if (
      learnerRow.userId === request.actorUserId &&
      photo.guardianOrigin &&
      !photo.released
    )
      throw new LearnerAuthorizationError();
    const link = await (
      await SubmissionAssetCollection.create({ db: this.db })
    ).get(
      {
        submissionId: String(row.id),
        assetId: request.assetId,
        tenantId: request.tenantId,
      },
      { cache: false },
    );
    const learner = await this.getLearner(request);
    const asset =
      link &&
      (await withPrivateAssetAccess(
        {
          tenantId: request.tenantId,
          actorUserId: request.actorUserId,
          ownerProfileId: learner.profileId,
          assetIds: [request.assetId],
        },
        async () =>
          (
            await this.assets()
          ).collection.get(
            {
              id: request.assetId,
              tenantId: request.tenantId,
              ownerProfileId: learner.profileId,
            },
            { cache: false },
          ),
      ));
    if (!asset) throw new LearnerAuthorizationError();
    if (!this.options.signAsset)
      throw new Error('A tenant-scoped asset signer is required');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const url = await this.options.signAsset(
      Object.freeze({
        enrollmentId: request.enrollmentId,
        tenantId: request.tenantId,
        actorUserId: request.actorUserId,
        learnerId: request.learnerId,
        submissionId: request.submissionId,
        assetId: request.assetId,
        expiresAt,
      }),
    );
    return { url, expiresAt };
  }
  /** Sign only an exact authorized printable join; answer keys never qualify. */
  /** Whether the actor is the learner themself (learner audience only). */
  private async learnerAudienceOnly(request: LearnerRequest) {
    const learner = await this.getLearner(request);
    return learner.userId === request.actorUserId;
  }
  private visibleTo(
    learnerOnly: boolean,
    relationship: string,
    audience: string,
  ): boolean {
    return (
      !learnerOnly || materialAudience(relationship, audience) === 'learner'
    );
  }
  private async materialAsset(assetId: string) {
    const asset = await this.db.get('assets', { id: assetId });
    return {
      name: String(asset?.name ?? ''),
      mimeType: asset?.mime_type ? String(asset.mime_type) : null,
    };
  }
  private async fileView(
    row: FileRow,
    scope: 'lesson' | 'course',
  ): Promise<LessonMaterialView> {
    const asset = await this.materialAsset(String(row.asset_id));
    return {
      id: String(row.id),
      kind: 'file',
      scope,
      relationship: row.relationship as LessonAssetRelationship,
      audience: materialAudience(
        String(row.relationship),
        String(row.audience ?? ''),
      ),
      // The bundle's material title (SMRT #4653); older rows fall back to the stored name.
      title: String(row.title ?? '') || asset.name,
      order: Number(row.sort_order) || 0,
      assetId: String(row.asset_id),
      provider: null,
      videoId: null,
      embedUrl: null,
      mimeType: asset.mimeType,
      rendition:
        row.rendition === 'original' || row.rendition === 'rendered'
          ? row.rendition
          : null,
      pairedMaterialId: null,
      thumbnailAssetId: row.thumbnail_asset_id
        ? String(row.thumbnail_asset_id)
        : null,
    };
  }
  /**
   * A lesson's materials for this actor: files by role and audience, then
   * external video references in step order. A learner sees only
   * learner-audience material; keys and guidance never reach them.
   */
  async listLessonMaterials(
    request: LessonRequest,
  ): Promise<LessonMaterialView[]> {
    return (await this.collectLessonMaterials(request)).map((m) => m.view);
  }
  private async collectLessonMaterials(
    request: LessonRequest,
  ): Promise<Array<{ view: LessonMaterialView; step: StepInfo | null }>> {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.read',
    );
    if (!(await this.lessonInScope(request, enrollment, request.lessonId)))
      throw new LearnerAuthorizationError();
    const lesson = await this.db.get('lessons', { id: request.lessonId });
    if (!lesson) throw new LearnerAuthorizationError();
    const tenant = lesson.tenant_id ?? null;
    const learnerOnly = await this.learnerAudienceOnly(request);
    const files = (
      await this.db.list('lesson_assets', { lesson_id: request.lessonId })
    )
      .filter(
        (row) =>
          (row.tenant_id ?? null) === tenant &&
          !row.retired_at &&
          this.visibleTo(
            learnerOnly,
            String(row.relationship),
            String(row.audience ?? ''),
          ),
      )
      .sort(
        (a, b) =>
          Number(a.sort_order) - Number(b.sort_order) ||
          String(a.id).localeCompare(String(b.id)),
      );
    const videos = (await this.db.tableExists('lesson_external_videos'))
      ? (
          await this.db.list('lesson_external_videos', {
            lesson_id: request.lessonId,
          })
        )
          .filter(
            (row) =>
              (row.tenant_id ?? null) === tenant &&
              !row.retired_at &&
              this.visibleTo(learnerOnly, 'video', String(row.audience ?? '')),
          )
          .sort(
            (a, b) =>
              Number(a.step_order) - Number(b.step_order) ||
              (Number(a.step_position ?? 0) || 0) -
                (Number(b.step_position ?? 0) || 0) ||
              String(a.id).localeCompare(String(b.id)),
          )
      : [];
    const fileViews: LessonMaterialView[] = [];
    for (const row of files) fileViews.push(await this.fileView(row, 'lesson'));
    const result = pairRenditions(files, fileViews);
    const steps: Array<StepInfo | null> = files.map((row) =>
      stepOfRow(row, 'step_order'),
    );
    for (const row of videos) {
      steps.push(stepOfRow(row, 'step_position'));
      result.push({
        id: String(row.id),
        kind: 'external-video',
        scope: 'lesson',
        relationship: 'video',
        audience: materialAudience('video', String(row.audience ?? '')),
        title: String(row.title),
        order: Number(row.step_order) || 0,
        assetId: null,
        provider: row.provider as ExternalVideoProvider,
        videoId: String(row.video_id),
        embedUrl: externalVideoEmbedUrl(
          row.provider as ExternalVideoProvider,
          String(row.video_id),
        ),
        mimeType: null,
        rendition: null,
        pairedMaterialId: null,
        thumbnailAssetId: null,
      });
    }
    return result.map((view, i) => ({ view, step: steps[i] ?? null }));
  }
  /**
   * A lesson walked in order (SMRT #4656), audience-filtered exactly like
   * `listLessonMaterials`: stepless handouts, learner pages and printables as
   * `setup`, then the declared steps. A step groups every material sharing its
   * key (the original and rendered halves of a deck stay together). A lesson
   * with no declared steps returns `steps: []`. Course-level supply lists are
   * not part of a lesson's listing and stay with `listCourseMaterials`.
   */
  async listLessonSteps(request: LessonRequest): Promise<LessonStepsView> {
    const collected = await this.collectLessonMaterials(request);
    const setup = collected
      .filter(
        (m) =>
          !m.step &&
          m.view.kind === 'file' &&
          SETUP_RELATIONSHIPS.has(m.view.relationship),
      )
      .map((m) => m.view);
    const groups = new Map<
      string,
      {
        key: string;
        order: number;
        label: string;
        materials: LessonMaterialView[];
      }
    >();
    for (const { view, step } of collected) {
      if (!step) continue;
      const group = groups.get(step.key) ?? {
        key: step.key,
        order: step.order,
        label: '',
        materials: [],
      };
      group.order = Math.min(group.order, step.order);
      group.label = group.label || step.label;
      group.materials.push(view);
      groups.set(step.key, group);
    }
    const kindOf = (materials: LessonMaterialView[]): LessonStepKind =>
      materials.some((m) => m.relationship === 'slides')
        ? 'present'
        : materials.some((m) => m.kind === 'external-video')
          ? 'watch'
          : materials.some((m) => m.relationship === 'assessment')
            ? 'check'
            : 'do';
    const steps = [...groups.values()]
      .sort(
        (a, b) =>
          a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      )
      .map(
        (g): LessonStepView => ({
          key: g.key,
          label: g.label || g.key,
          kind: kindOf(g.materials),
          order: g.order,
          materials: g.materials,
        }),
      );
    return { setup, steps };
  }
  /** Course-level materials (supply lists, posters) under the same audience rule. */
  async listCourseMaterials(
    request: LearnerRequest & { enrollmentId: string },
  ): Promise<LessonMaterialView[]> {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.read',
    );
    if (!(await this.db.tableExists('course_assets'))) return [];
    const course = await this.db.get('courses', { id: enrollment.courseId });
    if (!course) throw new LearnerAuthorizationError();
    const learnerOnly = await this.learnerAudienceOnly(request);
    const rows = (
      await this.db.list('course_assets', { course_id: enrollment.courseId })
    )
      .filter(
        (row) =>
          (row.tenant_id ?? null) === (course.tenant_id ?? null) &&
          !row.retired_at &&
          this.visibleTo(
            learnerOnly,
            String(row.relationship),
            String(row.audience ?? ''),
          ),
      )
      .sort(
        (a, b) =>
          Number(a.sort_order) - Number(b.sort_order) ||
          String(a.id).localeCompare(String(b.id)),
      );
    const views: LessonMaterialView[] = [];
    for (const row of rows) views.push(await this.fileView(row, 'course'));
    return pairRenditions(rows, views);
  }
  private async signMaterial(
    request: LearnerRequest & { enrollmentId: string },
    scope: string,
    assetId: string,
  ) {
    if (!this.options.signAsset) throw new LearnerAuthorizationError();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const url = await this.options.signAsset(
      Object.freeze({
        enrollmentId: request.enrollmentId,
        tenantId: request.tenantId,
        actorUserId: request.actorUserId,
        learnerId: request.learnerId,
        submissionId: scope,
        assetId,
        expiresAt,
      }),
    );
    return { url, expiresAt };
  }
  /**
   * Sign one lesson file the actor may see (learners: learner audience only),
   * or its recorded thumbnail with `thumbnail: true`.
   */
  async signLessonMaterial(
    request: LessonRequest & { materialId: string; thumbnail?: boolean },
  ): Promise<{ url: string; expiresAt: Date }> {
    const visible = await this.listLessonMaterials(request);
    const material = visible.find(
      (m) => m.kind === 'file' && m.id === request.materialId,
    );
    const assetId = request.thumbnail
      ? material?.thumbnailAssetId
      : material?.assetId;
    if (!assetId) throw new LearnerAuthorizationError();
    return this.signMaterial(request, `lesson:${request.lessonId}`, assetId);
  }
  /** Sign one course-level file the actor may see, or its thumbnail. */
  async signCourseMaterial(
    request: LearnerRequest & {
      enrollmentId: string;
      materialId: string;
      thumbnail?: boolean;
    },
  ): Promise<{ url: string; expiresAt: Date }> {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.read',
    );
    const visible = await this.listCourseMaterials(request);
    const material = visible.find((m) => m.id === request.materialId);
    const assetId = request.thumbnail
      ? material?.thumbnailAssetId
      : material?.assetId;
    if (!assetId) throw new LearnerAuthorizationError();
    return this.signMaterial(request, `course:${enrollment.courseId}`, assetId);
  }
  /** Re-save a family material join under the exact private-asset capability. */
  private async saveFamilyMaterial(
    request: LearnerRequest,
    assetId: string,
    save: () => Promise<unknown>,
  ) {
    const asset = await this.db.get('assets', {
      id: assetId,
      tenant_id: request.tenantId,
    });
    if (!asset) throw new LearnerAuthorizationError();
    if (!asset.owner_profile_id) return save();
    return withPrivateAssetAccess(
      {
        tenantId: request.tenantId,
        actorUserId: request.actorUserId,
        ownerProfileId: String(asset.owner_profile_id),
        assetIds: [assetId],
      },
      save,
    );
  }
  /** Family-owned, non-authored course rows only; authored material changes through authoring. */
  private async familyMaterialCourse(
    request: LearnerRequest,
    courseId: string,
  ) {
    const course = await this.db.get('courses', {
      id: courseId,
      tenant_id: request.tenantId,
    });
    if (!course) throw new LearnerAuthorizationError();
    if (['authored', 'authored-release'].includes(String(course.source_key)))
      throw new LearnerValidationError(
        'Authored course material changes through course authoring',
      );
    return course;
  }
  /**
   * Change who a family-owned material is for, within its role's bounds
   * (keys and assessment guidance stay guardian-only). Guardian planning.
   */
  async setMaterialAudience(
    request: LearnerRequest & {
      enrollmentId: string;
      scope: 'lesson' | 'course';
      kind: 'file' | 'external-video';
      materialId: string;
      audience: MaterialAudience;
    },
  ): Promise<LessonMaterialView> {
    return this.mutate(async (service) => {
      const enrollment = await service.requireEnrollment(
        request,
        'education.learner.plan',
      );
      if (await service.learnerAudienceOnly(request))
        throw new LearnerAuthorizationError();
      if (request.scope === 'course') {
        if (request.kind !== 'file') throw new LearnerAuthorizationError();
        await service.familyMaterialCourse(request, enrollment.courseId);
        const row = await (
          await CourseAssetCollection.create({ db: service.db })
        ).get(
          {
            id: request.materialId,
            tenantId: request.tenantId,
            courseId: enrollment.courseId,
          },
          { cache: false },
        );
        if (!row) throw new LearnerAuthorizationError();
        if (
          materialAudience(row.relationship, request.audience) !==
            request.audience ||
          (row.rendition === 'original' && request.audience !== 'guardian')
        )
          throw new LearnerValidationError('Invalid material audience');
        row.audience = request.audience;
        await service.saveFamilyMaterial(request, row.assetId, () =>
          row.save(),
        );
        const view = (await service.listCourseMaterials(request)).find(
          (m) => m.id === request.materialId,
        );
        if (!view) throw new LearnerAuthorizationError();
        return view;
      }
      const table =
        request.kind === 'file' ? 'lesson_assets' : 'lesson_external_videos';
      const raw = await service.db.get(table, {
        id: request.materialId,
        tenant_id: request.tenantId,
      });
      if (
        !raw ||
        !(await service.lessonInScope(
          request,
          enrollment,
          String(raw.lesson_id),
        ))
      )
        throw new LearnerAuthorizationError();
      const lesson = await service.db.get('lessons', { id: raw.lesson_id });
      const section =
        lesson &&
        (await service.db.get('course_sections', { id: lesson.section_id }));
      await service.familyMaterialCourse(request, String(section?.course_id));
      const row =
        request.kind === 'file'
          ? await (await LessonAssetCollection.create({ db: service.db })).get(
              { id: request.materialId, tenantId: request.tenantId },
              { cache: false },
            )
          : await (
              await LessonExternalVideoCollection.create({ db: service.db })
            ).get(
              { id: request.materialId, tenantId: request.tenantId },
              { cache: false },
            );
      if (!row) throw new LearnerAuthorizationError();
      const role = 'relationship' in row ? row.relationship : 'video';
      if (
        materialAudience(role, request.audience) !== request.audience ||
        // An editable original stays with the adult; its rendering is what a learner gets.
        ('rendition' in row &&
          row.rendition === 'original' &&
          request.audience !== 'guardian')
      )
        throw new LearnerValidationError('Invalid material audience');
      row.audience = request.audience;
      if ('assetId' in row)
        await service.saveFamilyMaterial(request, row.assetId, () =>
          row.save(),
        );
      else await row.save();
      const view = (
        await service.listLessonMaterials({
          ...request,
          lessonId: String(raw.lesson_id),
        })
      ).find((m) => m.id === request.materialId);
      if (!view) throw new LearnerAuthorizationError();
      return view;
    });
  }
  /**
   * Add an allowlisted external video (a YouTube id or URL) to a family-owned
   * lesson, with its title and step order. Nothing is downloaded. A replay of
   * the same video, title, step and audience returns the same reference.
   */
  async addLessonVideo(
    request: LessonRequest & {
      reference: string;
      title: string;
      stepOrder: number;
      audience?: MaterialAudience;
    },
  ): Promise<LessonMaterialView> {
    return this.mutate(async (service) => {
      const enrollment = await service.requireEnrollment(
        request,
        'education.learner.plan',
      );
      if (await service.learnerAudienceOnly(request))
        throw new LearnerAuthorizationError();
      if (!(await service.lessonInScope(request, enrollment, request.lessonId)))
        throw new LearnerAuthorizationError();
      const videoId = parseYouTubeReference(request.reference);
      if (!videoId) throw new ExternalVideoReferenceError();
      const lesson = await service.db.get('lessons', {
        id: request.lessonId,
        tenant_id: request.tenantId,
      });
      const section =
        lesson &&
        (await service.db.get('course_sections', { id: lesson.section_id }));
      if (!section) throw new LearnerAuthorizationError();
      await service.familyMaterialCourse(request, String(section.course_id));
      const audience = materialAudience('video', request.audience);
      const videos = await LessonExternalVideoCollection.create({
        db: service.db,
      });
      const existing = await videos.get(
        {
          tenantId: request.tenantId,
          lessonId: request.lessonId,
          provider: 'youtube',
          videoId,
        },
        { cache: false },
      );
      if (existing) {
        if (
          existing.title !== request.title ||
          existing.stepOrder !== request.stepOrder ||
          materialAudience('video', existing.audience) !== audience
        )
          throw new LearnerValidationError(
            'The lesson already has this video with other details',
          );
      } else
        await videos.create({
          _insertOnly: true,
          tenantId: request.tenantId,
          lessonId: request.lessonId,
          provider: 'youtube',
          videoId,
          title: request.title,
          stepOrder: request.stepOrder,
          audience,
        });
      const view = (await service.listLessonMaterials(request)).find(
        (m) => m.kind === 'external-video' && m.videoId === videoId,
      );
      if (!view) throw new LearnerAuthorizationError();
      return view;
    });
  }
  /**
   * Sign a lesson file for printing: a `printable`, `handout` or `learner-pages`
   * PDF the actor may see (learner-audience, or any for a guardian). Never an
   * editable `original` rendition and never an answer key.
   */
  async signLessonPrintable(
    request: LessonRequest & { assetId: string },
  ): Promise<{ url: string; expiresAt: Date }> {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.read',
    );
    if (!(await this.lessonInScope(request, enrollment, request.lessonId)))
      throw new LearnerAuthorizationError();
    if (!this.options.signAsset) throw new LearnerAuthorizationError();
    const links = await LessonAssetCollection.create({ db: this.db });
    // Explicit and load-bearing: only these relationships are ever signed.
    // The guardian-only `answer-key` copy of a generated worksheet
    // (QuestionAuthoringService.attachGeneratedPrintable) must never match.
    let link: Awaited<ReturnType<typeof links.get>> | null = null;
    for (const relationship of PRINTABLE_RELATIONSHIPS) {
      link = await links.get(
        {
          tenantId: request.tenantId,
          lessonId: request.lessonId,
          assetId: request.assetId,
          relationship,
        },
        { cache: false },
      );
      // A row a newer build retired is no longer part of the lesson's materials.
      if (link?.retiredAt) link = null;
      if (link) break;
    }
    if (!link) throw new LearnerAuthorizationError();
    // The editable original of a Word/PowerPoint pair is never printed or
    // signed here: the rendered PDF half is.
    if (link.rendition === 'original') throw new LearnerAuthorizationError();
    // Handouts and learner pages are printed only as a PDF.
    if (
      link.relationship !== 'printable' &&
      (await this.materialAsset(request.assetId)).mimeType !== 'application/pdf'
    )
      throw new LearnerAuthorizationError();
    // A row the family made guardian-only is not the learner's to sign.
    if (
      (await this.learnerAudienceOnly(request)) &&
      materialAudience(link.relationship, link.audience) !== 'learner'
    )
      throw new LearnerAuthorizationError();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const url = await this.options.signAsset(
      Object.freeze({
        enrollmentId: request.enrollmentId,
        tenantId: request.tenantId,
        actorUserId: request.actorUserId,
        learnerId: request.learnerId,
        submissionId: `lesson:${request.lessonId}`,
        assetId: request.assetId,
        expiresAt,
      }),
    );
    return { url, expiresAt };
  }
  /** Extract inclusive one-based, disjoint ranges into private worksheet PDFs. */
  async splitWorksheetPacket(
    request: LearnerRequest & {
      courseId: string;
      data: Buffer;
      ranges: readonly {
        lessonId: string;
        firstPage: number;
        lastPage: number;
      }[];
    },
  ): Promise<ReadonlyArray<{ lessonId: string; assetId: string }>> {
    return this.mutate(async (service) => {
      const learner = await service.requireActor(
        request,
        'education.learner.packet',
      );
      const catalog = await service.catalog(request, request.courseId);
      if (
        catalog.course.tenantId !== request.tenantId ||
        catalog.course.licenseKind !== 'personal-use-copy'
      )
        throw new LearnerAuthorizationError();
      if (
        !Buffer.isBuffer(request.data) ||
        !request.data.length ||
        request.data.length > 50 * 1024 * 1024 ||
        !Array.isArray(request.ranges) ||
        !request.ranges.length ||
        request.ranges.length > 100
      )
        throw new Error('Invalid worksheet packet');
      const pdf = await PDFDocument.load(request.data);
      const pages = new Set<number>();
      const lessons = new Set<string>();
      for (const range of request.ranges) {
        if (
          !range ||
          !Number.isSafeInteger(range.firstPage) ||
          !Number.isSafeInteger(range.lastPage) ||
          range.firstPage < 1 ||
          range.lastPage < range.firstPage ||
          range.lastPage > pdf.getPageCount() ||
          lessons.has(range.lessonId)
        )
          throw new Error('Invalid packet page range');
        const lesson = await service.db.get('lessons', {
          id: range.lessonId,
          tenant_id: request.tenantId,
          _meta_type: '@happyvertical/smrt-education:Worksheet',
        });
        if (
          !lesson ||
          !catalog.sections.some((section) =>
            section.lessons.some(
              ({ lesson: visible }) => visible.id === range.lessonId,
            ),
          )
        )
          throw new LearnerAuthorizationError();
        lessons.add(range.lessonId);
        for (let page = range.firstPage; page <= range.lastPage; page++) {
          if (pages.has(page)) throw new Error('Packet page ranges overlap');
          pages.add(page);
        }
      }
      const links = await LessonAssetCollection.create({ db: service.db });
      const result: Array<{ lessonId: string; assetId: string }> = [];
      for (const range of request.ranges) {
        const extracted = await PDFDocument.create();
        const selected = await extracted.copyPages(
          pdf,
          Array.from(
            { length: range.lastPage - range.firstPage + 1 },
            (_, index) => range.firstPage - 1 + index,
          ),
        );
        for (const page of selected) extracted.addPage(page);
        const asset = await service.storePage(request, learner.profileId, {
          name: `${range.lessonId}.pdf`,
          mimeType: 'application/pdf',
          data: Buffer.from(await extracted.save()),
        });
        await withPrivateAssetAccess(
          {
            tenantId: request.tenantId,
            actorUserId: request.actorUserId,
            ownerProfileId: learner.profileId,
            assetIds: [String(asset.id)],
          },
          () =>
            links.create({
              tenantId: request.tenantId,
              lessonId: range.lessonId,
              assetId: String(asset.id),
              relationship: 'printable',
            }),
        );
        result.push({ lessonId: range.lessonId, assetId: String(asset.id) });
      }
      return result;
    });
  }
}
