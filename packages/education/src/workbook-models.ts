import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  validateWorkbookAssessment,
  type WorkbookAssessment,
} from './workbook-contracts.js';

const closed = { api: false, mcp: false, cli: false } as const;
function optionsFor(target: object, options: Record<string, unknown>) {
  for (const [key, value] of Object.entries(options))
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
}

/** Education-owned private workbook record. Mutations go through WorkbookService. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbooks',
  conflictColumns: ['tenant_id', 'learner_id', 'workbook_key'],
  ...closed,
})
export class Workbook extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  workbookKey = '';
  title = '';
  edition = '';
  reviewRequired = true;
  policyVersion = 1;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async save(): Promise<this> {
    if (!this.tenantId.trim()) throw new Error('Workbook requires tenant');
    if (
      !(await this.db.get('learners', {
        id: this.learnerId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Workbook parent ownership mismatch');
    if (
      this.id &&
      (await this.db.get(this.tableName, { id: this.id })) &&
      !(await this.db.get(this.tableName, {
        id: this.id,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        workbook_key: this.workbookKey,
        title: this.title,
        edition: this.edition,
      }))
    )
      throw new Error('Workbook identity cannot change');
    if (
      typeof this.reviewRequired !== 'boolean' ||
      !Number.isSafeInteger(this.policyVersion) ||
      this.policyVersion < 1
    )
      throw new Error('Invalid workbook policy');
    return super.save();
  }
}
export class WorkbookCollection extends SmrtCollection<Workbook> {
  static readonly _itemClass = Workbook;
}

/** Education-owned private workbook record. Mutations go through WorkbookService. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_activities',
  conflictColumns: ['tenant_id', 'workbook_id', 'page_key'],
  ...closed,
})
export class WorkbookActivity extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('Workbook', { required: true }) workbookId = '';
  @foreignKey('Enrollment', { required: true }) enrollmentId = '';
  @foreignKey('Lesson', { required: true }) lessonId = '';
  pageKey = '';
  pageLabel = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async delete(): Promise<void> {
    throw new Error(
      'Workbook history is immutable; deliberate family deletion requires an owning retention operation',
    );
  }
  override async save(): Promise<this> {
    if (!this.tenantId.trim()) throw new Error('Workbook requires tenant');
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Workbook history is immutable');
    if (
      !(await this.db.get('workbooks', {
        id: this.workbookId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Workbook parent ownership mismatch');
    if (
      !(await this.db.get('enrollments', {
        id: this.enrollmentId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Workbook enrollment mismatch');
    return super.save();
  }
}
export class WorkbookActivityCollection extends SmrtCollection<WorkbookActivity> {
  static readonly _itemClass = WorkbookActivity;
}

/** Education-owned private workbook record. Mutations go through WorkbookService. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_attempts',
  conflictColumns: ['tenant_id', 'submission_id'],
  ...closed,
})
export class WorkbookAttempt extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('WorkbookActivity', { required: true }) activityId = '';
  @foreignKey('Submission', { required: true }) submissionId = '';
  @foreignKey('WorkbookAttempt', { nullable: true }) previousAttemptId:
    | string
    | null = null;
  capturedAt = new Date();
  episodeId = '';
  reviewRequired = true;
  policyVersion = 1;
  assistance = 'unknown';
  actorUserId = '';
  @field({ type: 'text' }) sourceHashes = '[]';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async delete(): Promise<void> {
    throw new Error(
      'Workbook history is immutable; deliberate family deletion requires an owning retention operation',
    );
  }
  override async save(): Promise<this> {
    if (!this.tenantId.trim()) throw new Error('Workbook requires tenant');
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Workbook history is immutable');
    if (
      !(await this.db.get('workbook_activities', {
        id: this.activityId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Workbook parent ownership mismatch');
    if (
      !(await this.db.get('submissions', {
        id: this.submissionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Workbook submission mismatch');
    if (
      this.previousAttemptId &&
      !(await this.db.get(this.tableName, {
        id: this.previousAttemptId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        activity_id: this.activityId,
        episode_id: this.episodeId,
      }))
    )
      throw new Error('Workbook correction identity mismatch');
    const sources: { assetId: string; sha256: string; pageCount: number }[] =
      JSON.parse(this.sourceHashes);
    if (!Array.isArray(sources) || !sources.length)
      throw new Error('Workbook requires retained source hashes');
    for (const source of sources)
      if (
        !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !Number.isSafeInteger(source.pageCount) ||
        source.pageCount < 1 ||
        !(await this.db.get('submission_assets', {
          submission_id: this.submissionId,
          asset_id: source.assetId,
          tenant_id: this.tenantId,
        }))
      )
        throw new Error('Workbook retained source mismatch');
    if (!['independent', 'assisted', 'unknown'].includes(this.assistance))
      throw new Error('Invalid assistance');
    return super.save();
  }
}
export class WorkbookAttemptCollection extends SmrtCollection<WorkbookAttempt> {
  static readonly _itemClass = WorkbookAttempt;
}

/** Education-owned private workbook record. Mutations go through WorkbookService. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_assessment_revisions',
  conflictColumns: ['tenant_id', 'attempt_id', 'request_key'],
  ...closed,
})
export class WorkbookAssessmentRevision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('WorkbookAttempt', { required: true }) attemptId = '';
  requestKey = '';
  requestDigest = '';
  kind = 'ai';
  actorUserId = '';
  @foreignKey('WorkbookAssessmentRevision', { nullable: true })
  sourceRevisionId: string | null = null;
  decisionReason = '';
  @foreignKey('WorkbookAssessmentRevision', { nullable: true }) supersedesId:
    | string
    | null = null;
  @field({ type: 'text' }) assessmentJson = '{}';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async delete(): Promise<void> {
    throw new Error(
      'Workbook history is immutable; deliberate family deletion requires an owning retention operation',
    );
  }
  override async save(): Promise<this> {
    if (!this.tenantId.trim()) throw new Error('Workbook requires tenant');
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Workbook history is immutable');
    validateWorkbookAssessment(
      JSON.parse(this.assessmentJson) as WorkbookAssessment,
    );
    if (
      !(await this.db.get('workbook_attempts', {
        id: this.attemptId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Workbook parent ownership mismatch');
    if (
      this.sourceRevisionId &&
      !(await this.db.get(this.tableName, {
        id: this.sourceRevisionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        attempt_id: this.attemptId,
      }))
    )
      throw new Error('Workbook reviewed source mismatch');
    if (!['ai', 'guardian'].includes(this.kind))
      throw new Error('Invalid revision kind');
    return super.save();
  }
}
export class WorkbookAssessmentRevisionCollection extends SmrtCollection<WorkbookAssessmentRevision> {
  static readonly _itemClass = WorkbookAssessmentRevision;
}

/** Education-owned private workbook record. Mutations go through WorkbookService. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_feedback_releases',
  conflictColumns: ['tenant_id', 'attempt_id', 'request_key'],
  ...closed,
})
export class WorkbookFeedbackRelease extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('WorkbookAttempt', { required: true }) attemptId = '';
  @foreignKey('WorkbookAssessmentRevision', { required: true }) revisionId = '';
  @foreignKey('WorkbookAssessmentRevision', { nullable: true }) expectedHeadId:
    | string
    | null = null;
  requestKey = '';
  actorUserId = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async delete(): Promise<void> {
    throw new Error(
      'Workbook history is immutable; deliberate family deletion requires an owning retention operation',
    );
  }
  override async save(): Promise<this> {
    if (!this.tenantId.trim()) throw new Error('Workbook requires tenant');
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Workbook history is immutable');
    if (
      !(await this.db.get('workbook_attempts', {
        id: this.attemptId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Workbook parent ownership mismatch');
    if (
      !(await this.db.get('workbook_assessment_revisions', {
        id: this.revisionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        attempt_id: this.attemptId,
      }))
    )
      throw new Error('Workbook release revision mismatch');
    return super.save();
  }
}
export class WorkbookFeedbackReleaseCollection extends SmrtCollection<WorkbookFeedbackRelease> {
  static readonly _itemClass = WorkbookFeedbackRelease;
}

/** Authenticated delivery acknowledgment; this does not assert comprehension. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_feedback_deliveries',
  conflictColumns: ['tenant_id', 'attempt_id', 'actor_user_id', 'revision_id'],
  ...closed,
})
export class WorkbookFeedbackDelivery extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('WorkbookAttempt', { required: true }) attemptId = '';
  @foreignKey('WorkbookAssessmentRevision', { required: true }) revisionId = '';
  actorUserId = '';
  requestKey = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async save(): Promise<this> {
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Workbook delivery history is immutable');
    if (
      !(await this.db.get('workbook_assessment_revisions', {
        id: this.revisionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        attempt_id: this.attemptId,
      }))
    )
      throw new Error('Workbook delivery revision mismatch');
    if (
      !(await this.db.get('learners', {
        id: this.learnerId,
        tenant_id: this.tenantId,
        user_id: this.actorUserId,
      }))
    )
      throw new Error('Workbook delivery must name own learner');
    return super.save();
  }
  override async delete(): Promise<void> {
    throw new Error('Workbook delivery history is immutable');
  }
}
export class WorkbookFeedbackDeliveryCollection extends SmrtCollection<WorkbookFeedbackDelivery> {
  static readonly _itemClass = WorkbookFeedbackDelivery;
}
