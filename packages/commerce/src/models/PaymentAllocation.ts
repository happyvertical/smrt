/**
 * PaymentAllocation model - maps payments to invoices
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { allocationOwner, allocationTotal } from '../allocation-integrity.js';
import { calculateAvailableRefund } from '../credit-allocation.js';
import { assertIntegerMinorUnits } from '../money.js';
import type { PaymentAllocationOptions } from '../types/index.js';

/*
 * There is deliberately no `ALLOCATION_EPSILON` here any more (#2401).
 *
 * `Payment.amount`, `Invoice.totalAmount` and this row's `amount` are all
 * integer minor units, so "does this allocation over-apply the payment" is an
 * exact integer question. The old `0.01` tolerance let an allocation exceed its
 * payment by up to a cent — real money, not rounding fuzz — and only existed
 * because the payment side was a float.
 */

/**
 * PaymentAllocation tracks how payments are applied to invoices.
 *
 * This enables:
 * - Partial payments (one payment partially covering an invoice)
 * - Split payments (one payment split across multiple invoices)
 * - Payment history per invoice
 *
 * Saves atomically enforce parent existence, matching tenant/customer/currency,
 * positive safe-integer amounts and both balance caps. Use
 * `PaymentAllocationCollection.allocatePayment()` for atomic splits and replay.
 * Direct saves retain caller-owned invoice status refresh.
 *
 * @example
 * ```typescript
 * import { PaymentAllocationCollection } from '@happyvertical/smrt-commerce';
 *
 * // Get the collection
 * const allocations = await PaymentAllocationCollection.create(options);
 *
 * // Check available funds before allocating (all amounts are minor units)
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
 *   // Reload the revision advanced by the allocation, then update status.
 *   await invoice.loadFromId();
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
  @field({ description: 'The payment being applied.' })
  @foreignKey('Payment')
  paymentId: string = '';

  /**
   * Invoice receiving the allocation
   */
  @field({ description: 'The invoice it settles.' })
  @foreignKey('Invoice')
  invoiceId: string = '';

  /**
   * Amount allocated from payment to invoice, in **integer minor units**
   * (cents, satoshis).
   *
   * Matches `Invoice.amountPaid` (derived by summing these rows) and
   * `Payment.amount` (which `save()` caps against). All three converted
   * together in #2401 — the cap is a subtraction across the pair, so a
   * dollars-vs-cents split there would reject every allocation as
   * over-applying.
   */
  @field({
    description: 'How much of the payment goes to this invoice.',
    ui: { format: 'money' },
  })
  amount: number = 0;

  /**
   * When the allocation was made
   */
  @field({ description: 'When it was applied.' })
  allocatedAt: Date = new Date();

  /**
   * User/agent who made the allocation
   */
  allocatedBy: string = '';

  /**
   * Notes about the allocation
   */
  @field({ description: 'Anything worth remembering about this allocation.' })
  notes: string = '';

  constructor(options: PaymentAllocationOptions = {}) {
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

  /** Save and validate against both claimed parent rows in one transaction. */
  override async save(): Promise<this> {
    assertIntegerMinorUnits('PaymentAllocation', this.id ?? '<new>', [
      ['amount', this.amount],
    ]);
    if (this.amount <= 0)
      throw new Error('PaymentAllocation amount must be a positive number');
    if (!this.paymentId || !this.invoiceId)
      throw new Error('PaymentAllocation requires payment and invoice');
    return this.withTransaction(async () => {
      const { PaymentCollection } = await import(
        '../collections/PaymentCollection.js'
      );
      const { InvoiceCollection } = await import(
        '../collections/InvoiceCollection.js'
      );
      const { PaymentAllocationCollection } = await import(
        '../collections/PaymentAllocationCollection.js'
      );
      const payments = await PaymentCollection.create({ db: this.db });
      const invoices = await InvoiceCollection.create({ db: this.db });
      const allocations = await PaymentAllocationCollection.create({
        db: this.db,
      });
      const prior = this.id
        ? await allocations.get({ id: this.id }, { cache: false })
        : null;
      if (
        prior &&
        (prior.paymentId !== this.paymentId ||
          prior.invoiceId !== this.invoiceId ||
          prior.tenantId !== allocationOwner(this.tenantId))
      ) {
        throw new Error('PaymentAllocation parent identity is immutable');
      }
      const payment = await payments.get(
        { id: this.paymentId },
        { cache: false },
      );
      if (!payment)
        throw new Error('PaymentAllocation referenced Payment does not exist');
      if (!payment.updated_at)
        throw new Error('Allocation parent has no persisted revision');
      await payment.claimRevision(payment.updated_at);
      const invoice = await invoices.get(
        { id: this.invoiceId },
        { cache: false },
      );
      if (!invoice)
        throw new Error('PaymentAllocation referenced Invoice does not exist');
      if (!invoice.updated_at)
        throw new Error('Allocation parent has no persisted revision');
      await invoice.claimRevision(invoice.updated_at);
      const owner = allocationOwner(this.tenantId);
      if (
        payment.tenantId !== owner ||
        invoice.tenantId !== owner ||
        (payment.customerId || null) !== (invoice.customerId || null) ||
        payment.currency !== invoice.currency
      ) {
        throw new Error(
          'PaymentAllocation requires matching tenant, customer and currency',
        );
      }
      if (
        (payment.kind === 'refund' && invoice.kind !== 'credit_note') ||
        (payment.kind === 'payment' && invoice.kind !== 'invoice')
      )
        throw new Error(
          'PaymentAllocation requires payments on invoices and refunds on credit notes',
        );
      const paymentTotal =
        allocationTotal(
          await allocations.findByPayment(this.paymentId),
          this.id,
        ) + BigInt(this.amount);
      const invoiceTotal =
        allocationTotal(
          await allocations.findByInvoice(this.invoiceId),
          this.id,
        ) + BigInt(this.amount);
      if (paymentTotal > BigInt(payment.amount))
        throw new Error('PaymentAllocation would over-apply payment');
      const invoiceCap =
        invoice.kind === 'invoice'
          ? invoice.totalAmount - invoice.creditedAmount
          : invoice.totalAmount;
      if (invoiceTotal > BigInt(Math.max(0, invoiceCap)))
        throw new Error('PaymentAllocation would over-pay invoice');
      if (payment.kind === 'refund') {
        if (payment.status !== 'completed')
          throw new Error('A refund must be settled before it is allocated');
        if (!invoice.creditedInvoiceId)
          throw new Error('Refund credit note has no credited invoice');
        const source = await invoices.get(
          { id: invoice.creditedInvoiceId },
          { cache: false },
        );
        if (!source || source.tenantId !== owner)
          throw new Error('Refund source invoice does not exist in its tenant');
        if (!source.updated_at)
          throw new Error('Refund source invoice has no persisted revision');
        await source.claimRevision(source.updated_at);
        const credits = (
          await invoices.list({
            where: {
              tenantId: owner,
              creditedInvoiceId: source.id,
            },
          })
        ).filter(
          (credit) =>
            credit.kind === 'credit_note' &&
            credit.status !== 'draft' &&
            credit.status !== 'cancelled',
        );
        const issuedCredits = credits.reduce(
          (sum, credit) => sum + credit.totalAmount,
          0,
        );
        let settledRefunds = 0;
        for (const credit of credits) {
          if (!credit.id) continue;
          for (const allocation of await allocations.findByInvoice(credit.id)) {
            if (allocation.id === this.id) continue;
            const refund = await payments.get(
              { id: allocation.paymentId },
              { cache: false },
            );
            if (refund?.kind === 'refund' && refund.status === 'completed')
              settledRefunds += allocation.amount;
          }
        }
        const availableRefund = calculateAvailableRefund({
          sourceTotalMinor: source.totalAmount,
          sourcePaidMinor: source.amountPaid,
          issuedCreditMinor: issuedCredits,
          settledRefundMinor: settledRefunds,
        });
        if (this.amount > availableRefund)
          throw new Error(
            `Refund allocation exceeds available unapplied credit (${availableRefund})`,
          );
      }
      return (await super.save()) as this;
    });
  }
}

export default PaymentAllocation;
