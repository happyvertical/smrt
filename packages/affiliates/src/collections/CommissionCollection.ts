/**
 * CommissionCollection - Collection manager for Commission objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Commission } from '../models/Commission.js';
import { CommissionStatus, CommissionType } from '../types/index.js';

export class CommissionCollection extends SmrtCollection<Commission> {
  static readonly _itemClass = Commission;

  /**
   * Find commissions by partner
   *
   * @param partnerId - Partner ID
   * @returns Array of commissions
   */
  async findByPartner(partnerId: string): Promise<Commission[]> {
    return await this.list({
      where: { partnerId },
      orderBy: 'event_timestamp DESC',
    });
  }

  /**
   * Find commissions by ad event
   *
   * @param eventId - Ad Event ID
   * @returns Array of commissions
   */
  async findByEvent(eventId: string): Promise<Commission[]> {
    return await this.list({
      where: { eventId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find commissions by payout
   *
   * @param payoutId - Payout ID
   * @returns Array of commissions
   */
  async findByPayout(payoutId: string): Promise<Commission[]> {
    return await this.list({
      where: { payoutId },
      orderBy: 'event_timestamp DESC',
    });
  }

  /**
   * Find commissions by status
   *
   * @param status - Commission status
   * @returns Array of commissions
   */
  async findByStatus(status: CommissionStatus): Promise<Commission[]> {
    return await this.list({
      where: { status },
      orderBy: 'event_timestamp DESC',
    });
  }

  /**
   * Find all pending commissions
   */
  async findPending(): Promise<Commission[]> {
    return await this.findByStatus(CommissionStatus.PENDING);
  }

  /**
   * Find pending commissions for a partner
   *
   * @param partnerId - Partner ID
   * @returns Array of pending commissions
   */
  async findPendingByPartner(partnerId: string): Promise<Commission[]> {
    return await this.list({
      where: { partnerId, status: CommissionStatus.PENDING },
      orderBy: 'event_timestamp DESC',
    });
  }

  /**
   * Find commissions by type
   *
   * @param commissionType - Commission type
   * @returns Array of commissions
   */
  async findByType(commissionType: CommissionType): Promise<Commission[]> {
    return await this.list({
      where: { commissionType },
      orderBy: 'event_timestamp DESC',
    });
  }

  /**
   * Find commissions in date range
   *
   * @param start - Start date
   * @param end - End date
   * @returns Array of commissions
   */
  async findByDateRange(start: Date, end: Date): Promise<Commission[]> {
    return await this.list({
      where: {
        'event_timestamp >=': start.toISOString(),
        'event_timestamp <=': end.toISOString(),
      },
      orderBy: 'event_timestamp DESC',
    });
  }

  /**
   * Find commissions for a partner in date range
   *
   * @param partnerId - Partner ID
   * @param start - Start date
   * @param end - End date
   * @returns Array of commissions
   */
  async findByPartnerAndDateRange(
    partnerId: string,
    start: Date,
    end: Date,
  ): Promise<Commission[]> {
    return await this.list({
      where: {
        partnerId,
        'event_timestamp >=': start.toISOString(),
        'event_timestamp <=': end.toISOString(),
      },
      orderBy: 'event_timestamp DESC',
    });
  }

  /**
   * Sum pending commissions for a partner
   *
   * @param partnerId - Partner ID
   * @returns Total pending amount in cents
   */
  async sumPendingByPartner(partnerId: string): Promise<number> {
    const pending = await this.findPendingByPartner(partnerId);
    return pending.reduce((sum, c) => sum + c.commissionAmount, 0);
  }

  /**
   * Sum commissions by type for a partner
   *
   * @param partnerId - Partner ID
   * @param commissionType - Commission type
   * @returns Total amount in cents
   */
  async sumByPartnerAndType(
    partnerId: string,
    commissionType: CommissionType,
  ): Promise<number> {
    const commissions = await this.list({
      where: { partnerId, commissionType },
    });
    return commissions.reduce((sum, c) => sum + c.commissionAmount, 0);
  }

  /**
   * Get earnings breakdown for a partner
   *
   * @param partnerId - Partner ID
   * @returns Breakdown by commission type
   */
  async getEarningsBreakdown(partnerId: string): Promise<{
    display: number;
    referral: number;
    sales: number;
    parent: number;
    total: number;
  }> {
    const commissions = await this.findByPartner(partnerId);
    const breakdown = {
      display: 0,
      referral: 0,
      sales: 0,
      parent: 0,
      total: 0,
    };

    for (const c of commissions) {
      if (c.isPaid() || c.isIncluded()) {
        switch (c.commissionType) {
          case CommissionType.DISPLAY:
            breakdown.display += c.commissionAmount;
            break;
          case CommissionType.REFERRAL:
            breakdown.referral += c.commissionAmount;
            break;
          case CommissionType.SALES:
            breakdown.sales += c.commissionAmount;
            break;
          case CommissionType.PARENT:
            breakdown.parent += c.commissionAmount;
            break;
        }
      }
    }

    breakdown.total =
      breakdown.display +
      breakdown.referral +
      breakdown.sales +
      breakdown.parent;
    return breakdown;
  }

  /**
   * Get pending earnings breakdown for a partner
   *
   * @param partnerId - Partner ID
   * @returns Breakdown of pending commissions by type
   */
  async getPendingBreakdown(partnerId: string): Promise<{
    display: number;
    referral: number;
    sales: number;
    parent: number;
    total: number;
  }> {
    const pending = await this.findPendingByPartner(partnerId);
    const breakdown = {
      display: 0,
      referral: 0,
      sales: 0,
      parent: 0,
      total: 0,
    };

    for (const c of pending) {
      switch (c.commissionType) {
        case CommissionType.DISPLAY:
          breakdown.display += c.commissionAmount;
          break;
        case CommissionType.REFERRAL:
          breakdown.referral += c.commissionAmount;
          break;
        case CommissionType.SALES:
          breakdown.sales += c.commissionAmount;
          break;
        case CommissionType.PARENT:
          breakdown.parent += c.commissionAmount;
          break;
      }
    }

    breakdown.total =
      breakdown.display +
      breakdown.referral +
      breakdown.sales +
      breakdown.parent;
    return breakdown;
  }
}
