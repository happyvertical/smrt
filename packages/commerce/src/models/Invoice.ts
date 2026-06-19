/**
 * Invoice model - billing document sent to customers
 * @packageDocumentation
 */

import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { InvoiceStatus, type RecognizeRevenueOptions } from '../types/index.js';

/**
 * Sub-cent rounding tolerance, matching the smrt-ledgers EPSILON. Used when
 * comparing caller-supplied totals against recomputed line-item totals so
 * floating-point fuzz doesn't trip the forged-total guard.
 */
const INVOICE_EPSILON = 0.01;

/**
 * Legal status transitions for an Invoice. Keyed by the prior (persisted)
 * status; the value is the set of statuses it may move to. A status mapping
 * to itself (no-op re-save) is always permitted and handled separately.
 *
 * Forward path: DRAFT → SENT → VIEWED → PARTIAL → PAID, with OVERDUE reachable
 * from any open status and CANCELLED / WRITTEN_OFF as terminal exits. Payment
 * progress (SENT/VIEWED ↔ PARTIAL ↔ PAID) is driven by `updatePaymentStatus`,
 * which can move both forward and backward as allocations change, so those
 * edges are bidirectional here.
 */
const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  [InvoiceStatus.DRAFT]: [
    InvoiceStatus.SENT,
    InvoiceStatus.CANCELLED,
    InvoiceStatus.WRITTEN_OFF,
  ],
  [InvoiceStatus.SENT]: [
    InvoiceStatus.VIEWED,
    InvoiceStatus.PARTIAL,
    InvoiceStatus.PAID,
    InvoiceStatus.OVERDUE,
    InvoiceStatus.CANCELLED,
    InvoiceStatus.WRITTEN_OFF,
  ],
  [InvoiceStatus.VIEWED]: [
    InvoiceStatus.SENT,
    InvoiceStatus.PARTIAL,
    InvoiceStatus.PAID,
    InvoiceStatus.OVERDUE,
    InvoiceStatus.CANCELLED,
    InvoiceStatus.WRITTEN_OFF,
  ],
  [InvoiceStatus.PARTIAL]: [
    InvoiceStatus.SENT,
    InvoiceStatus.VIEWED,
    InvoiceStatus.PAID,
    InvoiceStatus.OVERDUE,
    InvoiceStatus.CANCELLED,
    InvoiceStatus.WRITTEN_OFF,
  ],
  [InvoiceStatus.OVERDUE]: [
    InvoiceStatus.SENT,
    InvoiceStatus.VIEWED,
    InvoiceStatus.PARTIAL,
    InvoiceStatus.PAID,
    InvoiceStatus.CANCELLED,
    InvoiceStatus.WRITTEN_OFF,
  ],
  // PAID can fall back to PARTIAL / VIEWED / SENT when a payment allocation is
  // removed or reversed (handled by updatePaymentStatus). It can also be
  // written off as bad debt in unusual reconciliation flows.
  [InvoiceStatus.PAID]: [
    InvoiceStatus.PARTIAL,
    InvoiceStatus.VIEWED,
    InvoiceStatus.SENT,
    InvoiceStatus.OVERDUE,
    InvoiceStatus.WRITTEN_OFF,
  ],
  // Terminal states: no outbound transitions.
  [InvoiceStatus.CANCELLED]: [],
  [InvoiceStatus.WRITTEN_OFF]: [],
};

/**
 * Module-scoped record of the status each Invoice instance was loaded with.
 * Used by the save-time status-transition guard to compare the prior
 * persisted status against the one being written, without adding a
 * persisted column. A WeakMap keyed by the instance keeps it out of the
 * schema and garbage-collects with the instance — same pattern LicenseSale
 * uses for its rights snapshot.
 */
const loadedInvoiceStatus = new WeakMap<Invoice, InvoiceStatus>();

/**
 * Invoice represents a bill sent to a customer for goods or services.
 *
 * Invoices are distinct from Contracts - a Contract is an agreement,
 * while an Invoice is the billing document requesting payment.
 *
 * Invoices integrate with:
 * - `@happyvertical/smrt-ledgers` for revenue recognition (double-entry accounting)
 * - `@happyvertical/accounting` SDK for syncing with external providers (QBO, Stripe)
 *
 * @example
 * ```typescript
 * // Create an invoice
 * const invoice = await invoices.create({
 *   customerId: customer.id,
 *   invoiceNumber: await invoices.generateInvoiceNumber(),
 *   issueDate: new Date(),
 *   dueDate: addDays(new Date(), 30),
 *   subtotal: 1000,
 *   taxAmount: 50,
 *   totalAmount: 1050,
 *   currency: 'CAD'
 * });
 *
 * // Recognize revenue in ledger
 * await invoice.recognizeRevenue({
 *   arAccountId: arAccount.id,
 *   revenueAccountId: revenueAccount.id,
 *   taxAccountId: taxAccount.id
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  // NOTE: `send` and `recognizeRevenue` are intentionally NOT exposed over
  // MCP. `recognizeRevenue` posts a balanced journal into smrt-ledgers
  // (i.e. moves money in the books) and `send` transmits a billing document
  // to a customer — neither is safe as an unauthenticated/unguarded MCP tool.
  // Generated MCP tools carry no authz; financial mutations must go through
  // application code that enforces permissions. See S5 audit #1390.
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Invoice extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global invoices
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Customer this invoice is for
   */
  @foreignKey('Customer')
  customerId: string = '';

  /**
   * Optional link to Contract (cross-package reference)
   */
  @foreignKey('Contract')
  contractId: string = '';

  // ============================================================================
  // Identification
  // ============================================================================

  /**
   * Invoice number (e.g., INV-2025-0001)
   * Generated via InvoiceCollection.generateInvoiceNumber()
   */
  invoiceNumber: string = '';

  /**
   * External reference (e.g., customer PO number)
   */
  reference: string = '';

  // ============================================================================
  // Dates
  // ============================================================================

  /**
   * Date invoice was issued
   */
  issueDate: Date = new Date();

  /**
   * Payment due date
   */
  dueDate: Date = new Date();

  /**
   * Date invoice was fully paid
   */
  paidDate: Date | null = null;

  // ============================================================================
  // Amounts
  // ============================================================================

  /**
   * Subtotal before tax
   */
  subtotal: number = 0;

  /**
   * Tax amount
   */
  taxAmount: number = 0;

  /**
   * Total amount due (subtotal + tax)
   */
  totalAmount: number = 0;

  /**
   * Amount paid (sum of PaymentAllocations)
   */
  amountPaid: number = 0;

  /**
   * Currency code (ISO 4217)
   */
  currency: string = 'CAD';

  // ============================================================================
  // Status
  // ============================================================================

  /**
   * Current invoice status
   */
  status: InvoiceStatus = InvoiceStatus.DRAFT;

  // ============================================================================
  // Ledger Integration
  // ============================================================================

  /**
   * Journal ID for AR recognition (cross-package ref to smrt-ledgers)
   */
  @crossPackageRef('@happyvertical/smrt-ledgers:Journal')
  arJournalId: string = '';

  /**
   * Journal ID for revenue recognition (cross-package ref to smrt-ledgers)
   */
  @crossPackageRef('@happyvertical/smrt-ledgers:Journal')
  revenueJournalId: string = '';

  // ============================================================================
  // Provider Sync
  // ============================================================================

  /**
   * External ID in accounting provider (e.g., QBO invoice ID)
   */
  externalId: string = '';

  /**
   * Customer's external ID in accounting provider.
   * Used to link invoice to customer in external system.
   */
  customerExternalId: string = '';

  /**
   * Accounting provider name ('quickbooks' | 'stripe' | etc.)
   */
  externalProvider: string = '';

  /**
   * When invoice was last synced to provider
   */
  syncedAt: Date | null = null;

  // ============================================================================
  // Communication
  // ============================================================================

  /**
   * When invoice was sent to customer
   */
  sentAt: Date | null = null;

  /**
   * When customer viewed the invoice
   */
  viewedAt: Date | null = null;

  /**
   * Number of payment reminders sent
   */
  remindersSent: number = 0;

  /**
   * When last reminder was sent
   */
  lastReminderAt: Date | null = null;

  // ============================================================================
  // Notes
  // ============================================================================

  /**
   * Internal notes (not shown to customer)
   */
  notes: string = '';

  /**
   * Notes shown to customer on invoice
   */
  customerNotes: string = '';

  /**
   * Payment terms text
   */
  terms: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.customerId !== undefined) this.customerId = options.customerId;
    if (options.contractId !== undefined) this.contractId = options.contractId;
    if (options.invoiceNumber !== undefined)
      this.invoiceNumber = options.invoiceNumber;
    if (options.reference !== undefined) this.reference = options.reference;
    if (options.issueDate !== undefined) this.issueDate = options.issueDate;
    if (options.dueDate !== undefined) this.dueDate = options.dueDate;
    if (options.paidDate !== undefined) this.paidDate = options.paidDate;
    if (options.subtotal !== undefined) this.subtotal = options.subtotal;
    if (options.taxAmount !== undefined) this.taxAmount = options.taxAmount;
    if (options.totalAmount !== undefined)
      this.totalAmount = options.totalAmount;
    if (options.amountPaid !== undefined) this.amountPaid = options.amountPaid;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.status !== undefined) this.status = options.status;
    if (options.arJournalId !== undefined)
      this.arJournalId = options.arJournalId;
    if (options.revenueJournalId !== undefined)
      this.revenueJournalId = options.revenueJournalId;
    if (options.externalId !== undefined) this.externalId = options.externalId;
    if (options.customerExternalId !== undefined)
      this.customerExternalId = options.customerExternalId;
    if (options.externalProvider !== undefined)
      this.externalProvider = options.externalProvider;
    if (options.syncedAt !== undefined) this.syncedAt = options.syncedAt;
    if (options.sentAt !== undefined) this.sentAt = options.sentAt;
    if (options.viewedAt !== undefined) this.viewedAt = options.viewedAt;
    if (options.remindersSent !== undefined)
      this.remindersSent = options.remindersSent;
    if (options.lastReminderAt !== undefined)
      this.lastReminderAt = options.lastReminderAt;
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.customerNotes !== undefined)
      this.customerNotes = options.customerNotes;
    if (options.terms !== undefined) this.terms = options.terms;
  }

  /**
   * Capture the persisted status the row was loaded with, so the save-time
   * transition guard can reject illegal status flips made via raw field
   * assignment (mass-assignment on a generated update route, a stale caller,
   * etc.). Only rows that already exist in the database carry a "prior"
   * status — freshly-constructed (not-yet-saved) invoices have no prior and
   * may start in any status.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) {
      loadedInvoiceStatus.set(this, this.status);
    }
    return this;
  }

  // ============================================================================
  // Save-time financial-integrity guard (S5 audit #1390)
  // ============================================================================

  /**
   * Recompute and validate financial fields before every write so forged
   * totals, negative amounts, and illegal status flips can't be persisted via
   * raw mass-assignment on the generated CRUD routes.
   *
   * Behaviour:
   *  - **Totals are authoritative from line items.** When the invoice is
   *    persisted and has line items, `subtotal` / `taxAmount` / `totalAmount`
   *    are recomputed from those items, overriding whatever the caller sent.
   *    This blocks "create real line items but claim a tiny total" forgery.
   *  - **Without line items**, the caller-supplied totals are accepted but the
   *    `totalAmount === subtotal + taxAmount` arithmetic invariant is enforced.
   *  - **amountPaid is derived/validated.** When persisted, it is recomputed
   *    from PaymentAllocations rather than trusted from the caller. It may
   *    never exceed `totalAmount` (beyond rounding tolerance).
   *  - **Non-negativity** is enforced on all four amounts.
   *  - **Status transitions** are validated against the prior persisted status.
   */
  override async save(): Promise<this> {
    const persisted = await this.isSaved();

    await this.recomputeAmountsForSave(persisted);
    this.assertNonNegativeAmounts();
    this.assertStatusTransition();

    const result = (await super.save()) as this;
    // Once written, the current status becomes the new "prior" for the next
    // save in this instance's lifetime.
    loadedInvoiceStatus.set(this, this.status);
    return result;
  }

  /**
   * Recompute subtotal/tax/total from line items (when present) and derive
   * amountPaid from PaymentAllocations. Falls back to the arithmetic invariant
   * when the invoice has no line items. Tolerant of smrt-ledgers being absent
   * (the dynamic imports stay inside the package).
   */
  private async recomputeAmountsForSave(persisted: boolean): Promise<void> {
    if (persisted && this.id) {
      const { InvoiceLineItemCollection } = await import(
        '../collections/InvoiceLineItemCollection.js'
      );
      const lineItemCollection = await (
        InvoiceLineItemCollection as any
      ).create(this.options);
      const lineItems = await lineItemCollection.findByInvoice(this.id);

      if (lineItems.length > 0) {
        const subtotal = lineItems.reduce(
          (sum: number, item: any) => sum + item.getSubtotal(),
          0,
        );
        const taxAmount = lineItems.reduce(
          (sum: number, item: any) => sum + item.getTaxAmount(),
          0,
        );
        // Forged-total guard: refuse a caller-supplied total that disagrees
        // with the line-item sum beyond rounding tolerance, then snap the
        // stored values to the authoritative line-item figures.
        const computedTotal = subtotal + taxAmount;
        if (Math.abs(this.totalAmount - computedTotal) > INVOICE_EPSILON) {
          throw new Error(
            `Invoice ${this.invoiceNumber || this.id}: totalAmount ${this.totalAmount} ` +
              `does not match line-item total ${computedTotal} (subtotal=${subtotal}, tax=${taxAmount}). ` +
              'Invoice totals are derived from line items and cannot be set directly.',
          );
        }
        this.subtotal = subtotal;
        this.taxAmount = taxAmount;
        this.totalAmount = computedTotal;
      } else {
        this.assertTotalArithmetic();
      }

      // amountPaid is the sum of PaymentAllocations — never trust the caller.
      const { PaymentAllocationCollection } = await import(
        '../collections/PaymentAllocationCollection.js'
      );
      const allocationCollection = await (
        PaymentAllocationCollection as any
      ).create(this.options);
      const allocated = await allocationCollection.getTotalAllocatedToInvoice(
        this.id,
      );
      this.amountPaid = allocated;
    } else {
      // Not-yet-persisted invoice: no line items / allocations exist yet, so
      // enforce the arithmetic invariant on the caller-supplied totals.
      this.assertTotalArithmetic();
    }
  }

  /**
   * Enforce `totalAmount === subtotal + taxAmount` (within rounding tolerance).
   * Used when the invoice has no line items to recompute from.
   */
  private assertTotalArithmetic(): void {
    const expected = this.subtotal + this.taxAmount;
    if (Math.abs(this.totalAmount - expected) > INVOICE_EPSILON) {
      throw new Error(
        `Invoice ${this.invoiceNumber || this.id || '<new>'}: totalAmount ${this.totalAmount} ` +
          `must equal subtotal + taxAmount (${expected}).`,
      );
    }
  }

  /**
   * Reject negative financial values and an amountPaid that exceeds the total
   * (beyond rounding tolerance — overpayment is modelled elsewhere, not by
   * letting amountPaid float above the invoice total).
   */
  private assertNonNegativeAmounts(): void {
    const label = this.invoiceNumber || this.id || '<new>';
    for (const [field, value] of [
      ['subtotal', this.subtotal],
      ['taxAmount', this.taxAmount],
      ['totalAmount', this.totalAmount],
      ['amountPaid', this.amountPaid],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(
          `Invoice ${label}: ${field} must be a non-negative number (got ${value}).`,
        );
      }
    }
    if (this.amountPaid - this.totalAmount > INVOICE_EPSILON) {
      throw new Error(
        `Invoice ${label}: amountPaid ${this.amountPaid} cannot exceed totalAmount ${this.totalAmount}.`,
      );
    }
  }

  /**
   * Reject an illegal status flip done via raw field assignment. Compares the
   * about-to-be-written status against the status the row was loaded with.
   * No-op transitions (status unchanged) and brand-new rows are always allowed.
   */
  private assertStatusTransition(): void {
    const prior = loadedInvoiceStatus.get(this);
    if (prior === undefined) return; // new row — any starting status is fine
    if (prior === this.status) return; // no-op re-save
    const allowed = INVOICE_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Invoice ${this.invoiceNumber || this.id}: illegal status transition ` +
          `'${prior}' → '${this.status}'. Use the guarded transition helpers ` +
          '(markSent / markViewed / updatePaymentStatus / cancel / writeOff).',
      );
    }
  }

  // ============================================================================
  // Status Helpers
  // ============================================================================

  /**
   * Check if invoice is a draft
   */
  isDraft(): boolean {
    return this.status === InvoiceStatus.DRAFT;
  }

  /**
   * Check if invoice has been sent
   */
  isSent(): boolean {
    return this.status === InvoiceStatus.SENT;
  }

  /**
   * Check if invoice is fully paid
   */
  isPaid(): boolean {
    return this.status === InvoiceStatus.PAID;
  }

  /**
   * Check if invoice is partially paid
   */
  isPartial(): boolean {
    return this.status === InvoiceStatus.PARTIAL;
  }

  /**
   * Check if invoice is overdue
   */
  isOverdue(): boolean {
    if (this.status === InvoiceStatus.OVERDUE) return true;
    if (this.isPaid() || this.status === InvoiceStatus.CANCELLED) return false;
    return new Date() > this.dueDate;
  }

  /**
   * Get remaining amount due
   */
  getAmountDue(): number {
    return Math.max(0, this.totalAmount - this.amountPaid);
  }

  // ============================================================================
  // Status Transitions
  // ============================================================================

  /**
   * Mark invoice as sent
   */
  markSent(): void {
    if (this.status !== InvoiceStatus.DRAFT) {
      throw new Error(
        `Cannot send invoice with status '${this.status}'. Only draft invoices can be sent.`,
      );
    }
    this.status = InvoiceStatus.SENT;
    this.sentAt = new Date();
  }

  /**
   * Record that the invoice was viewed by the customer.
   *
   * This method is idempotent - calling it multiple times will only
   * record the first view time. Status only transitions to VIEWED if
   * the current status is SENT (other statuses like PARTIAL or PAID
   * are preserved).
   */
  markViewed(): void {
    if (this.viewedAt) return; // Already viewed
    this.viewedAt = new Date();
    if (this.status === InvoiceStatus.SENT) {
      this.status = InvoiceStatus.VIEWED;
    }
  }

  /**
   * Update payment amount and status.
   *
   * Called when PaymentAllocations change. Handles both forward transitions
   * (SENT → PARTIAL → PAID) and reversals (PAID → PARTIAL → original status).
   *
   * Terminal statuses (CANCELLED, WRITTEN_OFF) are not modified.
   */
  updatePaymentStatus(amountPaid: number): void {
    this.amountPaid = amountPaid;

    // Do not change payment status for terminal states
    if (
      this.status === InvoiceStatus.CANCELLED ||
      this.status === InvoiceStatus.WRITTEN_OFF
    ) {
      return;
    }

    if (amountPaid >= this.totalAmount) {
      this.status = InvoiceStatus.PAID;
      this.paidDate = new Date();
    } else if (amountPaid > 0) {
      this.status = InvoiceStatus.PARTIAL;
      this.paidDate = null; // Clear paidDate if no longer fully paid
    } else {
      // No payment remaining: revert to the appropriate pre-payment status
      this.paidDate = null;
      if (this.sentAt) {
        this.status = this.viewedAt ? InvoiceStatus.VIEWED : InvoiceStatus.SENT;
      } else {
        this.status = InvoiceStatus.DRAFT;
      }
    }
  }

  /**
   * Cancel the invoice
   */
  cancel(): void {
    if (this.isPaid()) {
      throw new Error(
        `Cannot cancel invoice with status '${this.status}'. Paid invoices cannot be cancelled.`,
      );
    }
    this.status = InvoiceStatus.CANCELLED;
  }

  /**
   * Write off the invoice (bad debt)
   */
  writeOff(): void {
    this.status = InvoiceStatus.WRITTEN_OFF;
  }

  // ============================================================================
  // Ledger Integration
  // ============================================================================

  /**
   * Recognize revenue and create AR journal entry.
   *
   * Creates a balanced journal entry in smrt-ledgers:
   * - Debit: Accounts Receivable (assets increase)
   * - Credit: Revenue (revenue increases)
   * - Credit: Tax Payable (liability increases, if taxAmount > 0)
   *
   * **Note**: This method saves the invoice after setting arJournalId.
   *
   * @param options - Account IDs for the journal entry
   * @returns The created journal
   *
   * @example
   * ```typescript
   * const journal = await invoice.recognizeRevenue({
   *   arAccountId: '1120',
   *   revenueAccountId: '4100',
   *   taxAccountId: '2130'
   * });
   * ```
   */
  async recognizeRevenue(options: RecognizeRevenueOptions): Promise<any> {
    if (this.arJournalId) {
      throw new Error(
        `Revenue already recognized for invoice ${this.invoiceNumber} (journal ID: ${this.arJournalId})`,
      );
    }

    if (this.totalAmount <= 0) {
      throw new Error(
        `Cannot recognize revenue for invoice ${this.invoiceNumber} with non-positive total: ${this.totalAmount}`,
      );
    }

    if (this.taxAmount > 0 && !options.taxAccountId) {
      throw new Error(
        `Invoice ${this.invoiceNumber} has taxAmount ${this.taxAmount} but no taxAccountId provided`,
      );
    }

    // Dynamic import to avoid hard dependency on smrt-ledgers
    const { JournalCollection } = await import('@happyvertical/smrt-ledgers');

    const journalCollection = await (JournalCollection as any).create(
      this.options,
    );

    // Build entries array
    const entries: any[] = [
      // Debit AR (assets increase)
      {
        accountId: options.arAccountId,
        debit: this.totalAmount,
        memo: `Invoice ${this.invoiceNumber}`,
      },
      // Credit Revenue
      {
        accountId: options.revenueAccountId,
        credit: this.subtotal,
        memo: `Invoice ${this.invoiceNumber}`,
      },
    ];

    // Credit Tax Payable if there's tax
    if (this.taxAmount > 0 && options.taxAccountId) {
      entries.push({
        accountId: options.taxAccountId,
        credit: this.taxAmount,
        memo: `Tax on Invoice ${this.invoiceNumber}`,
      });
    }

    // Create journal with entries
    const journal = await journalCollection.createWithEntries({
      description: `Revenue: Invoice ${this.invoiceNumber}`,
      sourceModule: 'smrt-commerce',
      sourceRef: this.id,
      entries,
    });

    // Post the journal
    await journal.post();

    // Update invoice record
    this.arJournalId = journal.id;
    await this.save();

    return journal;
  }

  /**
   * Get the AR journal entry (if revenue was recognized)
   */
  async getArJournal(): Promise<any | null> {
    if (!this.arJournalId) return null;

    try {
      const { JournalCollection } = await import('@happyvertical/smrt-ledgers');
      const collection = await (JournalCollection as any).create(this.options);
      return await collection.get({ id: this.arJournalId });
    } catch {
      // smrt-ledgers not available
      return null;
    }
  }

  // ============================================================================
  // Provider Sync
  // ============================================================================

  /**
   * Convert to InvoiceInput for SDK accounting provider sync.
   *
   * Fetches line items and maps all fields to the format expected
   * by @happyvertical/accounting providers.
   *
   * @returns InvoiceInput compatible with @happyvertical/accounting
   *
   * @example
   * ```typescript
   * const provider = await getAccountingProvider({ type: 'quickbooks', ... });
   * const input = await invoice.toAccountingInput();
   * const result = await provider.invoices.push(input);
   * invoice.externalId = result.externalId;
   * invoice.syncedAt = result.syncedAt;
   * await invoice.save();
   * ```
   */
  async toAccountingInput(): Promise<any> {
    // Dynamically import to avoid circular dependency
    const { InvoiceLineItemCollection } = await import(
      '../collections/InvoiceLineItemCollection.js'
    );

    const lineItemCollection = await (InvoiceLineItemCollection as any).create(
      this.options,
    );
    const lineItems = await lineItemCollection.findByInvoice(this.id);

    return {
      id: this.id,
      externalId: this.externalId || undefined,
      invoiceNumber: this.invoiceNumber,
      customerId: this.customerId,
      customerExternalId: this.customerExternalId || undefined,
      issueDate: this.issueDate,
      dueDate: this.dueDate,
      lineItems: lineItems.map((item: any) => item.toAccountingLineItem()),
      subtotal: this.subtotal,
      taxAmount: this.taxAmount,
      totalAmount: this.totalAmount,
      currency: this.currency,
      reference: this.reference || undefined,
      memo: this.customerNotes || undefined,
    };
  }
}

export default Invoice;
