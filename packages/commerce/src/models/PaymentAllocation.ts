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
  //
  // CLI parity (round 6, codex ROOT INSIGHT): the CLI is an independently
  // configured write surface. `cli: true` would still generate create/update/
  // delete commands that forge or un-apply allocations, re-opening the exact
  // vector closed on api/mcp. The CLI is locked to the same read-only surface.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
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
   * Save-time integrity guard (S5 audit #1390 + follow-up):
   *  - allocation `amount` must be a finite, positive number,
   *  - the sum of all allocations against the referenced Payment (this row
   *    included) must not exceed the Payment's amount — over-applying a
   *    payment across invoices would falsify both payment and invoice
   *    balances, and
   *  - the sum of all allocations against the referenced Invoice (this row
   *    included) must not exceed the Invoice's `totalAmount`.
   *
   * The Payment-amount cap is enforced against the persisted Payment row. An
   * allocation always carries a `@foreignKey('Payment')` paymentId, so a
   * `paymentId` that doesn't resolve to a real Payment is a **hard error** (S5
   * audit #1390 round 2): previously a missing Payment silently skipped the cap
   * entirely, letting a caller over-apply (or fabricate) funds simply by
   * pointing at a non-existent payment. An empty `paymentId` is still rejected
   * by the underlying FK requirement; the positivity check always applies.
   *
   * The Invoice-total cap (follow-up) closes a complementary hole: the
   * per-Payment cap lets allocations from *different* payments each pass their
   * own check while jointly summing above the invoice total. The next
   * `Invoice.save()` would then recompute `amountPaid` from these allocations,
   * trip `assertNonNegativeAmounts` (amountPaid > totalAmount), and leave the
   * invoice permanently unsaveable while the over-allocations persist. Capping
   * here keeps allocations from ever exceeding what the invoice owes. The cap
   * is skipped only when the invoice row can't be resolved (e.g. ledger-less /
   * not-yet-persisted) so it never blocks an otherwise-valid allocation.
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

    if (this.invoiceId) {
      const { InvoiceCollection } = await import(
        '../collections/InvoiceCollection.js'
      );
      const invoices = await (InvoiceCollection as any).create(this.options);
      const invoice = await invoices.get({ id: this.invoiceId });
      // Only enforce when the invoice resolves and carries a real positive
      // total — a missing/zero-total invoice (not yet persisted, ledger-less
      // test fixture) skips the cap rather than blocking a valid allocation.
      // `Number.isFinite(0)` is `true`, so the prior `isFinite` guard wrongly
      // capped a freshly-created total=0 invoice at 0 and rejected every
      // allocation against it; gate on `> ALLOCATION_EPSILON` to match the
      // documented "zero/missing total skips the cap" intent.
      if (invoice && invoice.totalAmount > ALLOCATION_EPSILON) {
        const { PaymentAllocationCollection } = await import(
          '../collections/PaymentAllocationCollection.js'
        );
        const allocations = await (PaymentAllocationCollection as any).create(
          this.options,
        );
        const existingForInvoice = await allocations.findByInvoice(
          this.invoiceId,
        );
        const otherInvoiceTotal = existingForInvoice.reduce(
          (sum: number, alloc: PaymentAllocation) =>
            alloc.id === this.id ? sum : sum + alloc.amount,
          0,
        );
        if (
          otherInvoiceTotal + this.amount - invoice.totalAmount >
          ALLOCATION_EPSILON
        ) {
          throw new Error(
            `PaymentAllocation ${this.id ?? '<new>'}: allocating ${this.amount} would over-pay ` +
              `invoice '${this.invoiceId}' — already allocated ${otherInvoiceTotal} of ` +
              `${invoice.totalAmount}.`,
          );
        }
      }
    }

    return super.save() as Promise<this>;
  }
}

export default PaymentAllocation;
