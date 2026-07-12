/**
 * CommissionAdjustmentCollection — collection manager for
 * {@link CommissionAdjustment}.
 *
 * "Unsettled" means `payoutId` is empty (checked in memory so `''`/`NULL`
 * storage differences don't matter). NOTE: the collection-level queries do
 * NOT apply the parent-commission-status eligibility rule — that lives in
 * `CommissionBalanceService` / `CommissionPayoutService`, which filter
 * unsettled adjustments to those whose parent commission is
 * earned/approved/payable/paid.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { CommissionAdjustment } from '../models/CommissionAdjustment.js';

export class CommissionAdjustmentCollection extends SmrtCollection<CommissionAdjustment> {
  static readonly _itemClass = CommissionAdjustment;

  /** All adjustments appended to one commission, oldest first. */
  async findByCommission(
    commissionId: string,
  ): Promise<CommissionAdjustment[]> {
    return await this.list({
      where: { commissionId },
      orderBy: 'created_at ASC',
    });
  }

  /** Unsettled adjustments for an earner+currency, oldest first. */
  async findUnsettledByEarner(
    earnerId: string,
    currency: string,
  ): Promise<CommissionAdjustment[]> {
    const rows = await this.list({
      where: { earnerId, currency },
      orderBy: 'created_at ASC',
    });
    return rows.filter((a) => !a.payoutId);
  }

  /**
   * Σ signed amountCents of {@link findUnsettledByEarner} rows (integer
   * cents; clawbacks make it negative).
   */
  async sumUnsettledByEarner(
    earnerId: string,
    currency: string,
  ): Promise<number> {
    const rows = await this.findUnsettledByEarner(earnerId, currency);
    return rows.reduce((sum, a) => sum + a.amountCents, 0);
  }

  /** Adjustments settled by one payout batch. */
  async findByPayout(payoutId: string): Promise<CommissionAdjustment[]> {
    return await this.list({
      where: { payoutId },
      orderBy: 'created_at ASC',
    });
  }

  /**
   * Atomically claim adjustment rows for a payout batch — the adjustment
   * twin of `CommissionCollection.claimForPayout`. A single guarded
   * `UPDATE ... WHERE id = ? AND (payout_id IS NULL OR payout_id = '')`
   * stamps each row; the database serializes concurrent writers so exactly
   * one batch wins a contested row. A row already owned by THIS payout
   * passes through via the re-read (idempotent retry / repair); a row owned
   * by a DIFFERENT payout is skipped. Returns the claimed rows.
   */
  async claimForPayout(
    adjustmentIds: string[],
    payoutId: string,
  ): Promise<CommissionAdjustment[]> {
    const claimed: CommissionAdjustment[] = [];
    for (const id of adjustmentIds) {
      if (!id) continue;
      await this.db
        .execute`UPDATE commission_adjustments SET payout_id = ${payoutId} WHERE id = ${id} AND (payout_id IS NULL OR payout_id = '')`;
      const verified = await this.get({ id });
      if (verified && verified.payoutId === payoutId) {
        claimed.push(verified);
      }
    }
    return claimed;
  }
}

export default CommissionAdjustmentCollection;
