/**
 * CommissionSettlementService — advances Commissions along the strict
 * `pending → earned → approved → payable` chain (the final `payable → paid`
 * step belongs to `CommissionPayoutService.completePayout`, which flips a
 * batch's rows when the money actually moves).
 *
 * All methods persist the rows they advance (transition method + save per
 * row) and return the updated instances.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import type { Commission } from '../models/Commission.js';

export class CommissionSettlementService {
  constructor(private readonly commissions: CommissionCollection) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<CommissionSettlementService> {
    return new CommissionSettlementService(
      await CommissionCollection.create(classOptions),
    );
  }

  /**
   * Sweep the clearing window: every `pending` commission whose
   * `clearingEndsAt` is `<= now` — or whose `clearingEndsAt` is `null`
   * (null means NO clearing window applies, so the row is immediately
   * sweepable) — transitions to `earned` and is saved.
   *
   * @returns The commissions that were marked earned by this sweep.
   */
  async sweepClearing(now: Date = new Date()): Promise<Commission[]> {
    const pending = await this.commissions.findByStatus('pending');
    const swept: Commission[] = [];
    for (const commission of pending) {
      const clearingEndsAt = commission.clearingEndsAt;
      if (clearingEndsAt !== null && clearingEndsAt.getTime() > now.getTime()) {
        continue; // still clearing
      }
      commission.markEarned(now);
      await commission.save();
      swept.push(commission);
    }
    return swept;
  }

  /**
   * Approve `earned` commissions by id (`earned → approved`). Strict: a
   * missing id or a commission in any other status throws — the caller
   * names exact rows, so a mismatch is a bug worth surfacing, not skipping.
   */
  async approveCommissions(
    ids: string[],
    now: Date = new Date(),
  ): Promise<Commission[]> {
    return await this.transitionByIds(ids, (commission) => {
      commission.approve(now);
    });
  }

  /**
   * Release `approved` commissions to `payable` by id. Strict — see
   * {@link approveCommissions}.
   */
  async markPayable(
    ids: string[],
    now: Date = new Date(),
  ): Promise<Commission[]> {
    return await this.transitionByIds(ids, (commission) => {
      commission.markPayable(now);
    });
  }

  /**
   * Convenience chain: advance each commission from wherever it currently
   * sits up to `payable` (`pending → earned → approved → payable`), saving
   * after EACH step — the save-time guard only admits single-step edges, so
   * every intermediate state is persisted (each with its timestamp). Rows
   * already `payable` or `paid` are returned untouched (idempotent). Note
   * this deliberately bypasses the clearing window — it's the "operator
   * says pay these now" path.
   */
  async settleUpToPayable(
    ids: string[],
    now: Date = new Date(),
  ): Promise<Commission[]> {
    const updated: Commission[] = [];
    for (const id of ids) {
      const commission = await this.requireCommission(id);
      if (commission.isPending()) {
        commission.markEarned(now);
        await commission.save();
      }
      if (commission.isEarned()) {
        commission.approve(now);
        await commission.save();
      }
      if (commission.isApproved()) {
        commission.markPayable(now);
        await commission.save();
      }
      updated.push(commission);
    }
    return updated;
  }

  private async transitionByIds(
    ids: string[],
    transition: (commission: Commission) => void,
  ): Promise<Commission[]> {
    const updated: Commission[] = [];
    for (const id of ids) {
      const commission = await this.requireCommission(id);
      const statusBefore = commission.status;
      transition(commission);
      if (commission.status !== statusBefore) {
        await commission.save();
      }
      updated.push(commission);
    }
    return updated;
  }

  private async requireCommission(id: string): Promise<Commission> {
    const commission = await this.commissions.get({ id });
    if (!commission) {
      throw new Error(
        `CommissionSettlementService: commission '${id}' not found`,
      );
    }
    return commission;
  }
}

export default CommissionSettlementService;
