import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { validateRubricResults } from './question-rubric.js';

const closed = { api: false, mcp: false, cli: false } as const;

function applyOptions(target: object, options: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
  }
}

function requireEnum(value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) throw new Error('Invalid education value');
}

function requireScore(value: number | null, label: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1))
    throw new Error(`${label} must be null or a number from zero to one`);
}

function requireNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a nonnegative integer`);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringifyJsonObject(
  value: Record<string, unknown>,
  label: string,
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return JSON.stringify(value);
}

async function immutableIdentity(
  object: SmrtObject & { tenantId: string },
  identity: Record<string, unknown>,
): Promise<void> {
  if (!object.tenantId?.trim()) throw new Error('Education requires a tenant');
  if (object.id && (await object.db.get(object.tableName, { id: object.id }))) {
    if (
      !(await object.db.get(object.tableName, {
        id: object.id,
        tenant_id: object.tenantId,
        ...identity,
      }))
    )
      throw new Error('Education record identity cannot change');
  }
}

export type SubmissionStatus =
  | 'captured'
  | 'extracting'
  | 'needs_review'
  | 'graded'
  | 'rejected';
export type ExternalCompletionReporter = 'learner' | 'guardian' | 'source';
export type SubmissionAssetRelationship = 'page' | 'attachment';
export type GraderKind = 'auto' | 'ai' | 'guardian' | 'instructor';
/** Blank workbook evidence is deliberately distinct from completed work. */
export type SubmissionKind = 'blank_reference' | 'completed_work';

/** Evidence that a learner completed one progress item. */
@TenantScoped({ mode: 'required' })
@smrt({ tableStrategy: 'sti', ...closed })
export class Submission extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('Lesson', { required: true }) lessonId = '';
  @foreignKey('LessonProgress', { required: true }) progressId = '';
  submittedAt = new Date();
  status: SubmissionStatus = 'captured';
  notes = '';
  /** Service-owned idempotency key for one capture request on this progress. */
  captureKey = '';
  /** Service-owned content digest used to detect changed retry payloads. */
  captureDigest = '';
  /** A retained blank workbook reference never becomes a completed attempt. */
  @field({ required: true }) kind: SubmissionKind = 'completed_work';
  /** Immutable predecessor for a correction/rescan chain. */
  @foreignKey('Submission', { nullable: true }) previousSubmissionId:
    | string
    | null = null;
  /** Stable external intake identity, unique in service scope when supplied. */
  @field({ type: 'text', nullable: true }) intakeItemId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    await immutableIdentity(this, {
      learner_id: this.learnerId,
      lesson_id: this.lessonId,
      progress_id: this.progressId,
    });
    requireEnum(this.status, [
      'captured',
      'extracting',
      'needs_review',
      'graded',
      'rejected',
    ]);
    requireEnum(this.kind, ['blank_reference', 'completed_work']);
    if (
      this.intakeItemId !== null &&
      (!this.intakeItemId.trim() || this.intakeItemId.length > 200)
    )
      throw new Error('Submission intake item id is invalid');
    if (this.previousSubmissionId === String(this.id))
      throw new Error('Submission cannot precede itself');
    if (
      this.previousSubmissionId &&
      !(await this.db.get('submissions', {
        id: this.previousSubmissionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        lesson_id: this.lessonId,
        progress_id: this.progressId,
      }))
    )
      throw new Error('Submission predecessor must match its tenant progress');
    if (
      !(await this.db.get('lesson_progress', {
        id: this.progressId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        lesson_id: this.lessonId,
      }))
    )
      throw new Error(
        'Submission requires its tenant learner, lesson, and progress record',
      );
    return super.save(options);
  }
}

/** Durable tenant/item claim for trusted ingestion receipts. This separate table
 * keeps ordinary uploads (which have no intake item) out of the uniqueness key.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'submission_intake_bindings',
  ...closed,
  conflictColumns: ['tenant_id', 'intake_item_id'],
})
export class SubmissionIntakeBinding extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ required: true, type: 'text' }) intakeItemId = '';
  @foreignKey('Submission', { required: true }) submissionId = '';

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!this.tenantId?.trim() || !this.intakeItemId?.trim())
      throw new Error('Submission intake binding requires tenant and item');
    if (this.intakeItemId.length > 200)
      throw new Error('Submission intake item id is invalid');
    if (
      !(await this.db.get('submissions', {
        id: this.submissionId,
        tenant_id: this.tenantId,
        intake_item_id: this.intakeItemId,
      }))
    )
      throw new Error('Submission intake binding must match its submission');
    return super.save(options);
  }
}

/** Photos or scans of work submitted for review. */
@smrt({ tableName: 'submissions', ...closed })
export class ScannedSubmission extends Submission {
  pageCount = 0;
  ocrText = '';
  extracted = '{}';

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }

  getExtracted(): Record<string, unknown> {
    return parseJsonObject(this.extracted);
  }

  setExtracted(value: Record<string, unknown>): void {
    this.extracted = stringifyJsonObject(value, 'Extracted answers');
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    requireNonnegativeInteger(this.pageCount, 'Page count');
    return super.save(options);
  }
}

/** Completion reported by the learner, guardian, or external source. */
@smrt({ tableName: 'submissions', ...closed })
export class ExternalCompletion extends Submission {
  reportedBy: ExternalCompletionReporter = 'learner';
  evidenceUrl = '';
  @field({ type: 'decimal' }) reportedScore = 0.0;

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    requireEnum(this.reportedBy, ['learner', 'guardian', 'source']);
    requireScore(this.reportedScore, 'Reported score');
    return super.save(options);
  }
}

/** A guardian's statement that work was completed. */
@smrt({ tableName: 'submissions', ...closed })
export class Attestation extends Submission {}

/** The tenant-owned files attached to a submission. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'submission_assets',
  conflictColumns: ['tenant_id', 'submission_id', 'asset_id', 'relationship'],
  ...closed,
})
export class SubmissionAsset extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Submission', { required: true }) submissionId = '';
  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId = '';
  @field({ required: true }) relationship: SubmissionAssetRelationship = 'page';
  sortOrder = 0;

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    await immutableIdentity(this, {
      submission_id: this.submissionId,
      asset_id: this.assetId,
      relationship: this.relationship,
    });
    requireEnum(this.relationship, ['page', 'attachment']);
    requireNonnegativeInteger(this.sortOrder, 'Asset sort order');
    const submission = await this.db.get('submissions', {
      id: this.submissionId,
      tenant_id: this.tenantId,
    });
    const asset = await this.db.get('assets', {
      id: this.assetId,
      tenant_id: this.tenantId,
    });
    if (!submission || !asset)
      throw new Error(
        'Submission assets require tenant-owned submission and asset',
      );
    if (
      !(await this.db.get('learners', {
        id: submission.learner_id,
        tenant_id: this.tenantId,
        profile_id: asset.owner_profile_id,
      }))
    )
      throw new Error('Submission assets must be owned by the learner profile');
    return super.save(options);
  }
}

/** An assessment of a submission; the service selects the authoritative grade. */
@TenantScoped({ mode: 'required' })
@smrt({ ...closed })
export class Grade extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Submission', { required: true }) submissionId = '';
  @field({ required: true }) graderKind: GraderKind = 'auto';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  graderProfileId: string | null = null;
  @field({ type: 'decimal', nullable: true }) score: number | null = null;
  @field({ type: 'integer', nullable: true }) pointsEarned: number | null =
    null;
  @field({ type: 'integer', nullable: true }) pointsPossible: number | null =
    null;
  rubricResults = '{}';
  /**
   * Exact immutable question revision this grade assesses. Nullable and
   * additive: legacy grades leave it unset and keep unvalidated rubric results.
   */
  @field({ type: 'text', nullable: true }) questionRevisionId: string | null =
    null;
  feedback = '';
  gradedAt = new Date();

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }

  getRubricResults(): Record<string, unknown> {
    return parseJsonObject(this.rubricResults);
  }

  setRubricResults(value: Record<string, unknown>): void {
    this.rubricResults = stringifyJsonObject(value, 'Rubric results');
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    await immutableIdentity(this, {
      submission_id: this.submissionId,
    });
    requireEnum(this.graderKind, ['auto', 'ai', 'guardian', 'instructor']);
    if (
      !(await this.db.get('submissions', {
        id: this.submissionId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Grade requires its tenant submission');
    requireScore(this.score, 'Score');
    for (const [value, label] of [
      [this.pointsEarned, 'Points earned'],
      [this.pointsPossible, 'Points possible'],
    ] as const)
      if (value !== null) requireNonnegativeInteger(value, label);
    if (
      this.pointsEarned !== null &&
      this.pointsPossible !== null &&
      this.pointsEarned > this.pointsPossible
    )
      throw new Error('Points earned cannot exceed points possible');
    if (this.questionRevisionId !== null) {
      const revision = await this.db.get('question_revisions', {
        id: this.questionRevisionId,
        tenant_id: this.tenantId,
      });
      if (!revision)
        throw new Error('Grade requires its tenant question revision');
      validateRubricResults(
        revision.rubric_json as string | null,
        this.getRubricResults(),
      );
    }
    return super.save(options);
  }
}
