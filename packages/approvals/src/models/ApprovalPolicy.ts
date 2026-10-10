/**
 * ApprovalPolicy: a tenant's tightening of one approval kind.
 *
 * A row may raise the quorum, shorten the expiry, or add one required
 * permission; it can never loosen the kind's package defaults. Writes go
 * through `ApprovalService.setPolicy`, which refuses loosening, and
 * `effectiveRules` clamps any stored row when a request is made. A policy
 * applies to requests made after it is written; existing requests keep the
 * rules fixed at request time.
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
import { assertPolicyTightens, requireApprovalKind } from '../kinds.js';

/** Constructor options for {@link ApprovalPolicy}. */
export interface ApprovalPolicyOptions extends SmrtObjectOptions {
  tenantId?: string;
  kind?: string;
  requiredApprovals?: number;
  ttlMs?: number;
  requiredPermission?: string;
  updatedBy?: string;
}

/** Tenant-level tightening of an approval kind. One row per tenant and kind. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'approval_policies',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
  indexes: [
    {
      name: 'approval_policies_tenant_kind_key',
      columns: ['tenantId', 'kind'],
      unique: true,
    },
  ],
})
export class ApprovalPolicy extends SmrtObject {
  /** Owning tenant. */
  @tenantId()
  tenantId: string = '';

  /** Approval kind key this row tightens. */
  @field({ type: 'text', required: true })
  kind: string = '';

  /** Raised quorum; `0` inherits the kind default. */
  @field({ type: 'integer' })
  requiredApprovals: number = 0;

  /** Shortened lifetime in milliseconds; `0` inherits the kind default. */
  @field({ type: 'integer' })
  ttlMs: number = 0;

  /** Extra permission slug a decider must hold; empty for none. */
  @field({ type: 'text' })
  requiredPermission: string = '';

  /** Principal id that last wrote the row. */
  @field({ type: 'text' })
  updatedBy: string = '';

  constructor(options: ApprovalPolicyOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.requiredApprovals !== undefined)
      this.requiredApprovals = options.requiredApprovals;
    if (options.ttlMs !== undefined) this.ttlMs = options.ttlMs;
    if (options.requiredPermission !== undefined)
      this.requiredPermission = options.requiredPermission;
    if (options.updatedBy !== undefined) this.updatedBy = options.updatedBy;
  }

  /**
   * Validate against the registered kind, then persist. A row for an unknown
   * kind, or one that would loosen the kind, is refused.
   *
   * @throws {ApprovalError} `APPROVAL_KIND_UNKNOWN`,
   *   `APPROVAL_POLICY_LOOSENS`, or `APPROVAL_INVALID`.
   */
  override async save(): Promise<this> {
    this.requiredPermission = String(this.requiredPermission ?? '').trim();
    this.requiredApprovals = Number(this.requiredApprovals ?? 0);
    this.ttlMs = Number(this.ttlMs ?? 0);
    assertPolicyTightens(requireApprovalKind(this.kind), {
      requiredApprovals: this.requiredApprovals,
      ttlMs: this.ttlMs,
      requiredPermission: this.requiredPermission,
    });
    return await super.save();
  }
}
