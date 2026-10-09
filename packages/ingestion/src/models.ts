import './__smrt-register__.js';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Durable IntakeItem record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_items',
  conflictColumns: ['tenant_id', 'source_id', 'delivery_key'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_items_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    { name: 'intake_items_expiry_idx', columns: ['tenantId', 'expiresAt'] },
    {
      name: 'intake_items_receipt_idx',
      columns: ['tenantId', 'receiptState', 'leaseUntil'],
    },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeItem extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @field({ type: 'text', required: true })
  sourceId: string = '';

  @field({ type: 'text', required: true })
  sourceVersion: string = '';

  @field({ type: 'text', required: true })
  deliveryKey: string = '';

  @field({ type: 'text', required: true })
  payloadDigest: string = '';

  @field({ type: 'text', required: true })
  scopeDigest: string = '';

  @field({ type: 'text', required: true })
  receiptState: string = '';

  @field({ type: 'text', required: true })
  processingState: string = '';

  @field({ type: 'text', required: true })
  visibility: string = '';

  @field({ type: 'integer', required: true })
  receiptVersion: number = 0;

  @field({ type: 'integer', required: true })
  analysisRevision: number = 0;

  @field({ type: 'integer', required: true })
  fence: number = 0;

  @field({ type: 'text', required: true })
  leaseToken: string = '';

  @field({ type: 'datetime', nullable: true })
  leaseUntil: Date | null = null;

  @field({ type: 'datetime', required: true })
  expiresAt: Date = new Date();

  @field({ type: 'datetime', required: true })
  replayUntil: Date = new Date();

  @field({ type: 'boolean', required: true })
  cancelled: boolean = false;

  @field({ type: 'text', required: true })
  traceId: string = '';

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakeEvidence record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_evidence',
  conflictColumns: ['tenant_id', 'item_id', 'part_id'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_evidence_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    { name: 'intake_evidence_item_idx', columns: ['tenantId', 'itemId'] },
    { name: 'intake_evidence_state_idx', columns: ['tenantId', 'state'] },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeEvidence extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @field({ type: 'text', required: true })
  partId: string = '';

  @foreignKey('IntakeEvidence', { nullable: true })
  parentEvidenceId: string | null = null;

  // Privacy deletion clears the live owner link; evidence/receipt IDs survive.
  @crossPackageRef('@happyvertical/smrt-assets:Asset', {
    nullable: true,
    onDelete: 'SET NULL',
  })
  assetId: string | null = null;

  @field({ type: 'text', required: true })
  state: string = '';

  @field({ type: 'text', required: true })
  contentHash: string = '';

  @field({ type: 'integer', required: true })
  byteLength: number = 0;

  @field({ type: 'text', required: true })
  mediaType: string = '';

  @field({ type: 'text', required: true })
  sourceUri: string = '';

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakeAnalysis record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_analyses',
  conflictColumns: ['tenant_id', 'item_id', 'revision'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_analyses_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    { name: 'intake_analyses_item_idx', columns: ['tenantId', 'itemId'] },
    { name: 'intake_analyses_state_idx', columns: ['tenantId', 'state'] },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeAnalysis extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @field({ type: 'integer', required: true })
  revision: number = 0;

  @field({ type: 'integer', required: true })
  fence: number = 0;

  @field({ type: 'integer', required: true })
  attemptNumber: number = 0;

  @foreignKey('IntakeAnalysisAttempt', { nullable: true })
  currentAttemptId: string | null = null;

  @field({ type: 'text', required: true })
  state: string = '';

  @field({ type: 'text', required: true })
  inputDigest: string = '';

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakeAnalysisAttempt record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_analysis_attempts',
  conflictColumns: ['tenant_id', 'analysis_id', 'attempt_number'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_analysis_attempts_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    {
      name: 'intake_analysis_attempts_item_idx',
      columns: ['tenantId', 'itemId'],
    },
    {
      name: 'intake_analysis_attempts_state_idx',
      columns: ['tenantId', 'state'],
    },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeAnalysisAttempt extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @foreignKey('IntakeAnalysis', { required: true })
  analysisId: string = '';

  @field({ type: 'integer', required: true })
  attemptNumber: number = 0;

  @field({ type: 'integer', required: true })
  fence: number = 0;

  @field({ type: 'text', required: true })
  state: string = '';

  @field({ type: 'text', required: true })
  leaseToken: string = '';

  @field({ type: 'datetime', nullable: true })
  leaseUntil: Date | null = null;

  @field({ type: 'text', required: true })
  outputDigest: string = '';

  @field({ type: 'text', required: true })
  safeError: string = '';

  @field({ type: 'decimal', nullable: true })
  confidence: number | null = null;

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakePlan record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_plans',
  conflictColumns: ['tenant_id', 'item_id', 'plan_key', 'revision'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_plans_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    { name: 'intake_plans_item_idx', columns: ['tenantId', 'itemId'] },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakePlan extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @field({ type: 'text', required: true })
  planKey: string = '';

  @field({ type: 'integer', required: true })
  revision: number = 0;

  @field({ type: 'text', required: true })
  digest: string = '';

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakeAction record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_actions',
  conflictColumns: ['tenant_id', 'item_id', 'action_key'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_actions_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    { name: 'intake_actions_item_idx', columns: ['tenantId', 'itemId'] },
    { name: 'intake_actions_state_idx', columns: ['tenantId', 'state'] },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeAction extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @field({ type: 'text', required: true })
  actionKey: string = '';

  @field({ type: 'text', required: true })
  state: string = '';

  @field({ type: 'integer', required: true })
  proposalRevision: number = 0;

  @field({ type: 'integer', required: true })
  reviewVersion: number = 0;

  @field({ type: 'integer', required: true })
  executionAttempt: number = 0;

  @field({ type: 'integer', required: true })
  fence: number = 0;

  @field({ type: 'text', required: true })
  resultDigest: string = '';

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakeProposal record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_proposals',
  conflictColumns: ['tenant_id', 'action_id', 'revision'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_proposals_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    { name: 'intake_proposals_item_idx', columns: ['tenantId', 'itemId'] },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeProposal extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @foreignKey('IntakeAction', { required: true })
  actionId: string = '';

  @foreignKey('IntakeAnalysis', { required: true })
  analysisId: string = '';

  @foreignKey('IntakeAnalysisAttempt', { required: true })
  analysisAttemptId: string = '';

  @field({ type: 'integer', required: true })
  revision: number = 0;

  @field({ type: 'text', required: true })
  bindingHash: string = '';

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakeReviewDecision record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_review_decisions',
  conflictColumns: ['tenant_id', 'action_id', 'review_version'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_review_decisions_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    {
      name: 'intake_review_decisions_item_idx',
      columns: ['tenantId', 'itemId'],
    },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeReviewDecision extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @foreignKey('IntakeAction', { required: true })
  actionId: string = '';

  @foreignKey('IntakeProposal', { required: true })
  proposalId: string = '';

  @field({ type: 'integer', required: true })
  reviewVersion: number = 0;

  @field({ type: 'text', required: true })
  bindingHash: string = '';

  @field({ type: 'text', required: true })
  decision: string = '';

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakeExecution record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_executions',
  conflictColumns: ['tenant_id', 'action_id', 'attempt_number'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_executions_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    { name: 'intake_executions_item_idx', columns: ['tenantId', 'itemId'] },
    { name: 'intake_executions_state_idx', columns: ['tenantId', 'state'] },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeExecution extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @foreignKey('IntakeAction', { required: true })
  actionId: string = '';

  @field({ type: 'integer', required: true })
  attemptNumber: number = 0;

  @field({ type: 'integer', required: true })
  fence: number = 0;

  @field({ type: 'text', required: true })
  state: string = '';

  @field({ type: 'text', required: true })
  bindingHash: string = '';

  @field({ type: 'text', required: true })
  resultDigest: string = '';

  @field({ type: 'text', required: true })
  idempotencyKey: string = '';

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakeFeedback record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_feedback',
  conflictColumns: ['tenant_id', 'item_id', 'request_key'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_feedback_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    { name: 'intake_feedback_item_idx', columns: ['tenantId', 'itemId'] },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeFeedback extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @field({ type: 'text', required: true })
  requestKey: string = '';

  @foreignKey('IntakeFeedback', { nullable: true })
  supersedesId: string | null = null;

  @field({ type: 'text', required: true })
  kind: string = '';

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakeDispatch record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_dispatches',
  conflictColumns: ['tenant_id', 'item_id', 'stage', 'revision'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_dispatches_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    { name: 'intake_dispatches_item_idx', columns: ['tenantId', 'itemId'] },
    { name: 'intake_dispatches_state_idx', columns: ['tenantId', 'state'] },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeDispatch extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @field({ type: 'text', required: true })
  stage: string = '';

  @field({ type: 'integer', required: true })
  revision: number = 0;

  @field({ type: 'text', required: true })
  state: string = '';

  @field({ type: 'text', required: true })
  jobId: string = '';

  @field({ type: 'integer', required: true })
  deliveries: number = 0;

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}

/** Durable IntakeDeletion record; mutations belong to the server service. */
@smrt({
  tableName: 'intake_deletions',
  conflictColumns: ['tenant_id', 'item_id'],
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'intake_deletions_scope_idx',
      columns: ['tenantId', 'confidentialScopeId'],
    },
    { name: 'intake_deletions_item_idx', columns: ['tenantId', 'itemId'] },
    { name: 'intake_deletions_state_idx', columns: ['tenantId', 'state'] },
  ],
})
@TenantScoped({ mode: 'required' })
export class IntakeDeletion extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  @field({ type: 'text', required: true })
  confidentialScopeId: string = '';

  @foreignKey('IntakeItem', { required: true })
  itemId: string = '';

  @field({ type: 'text', required: true })
  state: string = '';

  @field({ type: 'json', required: true })
  data: string = '{}';

  /** Parse a bounded object payload; malformed persisted data fails closed. */
  getData(): Record<string, unknown> {
    const value: unknown =
      typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid intake payload');
    return value as Record<string, unknown>;
  }
}
