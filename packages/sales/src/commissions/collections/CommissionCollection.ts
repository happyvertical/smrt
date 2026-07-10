/**
 * CommissionCollection — collection manager for {@link Commission}.
 *
 * "Unsettled" throughout means `payoutId` is empty — the row has not been
 * gathered into a {@link CommissionPayout} batch yet. The emptiness check is
 * applied in memory (`!c.payoutId`) rather than as a `WHERE payout_id = ''`
 * filter so the semantics hold whether an adapter stores the empty
 * reference as `''` or `NULL`.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Commission } from '../models/Commission.js';
import type { CommissionStatus } from '../types.js';

export class CommissionCollection extends SmrtCollection<Commission> {
  static readonly _itemClass = Commission;

  /** All commissions for an earner, newest first. */
  async findByEarner(earnerId: string): Promise<Commission[]> {
    return await this.list({
      where: { earnerId },
      orderBy: 'created_at DESC',
    });
  }

  /** All commissions derived from one earning event. */
  async findByEvent(earningEventId: string): Promise<Commission[]> {
    return await this.list({
      where: { earningEventId },
      orderBy: 'created_at DESC',
    });
  }

  /** Commissions by lifecycle status, newest first. */
  async findByStatus(status: CommissionStatus): Promise<Commission[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /** Look up a commission by its idempotency natural key. */
  async findByDedupeKey(dedupeKey: string): Promise<Commission | null> {
    if (!dedupeKey) return null;
    const results = await this.list({ where: { dedupeKey }, limit: 1 });
    return results[0] ?? null;
  }

  /**
   * Payable commissions for an earner+currency that no payout batch has
   * settled yet — the rows `CommissionPayoutService.createPayoutBatch`
   * gathers.
   */
  async findPayableUnsettled(
    earnerId: string,
    currency: string,
  ): Promise<Commission[]> {
    const payable = await this.list({
      where: { earnerId, currency, status: 'payable' },
      orderBy: 'created_at ASC',
    });
    return payable.filter((c) => !c.payoutId);
  }

  /** Σ amountCents of {@link findPayableUnsettled} rows (integer cents). */
  async sumPayableByEarner(
    earnerId: string,
    currency: string,
  ): Promise<number> {
    const payable = await this.findPayableUnsettled(earnerId, currency);
    return payable.reduce((sum, c) => sum + c.amountCents, 0);
  }

  /** Commissions settled by one payout batch. */
  async findByPayout(payoutId: string): Promise<Commission[]> {
    return await this.list({
      where: { payoutId },
      orderBy: 'created_at ASC',
    });
  }
}

export default CommissionCollection;
