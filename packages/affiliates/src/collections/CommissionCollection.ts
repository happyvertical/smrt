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

  // --- Network-scoped queries ---

  /**
   * Find all commissions for a network
   *
   * @param networkId - Network ID
   * @returns Array of commissions
   */
  async findByNetwork(networkId: string): Promise<Commission[]> {
    return await this.list({
      where: { networkId },
      orderBy: 'event_timestamp DESC',
    });
  }

  /**
   * Find commissions for a network filtered by type
   *
   * @param networkId - Network ID
   * @param commissionType - Commission type
   * @returns Array of commissions
   */
  async findByNetworkAndType(
    networkId: string,
    commissionType: CommissionType,
  ): Promise<Commission[]> {
    return await this.list({
      where: { networkId, commissionType },
      orderBy: 'event_timestamp DESC',
    });
  }

  /**
   * Find pending commissions for a network
   *
   * @param networkId - Network ID
   * @returns Array of pending commissions
   */
  async findPendingByNetwork(networkId: string): Promise<Commission[]> {
    return await this.list({
      where: { networkId, status: CommissionStatus.PENDING },
      orderBy: 'event_timestamp DESC',
    });
  }

  /**
   * Get aggregate summary of commissions by type and site for a network.
   *
   * @param networkId - Network ID
   * @param options - Optional filters (siteId, from, to, commissionType)
   * @returns Summary with byType, bySite, total, and count
   */
  async getSummaryByNetwork(
    networkId: string,
    options: {
      siteId?: string;
      from?: Date;
      to?: Date;
      commissionType?: CommissionType;
    } = {},
  ): Promise<{
    byType: Record<string, number>;
    bySite: Record<string, number>;
    total: number;
    count: number;
  }> {
    const where: Record<string, unknown> = { networkId };
    if (options.siteId) where.siteId = options.siteId;
    if (options.commissionType) where.commissionType = options.commissionType;

    const allCommissions = await this.list({ where });

    // Filter by date range if provided
    const filtered = allCommissions.filter((c) => {
      if (options.from && c.eventTimestamp && c.eventTimestamp < options.from)
        return false;
      if (options.to && c.eventTimestamp && c.eventTimestamp > options.to)
        return false;
      return true;
    });

    const byType: Record<string, number> = {
      overhead: 0,
      display: 0,
      referral: 0,
      sales: 0,
      parent: 0,
    };
    const bySite: Record<string, number> = {};
    let total = 0;

    for (const c of filtered) {
      byType[c.commissionType] =
        (byType[c.commissionType] ?? 0) + c.commissionAmount;
      if (c.siteId) {
        bySite[c.siteId] = (bySite[c.siteId] ?? 0) + c.commissionAmount;
      }
      total += c.commissionAmount;
    }

    return { byType, bySite, total, count: filtered.length };
  }

  /**
   * Get pending commissions grouped by partnerId for a network.
   *
   * @param networkId - Network ID
   * @returns Array of payout groups (partnerId, totalPending, currency, entries)
   */
  async getPendingPayoutsByNetwork(networkId: string): Promise<
    Array<{
      partnerId: string;
      totalPending: number;
      currency: string;
      entryCount: number;
      entries: Array<{
        id: string;
        commissionType: string;
        commissionAmount: number;
        campaignId: string;
        siteId: string;
      }>;
    }>
  > {
    const pending = await this.findPendingByNetwork(networkId);

    // Filter to entries with a partnerId
    const withPartner = pending.filter(
      (c) => c.partnerId && c.partnerId !== '',
    );

    // Group by partnerId
    const grouped = new Map<string, Commission[]>();
    for (const c of withPartner) {
      const existing = grouped.get(c.partnerId) ?? [];
      existing.push(c);
      grouped.set(c.partnerId, existing);
    }

    const payouts = [];
    for (const [partnerId, group] of grouped) {
      const totalPending = group.reduce(
        (sum, c) => sum + c.commissionAmount,
        0,
      );
      const currency = group[0]?.currency ?? 'CAD';

      payouts.push({
        partnerId,
        totalPending,
        currency,
        entryCount: group.length,
        entries: group.map((c) => ({
          id: c.id ?? '',
          commissionType: c.commissionType,
          commissionAmount: c.commissionAmount,
          campaignId: c.campaignId,
          siteId: c.siteId,
        })),
      });
    }

    // Sort by total pending descending
    payouts.sort((a, b) => b.totalPending - a.totalPending);

    return payouts;
  }

  // --- Aggregation queries ---

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
    overhead: number;
    total: number;
  }> {
    const commissions = await this.findByPartner(partnerId);
    const breakdown = {
      display: 0,
      referral: 0,
      sales: 0,
      parent: 0,
      overhead: 0,
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
          case CommissionType.OVERHEAD:
            breakdown.overhead += c.commissionAmount;
            break;
        }
      }
    }

    breakdown.total =
      breakdown.display +
      breakdown.referral +
      breakdown.sales +
      breakdown.parent +
      breakdown.overhead;
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
    overhead: number;
    total: number;
  }> {
    const pending = await this.findPendingByPartner(partnerId);
    const breakdown = {
      display: 0,
      referral: 0,
      sales: 0,
      parent: 0,
      overhead: 0,
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
        case CommissionType.OVERHEAD:
          breakdown.overhead += c.commissionAmount;
          break;
      }
    }

    breakdown.total =
      breakdown.display +
      breakdown.referral +
      breakdown.sales +
      breakdown.parent +
      breakdown.overhead;
    return breakdown;
  }
}
