/** Database serialization primitive for referral-click replay keys. */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ReferralClickOperation } from '../models/ReferralClickOperation.js';

export interface ClaimReferralClickOperationInput {
  operationId: string;
  tenantId: string | null;
  keyHash: string;
  linkId: string;
  touchId: string;
  intentHash: string;
  callerEvidenceHash: string;
  requestedOccurredAt: string;
}

export interface ClaimReferralClickOperationResult {
  operation: ReferralClickOperation | null;
  claimed: boolean;
}

export class ReferralClickOperationCollection extends SmrtCollection<ReferralClickOperation> {
  static readonly _itemClass = ReferralClickOperation;

  /** Tenant-filtered lookup; a foreign operation payload remains invisible. */
  async findByOperationId(
    operationId: string,
  ): Promise<ReferralClickOperation | null> {
    return await this.get({ id: operationId }, { cache: false });
  }

  /**
   * Claim the deterministic operation UUID without changing a winner.
   * Must run in the transaction that creates the touch and increments the
   * link counter.
   */
  async claim(
    input: ClaimReferralClickOperationInput,
  ): Promise<ClaimReferralClickOperationResult> {
    const inserted = await this.query(
      `INSERT INTO ${this.tableName} (
         id, slug, context, tenant_id, key_hash, link_id, touch_id,
         intent_hash, caller_evidence_hash, requested_occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        input.operationId,
        input.operationId,
        '',
        input.tenantId,
        input.keyHash,
        input.linkId,
        input.touchId,
        input.intentHash,
        input.callerEvidenceHash,
        input.requestedOccurredAt,
      ],
      { allowRawOnTenantScoped: true },
    );

    const operation = await this.findByOperationId(input.operationId);
    return { operation, claimed: inserted.length === 1 };
  }
}

export default ReferralClickOperationCollection;
