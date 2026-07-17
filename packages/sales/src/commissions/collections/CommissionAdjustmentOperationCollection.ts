/** Database serialization primitive for adjustment operation UUIDs. */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { requireTenantId } from '@happyvertical/smrt-tenancy';
import { CommissionAdjustmentOperation } from '../models/CommissionAdjustmentOperation.js';

export interface ClaimCommissionAdjustmentOperationInput {
  operationId: string;
  tenantId: string;
  adjustmentId: string;
}

export interface ClaimCommissionAdjustmentOperationResult {
  operation: CommissionAdjustmentOperation | null;
  claimed: boolean;
}

export class CommissionAdjustmentOperationCollection extends SmrtCollection<CommissionAdjustmentOperation> {
  static readonly _itemClass = CommissionAdjustmentOperation;

  /** Tenant-scoped lookup; foreign-tenant operation payloads stay invisible. */
  async findByOperationId(
    operationId: string,
  ): Promise<CommissionAdjustmentOperation | null> {
    const tenantId = requireTenantId();
    const [operation] = await this.query(
      `SELECT
         id, slug, context, created_at, updated_at, tenant_id,
         CAST(adjustment_id AS TEXT) AS adjustment_id
       FROM ${this.tableName}
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`,
      [operationId, tenantId],
      { allowRawOnTenantScoped: true },
    );
    return operation ?? null;
  }

  /**
   * Claim the globally unique operation UUID without changing an existing
   * winner. This must run inside the same transaction that creates the
   * corresponding adjustment.
   */
  async claim(
    input: ClaimCommissionAdjustmentOperationInput,
  ): Promise<ClaimCommissionAdjustmentOperationResult> {
    if (requireTenantId().toLowerCase() !== input.tenantId.toLowerCase()) {
      throw new Error('CommissionAdjustment operation tenant mismatch');
    }

    const inserted = await this.query(
      `INSERT INTO ${this.tableName} (
         id, slug, context, tenant_id, adjustment_id
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        input.operationId,
        input.operationId,
        '',
        input.tenantId,
        input.adjustmentId,
      ],
      { allowRawOnTenantScoped: true },
    );

    const operation = await this.findByOperationId(input.operationId);
    return { operation, claimed: inserted.length === 1 };
  }
}

export default CommissionAdjustmentOperationCollection;
