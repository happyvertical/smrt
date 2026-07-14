/**
 * CommissionPayoutCollection — collection manager for
 * {@link CommissionPayout}.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { CommissionPayout } from '../models/CommissionPayout.js';
import type { CommissionPayoutStatus } from '../types.js';

export class CommissionPayoutCollection extends SmrtCollection<CommissionPayout> {
  static readonly _itemClass = CommissionPayout;

  /** All payout batches for an earner, newest first. */
  async findByEarner(earnerId: string): Promise<CommissionPayout[]> {
    return await this.list({
      where: { earnerId },
      orderBy: 'created_at DESC',
    });
  }

  /** Payout batches by status, newest first. */
  async findByStatus(
    status: CommissionPayoutStatus,
  ): Promise<CommissionPayout[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /** Look up a payout by its idempotency natural key. */
  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CommissionPayout | null> {
    if (!idempotencyKey) return null;
    const results = await this.list({ where: { idempotencyKey }, limit: 1 });
    return results[0] ?? null;
  }

  /**
   * One page of payouts carrying the derived single-source stamp for
   * `(sourceKind, sourceId)`, newest first with a deterministic id
   * tiebreak. This is the RAW indexed page — stamped rows only, membership
   * unverified. Consumers want
   * `CommissionPayoutService.getSourcePayoutHistory`, which re-verifies
   * each page's membership and fails closed on rows the stamp alone cannot
   * prove.
   */
  async findBySource(
    sourceKind: string,
    sourceId: string,
    page: { limit: number; offset: number },
  ): Promise<CommissionPayout[]> {
    if (!sourceKind || !sourceId) return [];
    return await this.list({
      where: { sourceKind, sourceId },
      orderBy: ['created_at DESC', 'id DESC'],
      limit: page.limit,
      offset: page.offset,
    });
  }

  /**
   * Σ totalAmountCents of COMPLETED payouts for an earner+currency —
   * lifetime settled earnings (integer cents).
   */
  async sumPaidByEarner(earnerId: string, currency: string): Promise<number> {
    const completed = await this.list({
      where: { earnerId, currency, status: 'completed' },
    });
    return completed.reduce((sum, p) => sum + p.totalAmountCents, 0);
  }
}

export default CommissionPayoutCollection;
