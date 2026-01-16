/**
 * Payout model - Aggregated payout batch for a partner
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { PayoutStatus } from '../types/index.js';
import { Partner } from './Partner.js';

/**
 * Payout represents an aggregated payment batch for a partner.
 *
 * Payouts are created periodically (e.g., monthly) and include
 * all pending commissions for a partner that meet the threshold.
 *
 * References:
 * - partnerId: FK to Partner (within package)
 * - invoiceId: String reference to smrt-commerce Invoice (cross-package)
 *
 * @example
 * ```typescript
 * // Create a payout for a partner
 * const payout = await payouts.create({
 *   partnerId: publisher.id,
 *   periodStart: new Date('2024-01-01'),
 *   periodEnd: new Date('2024-01-31'),
 *   displayEarnings: 25000,  // $250.00
 *   referralEarnings: 500,   // $5.00
 *   salesEarnings: 0,
 *   parentEarnings: 0,
 *   totalAmount: 25500,      // $255.00
 *   currency: 'CAD',
 *   status: PayoutStatus.PENDING
 * });
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class Payout extends SmrtObject {
  /**
   * Partner ID (FK to Partner)
   */
  partnerId = foreignKey(Partner);

  /**
   * Period start date
   */
  periodStart: Date = new Date();

  /**
   * Period end date
   */
  periodEnd: Date = new Date();

  /**
   * Total display earnings in cents
   */
  displayEarnings: number = 0;

  /**
   * Total referral earnings in cents
   */
  referralEarnings: number = 0;

  /**
   * Total sales earnings in cents
   */
  salesEarnings: number = 0;

  /**
   * Total parent earnings in cents (from site-attached salespeople)
   */
  parentEarnings: number = 0;

  /**
   * Total payout amount in cents
   * = displayEarnings + referralEarnings + salesEarnings + parentEarnings
   */
  totalAmount: number = 0;

  /**
   * Currency code
   * Defaults to CAD
   */
  currency: string = 'CAD';

  /**
   * Invoice ID when payout is processed (FK to smrt-commerce Invoice)
   * Partner is treated as a Vendor for payout invoices
   */
  invoiceId: string = '';

  /**
   * Payout status
   */
  status: PayoutStatus = PayoutStatus.PENDING;

  /**
   * Payment reference (check number, transfer ID, etc.)
   */
  paymentReference: string = '';

  /**
   * Date payment was processed
   */
  paidAt: Date | null = null;

  /**
   * Notes from admin (approval notes, issues, etc.)
   */
  notes: string = '';

  /**
   * Additional metadata as JSON string
   */
  metadata: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.partnerId !== undefined) this.partnerId = options.partnerId;
    if (options.periodStart !== undefined)
      this.periodStart = options.periodStart;
    if (options.periodEnd !== undefined) this.periodEnd = options.periodEnd;
    if (options.displayEarnings !== undefined)
      this.displayEarnings = options.displayEarnings;
    if (options.referralEarnings !== undefined)
      this.referralEarnings = options.referralEarnings;
    if (options.salesEarnings !== undefined)
      this.salesEarnings = options.salesEarnings;
    if (options.parentEarnings !== undefined)
      this.parentEarnings = options.parentEarnings;
    if (options.totalAmount !== undefined)
      this.totalAmount = options.totalAmount;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.invoiceId !== undefined) this.invoiceId = options.invoiceId;
    if (options.status !== undefined) this.status = options.status;
    if (options.paymentReference !== undefined)
      this.paymentReference = options.paymentReference;
    if (options.paidAt !== undefined) this.paidAt = options.paidAt;
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Check if payout is pending approval
   */
  isPending(): boolean {
    return this.status === PayoutStatus.PENDING;
  }

  /**
   * Check if payout is approved (waiting for processing)
   */
  isApproved(): boolean {
    return this.status === PayoutStatus.APPROVED;
  }

  /**
   * Check if payout is being processed
   */
  isProcessing(): boolean {
    return this.status === PayoutStatus.PROCESSING;
  }

  /**
   * Check if payout is completed
   */
  isCompleted(): boolean {
    return this.status === PayoutStatus.COMPLETED;
  }

  /**
   * Check if payout failed
   */
  isFailed(): boolean {
    return this.status === PayoutStatus.FAILED;
  }

  /**
   * Get total amount in dollars (for display)
   */
  getTotalInDollars(): number {
    return this.totalAmount / 100;
  }

  /**
   * Get display earnings in dollars
   */
  getDisplayEarningsInDollars(): number {
    return this.displayEarnings / 100;
  }

  /**
   * Get referral earnings in dollars
   */
  getReferralEarningsInDollars(): number {
    return this.referralEarnings / 100;
  }

  /**
   * Get sales earnings in dollars
   */
  getSalesEarningsInDollars(): number {
    return this.salesEarnings / 100;
  }

  /**
   * Get parent earnings in dollars
   */
  getParentEarningsInDollars(): number {
    return this.parentEarnings / 100;
  }

  /**
   * Calculate total from component earnings
   */
  calculateTotal(): number {
    return (
      this.displayEarnings +
      this.referralEarnings +
      this.salesEarnings +
      this.parentEarnings
    );
  }

  /**
   * Get period as human-readable string
   */
  getPeriodString(): string {
    const start = this.periodStart.toISOString().split('T')[0];
    const end = this.periodEnd.toISOString().split('T')[0];
    return `${start} to ${end}`;
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

  // ============================================================================
  // Status Transitions
  // ============================================================================

  /**
   * Approve the payout for processing
   *
   * @throws Error if payout is not in pending status
   */
  approve(): void {
    if (this.status !== PayoutStatus.PENDING) {
      throw new Error(
        `Cannot approve payout with status '${this.status}'. Only pending payouts can be approved.`,
      );
    }
    this.status = PayoutStatus.APPROVED;
  }

  /**
   * Mark payout as processing (payment in progress)
   *
   * @throws Error if payout is not in approved status
   */
  markProcessing(): void {
    if (this.status !== PayoutStatus.APPROVED) {
      throw new Error(
        `Cannot mark payout as processing with status '${this.status}'. Only approved payouts can be processed.`,
      );
    }
    this.status = PayoutStatus.PROCESSING;
  }

  /**
   * Mark payout as completed
   *
   * @param paymentReference - Payment reference (check number, transfer ID, etc.)
   * @throws Error if payout is not in processing status
   */
  complete(paymentReference: string): void {
    if (this.status !== PayoutStatus.PROCESSING) {
      throw new Error(
        `Cannot complete payout with status '${this.status}'. Only processing payouts can be completed.`,
      );
    }
    this.status = PayoutStatus.COMPLETED;
    this.paymentReference = paymentReference;
    this.paidAt = new Date();
  }

  /**
   * Mark payout as failed
   *
   * @param reason - Reason for failure (stored in notes)
   */
  fail(reason: string): void {
    if (
      this.status !== PayoutStatus.APPROVED &&
      this.status !== PayoutStatus.PROCESSING
    ) {
      throw new Error(
        `Cannot fail payout with status '${this.status}'. Only approved or processing payouts can fail.`,
      );
    }
    this.status = PayoutStatus.FAILED;
    this.notes = reason;
  }
}

export default Payout;
