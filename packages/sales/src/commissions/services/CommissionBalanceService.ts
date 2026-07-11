/**
 * CommissionBalanceService — computed (never stored) per-earner balances.
 *
 * `payableCents` is the sum of unsettled `payable` commissions;
 * `unsettledAdjustmentCents` is the signed sum of unsettled adjustments
 * whose parent commission is earned/approved/payable/paid (adjustments
 * against still-`pending` commissions wait for the earning to clear);
 * `netPayableCents = payableCents + unsettledAdjustmentCents` and can go
 * NEGATIVE when clawbacks against already-paid commissions exceed what is
 * currently payable. The pending/earned/approved breakdowns feed portal
 * views.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import type { Commission } from '../models/Commission.js';
import {
  ADJUSTMENT_SETTLEABLE_COMMISSION_STATUSES,
  type CommissionStatus,
  type EarnerBalance,
} from '../types.js';

export class CommissionBalanceService {
  constructor(
    private readonly commissions: CommissionCollection,
    private readonly adjustments: CommissionAdjustmentCollection,
  ) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<CommissionBalanceService> {
    return new CommissionBalanceService(
      await CommissionCollection.create(classOptions),
      await CommissionAdjustmentCollection.create(classOptions),
    );
  }

  /** Compute the {@link EarnerBalance} for one earner in one currency. */
  async getBalance(earnerId: string, currency: string): Promise<EarnerBalance> {
    const rows = await this.commissions.list({
      where: { earnerId, currency },
    });

    const sumByStatus = (status: CommissionStatus): number =>
      rows
        .filter((c: Commission) => c.status === status)
        .reduce((sum: number, c: Commission) => sum + c.amountCents, 0);

    const pendingCents = sumByStatus('pending');
    const earnedCents = sumByStatus('earned');
    const approvedCents = sumByStatus('approved');
    const payableCents = rows
      .filter((c: Commission) => c.status === 'payable' && !c.payoutId)
      .reduce((sum: number, c: Commission) => sum + c.amountCents, 0);

    const statusById = new Map<string, CommissionStatus>();
    for (const c of rows) {
      if (c.id) statusById.set(c.id, c.status);
    }

    const unsettled = await this.adjustments.findUnsettledByEarner(
      earnerId,
      currency,
    );
    let unsettledAdjustmentCents = 0;
    for (const adjustment of unsettled) {
      const parentStatus = statusById.get(adjustment.commissionId);
      if (
        parentStatus !== undefined &&
        (
          ADJUSTMENT_SETTLEABLE_COMMISSION_STATUSES as readonly CommissionStatus[]
        ).includes(parentStatus)
      ) {
        unsettledAdjustmentCents += adjustment.amountCents;
      }
    }

    return {
      earnerId,
      currency,
      payableCents,
      pendingCents,
      earnedCents,
      approvedCents,
      unsettledAdjustmentCents,
      netPayableCents: payableCents + unsettledAdjustmentCents,
    };
  }
}

export default CommissionBalanceService;
