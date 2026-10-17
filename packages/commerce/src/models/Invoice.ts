/**
 * Invoice model - billing document sent to customers
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import type { Journal } from '@happyvertical/smrt-ledgers';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  assertAllocationParent,
  claimAllocationParent,
} from '../allocation-integrity.js';
import {
  DOCUMENT_MONEY_READ_REBIND,
  DOCUMENT_MONEY_WRITE,
  type DocumentMoneyReadRebindCapability,
  type DocumentMoneyWriteCapability,
} from '../document-money-internal.js';
import type { FrozenInvoiceAccountingOptions } from '../invoice-accounting-sync.js';
import { assertIntegerMinorUnits, MoneyValidationError } from '../money.js';
import { calculateInvoicePayable } from '../retention-money.js';
import {
  type AccountingInvoiceInput,
  type CancelRevenueOptions,
  type InvoiceCollectionMethod,
  type InvoiceKind,
  type InvoiceOptions,
  InvoiceStatus,
  type RecognizeRevenueOptions,
  type TaxRegistrationOptions,
} from '../types/index.js';

/*
 * There is deliberately no `INVOICE_EPSILON` here any more (#2401).
 *
 * Every amount on this model is integer minor units, so `subtotal + taxAmount`
 * is exact, the sum of allocations is exact, and every comparison below is a
 * plain integer comparison. The old `0.01` tolerance existed because the values
 * were floats; keeping it against integers would silently forgive a genuine
 * one-cent discrepancy, and the "snap `totalAmount` to `subtotal + taxAmount`
 * afterwards" workaround it required (to stay inside the tighter smrt-ledgers
 * `BALANCE_EPSILON`) is gone with it — exact arithmetic needs no snap.
 */

/**
 * Legal status transitions for an Invoice. Keyed by the prior (persisted)
 * status; the value is the set of statuses it may move to. A status mapping
 * to itself (no-op re-save) is always permitted and handled separately.
 *
 * Forward path: DRAFT → SENT → VIEWED → PARTIAL → PAID, with OVERDUE reachable
 * from any open status and CANCELLED / WRITTEN_OFF as terminal exits. Payment
 * progress (DRAFT/SENT/VIEWED ↔ PARTIAL ↔ PAID) is driven by `updatePaymentStatus`,
 * which can move both forward and backward as allocations change, so those
 * edges are bidirectional here.
 */
const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  [InvoiceStatus.DRAFT]: [
    InvoiceStatus.SENT,
    InvoiceStatus.PARTIAL,
    InvoiceStatus.PAID,
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
    InvoiceStatus.DRAFT,
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
    InvoiceStatus.DRAFT,
    InvoiceStatus.PARTIAL,
    InvoiceStatus.VIEWED,
    InvoiceStatus.SENT,
    InvoiceStatus.OVERDUE,
    InvoiceStatus.CANCELLED,
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
  // ROOT FIX (S5 audit #1390 round 4): the generated create/update surface may
  // only set the billing-document descriptors (who/when/identifiers). The
  // derived/integrity amounts (`subtotal`, `taxAmount`, `totalAmount`,
  // `amountPaid`) and `status` are EXCLUDED — totals are derived from line
  // items, amountPaid from PaymentAllocations, and status from
  // updatePaymentStatus()/the lifecycle helpers. A caller can therefore create
  // a DRAFT invoice (customer / dueDate / line-item refs) but can never forge a
  // total, an amountPaid, or a PAID status through a generated route. Ledger
  // journal refs and communication timestamps are server-managed too.
  api: {
    include: ['list', 'get', 'create', 'update'],
    writable: [
      'customerId',
      'contractId',
      'invoiceNumber',
      'reference',
      'issueDate',
      'dueDate',
      'currency',
      'lineAmountType',
      'taxRoundingScope',
      'notes',
      'customerNotes',
      'terms',
      'externalId',
      'customerExternalId',
      'externalProvider',
    ],
  },
  // NOTE: `send` and `recognizeRevenue` are intentionally NOT exposed over
  // MCP. `recognizeRevenue` posts a balanced journal into smrt-ledgers
  // (i.e. moves money in the books) and `send` transmits a billing document
  // to a customer — neither is safe as an unauthenticated/unguarded MCP tool.
  // Generated MCP tools carry no authz; financial mutations must go through
  // application code that enforces permissions. MCP create/update honor the
  // same `api.writable` allowlist, so status/amounts are unsettable over MCP
  // too. See S5 audit #1390.
  mcp: {
    include: ['list', 'get'],
    serializers: {
      get: {
        importPath: '@happyvertical/smrt-commerce',
        exportName: 'serializeInvoiceMcpGet',
      },
    },
  },
  cli: { skipApiCheck: true },
  indexes: [
    {
      name: 'invoice_historical_source_identity',
      columns: ['tenantId', 'historicalSourceKeyHash'],
      unique: true,
    },
  ],
})
export class Invoice extends SmrtObject {
  /** Command-owned original sales authority; ordinary documents stay calculated. */
  @field({
    description:
      'Whether amounts were calculated or retained from an original issued invoice.',
  })
  moneyAuthority: 'calculated' | 'historical' = 'calculated';
  historicalSalesMoneyJson = '';
  @field({ type: 'text', nullable: true }) historicalSourceKeyHash:
    | string
    | null = null;

  /** @internal Collection read guard returns this snapshot on its root DB. */
  rebindMoneyRead(
    capability: DocumentMoneyReadRebindCapability,
    db: DatabaseInterface,
  ): this {
    if (capability !== DOCUMENT_MONEY_READ_REBIND)
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'Invoice read rebinding requires the owning capability',
      );
    this._db = db;
    this.options.db = db;
    return this;
  }

  @field({ description: 'Invoice or customer credit note.' })
  kind: InvoiceKind = 'invoice';

  @foreignKey('Invoice', { nullable: true })
  creditedInvoiceId: string | null = null;

  /** Issued credit-note total cached under the source invoice lock. */
  @field({ ui: { format: 'money' } })
  creditedAmount = 0;

  /** Server-owned immutable retention policy and append-only release evidence. */
  retentionStateJson = '';

  /** Command-owned durable provider retention bundle; never caller-writable. */
  @field({ sensitive: true })
  retentionAccountingStateJson = '';

  /** Command-owned ordinary provider adjustments; no retention agreement. */
  @field({ sensitive: true })
  ordinaryAccountingStateJson = '';

  getPayableFacts() {
    return calculateInvoicePayable(this);
  }

  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global invoices
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Customer this invoice is for
   */
  @field({ description: 'The customer being billed.' })
  @foreignKey('Customer')
  customerId: string = '';

  /**
   * Optional link to Contract (cross-package reference)
   */
  @field({
    description: 'The order or agreement this invoice bills for, if any.',
  })
  @foreignKey('SalesContract', { validateSubtype: true })
  contractId: string = '';

  // ============================================================================
  // Identification
  // ============================================================================

  /**
   * Invoice number (e.g., INV-2025-0001)
   * Generated via InvoiceCollection.generateInvoiceNumber()
   */
  @field({ description: 'The number printed on the invoice.' })
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
  @field({
    description: 'The date the invoice was issued.',
    // A business date: what "invoices by month" buckets (#4100).
    ui: { format: 'date' },
  })
  issueDate: Date = new Date();

  /**
   * Payment due date
   */
  @field({
    type: 'datetime',
    nullable: true,
    description:
      'The date payment is expected; null when the original source did not establish it.',
  })
  dueDate: Date | null = new Date();

  /**
   * Date invoice was fully paid
   */
  @field({ description: 'The date it was paid in full.' })
  paidDate: Date | null = null;

  // ============================================================================
  // Amounts
  // ============================================================================

  /**
   * Subtotal before tax, in **integer minor units** (cents, satoshis).
   *
   * The `= 0` initializer is load-bearing: SMRT maps an integer literal to
   * INTEGER and a decimal literal to DECIMAL. Money is exact, so it is stored
   * as minor units and never as a float — `$19.99` is `1999`, not `19.99`.
   * Writing a fractional major-unit value here is the bug; PostgreSQL rejects
   * it with `22P02` while SQLite's affinity silently stores it (#2361).
   */
  @field({ description: 'The amount before tax.', ui: { format: 'money' } })
  subtotal: number = 0;

  /**
   * Tax amount, in integer minor units (#2361). With line items this is the
   * sum of their rate-based tax plus {@link providerTaxAmount}.
   */
  @field({ description: 'The tax charged.', ui: { format: 'money' } })
  taxAmount: number = 0;

  /**
   * Tax calculated by the payment provider (for example Stripe Tax) from the
   * customer's tax location, in integer minor units (#3060). Server-managed:
   * billing-period close records it after the provider finalizes the invoice.
   * It is added to the line items' tax, so `taxAmount` and `totalAmount` stay
   * authoritative from line items plus this one provider figure.
   */
  @field({ ui: { format: 'money' } })
  providerTaxAmount: number = 0;

  /**
   * Total amount due (subtotal + tax), in integer minor units (#2361).
   */
  @field({
    description: 'What the customer owes in all, tax included.',
    ui: { format: 'money' },
  })
  totalAmount: number = 0;

  /**
   * Amount paid (sum of PaymentAllocations), in integer minor units (#2361).
   */
  @field({
    description: 'How much of the total has been paid so far.',
    ui: { format: 'money' },
  })
  amountPaid: number = 0;

  /**
   * Currency code (ISO 4217)
   */
  @field({
    description: 'The currency of the invoice.',
    ui: { widget: 'currency' },
  })
  currency: string = 'CAD';

  /** Pricing interpretation fixed for the document before issue. */
  lineAmountType: 'exclusive' | 'inclusive' | 'none' = 'exclusive';

  /** Component rounding scope fixed for the document before issue. */
  taxRoundingScope: 'line' | 'document' = 'line';

  /** Informational sum of resolved line discounts, in minor units. */
  @field({ ui: { format: 'money' } })
  discountTotal = 0;

  /** Immutable seller registration snapshot once the invoice leaves draft. */
  sellerTaxRegistrationsJson = '[]';

  get sellerTaxRegistrations(): TaxRegistrationOptions[] {
    try {
      const value: unknown = JSON.parse(this.sellerTaxRegistrationsJson);
      if (!Array.isArray(value)) return [];
      return value.filter(
        (entry): entry is TaxRegistrationOptions =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as TaxRegistrationOptions).taxComponentId ===
            'string' &&
          typeof (entry as TaxRegistrationOptions).number === 'string' &&
          typeof (entry as TaxRegistrationOptions).label === 'string',
      );
    } catch {
      return [];
    }
  }

  set sellerTaxRegistrations(value: TaxRegistrationOptions[]) {
    this.sellerTaxRegistrationsJson = JSON.stringify(value);
  }

  /** Immutable customer tax identifier snapshot once issued. */
  partyTaxId = '';

  /** Stable issue/freeze identity, independent of lifecycle updated_at. */
  moneySnapshotId = '';

  // ============================================================================
  // Status
  // ============================================================================

  /**
   * Current invoice status
   */
  @field({
    description:
      'Where the invoice stands: draft, sent, viewed, paid, overdue or cancelled.',
  })
  status: InvoiceStatus = InvoiceStatus.DRAFT;

  // ============================================================================
  // Ledger Integration
  // ============================================================================

  /**
   * Journal ID for AR recognition (cross-package ref to smrt-ledgers)
   */
  @crossPackageRef('@happyvertical/smrt-ledgers:Journal')
  arJournalId: string = '';

  /** Posted journal that exactly reverses arJournalId on cancellation. */
  @crossPackageRef('@happyvertical/smrt-ledgers:Journal', { nullable: true })
  arReversalJournalId: string | null = null;

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

  /** Server-owned prepared/in-flight/result identity for frozen accounting sync. */
  @field({ sensitive: true })
  accountingSyncStateJson = '';

  /**
   * How the provider collects this invoice (#3190), decided once by billing
   * period close before its first push and reused on every retry, so it is
   * what the provider was asked for. Server-managed. A host must not offer
   * another payment rail on a `charge_automatically` invoice the provider is
   * still collecting.
   */
  collectionMethod: InvoiceCollectionMethod = '';

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
  @field({
    description: 'Private notes, not shown to the customer.',
    ui: { widget: 'textarea' },
  })
  notes: string = '';

  /**
   * Notes shown to customer on invoice
   */
  @field({
    description: 'A message shown to the customer on the invoice.',
    ui: { widget: 'textarea' },
  })
  customerNotes: string = '';

  /**
   * Payment terms text
   */
  @field({
    description: 'The payment conditions, such as Net 30.',
    ui: { widget: 'textarea' },
  })
  terms: string = '';

  constructor(options: InvoiceOptions = {}) {
    super(options);
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.creditedInvoiceId !== undefined)
      this.creditedInvoiceId = options.creditedInvoiceId;
    if (options.moneyAuthority !== undefined)
      this.moneyAuthority = options.moneyAuthority;
    if (options.historicalSalesMoneyJson !== undefined)
      this.historicalSalesMoneyJson = options.historicalSalesMoneyJson;
    if (options.historicalSourceKeyHash !== undefined)
      this.historicalSourceKeyHash = options.historicalSourceKeyHash;
    if (options.creditedAmount !== undefined)
      this.creditedAmount = options.creditedAmount;
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
    if (options.providerTaxAmount !== undefined)
      this.providerTaxAmount = options.providerTaxAmount;
    if (options.totalAmount !== undefined)
      this.totalAmount = options.totalAmount;
    if (options.amountPaid !== undefined) this.amountPaid = options.amountPaid;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.lineAmountType !== undefined)
      this.lineAmountType = options.lineAmountType;
    if (options.taxRoundingScope !== undefined)
      this.taxRoundingScope = options.taxRoundingScope;
    if (options.discountTotal !== undefined)
      this.discountTotal = options.discountTotal;
    if (options.sellerTaxRegistrationsJson !== undefined)
      this.sellerTaxRegistrationsJson = options.sellerTaxRegistrationsJson;
    if (options.sellerTaxRegistrations !== undefined)
      this.sellerTaxRegistrations = structuredClone(
        options.sellerTaxRegistrations,
      );
    if (options.partyTaxId !== undefined) this.partyTaxId = options.partyTaxId;
    if (options.moneySnapshotId !== undefined)
      this.moneySnapshotId = options.moneySnapshotId;
    if (options.status !== undefined) this.status = options.status;
    if (options.arJournalId !== undefined)
      this.arJournalId = options.arJournalId;
    if (options.arReversalJournalId !== undefined)
      this.arReversalJournalId = options.arReversalJournalId;
    if (options.revenueJournalId !== undefined)
      this.revenueJournalId = options.revenueJournalId;
    if (options.externalId !== undefined) this.externalId = options.externalId;
    if (options.customerExternalId !== undefined)
      this.customerExternalId = options.customerExternalId;
    if (options.externalProvider !== undefined)
      this.externalProvider = options.externalProvider;
    if (options.syncedAt !== undefined) this.syncedAt = options.syncedAt;
    if (options.accountingSyncStateJson !== undefined)
      this.accountingSyncStateJson = options.accountingSyncStateJson;
    if (options.collectionMethod !== undefined)
      this.collectionMethod = options.collectionMethod;
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
    // A row read from the database must not be old-format money data.
    if (this.isPersisted) {
      const { assertHydratedMoneyRowCurrent } = await import(
        '../upgrade/detect.js'
      );
      await assertHydratedMoneyRowCurrent(this);
    }
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
   *  - **Totals are authoritative from line items.** A draft's `subtotal` /
   *    `discountTotal` / `taxAmount` / `totalAmount` are recomputed from its
   *    lines and tax codes on every save, whatever the caller sent; a new
   *    invoice with no lines starts at zero. Issued invoices are frozen.
   *  - **amountPaid is derived/validated.** When persisted, it is recomputed
   *    from PaymentAllocations rather than trusted from the caller. It may
   *    never exceed `totalAmount`, and a new invoice cannot start paid.
   *  - **Whole minor units and non-negativity** are enforced on all amounts.
   *  - **Status transitions** are validated against the prior persisted status.
   */
  override async save(): Promise<this> {
    const { saveInvoice } = await import('../document-money.js');
    return (await saveInvoice(this)) as this;
  }

  /** @internal Aggregate persistence only. */
  async saveDerived(capability: DocumentMoneyWriteCapability): Promise<this> {
    if (capability !== DOCUMENT_MONEY_WRITE)
      throw new Error('Invoice money write capability is required');
    await claimAllocationParent(this, 'invoice');
    const persisted = await this.isSaved();
    const prior = await this.resolvePriorStatus(persisted);

    this.assertAmountsAreMinorUnits();
    if (persisted && this.id) await this.recomputeAmountPaid();
    else {
      // A new invoice has no PaymentAllocations behind it, so it cannot
      // start paid: payment status is derived from allocations.
      this.amountPaid = 0;
      if (
        this.status === InvoiceStatus.PAID ||
        this.status === InvoiceStatus.PARTIAL
      )
        throw new Error(
          `Invoice ${this.invoiceNumber || '<new>'}: a new invoice cannot start ` +
            `in status '${this.status}' — payment status is derived from ` +
            'PaymentAllocations, not set at creation. Create the invoice unpaid ' +
            '(DRAFT / SENT) and record payments via allocations.',
        );
    }
    this.assertNonNegativeAmounts();
    this.assertStatusTransition(prior);
    this.assertPaymentStatusConsistent();
    const payable = calculateInvoicePayable(this);
    if (
      (this.retentionAccountingStateJson || this.ordinaryAccountingStateJson) &&
      [InvoiceStatus.CANCELLED, InvoiceStatus.WRITTEN_OFF].includes(this.status)
    )
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
        'Provider retention cannot be voided or written off without an explicit reconciled reversal contract',
      );
    if (
      (this.retentionAccountingStateJson || this.ordinaryAccountingStateJson) &&
      (this.collectionMethod || this.providerTaxAmount)
    )
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Retention accounting does not support provider collection or tax overrides',
      );
    if (
      payable.retainedRemainingMinor > 0 &&
      !this.retentionAccountingStateJson &&
      (this.externalId ||
        this.externalProvider ||
        this.accountingSyncStateJson ||
        this.collectionMethod ||
        this.providerTaxAmount)
    )
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Unreleased retention requires an explicit provider retention contract',
      );
    await this.assertDraftDeliveryHistory(persisted);

    await assertAllocationParent(this, 'invoice');
    const result = (await super.save()) as this;
    loadedInvoiceStatus.set(this, this.status);
    return result;
  }

  override async delete(
    options: { expectedUpdatedAt?: Date | string } = {},
  ): Promise<void> {
    const { deleteInvoice } = await import('../document-money.js');
    await deleteInvoice(this, options);
  }

  /** @internal Aggregate persistence only. */
  async deleteDerived(
    capability: DocumentMoneyWriteCapability,
    options: { expectedUpdatedAt?: Date | string } = {},
  ): Promise<void> {
    if (capability !== DOCUMENT_MONEY_WRITE)
      throw new Error('Invoice money write capability is required');
    await super.delete(options);
  }

  /**
   * Resolve the AUTHORITATIVE prior status (S5 audit #1390 round 4). The
   * {@link loadedInvoiceStatus} WeakMap is only populated when {@link initialize}
   * hydrated the row, so a `create({ id: <existing>, _skipLoad: true })` upsert
   * yields an instance whose WeakMap entry is missing — trusting it would treat
   * the write as a brand-new row and skip the transition guard entirely. Read
   * the persisted row's status directly so a create-onto-existing is correctly
   * treated as an update. `undefined` means no row exists (genuinely new).
   */
  private async resolvePriorStatus(
    persisted: boolean,
  ): Promise<InvoiceStatus | undefined> {
    if (persisted && this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as InvoiceStatus;
        }
      } catch {
        // DB not ready — fall through to the in-memory record.
      }
    }
    return loadedInvoiceStatus.get(this);
  }

  private async recomputeAmountPaid(): Promise<void> {
    const { PaymentAllocationCollection } = await import(
      '../collections/PaymentAllocationCollection.js'
    );
    const allocationCollection = await PaymentAllocationCollection.create({
      ...this.options,
      db: this.db,
    });
    if (!this.id) throw new Error('Persisted invoice is missing its ID');
    this.amountPaid = await allocationCollection.getTotalAllocatedToInvoice(
      this.id,
    );
  }

  /**
   * Whether `amountPaid` covers `totalAmount`. This is the SINGLE source of
   * truth for the **PAID** decision — both {@link updatePaymentStatus} (which
   * decides PAID) and {@link assertPaymentStatusConsistent} (which validates
   * PAID on save) call it, so the PAID-deciding comparison and the
   * PAID-validating comparison can never drift apart (S5 audit #1390
   * follow-up).
   *
   * With integer minor units this is a plain `>=` (#2401). The float-era
   * hazard it used to guard against — a total summed from `0.1 × 3` line items
   * reading as "not covered" by `>=` but "covered" by an epsilon-tolerant
   * guard, leaving a genuinely-paid invoice unsaveable — cannot arise when both
   * sides are exact integers. That also removes the documented PAID/PARTIAL
   * asymmetry: {@link updatePaymentStatus} and {@link isPartiallyPaid} now
   * agree that any `amountPaid > 0` is a partial payment, because there is no
   * such thing as sub-cent dust.
   */
  private isFullyPaid(): boolean {
    return this.amountPaid + this.creditedAmount >= this.totalAmount;
  }

  /**
   * Whether `amountPaid` is a non-trivial partial payment of `totalAmount`.
   * Derived from {@link isFullyPaid} so the two stay mutually exclusive.
   */
  private isPartiallyPaid(): boolean {
    return this.amountPaid + this.creditedAmount > 0 && !this.isFullyPaid();
  }

  /**
   * After amounts are recomputed and amountPaid is re-derived from allocations,
   * assert the persisted `status` is consistent with the derived
   * amountPaid-vs-totalAmount relationship. This blocks the raw
   * `SENT → PAID with amountPaid=0` flip (and its inverse, claiming PARTIAL/SENT
   * while fully allocated) that the status-transition map alone permits because
   * SENT → PAID is a structurally legal edge.
   *
   * Only enforced for the payment-derived statuses (PAID / PARTIAL and the
   * unpaid states DRAFT / SENT / VIEWED). Lifecycle statuses that aren't a
   * function of amountPaid — OVERDUE, CANCELLED, WRITTEN_OFF — are left
   * to their own transition rules.
   */
  private assertPaymentStatusConsistent(): void {
    const label = this.invoiceNumber || this.id || '<new>';
    const fullyPaid = this.isFullyPaid();
    const partiallyPaid = this.isPartiallyPaid();

    if (this.status === InvoiceStatus.DRAFT && this.amountPaid !== 0) {
      throw new Error(
        `Invoice ${label}: DRAFT requires zero derived payment allocations.`,
      );
    }
    if (this.status === InvoiceStatus.PAID && !fullyPaid) {
      throw new Error(
        `Invoice ${label}: status is PAID but derived amountPaid ${this.amountPaid} ` +
          `does not cover totalAmount ${this.totalAmount}. Payment status is ` +
          'derived from PaymentAllocations — use updatePaymentStatus().',
      );
    }
    if (this.status === InvoiceStatus.PARTIAL && !partiallyPaid) {
      throw new Error(
        `Invoice ${label}: status is PARTIAL but derived amountPaid ${this.amountPaid} ` +
          `is not a partial payment of totalAmount ${this.totalAmount}. Payment ` +
          'status is derived from PaymentAllocations — use updatePaymentStatus().',
      );
    }
    // Claiming an unpaid open status (SENT / VIEWED) while the invoice is in
    // fact fully covered by allocations is also inconsistent.
    if (
      (this.status === InvoiceStatus.SENT ||
        this.status === InvoiceStatus.VIEWED) &&
      this.totalAmount > 0 &&
      fullyPaid
    ) {
      throw new Error(
        `Invoice ${label}: status is '${this.status}' but derived amountPaid ` +
          `${this.amountPaid} fully covers totalAmount ${this.totalAmount}. ` +
          'Use updatePaymentStatus() so the status reflects the allocations.',
      );
    }
  }

  /** A payment reversal cannot erase an actual delivery event. */
  private async assertDraftDeliveryHistory(persisted: boolean): Promise<void> {
    if (this.status !== InvoiceStatus.DRAFT) return;
    if (this.sentAt || this.viewedAt) {
      throw new Error('DRAFT requires an undelivered invoice');
    }
    if (persisted && this.id) {
      const { InvoiceCollection } = await import(
        '../collections/InvoiceCollection.js'
      );
      const invoices = await InvoiceCollection.create({ db: this.db });
      const prior = await invoices.get({ id: this.id }, { cache: false });
      if (prior?.sentAt || prior?.viewedAt) {
        throw new Error(
          'DRAFT cannot erase persisted invoice delivery history',
        );
      }
    }
  }

  /**
   * Reject amounts that are not whole minor units, negative financial values,
   * and an amountPaid that exceeds the total (overpayment is modelled
   * elsewhere, not by letting amountPaid float above the invoice total).
   */
  private assertAmountsAreMinorUnits(): void {
    assertIntegerMinorUnits(
      'Invoice',
      this.invoiceNumber || this.id || '<new>',
      [
        ['subtotal', this.subtotal],
        ['taxAmount', this.taxAmount],
        ['providerTaxAmount', this.providerTaxAmount],
        ['totalAmount', this.totalAmount],
        ['amountPaid', this.amountPaid],
        ['creditedAmount', this.creditedAmount],
      ],
    );
  }

  private assertNonNegativeAmounts(): void {
    const label = this.invoiceNumber || this.id || '<new>';
    const amounts = [
      ['subtotal', this.subtotal],
      ['taxAmount', this.taxAmount],
      ['providerTaxAmount', this.providerTaxAmount],
      ['totalAmount', this.totalAmount],
      ['amountPaid', this.amountPaid],
      ['creditedAmount', this.creditedAmount],
    ] as const;
    // Re-checked after the recompute: line-item sums and the allocation total
    // feed these, so integer-ness has to hold for the derived values too — it
    // is what lets every comparison below drop its epsilon.
    assertIntegerMinorUnits('Invoice', label, amounts);
    for (const [field, value] of amounts) {
      if (value < 0) {
        throw new Error(
          `Invoice ${label}: ${field} must be a non-negative number (got ${value}).`,
        );
      }
    }
    if (this.amountPaid > this.totalAmount) {
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
  private assertStatusTransition(prior: InvoiceStatus | undefined): void {
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
    if (this.getAmountDue() === 0) return false;
    if (this.status === InvoiceStatus.OVERDUE) return true;
    if (this.isPaid() || this.status === InvoiceStatus.CANCELLED) return false;
    return this.dueDate !== null && new Date() > this.dueDate;
  }

  /**
   * Get remaining amount due
   */
  getAmountDue(): number {
    return this.getPayableFacts().currentlyDueMinor;
  }

  /** Signed amount still owed after payments and issued credit notes. */
  getBalance(): number {
    return this.totalAmount - this.amountPaid - this.creditedAmount;
  }

  // ============================================================================
  // Status Transitions
  // ============================================================================

  /**
   * Mark invoice as sent
   */
  markSent(): void {
    // Payment progress and actual delivery are independent. A prepaid invoice
    // may be sent later; preserve its allocation-derived status and first send.
    if (
      this.status === InvoiceStatus.PARTIAL ||
      this.status === InvoiceStatus.PAID
    ) {
      this.sentAt ??= new Date();
      return;
    }
    if (this.status !== InvoiceStatus.DRAFT) {
      throw new Error(
        `Cannot send invoice with status '${this.status}'. Only draft or payment-progress invoices can be sent.`,
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
   * (DRAFT/SENT → PARTIAL → PAID) and reversals (PAID → PARTIAL → original status).
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

    // Use the SAME epsilon-tolerant "fully paid" test the save-time guard
    // (assertPaymentStatusConsistent) applies, so a float-summed total paid
    // exactly (e.g. 0.1×3 line items paid 0.3) is treated as PAID by both —
    // not PARTIAL here and then rejected on save (S5 audit #1390 follow-up).
    if (this.isFullyPaid()) {
      if (
        this.moneyAuthority !== 'historical' &&
        (this.status !== InvoiceStatus.PAID || !this.paidDate)
      ) {
        this.paidDate = new Date();
      }
      this.status = InvoiceStatus.PAID;
    } else if (amountPaid + this.creditedAmount > 0) {
      this.status = InvoiceStatus.PARTIAL;
      this.paidDate = null; // Clear paidDate if no longer fully paid
    } else {
      // No payment remaining: revert to the appropriate pre-payment status
      this.paidDate = null;
      if (this.viewedAt) {
        this.status = InvoiceStatus.VIEWED;
      } else if (this.sentAt || this.moneyAuthority === 'historical') {
        this.status = InvoiceStatus.SENT;
      } else {
        this.status = InvoiceStatus.DRAFT;
      }
    }
  }

  /**
   * Cancel the invoice
   */
  cancel(): void {
    if (
      (this.kind === 'invoice' && this.isPaid()) ||
      (this.kind === 'credit_note' && this.amountPaid > 0)
    ) {
      throw new Error(
        `Cannot cancel ${this.kind} with status '${this.status}' and refunded/paid amount ${this.amountPaid}.`,
      );
    }
    this.status = InvoiceStatus.CANCELLED;
  }

  /** Cancel a posted invoice with an exact atomic journal reversal. */
  async cancelWithRevenueReversal(
    options: CancelRevenueOptions,
  ): Promise<Journal> {
    const { cancelInvoiceWithRevenueReversal, rebindJournal } = await import(
      '../invoice-posting.js'
    );
    return rebindJournal(
      this.db,
      await cancelInvoiceWithRevenueReversal(this, options),
    );
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
   * Post the issued invoice's revenue journal from its frozen money facts.
   *
   * Debits accounts receivable with the stored total, credits each line's
   * revenue account (or `revenueAccountId`) and each tax component's
   * liability account (or `taxAccountId`), then links the journal to the
   * invoice atomically. The invoice must be issued (frozen).
   *
   * @param options - Account IDs and the ledger book currency
   * @returns The posted journal
   *
   * @example
   * ```typescript
   * const journal = await invoice.recognizeRevenue({
   *   arAccountId: '1120',
   *   revenueAccountId: '4100',
   *   taxAccountId: '2130',
   *   bookCurrency: 'CAD',
   * });
   * ```
   */
  async recognizeRevenue(options: RecognizeRevenueOptions): Promise<Journal> {
    const { recognizeInvoiceRevenue, rebindJournal } = await import(
      '../invoice-posting.js'
    );
    return rebindJournal(this.db, await recognizeInvoiceRevenue(this, options));
  }

  /**
   * Get the AR journal entry (if revenue was recognized)
   */
  async getArJournal(): Promise<Journal | null> {
    if (!this.arJournalId) return null;

    try {
      const { JournalCollection } = await import('@happyvertical/smrt-ledgers');
      const collection = await JournalCollection.create(this.options);
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
   * by @happyvertical/accounting providers. The SDK takes currency **major**
   * units (`12.34` USD), so every amount is converted from this package's
   * integer minor units with the currency's ISO 4217 exponent (#3060).
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
  async toAccountingInput(
    options?: FrozenInvoiceAccountingOptions,
  ): Promise<AccountingInvoiceInput> {
    if (!options) {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Accounting conversion requires explicit realm mapping',
      );
    }
    if (!this.id || !this.tenantId) {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Accounting conversion requires a persisted tenant invoice',
      );
    }
    const { toFrozenInvoiceAccountingInput } = await import(
      '../invoice-accounting-sync.js'
    );
    return toFrozenInvoiceAccountingInput({
      db: this.db,
      tenantId: this.tenantId,
      invoiceId: this.id,
      mapping: options.mapping,
    });
  }
}

export default Invoice;
