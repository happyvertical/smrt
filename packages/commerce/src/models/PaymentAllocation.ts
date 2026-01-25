/**
 * PaymentAllocation model - maps payments to invoices
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { Invoice } from './Invoice.js';
import { Payment } from './Payment.js';

/**
 * PaymentAllocation tracks how payments are applied to invoices.
 *
 * This enables:
 * - Partial payments (one payment partially covering an invoice)
 * - Split payments (one payment split across multiple invoices)
 * - Payment history per invoice
 *
 * **Note**: This model does not automatically validate that allocations
 * don't exceed the payment amount or invoice amount due. Use
 * `PaymentAllocationCollection.getUnallocatedFromPayment()` before creating
 * allocations to ensure sufficient funds are available.
 *
 * @example
 * ```typescript
 * import { PaymentAllocationCollection } from '@happyvertical/smrt-commerce';
 *
 * // Get the collection
 * const allocations = await PaymentAllocationCollection.create(options);
 *
 * // Check available funds before allocating
 * const available = await allocations.getUnallocatedFromPayment(
 *   payment.id,
 *   payment.amount
 * );
 *
 * if (available >= amountToAllocate) {
 *   const allocation = await allocations.create({
 *     paymentId: payment.id,
 *     invoiceId: invoice.id,
 *     amount: amountToAllocate,
 *     allocatedBy: 'user-uuid'
 *   });
 *
 *   // Update invoice payment status
 *   const totalAllocated = await allocations.getTotalAllocatedToInvoice(invoice.id);
 *   invoice.updatePaymentStatus(totalAllocated);
 *   await invoice.save();
 * }
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class PaymentAllocation extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global payment allocations
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Payment being allocated
   */
  paymentId = foreignKey(Payment);

  /**
   * Invoice receiving the allocation
   */
  invoiceId = foreignKey(Invoice);

  /**
   * Amount allocated from payment to invoice
   */
  amount: number = 0;

  /**
   * When the allocation was made
   */
  allocatedAt: Date = new Date();

  /**
   * User/agent who made the allocation
   */
  allocatedBy: string = '';

  /**
   * Notes about the allocation
   */
  notes: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.paymentId !== undefined) this.paymentId = options.paymentId;
    if (options.invoiceId !== undefined) this.invoiceId = options.invoiceId;
    if (options.amount !== undefined) this.amount = options.amount;
    if (options.allocatedAt !== undefined)
      this.allocatedAt = options.allocatedAt;
    if (options.allocatedBy !== undefined)
      this.allocatedBy = options.allocatedBy;
    if (options.notes !== undefined) this.notes = options.notes;
  }
}

export default PaymentAllocation;
