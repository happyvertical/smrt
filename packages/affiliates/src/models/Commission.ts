/**
 * Commission model - Revenue attribution per ad event
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { CommissionStatus, CommissionType } from '../types/index.js';

/**
 * Commission tracks revenue attribution from ad events to partners.
 *
 * Each ad event can generate multiple commissions:
 * - Display commission to publisher (site owner)
 * - Referral commission to referrer (who brought in the publisher)
 * - Sales commission to salesperson (who brought in the advertiser)
 * - Parent commission to salesperson's parent publisher
 *
 * References:
 * - eventId: String reference to smrt-ads AdEvent (cross-package)
 * - partnerId: FK to Partner (within package)
 * - payoutId: FK to Payout (within package)
 *
 * @example
 * ```typescript
 * // Create display commission for a publisher
 * const commission = await commissions.create({
 *   eventId: 'adevent-uuid',
 *   partnerId: publisher.id,
 *   commissionType: CommissionType.DISPLAY,
 *   grossRevenue: 100,  // 1 cent = $0.01
 *   commissionRate: 0.50,
 *   commissionAmount: 50,  // 0.5 cents
 *   currency: 'CAD',
 *   status: CommissionStatus.PENDING
 * });
 * ```
 */
@smrt({
  api: { include: ['create', 'list', 'get'] }, // No delete (audit trail)
  mcp: { include: ['create', 'list'] },
  cli: false, // High volume, not useful in CLI
})
export class Commission extends SmrtObject {
  /**
   * Calculate commission amount from gross revenue and rate
   *
   * @param grossRevenue - Gross revenue in cents
   * @param rate - Commission rate (0-1)
   * @returns Commission amount in cents (rounded)
   *
   * @example
   * ```typescript
   * const amount = Commission.calculateAmount(1000, 0.50); // 500 cents
   * ```
   */
  static calculateAmount(grossRevenue: number, rate: number): number {
    return Math.round(grossRevenue * rate);
  }
  /**
   * Ad Event ID (FK to smrt-ads AdEvent, cross-package)
   */
  eventId: string = '';

  /**
   * Partner ID (FK to Partner)
   */
  @foreignKey('Partner')
  partnerId: string = '';

  /**
   * Commission type (display, referral, sales, parent)
   */
  commissionType: CommissionType = CommissionType.DISPLAY;

  /**
   * Gross revenue from the event in cents
   * This is the total ad revenue before commission split
   */
  grossRevenue: number = 0;

  /**
   * Commission rate applied (0-1)
   * Copied from partner at time of event for audit trail
   */
  commissionRate: number = 0;

  /**
   * Calculated commission amount in cents
   * = grossRevenue * commissionRate
   */
  commissionAmount: number = 0;

  /**
   * Currency code
   * Defaults to CAD
   */
  currency: string = 'CAD';

  /**
   * Payout ID when commission is included in a payout
   */
  @foreignKey('Payout')
  payoutId: string = '';

  /**
   * Commission status
   */
  status: CommissionStatus = CommissionStatus.PENDING;

  /**
   * Event timestamp (copied from AdEvent for reporting)
   */
  eventTimestamp: Date = new Date();

  /**
   * Additional metadata as JSON string
   */
  metadata: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.eventId !== undefined) this.eventId = options.eventId;
    if (options.partnerId !== undefined) this.partnerId = options.partnerId;
    if (options.commissionType !== undefined)
      this.commissionType = options.commissionType;
    if (options.grossRevenue !== undefined)
      this.grossRevenue = options.grossRevenue;
    if (options.commissionRate !== undefined)
      this.commissionRate = options.commissionRate;
    if (options.commissionAmount !== undefined)
      this.commissionAmount = options.commissionAmount;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.payoutId !== undefined) this.payoutId = options.payoutId;
    if (options.status !== undefined) this.status = options.status;
    if (options.eventTimestamp !== undefined)
      this.eventTimestamp = options.eventTimestamp;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Check if commission is pending (not yet in a payout)
   */
  isPending(): boolean {
    return this.status === CommissionStatus.PENDING;
  }

  /**
   * Check if commission is included in a payout
   */
  isIncluded(): boolean {
    return this.status === CommissionStatus.INCLUDED;
  }

  /**
   * Check if commission has been paid
   */
  isPaid(): boolean {
    return this.status === CommissionStatus.PAID;
  }

  /**
   * Check if this is a display commission
   */
  isDisplay(): boolean {
    return this.commissionType === CommissionType.DISPLAY;
  }

  /**
   * Check if this is a referral commission
   */
  isReferral(): boolean {
    return this.commissionType === CommissionType.REFERRAL;
  }

  /**
   * Check if this is a sales commission
   */
  isSales(): boolean {
    return this.commissionType === CommissionType.SALES;
  }

  /**
   * Check if this is a parent commission
   */
  isParent(): boolean {
    return this.commissionType === CommissionType.PARENT;
  }

  /**
   * Get commission amount in dollars (for display)
   */
  getAmountInDollars(): number {
    return this.commissionAmount / 100;
  }

  /**
   * Get gross revenue in dollars (for display)
   */
  getGrossRevenueInDollars(): number {
    return this.grossRevenue / 100;
  }

  /**
   * Get metadata as object
   */
  getMetadata(): Record<string, any> {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  /**
   * Set metadata from object
   */
  setMetadata(data: Record<string, any>): void {
    this.metadata = JSON.stringify(data);
  }
}

export default Commission;
