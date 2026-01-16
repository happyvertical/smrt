/**
 * PayoutCollection - Collection manager for Payout objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Payout } from '../models/Payout.js';
import { PayoutStatus } from '../types/index.js';

export class PayoutCollection extends SmrtCollection<Payout> {
  static readonly _itemClass = Payout;

  /**
   * Find payouts by partner
   *
   * @param partnerId - Partner ID
   * @returns Array of payouts
   */
  async findByPartner(partnerId: string): Promise<Payout[]> {
    return await this.list({
      where: { partnerId },
      orderBy: 'period_end DESC',
    });
  }

  /**
   * Find payouts by status
   *
   * @param status - Payout status
   * @returns Array of payouts
   */
  async findByStatus(status: PayoutStatus): Promise<Payout[]> {
    return await this.list({
      where: { status },
      orderBy: 'period_end DESC',
    });
  }

  /**
   * Find all pending payouts (awaiting approval)
   */
  async findPending(): Promise<Payout[]> {
    return await this.findByStatus(PayoutStatus.PENDING);
  }

  /**
   * Find all approved payouts (ready for processing)
   */
  async findApproved(): Promise<Payout[]> {
    return await this.findByStatus(PayoutStatus.APPROVED);
  }

  /**
   * Find all processing payouts
   */
  async findProcessing(): Promise<Payout[]> {
    return await this.findByStatus(PayoutStatus.PROCESSING);
  }

  /**
   * Find all completed payouts
   */
  async findCompleted(): Promise<Payout[]> {
    return await this.findByStatus(PayoutStatus.COMPLETED);
  }

  /**
   * Find all failed payouts
   */
  async findFailed(): Promise<Payout[]> {
    return await this.findByStatus(PayoutStatus.FAILED);
  }

  /**
   * Find payouts by invoice
   *
   * @param invoiceId - Invoice ID
   * @returns Array of payouts
   */
  async findByInvoice(invoiceId: string): Promise<Payout[]> {
    return await this.list({
      where: { invoiceId },
      orderBy: 'period_end DESC',
    });
  }

  /**
   * Find payouts in period range
   *
   * @param start - Period start date
   * @param end - Period end date
   * @returns Array of payouts
   */
  async findByPeriod(start: Date, end: Date): Promise<Payout[]> {
    return await this.list({
      where: {
        'period_start >=': start.toISOString(),
        'period_end <=': end.toISOString(),
      },
      orderBy: 'period_end DESC',
    });
  }

  /**
   * Find payouts for a partner by status
   *
   * @param partnerId - Partner ID
   * @param status - Payout status
   * @returns Array of payouts
   */
  async findByPartnerAndStatus(
    partnerId: string,
    status: PayoutStatus,
  ): Promise<Payout[]> {
    return await this.list({
      where: { partnerId, status },
      orderBy: 'period_end DESC',
    });
  }

  /**
   * Find pending payouts for a partner
   *
   * @param partnerId - Partner ID
   * @returns Array of pending payouts
   */
  async findPendingByPartner(partnerId: string): Promise<Payout[]> {
    return await this.findByPartnerAndStatus(partnerId, PayoutStatus.PENDING);
  }

  /**
   * Find completed payouts for a partner
   *
   * @param partnerId - Partner ID
   * @returns Array of completed payouts
   */
  async findCompletedByPartner(partnerId: string): Promise<Payout[]> {
    return await this.findByPartnerAndStatus(partnerId, PayoutStatus.COMPLETED);
  }

  /**
   * Sum total paid to a partner
   *
   * @param partnerId - Partner ID
   * @returns Total paid in cents
   */
  async sumPaidByPartner(partnerId: string): Promise<number> {
    const completed = await this.findCompletedByPartner(partnerId);
    return completed.reduce((sum, p) => sum + p.totalAmount, 0);
  }

  /**
   * Sum total pending for a partner
   *
   * @param partnerId - Partner ID
   * @returns Total pending in cents
   */
  async sumPendingByPartner(partnerId: string): Promise<number> {
    const pending = await this.findPendingByPartner(partnerId);
    return pending.reduce((sum, p) => sum + p.totalAmount, 0);
  }

  /**
   * Get most recent payout for a partner
   *
   * @param partnerId - Partner ID
   * @returns Most recent payout or null
   */
  async findLatestByPartner(partnerId: string): Promise<Payout | null> {
    const results = await this.list({
      where: { partnerId },
      orderBy: 'period_end DESC',
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Get payout statistics
   *
   * @returns Stats object
   */
  async getStats(): Promise<{
    pending: number;
    approved: number;
    processing: number;
    completed: number;
    failed: number;
    totalPaid: number;
    totalPending: number;
  }> {
    const all = await this.list({});

    const stats = {
      pending: 0,
      approved: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      totalPaid: 0,
      totalPending: 0,
    };

    for (const p of all) {
      switch (p.status) {
        case PayoutStatus.PENDING:
          stats.pending++;
          stats.totalPending += p.totalAmount;
          break;
        case PayoutStatus.APPROVED:
          stats.approved++;
          stats.totalPending += p.totalAmount;
          break;
        case PayoutStatus.PROCESSING:
          stats.processing++;
          break;
        case PayoutStatus.COMPLETED:
          stats.completed++;
          stats.totalPaid += p.totalAmount;
          break;
        case PayoutStatus.FAILED:
          stats.failed++;
          break;
      }
    }

    return stats;
  }
}
