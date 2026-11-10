import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  adopt,
  noDelete,
  requireInsert,
  requireJson,
  requireOwned,
  requireText,
  validDate,
} from './course-append-only.js';

const closed = { api: false, mcp: false, cli: false } as const;

import {
  COURSE_FINDING_RESOLUTIONS,
  COURSE_REVIEW_CONCERNS,
  COURSE_REVIEW_SECTIONS,
  COURSE_REVIEW_TARGET_KINDS,
} from './course-review-contracts.js';

/**
 * Educational review bound to one exact course revision and a context digest.
 * There is deliberately no score or rating member; findings carry the substance.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_reviews',
  conflictColumns: ['tenant_id', 'course_id', 'request_key'],
  indexes: [
    {
      name: 'course_reviews_sequence_unique',
      columns: ['tenantId', 'courseId', 'revisionId', 'sequence'],
      unique: true,
    },
  ],
  ...closed,
})
export class CourseReview extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  @foreignKey('CourseRevision', { required: true }) revisionId = '';
  sequence = 1;
  @field({ type: 'text' }) contextJson = '{}';
  contextDigest = '';
  @field({ type: 'text' }) disclaimer = '';
  @field({ type: 'text' }) generalSummary = '';
  @field({ type: 'text' }) learnerSummary = '';
  reviewerKind = 'guardian';
  reviewerProvider = '';
  reviewerModel = '';
  authorUserId = '';
  delegatingGuardianUserId = '';
  delegationId = '';
  requestKey = '';
  payloadDigest = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    await requireOwned(this, 'courses', this.courseId);
    await requireOwned(this, 'course_revisions', this.revisionId, {
      course_id: this.courseId,
    });
    requireText(this.authorUserId, 'Review requires an author');
    requireText(this.requestKey, 'Review requires a request key');
    requireText(this.contextDigest, 'Review requires a context digest', 128);
    requireText(this.disclaimer, 'Review requires its disclaimer', 2000);
    if (
      !['guardian', 'agent'].includes(this.reviewerKind) ||
      !Number.isSafeInteger(this.sequence) ||
      this.sequence < 1
    )
      throw new Error('Invalid review');
    requireJson(this.contextJson, 'object', 'Review context');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseReviewCollection extends SmrtCollection<CourseReview> {
  static readonly _itemClass = CourseReview;
}

/** One concern about specific material; append-only. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_review_findings',
  conflictColumns: ['tenant_id', 'review_id', 'ordinal'],
  indexes: [
    {
      name: 'course_review_findings_ordinal_unique',
      columns: ['tenantId', 'reviewId', 'ordinal'],
      unique: true,
    },
  ],
  ...closed,
})
export class CourseReviewFinding extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseReview', { required: true }) reviewId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  @foreignKey('CourseRevision', { required: true }) revisionId = '';
  ordinal = 0;
  section = 'general-level';
  targetKind = 'course-revision';
  targetId = '';
  targetField = '';
  targetRegion = '';
  concern = 'other';
  @field({ type: 'text' }) explanation = '';
  @field({ type: 'text' }) suggestedChange = '';
  uncertain = false;
  humanVerificationRequired = false;
  blocking = false;
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    await requireOwned(this, 'course_reviews', this.reviewId, {
      course_id: this.courseId,
      revision_id: this.revisionId,
    });
    requireText(this.targetId, 'Finding requires a material reference');
    requireText(this.targetField, 'Finding requires a field');
    requireText(this.explanation, 'Finding requires an explanation', 4000);
    if (
      !COURSE_REVIEW_SECTIONS.includes(this.section as never) ||
      !COURSE_REVIEW_TARGET_KINDS.includes(this.targetKind as never) ||
      !COURSE_REVIEW_CONCERNS.includes(this.concern as never) ||
      !Number.isSafeInteger(this.ordinal) ||
      this.ordinal < 0 ||
      typeof this.uncertain !== 'boolean' ||
      typeof this.humanVerificationRequired !== 'boolean' ||
      typeof this.blocking !== 'boolean'
    )
      throw new Error('Invalid review finding');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseReviewFindingCollection extends SmrtCollection<CourseReviewFinding> {
  static readonly _itemClass = CourseReviewFinding;
}

/** Explicit record that a review stopped being current; one per review, never removed. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_review_outdated_markers',
  conflictColumns: ['tenant_id', 'review_id'],
  ...closed,
})
export class CourseReviewOutdatedMarker extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseReview', { required: true }) reviewId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  reason = 'revision-changed';
  @field({ type: 'text', nullable: true }) supersedingRevisionId:
    | string
    | null = null;
  newContextDigest = '';
  actorUserId = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    await requireOwned(this, 'course_reviews', this.reviewId, {
      course_id: this.courseId,
    });
    requireText(this.actorUserId, 'Outdated marker requires an actor');
    if (!['revision-changed', 'context-changed'].includes(this.reason))
      throw new Error('Invalid outdated reason');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseReviewOutdatedMarkerCollection extends SmrtCollection<CourseReviewOutdatedMarker> {
  static readonly _itemClass = CourseReviewOutdatedMarker;
}

/** How a finding was dealt with; a finding has at most one resolution. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_finding_resolutions',
  conflictColumns: ['tenant_id', 'finding_id'],
  ...closed,
})
export class CourseFindingResolution extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseReviewFinding', { required: true }) findingId = '';
  @foreignKey('CourseReview', { required: true }) reviewId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  resolution = 'addressed';
  @field({ type: 'text' }) note = '';
  actorUserId = '';
  delegatingGuardianUserId = '';
  delegationId = '';
  requestKey = '';
  payloadDigest = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    await requireOwned(this, 'course_review_findings', this.findingId, {
      review_id: this.reviewId,
      course_id: this.courseId,
    });
    requireText(this.actorUserId, 'Resolution requires an actor');
    requireText(this.requestKey, 'Resolution requires a request key');
    if (!COURSE_FINDING_RESOLUTIONS.includes(this.resolution as never))
      throw new Error('Invalid finding resolution');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseFindingResolutionCollection extends SmrtCollection<CourseFindingResolution> {
  static readonly _itemClass = CourseFindingResolution;
}
