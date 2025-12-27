/**
 * PaymentCollection - Collection manager for Payment objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Payment } from '../models/Payment.js';
import { type PaymentMethod, PaymentStatus } from '../types/index.js';

export class PaymentCollection extends SmrtCollection<Payment> {
  static readonly _itemClass = Payment;

  /**
   * Find payments by contract
   *
   * @param contractId - Contract ID
   * @returns Array of payments
   */
  async findByContract(contractId: string): Promise<Payment[]> {
    return await this.list({
      where: { contractId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find payments by customer
   *
   * @param customerId - Customer ID
   * @returns Array of payments
   */
  async findByCustomer(customerId: string): Promise<Payment[]> {
    return await this.list({
      where: { customerId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find payments by status
   *
   * @param status - Payment status
   * @returns Array of payments
   */
  async findByStatus(status: PaymentStatus): Promise<Payment[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find payments by method
   *
   * @param method - Payment method
   * @returns Array of payments
   */
  async findByMethod(method: PaymentMethod): Promise<Payment[]> {
    return await this.list({
      where: { method },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all pending payments
   *
   * @returns Array of pending payments
   */
  async findPending(): Promise<Payment[]> {
    return await this.findByStatus(PaymentStatus.PENDING);
  }

  /**
   * Find all completed payments
   *
   * @returns Array of completed payments
   */
  async findCompleted(): Promise<Payment[]> {
    return await this.findByStatus(PaymentStatus.COMPLETED);
  }

  /**
   * Find payment by transaction ID
   *
   * @param transactionId - External transaction ID
   * @returns Payment or null
   */
  async findByTransactionId(transactionId: string): Promise<Payment | null> {
    const results = await this.list({
      where: { transactionId },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Find payments in date range
   *
   * @param startDate - Start date
   * @param endDate - End date
   * @returns Array of payments
   */
  async findByDateRange(startDate: Date, endDate: Date): Promise<Payment[]> {
    return await this.list({
      where: {
        'paidAt >=': startDate.toISOString(),
        'paidAt <=': endDate.toISOString(),
      },
      orderBy: 'paidAt DESC',
    });
  }

  /**
   * Calculate total payments for a contract
   *
   * @param contractId - Contract ID
   * @returns Total amount paid
   */
  async getTotalForContract(contractId: string): Promise<number> {
    const payments = await this.list({
      where: {
        contractId,
        status: PaymentStatus.COMPLETED,
      },
    });

    return payments.reduce((sum, payment) => sum + payment.amount, 0);
  }

  /**
   * Find payments linked to a ledger journal
   *
   * @param journalId - Journal ID from smrt-ledgers
   * @returns Payment or null
   */
  async findByJournal(journalId: string): Promise<Payment | null> {
    const results = await this.list({
      where: { journalId },
      limit: 1,
    });
    return results[0] || null;
  }
}
