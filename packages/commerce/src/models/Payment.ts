/**
 * Payment model - tracks payments with ledger integration
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  PaymentMethod,
  PaymentStatus,
  type RecordPaymentOptions,
} from '../types/index.js';
import { Contract } from './Contract.js';
import { Customer } from './Customer.js';

/**
 * Payment represents a financial transaction against a contract.
 *
 * Payments can be integrated with smrt-ledgers to automatically
 * create balanced journal entries for proper accounting.
 *
 * @example
 * ```typescript
 * // Create a payment
 * const payment = await payments.create({
 *   contractId: order.id,
 *   customerId: customer.id,
 *   amount: 1500.00,
 *   method: PaymentMethod.CREDIT_CARD,
 *   transactionId: 'stripe_pi_123456'
 * });
 *
 * // Record with ledger integration
 * await payment.recordPayment({
 *   ledgerId: ledger.id,
 *   receivablesAccountId: arAccount.id,
 *   cashAccountId: bankAccount.id
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'recordPayment'] },
  cli: true,
})
export class Payment extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global payments
   */
  tenantId = tenantId({ nullable: true });
  /**
   * Contract this payment is for
   */
  contractId = foreignKey(Contract);

  /**
   * Customer who made the payment
   */
  customerId = foreignKey(Customer);

  /**
   * Payment amount
   */
  amount: number = 0.0;

  /**
   * Currency code (ISO 4217)
   */
  currency: string = 'USD';

  /**
   * Payment method used
   */
  method: PaymentMethod = PaymentMethod.BANK_TRANSFER;

  /**
   * Current payment status
   */
  status: PaymentStatus = PaymentStatus.PENDING;

  /**
   * External transaction ID (from payment processor)
   */
  transactionId: string = '';

  /**
   * Internal reference number
   */
  reference: string = '';

  /**
   * Link to smrt-ledgers Journal (created by recordPayment)
   */
  journalId: string = '';

  /**
   * When the payment was completed
   */
  paidAt: Date | null = null;

  /**
   * Notes about the payment
   */
  notes: string = '';

  // ============================================================================
  // Provider Sync
  // ============================================================================

  /**
   * External ID in accounting provider (e.g., QBO payment ID)
   */
  externalId: string = '';

  /**
   * Accounting provider name ('quickbooks' | 'stripe' | 'paypal' | etc.)
   */
  externalProvider: string = '';

  /**
   * When payment was last synced to provider
   */
  syncedAt: Date | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.contractId !== undefined) this.contractId = options.contractId;
    if (options.customerId !== undefined) this.customerId = options.customerId;
    if (options.amount !== undefined) this.amount = options.amount;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.method !== undefined) this.method = options.method;
    if (options.status !== undefined) this.status = options.status;
    if (options.transactionId !== undefined)
      this.transactionId = options.transactionId;
    if (options.reference !== undefined) this.reference = options.reference;
    if (options.journalId !== undefined) this.journalId = options.journalId;
    if (options.paidAt !== undefined) this.paidAt = options.paidAt;
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.externalId !== undefined) this.externalId = options.externalId;
    if (options.externalProvider !== undefined)
      this.externalProvider = options.externalProvider;
    if (options.syncedAt !== undefined) this.syncedAt = options.syncedAt;
  }

  /**
   * Check if payment is pending
   */
  isPending(): boolean {
    return this.status === PaymentStatus.PENDING;
  }

  /**
   * Check if payment is completed
   */
  isCompleted(): boolean {
    return this.status === PaymentStatus.COMPLETED;
  }

  /**
   * Check if payment is refunded
   */
  isRefunded(): boolean {
    return this.status === PaymentStatus.REFUNDED;
  }

  /**
   * Record the payment and create a balanced journal entry.
   *
   * Creates a journal entry in smrt-ledgers:
   * - Debit: Cash/Bank account (assets increase)
   * - Credit: Accounts Receivable (receivables decrease)
   *
   * @param options - Ledger and account configuration
   * @returns The created journal
   *
   * @example
   * ```typescript
   * const journal = await payment.recordPayment({
   *   ledgerId: ledger.id,
   *   receivablesAccountId: arAccount.id,
   *   cashAccountId: bankAccount.id
   * });
   * console.log(`Created journal: ${journal.number}`);
   * ```
   */
  async recordPayment(options: RecordPaymentOptions): Promise<any> {
    if (this.status === PaymentStatus.COMPLETED) {
      throw new Error('Payment already recorded');
    }

    if (this.amount <= 0) {
      throw new Error('Payment amount must be positive');
    }

    // Dynamic import to avoid hard dependency on smrt-ledgers
    const { JournalCollection } = await import('@happyvertical/smrt-ledgers');

    // Create the journal collection
    const journalCollection = await (JournalCollection as any).create(
      this.options,
    );

    // Create a new journal for this payment
    const journal = await journalCollection.create({
      date: new Date(),
      description: `Payment received for contract ${this.contractId}`,
      sourceModule: 'smrt-commerce',
      sourceRef: this.id,
    });
    await journal.save();

    // Add balanced entries:
    // Debit Cash/Bank (assets increase)
    await journal.addEntry({
      accountId: options.cashAccountId,
      debit: this.amount,
      memo: `Payment ${this.reference || this.id}`,
    });

    // Credit Accounts Receivable (receivables decrease)
    await journal.addEntry({
      accountId: options.receivablesAccountId,
      credit: this.amount,
      memo: `Payment ${this.reference || this.id}`,
    });

    // Post the journal (validates balance and finalizes)
    await journal.post();

    // Update payment record
    this.journalId = journal.id;
    this.status = PaymentStatus.COMPLETED;
    this.paidAt = new Date();
    await this.save();

    return journal;
  }

  /**
   * Get the linked journal entry (if recorded)
   */
  async getJournal(): Promise<any | null> {
    if (!this.journalId) return null;

    try {
      const { JournalCollection } = await import('@happyvertical/smrt-ledgers');
      const collection = await (JournalCollection as any).create(this.options);
      return await collection.get({ id: this.journalId });
    } catch {
      // smrt-ledgers not available
      return null;
    }
  }

  /**
   * Mark payment as failed
   */
  markFailed(reason?: string): void {
    this.status = PaymentStatus.FAILED;
    if (reason) {
      this.notes = `${this.notes ? `${this.notes}\n` : ''}Failed: ${reason}`;
    }
  }

  /**
   * Cancel the payment
   */
  cancel(): void {
    if (this.status === PaymentStatus.COMPLETED) {
      throw new Error('Cannot cancel a completed payment. Use refund instead.');
    }
    this.status = PaymentStatus.CANCELLED;
  }
}

export default Payment;
