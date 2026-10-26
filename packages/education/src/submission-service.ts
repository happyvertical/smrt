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
  LessonProgressCollection,
  ScannedSubmissionCollection,
  SubmissionAssetCollection,
  SubmissionCollection,
  SubmissionIntakeBindingCollection,
} from './collections.js';
import {
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  type LearnerRequest,
  LearnerService,
} from './learner-service.js';
import type { Grade, Submission, SubmissionKind } from './submissions.js';

/** A single captured page. No model patches or pre-existing asset IDs are accepted. */
export interface SubmissionPage {
  name: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  data: Buffer;
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
  pages: ReadonlyArray<{ assetId: string; sortOrder: number }>;
  grade: null | {
    id: string;
    graderKind: Grade['graderKind'];
    score: number | null;
    feedback: string;
  };
}>;
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

/** Workbook scaffolding can only be mutated through its owning workflow. */
export class WorkbookWorkflowRequiredError extends Error {
  constructor() {
    super('Workbook workflow required');
    this.name = 'WorkbookWorkflowRequiredError';
  }
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
  private assets(): Promise<AssetRuntime> {
    this.runtime ??= createAssetRuntime({
      db: this.db,
      storage: this.options.storage,
      storeOptions: this.options.storeOptions,
    });
    return this.runtime;
  }
  private async storePage(
    request: LearnerRequest,
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
  private validatePages(pages: readonly SubmissionPage[]): void {
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
  }
  private async progress(
    request: LessonRequest,
    action: Parameters<LearnerAuthorizer>[0]['action'],
  ) {
    const enrollment = await this.requireEnrollment(request, action);
    await this.lock('enrollments', request.enrollmentId, request.tenantId);
    const catalog = await this.catalog(request, enrollment.courseId);
    if (
      !catalog.sections.some((section) =>
        section.lessons.some(({ lesson }) => lesson.id === request.lessonId),
      )
    )
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
    const catalog = await this.catalog(request, enrollment.courseId);
    if (
      !progress ||
      !catalog.sections.some((section) =>
        section.lessons.some(({ lesson }) => lesson.id === row.lessonId),
      )
    )
      throw new LearnerAuthorizationError();
    return { row, progress };
  }
  private async view(
    row: Submission,
    actorUserId: string,
  ): Promise<SubmissionView> {
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
    const pages: Array<{ assetId: string; sortOrder: number }> = [];
    for (const link of links) {
      if (
        await this.db.get('assets', {
          id: link.assetId,
          tenant_id: row.tenantId,
          owner_profile_id: learner.profile_id,
        })
      )
        pages.push({ assetId: link.assetId, sortOrder: link.sortOrder });
    }
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
    const withheld =
      learner.user_id === actorUserId &&
      Boolean(
        await this.findWorkbookActivity(
          { tenantId: row.tenantId, learnerId: row.learnerId, actorUserId },
          { lessonId: row.lessonId },
        ),
      );
    return {
      id: String(row.id),
      learnerId: row.learnerId,
      lessonId: row.lessonId,
      progressId: row.progressId,
      status: withheld && row.status === 'graded' ? 'captured' : row.status,
      submittedAt: row.submittedAt,
      notes: row.notes,
      kind: row.kind,
      previousSubmissionId: row.previousSubmissionId,
      intakeItemId: row.intakeItemId,
      pages,
      grade:
        grade && !withheld
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
    const catalog = await this.catalog(request, enrollment.courseId);
    if (
      !catalog.sections.some((section) =>
        section.lessons.some(({ lesson }) => lesson.id === request.lessonId),
      )
    )
      throw new LearnerAuthorizationError();
  }

  /** Reject legacy upload/review entry points using authoritative owned scope. */
  async assertNonWorkbookSubmissionScope(
    request: LearnerRequest & {
      enrollmentId: string;
      lessonId?: string;
      previousSubmissionId?: string;
    },
  ): Promise<void> {
    await this.requireEnrollment(request, 'education.learner.read');
    if (
      await this.findWorkbookActivity(request, {
        enrollmentId: request.enrollmentId,
      })
    )
      throw new WorkbookWorkflowRequiredError();
    if (
      request.lessonId &&
      (await this.findWorkbookActivity(request, { lessonId: request.lessonId }))
    )
      throw new WorkbookWorkflowRequiredError();
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
      if (
        previous &&
        (await this.findWorkbookActivity(request, {
          lessonId: previous.lessonId,
        }))
      )
        throw new WorkbookWorkflowRequiredError();
    }
  }

  async captureSubmission(request: CaptureRequest): Promise<SubmissionView> {
    return this.captureSubmissionInScope(request);
  }

  /** Owning workflow extension; no browser input can grant this scoped path. */
  protected async captureWorkbookSubmission(
    request: CaptureRequest,
    activityId: string,
  ): Promise<SubmissionView> {
    return this.captureSubmissionInScope(request, activityId);
  }

  private async captureSubmissionInScope(
    request: CaptureRequest,
    activityId?: string,
  ): Promise<SubmissionView> {
    return this.mutate(async (service) => {
      await service.requireEnrollment(request, 'education.learner.submit');
      const workbookLesson = await service.findWorkbookActivity(request, {
        lessonId: request.lessonId,
      });
      const workbookEnrollment = await service.findWorkbookActivity(request, {
        enrollmentId: request.enrollmentId,
      });
      if (
        activityId
          ? !workbookLesson ||
            String(workbookLesson.id) !== activityId ||
            workbookLesson.enrollmentId !== request.enrollmentId
          : Boolean(workbookLesson || workbookEnrollment)
      )
        throw new WorkbookWorkflowRequiredError();
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
      for (const [sortOrder, page] of request.pages.entries()) {
        const asset = await service.storePage(request, learner.profileId, page);
        await links.create({
          tenantId: request.tenantId,
          submissionId: String(row.id),
          assetId: String(asset.id),
          relationship: 'page',
          sortOrder,
        });
      }
      if (kind === 'completed_work') {
        progress.status = 'submitted';
        progress.attempts += 1;
        await progress.save();
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
    progress.status = 'complete';
    progress.completedAt = new Date();
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
      await service.lock('enrollments', request.enrollmentId, request.tenantId);
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
  async signSubmissionAsset(
    request: SubmissionRequest & { assetId: string },
  ): Promise<{ url: string; expiresAt: Date }> {
    const { row } = await this.requireSubmission(
      request,
      'education.learner.read',
    );
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
  async signLessonPrintable(
    request: LessonRequest & { assetId: string },
  ): Promise<{ url: string; expiresAt: Date }> {
    const enrollment = await this.requireEnrollment(
      request,
      'education.learner.read',
    );
    const catalog = await this.catalog(request, enrollment.courseId);
    if (
      !catalog.sections.some((section) =>
        section.lessons.some(
          ({ lesson }) => String(lesson.id) === request.lessonId,
        ),
      )
    )
      throw new LearnerAuthorizationError();
    const link = await (
      await LessonAssetCollection.create({ db: this.db })
    ).get(
      {
        tenantId: request.tenantId,
        lessonId: request.lessonId,
        assetId: request.assetId,
        relationship: 'printable',
      },
      { cache: false },
    );
    if (!link || !this.options.signAsset) throw new LearnerAuthorizationError();
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
