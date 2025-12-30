/**
 * PaymentAllocationCollection - Collection manager for PaymentAllocation objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { PaymentAllocation } from '../models/PaymentAllocation.js';

export class PaymentAllocationCollection extends SmrtCollection<PaymentAllocation> {
  static readonly _itemClass = PaymentAllocation;

  /**
   * Find allocations by payment
   *
   * @param paymentId - Payment ID
   * @returns Array of allocations
   */
  async findByPayment(paymentId: string): Promise<PaymentAllocation[]> {
    return await this.list({
      where: { paymentId },
      orderBy: 'allocatedAt DESC',
    });
  }

  /**
   * Find allocations by invoice
   *
   * @param invoiceId - Invoice ID
   * @returns Array of allocations
   */
  async findByInvoice(invoiceId: string): Promise<PaymentAllocation[]> {
    return await this.list({
      where: { invoiceId },
      orderBy: 'allocatedAt DESC',
    });
  }

  /**
   * Get total amount allocated to an invoice
   *
   * @param invoiceId - Invoice ID
   * @returns Total allocated amount
   */
  async getTotalAllocatedToInvoice(invoiceId: string): Promise<number> {
    const allocations = await this.findByInvoice(invoiceId);
    return allocations.reduce((sum, alloc) => sum + alloc.amount, 0);
  }

  /**
   * Get total amount allocated from a payment
   *
   * @param paymentId - Payment ID
   * @returns Total allocated amount
   */
  async getTotalAllocatedFromPayment(paymentId: string): Promise<number> {
    const allocations = await this.findByPayment(paymentId);
    return allocations.reduce((sum, alloc) => sum + alloc.amount, 0);
  }

  /**
   * Get remaining unallocated amount from a payment
   *
   * @param paymentId - Payment ID
   * @param paymentAmount - Total payment amount
   * @returns Unallocated amount
   */
  async getUnallocatedFromPayment(
    paymentId: string,
    paymentAmount: number,
  ): Promise<number> {
    const allocated = await this.getTotalAllocatedFromPayment(paymentId);
    return Math.max(0, paymentAmount - allocated);
  }

  /**
   * Find allocation by payment and invoice
   *
   * @param paymentId - Payment ID
   * @param invoiceId - Invoice ID
   * @returns Allocation or null
   */
  async findByPaymentAndInvoice(
    paymentId: string,
    invoiceId: string,
  ): Promise<PaymentAllocation | null> {
    const results = await this.list({
      where: { paymentId, invoiceId },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Find allocations by allocator
   *
   * @param allocatedBy - User/agent ID who made the allocation
   * @returns Array of allocations
   */
  async findByAllocator(allocatedBy: string): Promise<PaymentAllocation[]> {
    return await this.list({
      where: { allocatedBy },
      orderBy: 'allocatedAt DESC',
    });
  }

  /**
   * Find allocations in date range
   *
   * @param startDate - Start date
   * @param endDate - End date
   * @returns Array of allocations
   */
  async findByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<PaymentAllocation[]> {
    return await this.list({
      where: {
        'allocatedAt >=': startDate.toISOString(),
        'allocatedAt <=': endDate.toISOString(),
      },
      orderBy: 'allocatedAt DESC',
    });
  }
}
