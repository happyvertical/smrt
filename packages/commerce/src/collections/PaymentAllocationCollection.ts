/**
 * PaymentAllocationCollection - Collection manager for PaymentAllocation objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { customerFundsState } from '../customer-funds-internal.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';

export class PaymentAllocationCollection extends SmrtCollection<PaymentAllocation> {
  static readonly _itemClass = PaymentAllocation;

  /**
   * Apply a payment to several invoices atomically. Callers supply stable UUID
   * allocation ids: exact replays reuse rows; reusing an id with other money
   * or parents fails. Actor authorization remains the application's job.
   */
  async allocatePayment(input: {
    paymentId: string;
    allocations: { id: string; invoiceId: string; amount: number }[];
    allocatedBy?: string;
  }): Promise<PaymentAllocation[]> {
    if (
      !input.allocations.length ||
      new Set(input.allocations.map((item) => item.id)).size !==
        input.allocations.length
    ) {
      throw new Error(
        'Allocation batch requires distinct stable allocation ids',
      );
    }
    const { PaymentCollection } = await import('./PaymentCollection.js');
    const { InvoiceCollection } = await import('./InvoiceCollection.js');
    const { InvoiceStatus } = await import('../types/index.js');
    const payments = await PaymentCollection.create({ db: this.db });
    const payment = await payments.get(
      { id: input.paymentId },
      { cache: false },
    );
    if (!payment) throw new Error('Payment does not exist');
    const committed = await payment.withTransaction(async () => {
      if (!payment.updated_at)
        throw new Error('Allocation parent has no persisted revision');
      await payment.claimRevision(payment.updated_at);
      const allocations = await PaymentAllocationCollection.create({
        db: payment.db,
      });
      const invoices = await InvoiceCollection.create({ db: payment.db });
      const result: PaymentAllocation[] = [];
      for (const item of [...input.allocations].sort(
        (a, b) =>
          a.invoiceId.localeCompare(b.invoiceId) || a.id.localeCompare(b.id),
      )) {
        if (!item.id) throw new Error('Allocation requires a stable id');
        const existing = await allocations.get(
          { id: item.id },
          { cache: false },
        );
        if (existing) {
          if (
            existing.paymentId !== input.paymentId ||
            existing.invoiceId !== item.invoiceId ||
            existing.amount !== item.amount ||
            existing.tenantId !== payment.tenantId
          ) {
            throw new Error(
              'Allocation replay does not match existing allocation',
            );
          }
          result.push(existing);
        } else {
          result.push(
            await allocations.create({
              ...item,
              paymentId: input.paymentId,
              tenantId: payment.tenantId,
              allocatedBy: input.allocatedBy ?? '',
              _insertOnly: true,
            }),
          );
        }
      }
      for (const invoiceId of [
        ...new Set(input.allocations.map((item) => item.invoiceId)),
      ].sort()) {
        const invoice = await invoices.get({ id: invoiceId }, { cache: false });
        if (!invoice) throw new Error('Invoice does not exist');
        if (invoice.status !== InvoiceStatus.WRITTEN_OFF)
          invoice.updatePaymentStatus(
            await allocations.getTotalAllocatedToInvoice(invoiceId),
          );
        await invoice.save();
      }
      return result;
    });
    // Child objects created on the transaction cannot escape with its closed
    // executor. Hydrate results on the caller's executor (possibly an outer tx).
    return Promise.all(
      committed.map(async ({ id }) => {
        const allocation = await this.get({ id: String(id) }, { cache: false });
        if (!allocation)
          throw new Error('Committed allocation no longer exists');
        return allocation;
      }),
    );
  }

  /** Remove one allocation atomically and rederive its invoice/credit status. */
  async removeAllocation(id: string): Promise<void> {
    const allocation = await this.get({ id }, { cache: false });
    if (!allocation) return;
    const { PaymentCollection } = await import('./PaymentCollection.js');
    const { InvoiceCollection } = await import('./InvoiceCollection.js');
    const payment = await (await PaymentCollection.create({ db: this.db })).get(
      { id: allocation.paymentId },
      { cache: false },
    );
    if (!payment) throw new Error('Allocation payment does not exist');
    await payment.withTransaction(async () => {
      const rows = await PaymentAllocationCollection.create({ db: payment.db });
      const current = await rows.get({ id }, { cache: false });
      if (!current) return;
      const invoices = await InvoiceCollection.create({ db: payment.db });
      const invoice = await invoices.get(
        { id: current.invoiceId },
        { cache: false },
      );
      if (!invoice) throw new Error('Allocation invoice does not exist');
      await current.delete();
      invoice.updatePaymentStatus(
        await rows.getTotalAllocatedToInvoice(current.invoiceId),
      );
      await invoice.save();
    });
  }

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
   * Get remaining unallocated amount from a payment.
   *
   * @param paymentId - Payment ID
   * @param paymentAmount - Total payment amount
   * @returns Unallocated amount
   * @throws Error if payment is over-allocated (indicates data integrity issue)
   */
  async getUnallocatedFromPayment(
    paymentId: string,
    paymentAmount: number,
  ): Promise<number> {
    const allocated = await this.getTotalAllocatedFromPayment(paymentId);
    const { PaymentCollection } = await import('./PaymentCollection.js');
    const payment = await (await PaymentCollection.create({ db: this.db })).get(
      { id: paymentId },
      { cache: false },
    );
    const managed = customerFundsState(payment?.customerFundsJson);
    if (
      managed &&
      (managed.kind !== 'receipt' || payment?.amount !== paymentAmount)
    )
      throw new Error(
        'Customer funds require their authoritative receipt amount',
      );
    const refunded =
      managed?.operations
        .filter((op) => op.kind === 'refund')
        .reduce((sum, op) => sum + BigInt(op.amountMinor), 0n) ?? 0n;
    const remaining = Number(
      BigInt(paymentAmount) - BigInt(allocated) - refunded,
    );

    if (remaining < 0) {
      throw new Error(
        `Over-allocated payment detected for paymentId=${paymentId}: ` +
          `allocated amount (${allocated}) exceeds payment amount (${paymentAmount})`,
      );
    }

    return remaining;
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

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all payment allocations belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of payment allocations for the tenant
   */
  async findByTenant(tenantId: string): Promise<PaymentAllocation[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global payment allocations (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global payment allocations
   */
  async findGlobal(): Promise<PaymentAllocation[]> {
    return queryGlobal<PaymentAllocation>(this);
  }

  /**
   * Find payment allocations for a tenant including global allocations.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global payment allocations
   */
  async findWithGlobals(tenantId: string): Promise<PaymentAllocation[]> {
    return queryWithGlobals<PaymentAllocation>(
      this,
      tenantId,
      'PaymentAllocation.findWithGlobals',
    );
  }
}
