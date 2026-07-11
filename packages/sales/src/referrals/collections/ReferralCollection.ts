/**
 * ReferralCollection — collection manager for {@link Referral}.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Referral } from '../models/Referral.js';

export class ReferralCollection extends SmrtCollection<Referral> {
  static readonly _itemClass = Referral;

  /** All referrals credited to a referrer, newest first. */
  async findByReferrer(referrerId: string): Promise<Referral[]> {
    return await this.list({
      where: { referrerId },
      orderBy: 'created_at DESC',
    });
  }

  /** All referrals pointing at one qualifying target, newest first. */
  async findByTarget(
    targetKind: string,
    targetId: string,
  ): Promise<Referral[]> {
    return await this.list({
      where: { targetKind, targetId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * QUALIFIED referrals for one target — what
   * `ReferralCommissionService.processEarningEvent` resolves when given a
   * target instead of explicit referral ids.
   */
  async findQualifiedByTarget(
    targetKind: string,
    targetId: string,
  ): Promise<Referral[]> {
    return await this.list({
      where: { targetKind, targetId, status: 'qualified' },
      orderBy: 'created_at ASC',
    });
  }

  /**
   * Expire lapsed attributions: every `attributed` referral whose
   * `expiresAt` is set and `<= now` transitions to `expired` and is saved.
   * Referrals without an `expiresAt` never lapse.
   *
   * @returns The referrals expired by this sweep.
   */
  async sweepExpired(now: Date = new Date()): Promise<Referral[]> {
    const attributed = await this.list({
      where: { status: 'attributed' },
      orderBy: 'created_at ASC',
    });
    const swept: Referral[] = [];
    for (const referral of attributed) {
      const expiresAt = referral.expiresAt;
      if (expiresAt === null || expiresAt.getTime() > now.getTime()) {
        continue; // no deadline, or still inside the window
      }
      referral.markExpired();
      await referral.save();
      swept.push(referral);
    }
    return swept;
  }
}

export default ReferralCollection;
