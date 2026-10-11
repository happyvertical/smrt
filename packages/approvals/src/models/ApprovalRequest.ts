/**
 * ApprovalRequest: one decision gate on one revision of one subject.
 *
 * The row is the authority for the decision; a consumer's own status column
 * is a projection it writes in the same transaction as `consume`. Every
 * lifecycle field is changed only by `ApprovalService` through one guarded
 * conditional UPDATE, so the generated surface is read-only and a plain
 * `save()` of a loaded request is refused.
 *
 * @packageDocumentation
 */

import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  ApprovalError,
  type ApprovalPrincipalType,
  type ApprovalStatus,
} from '../types.js';
import { adoptServiceWrite, hasServiceWrite } from '../write-capability.js';

/** Constructor options for {@link ApprovalRequest}. */
export interface ApprovalRequestOptions extends SmrtObjectOptions {
  tenantId?: string;
  kind?: string;
  subjectType?: string;
  subjectId?: string;
  subjectRevisionHash?: string;
  requestKey?: string;
  requestedBy?: string;
  requestedByType?: ApprovalPrincipalType;
  summary?: string;
  status?: ApprovalStatus;
  requiredApprovals?: number;
  approvalCount?: number;
  requiredPermissions?: string;
  version?: number;
  expiresAt?: Date | null;
  decidedAt?: Date | null;
  consumedAt?: Date | null;
  consumedBy?: string;
}

/**
 * A request for approval of one subject revision.
 *
 * Status moves `pending` to `approved`, `rejected`, `changes_requested`,
 * `cancelled`, or `expired`; an approved request is consumed once
 * (`consumedAt` set, status stays `approved`) or expires unconsumed.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'approval_requests',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
  indexes: [
    {
      name: 'approval_requests_tenant_request_key',
      columns: ['tenantId', 'requestKey'],
      unique: true,
    },
    {
      name: 'approval_requests_status_expiry_idx',
      columns: ['tenantId', 'status', 'expiresAt'],
    },
    {
      name: 'approval_requests_subject_idx',
      columns: ['tenantId', 'subjectType', 'subjectId'],
    },
  ],
})
export class ApprovalRequest extends SmrtObject {
  /** Owning tenant. Every read and transition is pinned to it. */
  @tenantId()
  tenantId: string = '';

  /** Approval kind key, e.g. `social.post.publish`. */
  @field({ type: 'text', required: true, readonly: true })
  kind: string = '';

  /** Qualified subject class, e.g. `@happyvertical/smrt-social:SocialPost`. */
  @field({ type: 'text', required: true, readonly: true })
  subjectType: string = '';

  /** Subject id. Bare string: the subject table is polymorphic. */
  @field({ type: 'text', required: true, readonly: true })
  subjectId: string = '';

  /**
   * Hash of the exact subject revision being approved. `consume` must
   * present the same hash, so an approval never transfers to changed content.
   */
  @field({ type: 'text', required: true, readonly: true })
  subjectRevisionHash: string = '';

  /** Idempotency key, unique per tenant. A replay returns the same request. */
  @field({ type: 'text', required: true, readonly: true })
  requestKey: string = '';

  /** Principal id of the requester. The requester can never decide. */
  @field({ type: 'text', required: true, readonly: true })
  requestedBy: string = '';

  /** Principal type of the requester (`human`, `agent`, or `service`). */
  @field({ type: 'text', readonly: true })
  requestedByType: ApprovalPrincipalType = 'human';

  /** Short human-readable description shown to deciders. */
  @field({ type: 'text', readonly: true })
  summary: string = '';

  /** Lifecycle status. Changed only by guarded transitions. */
  @field({ type: 'text', readonly: true })
  status: ApprovalStatus = 'pending';

  /** Distinct approvers needed, fixed when the request is made. */
  @field({ type: 'integer', readonly: true })
  requiredApprovals: number = 1;

  /** Distinct approvals recorded so far. */
  @field({ type: 'integer', readonly: true })
  approvalCount: number = 0;

  /**
   * JSON array of permission slugs a decider must hold, fixed at request
   * time. Read it through {@link getRequiredPermissions}.
   */
  @field({ type: 'text', readonly: true })
  requiredPermissions: string = '[]';

  /** Transition counter; every guarded UPDATE requires and bumps it. */
  @field({ type: 'integer', readonly: true })
  version: number = 0;

  /** After this instant the request can no longer be decided or consumed. */
  @field({ type: 'datetime', readonly: true })
  expiresAt: Date | null = null;

  /** When the request reached a terminal decision. */
  @field({ type: 'datetime', readonly: true })
  decidedAt: Date | null = null;

  /** When the approval was consumed (single use). */
  @field({ type: 'datetime', readonly: true })
  consumedAt: Date | null = null;

  /** Principal id that consumed the approval. */
  @field({ type: 'text', readonly: true })
  consumedBy: string = '';

  constructor(options: ApprovalRequestOptions = {}) {
    super(options);
    adoptServiceWrite(this, options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.subjectType !== undefined)
      this.subjectType = options.subjectType;
    if (options.subjectId !== undefined) this.subjectId = options.subjectId;
    if (options.subjectRevisionHash !== undefined)
      this.subjectRevisionHash = options.subjectRevisionHash;
    if (options.requestKey !== undefined) this.requestKey = options.requestKey;
    if (options.requestedBy !== undefined)
      this.requestedBy = options.requestedBy;
    if (options.requestedByType !== undefined)
      this.requestedByType = options.requestedByType;
    if (options.summary !== undefined) this.summary = options.summary;
    if (options.status !== undefined) this.status = options.status;
    if (options.requiredApprovals !== undefined)
      this.requiredApprovals = options.requiredApprovals;
    if (options.approvalCount !== undefined)
      this.approvalCount = options.approvalCount;
    if (options.requiredPermissions !== undefined)
      this.requiredPermissions = options.requiredPermissions;
    if (options.version !== undefined) this.version = options.version;
    if (options.expiresAt !== undefined) this.expiresAt = options.expiresAt;
    if (options.decidedAt !== undefined) this.decidedAt = options.decidedAt;
    if (options.consumedAt !== undefined) this.consumedAt = options.consumedAt;
    if (options.consumedBy !== undefined) this.consumedBy = options.consumedBy;
  }

  /** The permission slugs a decider must hold (never throws; bad JSON = none valid). */
  getRequiredPermissions(): string[] {
    try {
      const parsed: unknown = JSON.parse(this.requiredPermissions || '[]');
      return Array.isArray(parsed)
        ? parsed.filter((slug): slug is string => typeof slug === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /** Store the permission slugs a decider must hold. */
  setRequiredPermissions(slugs: readonly string[]): void {
    this.requiredPermissions = JSON.stringify([...slugs]);
  }

  /** The expiry as epoch milliseconds (`NaN` when unset or unparseable). */
  expiresAtMs(): number {
    const value = this.expiresAt as unknown;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string' || typeof value === 'number') {
      return new Date(value).getTime();
    }
    return Number.NaN;
  }

  /** True when the approval was consumed. */
  isConsumed(): boolean {
    return this.consumedAt !== null && this.consumedAt !== undefined;
  }

  /**
   * Refuse any insert `ApprovalService` did not mint (see
   * `write-capability.ts`), and any minted insert that does not start in the
   * initial state. Runs for ordinary saves and bulk creates alike (core
   * wraps an error thrown here; `save()` checks first so callers see it).
   *
   * @throws {ApprovalError} `APPROVAL_FORBIDDEN`.
   */
  protected override async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    this.assertInsertAllowed();
  }

  private assertInsertAllowed(): void {
    if (this.isPersisted) return;
    if (!hasServiceWrite(this)) {
      throw new ApprovalError(
        'APPROVAL_FORBIDDEN',
        'ApprovalRequest rows are created only by ApprovalService.requestApproval().',
      );
    }
    if (
      this.status !== 'pending' ||
      Number(this.approvalCount) !== 0 ||
      Number(this.version) !== 1 ||
      this.decidedAt ||
      this.consumedAt ||
      this.consumedBy
    ) {
      throw new ApprovalError(
        'APPROVAL_FORBIDDEN',
        'A new ApprovalRequest must start pending, undecided, and unconsumed.',
      );
    }
  }

  /**
   * Insert a new request. A loaded request is never re-saved: every later
   * change is a guarded transition in `ApprovalService`.
   *
   * @throws {ApprovalError} `APPROVAL_FORBIDDEN` for a persisted request.
   */
  override async save(): Promise<this> {
    if (this.isPersisted) {
      throw new ApprovalError(
        'APPROVAL_FORBIDDEN',
        `ApprovalRequest ${this.id} is changed only through ApprovalService transitions.`,
      );
    }
    this.assertInsertAllowed();
    this.requireInsertOnSave();
    return await super.save();
  }

  /**
   * Requests are durable records of a decision.
   *
   * @throws {ApprovalError} always.
   */
  override async delete(): Promise<void> {
    throw new ApprovalError(
      'APPROVAL_FORBIDDEN',
      `ApprovalRequest ${this.id} cannot be deleted.`,
    );
  }
}
