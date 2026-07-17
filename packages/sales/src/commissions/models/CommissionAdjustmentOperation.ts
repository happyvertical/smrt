/** Persisted serialization fence for idempotent CommissionAdjustment writes. */

import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

interface CommissionAdjustmentOperationOptions extends SmrtObjectOptions {
  tenantId?: string;
  adjustmentId?: string;
}

/**
 * One globally unique adjustment operation UUID mapped to its adjustment.
 *
 * This is package-owned infrastructure for `CommissionAdjustmentService`, not
 * a second financial record. The operation UUID is stored as the table's
 * primary `id`, which gives every supported database a persisted uniqueness
 * fence without adding a constrained column to the existing adjustments
 * table. The service inserts this fence and the adjustment in one transaction.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class CommissionAdjustmentOperation extends SmrtObject {
  /** Owning tenant; the operation UUID itself remains globally unique. */
  @tenantId()
  tenantId: string = '';

  /** Adjustment that the operation creates in the same transaction. */
  // Deliberately not a database foreign key: the fence is inserted first in
  // the transaction, then its adjustment. Atomic commit plus replay
  // verification preserve integrity without requiring deferred constraints.
  @field({ sqlType: 'UUID', required: true, readonly: true, indexed: true })
  adjustmentId!: string;

  constructor(options: CommissionAdjustmentOperationOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.adjustmentId !== undefined)
      this.adjustmentId = options.adjustmentId;
  }
}

export default CommissionAdjustmentOperation;
