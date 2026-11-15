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

import { COURSE_GENERATION_STATUSES } from './course-generation-contracts.js';

/** Immutable generation request with its retained input snapshot. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_generation_jobs',
  conflictColumns: ['tenant_id', 'request_key'],
  ...closed,
})
export class CourseGenerationJob extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true, requiredFor: 'identity' }) courseId =
    '';
  @foreignKey('CourseRevision', { required: true, requiredFor: 'identity' })
  baseRevisionId = '';
  requestKey = '';
  payloadDigest = '';
  @field({ type: 'text' }) instruction = '';
  /** The exact material snapshot offered to the provider. */
  @field({ type: 'text' }) inputJson = '{}';
  requestedByUserId = '';
  delegatingGuardianUserId = '';
  delegationId = '';
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
    await requireOwned(this, 'course_revisions', this.baseRevisionId, {
      course_id: this.courseId,
    });
    requireText(this.requestKey, 'Generation job requires a request key');
    requireText(this.requestedByUserId, 'Generation job requires an actor');
    requireJson(this.inputJson, 'object', 'Generation input');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseGenerationJobCollection extends SmrtCollection<CourseGenerationJob> {
  static readonly _itemClass = CourseGenerationJob;
}

/** Append-only status log; the highest sequence is the job's status and outcome. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_generation_events',
  conflictColumns: ['tenant_id', 'job_id', 'sequence'],
  indexes: [
    {
      name: 'course_generation_events_sequence_unique',
      columns: ['tenantId', 'jobId', 'sequence'],
      unique: true,
    },
  ],
  ...closed,
})
export class CourseGenerationEvent extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseGenerationJob', {
    required: true,
    requiredFor: 'identity',
  })
  jobId = '';
  @foreignKey('Course', { required: true, requiredFor: 'identity' }) courseId =
    '';
  sequence = 1;
  status = 'queued';
  provider = '';
  model = '';
  version = '';
  responseModel = '';
  @field({ type: 'integer', nullable: true }) inputTokens: number | null = null;
  @field({ type: 'integer', nullable: true }) outputTokens: number | null =
    null;
  @field({ type: 'decimal', nullable: true }) cost: number | null = null;
  @field({ type: 'text', nullable: true }) costCurrency: string | null = null;
  @field({ type: 'text' }) usageJson = '{}';
  @field({ type: 'text', nullable: true }) errorCode: string | null = null;
  @field({ type: 'text' }) detail = '';
  @field({ type: 'text', nullable: true }) proposalId: string | null = null;
  @field({ type: 'text', nullable: true }) resultRevisionId: string | null =
    null;
  actorUserId = '';
  delegatingGuardianUserId = '';
  delegationId = '';
  requestKey = '';
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
    await requireOwned(this, 'course_generation_jobs', this.jobId, {
      course_id: this.courseId,
    });
    requireText(this.actorUserId, 'Generation event requires an actor');
    if (
      !COURSE_GENERATION_STATUSES.includes(this.status as never) ||
      !Number.isSafeInteger(this.sequence) ||
      this.sequence < 1
    )
      throw new Error('Invalid generation event');
    requireJson(this.usageJson, 'object', 'Generation usage');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseGenerationEventCollection extends SmrtCollection<CourseGenerationEvent> {
  static readonly _itemClass = CourseGenerationEvent;
}

/** The validated proposal for one job and its supplied-versus-proposed plan. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_proposals',
  conflictColumns: ['tenant_id', 'job_id'],
  ...closed,
})
export class CourseProposal extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseGenerationJob', {
    required: true,
    requiredFor: 'identity',
  })
  jobId = '';
  @foreignKey('Course', { required: true, requiredFor: 'identity' }) courseId =
    '';
  @foreignKey('CourseRevision', { required: true, requiredFor: 'identity' })
  baseRevisionId = '';
  @foreignKey('CourseRevision', { required: true, requiredFor: 'identity' })
  resultRevisionId = '';
  @field({ type: 'text' }) rationale = '';
  @field({ type: 'text' }) proposalJson = '{}';
  @field({ type: 'text' }) planJson = '[]';
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
    await requireOwned(this, 'course_generation_jobs', this.jobId, {
      course_id: this.courseId,
    });
    await requireOwned(this, 'course_revisions', this.baseRevisionId, {
      course_id: this.courseId,
    });
    await requireOwned(this, 'course_revisions', this.resultRevisionId, {
      course_id: this.courseId,
    });
    requireJson(this.proposalJson, 'object', 'Proposal');
    requireJson(this.planJson, 'array', 'Proposal plan');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseProposalCollection extends SmrtCollection<CourseProposal> {
  static readonly _itemClass = CourseProposal;
}

/** Explicit, recorded accept or reject of conflicting proposal fields. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_proposal_decisions',
  conflictColumns: ['tenant_id', 'proposal_id', 'request_key'],
  ...closed,
})
export class CourseProposalDecision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseProposal', { required: true, requiredFor: 'identity' })
  proposalId = '';
  @foreignKey('Course', { required: true, requiredFor: 'identity' }) courseId =
    '';
  decision = 'accepted';
  @field({ type: 'text' }) fieldsJson = '[]';
  @field({ type: 'text', nullable: true }) resultRevisionId: string | null =
    null;
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
    await requireOwned(this, 'course_proposals', this.proposalId, {
      course_id: this.courseId,
    });
    requireText(this.actorUserId, 'Proposal decision requires an actor');
    requireText(this.requestKey, 'Proposal decision requires a request key');
    if (!['accepted', 'rejected'].includes(this.decision))
      throw new Error('Invalid proposal decision');
    requireJson(this.fieldsJson, 'array', 'Decision fields');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseProposalDecisionCollection extends SmrtCollection<CourseProposalDecision> {
  static readonly _itemClass = CourseProposalDecision;
}

/**
 * The structured brief of one generation job and the theme it resolved to:
 * written once with the job, never rewritten, so the guardian review can show
 * the objective, the theme used and whether it was a per-request override.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_generation_briefs',
  conflictColumns: ['tenant_id', 'job_id'],
  ...closed,
})
export class CourseGenerationBriefRecord extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseGenerationJob', {
    required: true,
    requiredFor: 'identity',
  })
  jobId = '';
  @foreignKey('Course', { required: true, requiredFor: 'identity' }) courseId =
    '';
  target = 'course';
  subject = '';
  category = '';
  area = '';
  /** Whole grade level; `-1` means none was given. */
  grade = -1;
  @field({ type: 'text' }) objective = '';
  learningObjectiveId = '';
  learnerId = '';
  themeLabel = '';
  themeKey = '';
  themeSource = 'none';
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
    await requireOwned(this, 'course_generation_jobs', this.jobId, {
      course_id: this.courseId,
    });
    if (!['course', 'lesson'].includes(this.target))
      throw new Error('Invalid generation target');
    if (!['override', 'saved', 'none'].includes(this.themeSource))
      throw new Error('Invalid generation theme source');
    if (
      (this.themeSource === 'none') !== !this.themeLabel ||
      (this.themeKey && !this.themeLabel)
    )
      throw new Error('Generation theme and its source disagree');
    if (!Number.isSafeInteger(this.grade) || this.grade < -1 || this.grade > 12)
      throw new Error('Invalid generation grade');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseGenerationBriefRecordCollection extends SmrtCollection<CourseGenerationBriefRecord> {
  static readonly _itemClass = CourseGenerationBriefRecord;
}
