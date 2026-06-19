/**
 * PaymentAllocation model - maps payments to invoices
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Sub-cent rounding tolerance for over-allocation checks, matching the rest
 * of the package's EPSILON convention.
 */
const ALLOCATION_EPSILON = 0.01;

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
  // NOTE: `create` and `delete` are intentionally NOT exposed over the
  // generated REST/MCP surface (S5 audit #1390). Allocation rows directly
  // determine an invoice's amountPaid/status and a payment's remaining funds;
  // a generated `create` lets a caller forge an allocation that over-applies a
  // payment, and a generated `delete` lets a caller silently un-apply funds —
  // both falsify balances with no authz. Allocations must be created/removed
  // through application code that re-derives invoice status and respects the
  // payment-amount cap (the cap is also enforced in `save()` as defence in
  // depth).
  api: { include: ['list', 'get'] },
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
  @foreignKey('Payment')
  paymentId: string = '';

  /**
   * Invoice receiving the allocation
   */
  @foreignKey('Invoice')
  invoiceId: string = '';

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

  /**
   * Save-time integrity guard (S5 audit #1390):
   *  - allocation `amount` must be a finite, positive number, and
   *  - the sum of all allocations against the referenced Payment (this row
   *    included) must not exceed the Payment's amount — over-applying a
   *    payment across invoices would falsify both payment and invoice
   *    balances.
   *
   * The Payment-amount cap is enforced against the persisted Payment row. An
   * allocation always carries a `@foreignKey('Payment')` paymentId, so a
   * `paymentId` that doesn't resolve to a real Payment is a **hard error** (S5
   * audit #1390 round 2): previously a missing Payment silently skipped the cap
   * entirely, letting a caller over-apply (or fabricate) funds simply by
   * pointing at a non-existent payment. An empty `paymentId` is still rejected
   * by the underlying FK requirement; the positivity check always applies.
   */
  override async save(): Promise<this> {
    if (!Number.isFinite(this.amount) || this.amount <= 0) {
      throw new Error(
        `PaymentAllocation ${this.id ?? '<new>'}: amount must be a positive number (got ${this.amount}).`,
      );
    }

    if (this.paymentId) {
      const { PaymentCollection } = await import(
        '../collections/PaymentCollection.js'
      );
      const payments = await (PaymentCollection as any).create(this.options);
      const payment = await payments.get({ id: this.paymentId });
      if (!payment) {
        throw new Error(
          `PaymentAllocation ${this.id ?? '<new>'}: referenced Payment ` +
            `'${this.paymentId}' does not exist — refusing to allocate against a ` +
            'missing payment (the payment-amount cap cannot be enforced otherwise).',
        );
      }
      const { PaymentAllocationCollection } = await import(
        '../collections/PaymentAllocationCollection.js'
      );
      const allocations = await (PaymentAllocationCollection as any).create(
        this.options,
      );
      const existing = await allocations.findByPayment(this.paymentId);
      const otherTotal = existing.reduce(
        (sum: number, alloc: PaymentAllocation) =>
          alloc.id === this.id ? sum : sum + alloc.amount,
        0,
      );
      if (otherTotal + this.amount - payment.amount > ALLOCATION_EPSILON) {
        throw new Error(
          `PaymentAllocation ${this.id ?? '<new>'}: allocating ${this.amount} would over-apply ` +
            `payment '${this.paymentId}' — already allocated ${otherTotal} of ${payment.amount}.`,
        );
      }
    }

    return super.save() as Promise<this>;
  }
}

export default PaymentAllocation;
