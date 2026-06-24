/**
 * Payment model - tracks payments with ledger integration
 * @packageDocumentation
 */

import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import type { Journal } from '@happyvertical/smrt-ledgers';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  PaymentMethod,
  type PaymentOptions,
  PaymentStatus,
  type RecordPaymentOptions,
} from '../types/index.js';

/**
 * Legal status transitions for a Payment, keyed by the prior persisted status.
 * A status mapping to itself (no-op re-save) is always permitted and handled
 * separately. Transitioning *into* COMPLETED is additionally gated on the
 * verified `recordPayment()` settlement path (see {@link Payment.save}) — it is
 * never reachable by raw mass-assignment even though it appears here as a
 * structurally legal edge out of PENDING.
 *
 * Forward path: PENDING → COMPLETED, with FAILED / CANCELLED as alternate
 * terminal exits from PENDING and REFUNDED reachable from COMPLETED.
 */
const PAYMENT_STATUS_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [
    PaymentStatus.COMPLETED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ],
  // A completed payment can only be reversed via refund.
  [PaymentStatus.COMPLETED]: [PaymentStatus.REFUNDED],
  // Terminal states.
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.REFUNDED]: [],
  [PaymentStatus.CANCELLED]: [],
};

/**
 * Module-scoped record of the status each Payment instance was loaded with,
 * so the save-time transition guard can compare the prior persisted status
 * against the one being written without adding a persisted column. WeakMap
 * keeps it out of the schema and GCs with the instance — same pattern as the
 * other commerce models.
 */
const loadedPaymentStatus = new WeakMap<Payment, PaymentStatus>();

/**
 * Marks instances whose transition into COMPLETED is being driven by the
 * verified `recordPayment()` settlement path (which posts a balanced journal
 * before flipping the status). The save-time guard consults this set so that
 * COMPLETED can only be reached through that path, never via raw
 * mass-assignment on the generated update route. Cleared after the save runs.
 */
const settlementInProgress = new WeakSet<Payment>();

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
  // ROOT FIX (S5 audit #1390 round 4): restrict the generated create/update
  // write surface so privileged / settlement-derived fields can NEVER be set
  // by a generated REST/MCP route — closing the status-mass-assignment vector
  // at the surface rather than relying solely on the save()-time guard.
  //
  // `writable` is an allowlist: only these fields survive applyWritablePolicy()
  // on BOTH create and update (#1540). Deliberately EXCLUDED:
  //  - `status` — a COMPLETED Payment is settlement proof downstream
  //    (PaymentIntent's PAID verification trusts it). It is only ever set by
  //    the verified `recordPayment()` settlement path, never by a caller. This
  //    closes the "forged COMPLETED Payment via api.create" vector (codex HIGH#1).
  //  - `journalId` / `paidAt` — settlement-derived, written by recordPayment().
  //  - `syncedAt` — provider-sync bookkeeping, written by the sync path.
  api: {
    include: ['list', 'get', 'create', 'update'],
    writable: [
      'contractId',
      'customerId',
      'amount',
      'currency',
      'method',
      'transactionId',
      'reference',
      'notes',
      'externalId',
      'externalProvider',
      'backendId',
      'backendTxRef',
      'nativeAmount',
      'nativeCurrency',
      'usdAtQuote',
      'usdAtConfirmation',
    ],
  },
  // NOTE: `recordPayment` is intentionally NOT exposed over MCP. It posts a
  // balanced journal into smrt-ledgers (moves money in the books) and flips
  // the payment to COMPLETED — not safe as an unguarded MCP tool that carries
  // no authz. Financial mutations must go through application code that
  // enforces permissions. The MCP create/update tools honor the same
  // `api.writable` allowlist above, so `status` is unsettable over MCP too.
  // See S5 audit #1390.
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Payment extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global payments
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Contract this payment is for
   */
  @foreignKey('Contract')
  contractId: string = '';

  /**
   * Customer who made the payment
   */
  @foreignKey('Customer')
  customerId: string = '';

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
  @crossPackageRef('@happyvertical/smrt-ledgers:Journal')
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

  // ============================================================================
  // Payment Backend Identity
  // ============================================================================
  //
  // When a `PaymentBackend` adapter (Stripe, x402, BTC RPC, etc.) brokers the
  // payment rather than a human recording it manually, we capture the
  // backend identity, its native-currency amount, and the USD valuation at
  // both quote and confirmation time. The classic `amount` / `currency`
  // pair stays as the canonical settlement number; the backend fields
  // describe *how* the funds arrived and let downstream accounting close
  // the loop on volatile-currency drift.
  //
  // All fields default to empty / zero so existing Payment consumers that
  // pre-date the marketplace adapter machinery are unaffected.

  /**
   * Stable identifier of the `PaymentBackend` adapter that served this
   * payment — e.g. `base-usdc`, `solana-usdc`, `btc`, `stripe`, `paypal`.
   *
   * Distinct from {@link externalProvider}: `backendId` names the SMRT
   * payment-rail adapter, while `externalProvider` names a downstream
   * accounting destination (QuickBooks, Stripe-the-accounting-source).
   * The same Stripe payment will have `backendId: 'stripe'` AND
   * `externalProvider: 'stripe'`; a crypto payment synced to QBO will
   * have `backendId: 'base-usdc'` and `externalProvider: 'quickbooks'`.
   */
  backendId: string = '';

  /**
   * Chain transaction hash or backend aggregator's reference id. For
   * on-chain payments this is the tx hash (`0x...` on EVM, base58 sig on
   * Solana, txid on Bitcoin); for fiat-rail backends it's the gateway's
   * own reference. Kept distinct from {@link transactionId} so consumers
   * that already populate `transactionId` with a provider-internal id
   * don't have to overload it.
   */
  backendTxRef: string = '';

  /**
   * The amount the backend actually moved, in its own native currency.
   * For stablecoin rails this typically equals `amount`; for volatile-
   * currency rails (BTC, ETH) it's the satoshi/wei figure that the chain
   * recorded, independent of any USD valuation.
   */
  nativeAmount: number = 0.0;

  /**
   * Code identifying the native currency `nativeAmount` is denominated
   * in. Mirrors the `backendId` namespacing convention — `USDC-base`,
   * `BTC`, `ETH`, `USD-stripe`. Empty string means "use {@link currency}"
   * (i.e. the payment was already quoted and settled in the same
   * currency).
   */
  nativeCurrency: string = '';

  /**
   * USD valuation of the payment at the moment the price was quoted to
   * the buyer (typically the moment a `PaymentIntent` was issued).
   * Stored at decimal precision; empty default `0.0` means no USD-quote
   * snapshot was taken (the payment was already USD-denominated or the
   * backend doesn't require drift accounting).
   */
  usdAtQuote: number = 0.0;

  /**
   * USD valuation of the payment at the moment it was confirmed on the
   * backend (chain confirmation, gateway settlement, etc.). The delta
   * between {@link usdAtQuote} and `usdAtConfirmation` is the USD drift
   * the operator absorbs (positive or negative) when accepting payment
   * in a volatile native currency.
   */
  usdAtConfirmation: number = 0.0;

  constructor(options: PaymentOptions = {}) {
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
    if (options.backendId !== undefined) this.backendId = options.backendId;
    if (options.backendTxRef !== undefined)
      this.backendTxRef = options.backendTxRef;
    if (options.nativeAmount !== undefined)
      this.nativeAmount = options.nativeAmount;
    if (options.nativeCurrency !== undefined)
      this.nativeCurrency = options.nativeCurrency;
    if (options.usdAtQuote !== undefined) this.usdAtQuote = options.usdAtQuote;
    if (options.usdAtConfirmation !== undefined)
      this.usdAtConfirmation = options.usdAtConfirmation;
  }

  /**
   * Capture the persisted status the row was loaded with, so the save-time
   * transition guard can reject illegal status flips made via raw field
   * assignment (mass-assignment on the generated update route, a stale caller,
   * etc.). Freshly-constructed (not-yet-saved) payments have no prior status.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) {
      loadedPaymentStatus.set(this, this.status);
    }
    return this;
  }

  /**
   * Save-time state-machine guard (S5 audit #1390).
   *
   * `status` is mass-assignable on the generated update/create routes, and a
   * COMPLETED Payment is treated as settlement proof downstream — e.g.
   * {@link PaymentIntent}'s PAID verification trusts a COMPLETED Payment row.
   * A forged `status: 'completed'` (with arbitrary amounts and no journal)
   * would therefore satisfy that check without any money having moved.
   *
   * This guard enforces two things:
   *  - **Transitions must be legal** per {@link PAYMENT_STATUS_TRANSITIONS}.
   *  - **Reaching COMPLETED requires the verified settlement path — on
   *    creation AND on update.** Only `recordPayment()` (which posts a
   *    balanced journal and links `journalId`) may write a Payment into
   *    COMPLETED; it announces itself via {@link settlementInProgress}. A raw
   *    `status: 'completed'` is rejected whether the row is brand-new (a
   *    GENESIS `create({ status: 'completed' })`) or already persisted — that
   *    is the exact path a forged COMPLETED would take to satisfy
   *    PaymentIntent's PAID verification without any money having moved (codex
   *    HIGH#1, #1390 round 5). There is deliberately NO import/fixture
   *    carve-out: a COMPLETED Payment is settlement proof downstream, so it is
   *    only ever reachable through `recordPayment()`, on every surface
   *    (REST/MCP/CLI/direct). Fixtures/migrations that need a completed payment
   *    must drive it through `recordPayment()` (or start non-COMPLETED).
   */
  override async save(): Promise<this> {
    const priorRow = await this.loadPersistedRow();
    const prior =
      priorRow && priorRow.status != null
        ? (priorRow.status as PaymentStatus)
        : loadedPaymentStatus.get(this);
    this.assertStatusTransition(prior);

    // Reaching COMPLETED is only legal via the verified settlement path,
    // regardless of whether this is a create (no persisted prior) or an
    // update of an existing row. A GENESIS create with status: COMPLETED would
    // otherwise forge settlement proof, so we close it here at the model level
    // — this covers EVERY surface (REST/MCP/CLI/direct), independent of any
    // writable-allowlist gap on a given surface.
    const reachingCompleted =
      this.status === PaymentStatus.COMPLETED &&
      prior !== PaymentStatus.COMPLETED;
    if (reachingCompleted && !settlementInProgress.has(this)) {
      throw new Error(
        `Payment ${this.id || '<new>'}: cannot set status to COMPLETED via ` +
          'raw assignment — a Payment is only completed through ' +
          'recordPayment(), which posts a balanced settlement journal. Use ' +
          'recordPayment() instead of setting status directly.',
      );
    }

    // Freeze the settled monetary fields once the row is already COMPLETED in
    // the database (S5 audit #1390 round 6 — codex ROOT INSIGHT; mirrors the
    // PaymentIntent PAID backing-field freeze). A COMPLETED Payment is
    // settlement proof: its amount was reconciled against a balanced journal
    // and is trusted downstream — PaymentIntent's PAID verification binds the
    // winning option's `nativeAmount` to `Payment.amount` / `nativeAmount`. The
    // only legal exit from COMPLETED is COMPLETED → REFUNDED, and a refund must
    // NOT alter the settled figures. Closing this at the model level covers
    // EVERY surface (REST/MCP/CLI/direct), independent of the per-surface
    // writable allowlist (`amount`/`currency`/`nativeAmount`/... are writable
    // on a *new* PENDING payment, but must be immutable once settled).
    if (priorRow && priorRow.status === PaymentStatus.COMPLETED) {
      this.assertSettledAmountsUnchanged(priorRow);
    }

    try {
      const result = (await super.save()) as this;
      loadedPaymentStatus.set(this, this.status);
      return result;
    } finally {
      settlementInProgress.delete(this);
    }
  }

  /**
   * Reject an illegal status flip. Compares the about-to-be-written status
   * against the status the row was loaded with. No-op transitions (status
   * unchanged) and brand-new rows (no prior) are always allowed — the
   * COMPLETED-specific settlement requirement is enforced separately in
   * {@link save}.
   */
  private assertStatusTransition(prior: PaymentStatus | undefined): void {
    if (prior === undefined) return; // new row — any starting status (subject to the COMPLETED gate)
    if (prior === this.status) return; // no-op re-save
    const allowed = PAYMENT_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Payment ${this.id}: illegal status transition '${prior}' → '${this.status}'. ` +
          'Use the guarded helpers (recordPayment / markFailed / cancel).',
      );
    }
  }

  /**
   * Load the AUTHORITATIVE persisted row (S5 audit #1390 round 4, codex HIGH#1;
   * extended round 6 to carry the full row, not just `status`). The WeakMap is
   * only populated when {@link initialize} loaded the row from the DB; it is
   * empty for an instance built via
   * `collection.create({ id: <existing>, _skipLoad: true })` — the upsert path
   * that lets a caller write onto an existing row without hydrating it. Trusting
   * an empty WeakMap there would treat the write as a brand-new row and skip the
   * transition guard entirely (a poisonable prior-state).
   *
   * So when this instance carries an `id`, read the persisted row straight from
   * the database and use it as the prior — a create-onto-existing is an update.
   * Returns `undefined` when no row exists (truly new), so callers fall back to
   * the WeakMap (which is also empty then). Settled-amount columns are
   * snake_case (`native_amount`, etc.); the `status` column is single-word.
   */
  private async loadPersistedRow(): Promise<
    Record<string, unknown> | undefined
  > {
    if (!this.id) return undefined;
    try {
      const row = await this.db.get(this.tableName, { id: this.id });
      return row ?? undefined;
    } catch {
      // DB not ready / table absent — treat as new (in-memory fallback in save).
      return undefined;
    }
  }

  /**
   * Reject any change to the settled monetary fields of an already-COMPLETED
   * Payment (S5 audit #1390 round 6 — codex ROOT INSIGHT). Mirrors the
   * PaymentIntent PAID backing-field freeze. A COMPLETED Payment's economic
   * identity is settled: the `amount` was posted into a balanced journal and is
   * the figure PaymentIntent's PAID verification reconciles against, so it (and
   * the native/USD valuation fields that describe the same money) must not
   * drift. The only legal status move out of COMPLETED is REFUNDED, which
   * reverses the funds without rewriting how much they were. Compared against
   * the AUTHORITATIVE persisted row so the freeze holds on every surface, even
   * for an un-hydrated create-onto-existing upsert.
   */
  private assertSettledAmountsUnchanged(
    priorRow: Record<string, unknown>,
  ): void {
    const frozen: Array<[string, number | string, number | string]> = [
      ['amount', Number(priorRow.amount ?? 0), Number(this.amount ?? 0)],
      [
        'currency',
        String(priorRow.currency ?? ''),
        String(this.currency ?? ''),
      ],
      [
        'nativeAmount',
        Number(priorRow.native_amount ?? 0),
        Number(this.nativeAmount ?? 0),
      ],
      [
        'nativeCurrency',
        String(priorRow.native_currency ?? ''),
        String(this.nativeCurrency ?? ''),
      ],
      [
        'usdAtQuote',
        Number(priorRow.usd_at_quote ?? 0),
        Number(this.usdAtQuote ?? 0),
      ],
      [
        'usdAtConfirmation',
        Number(priorRow.usd_at_confirmation ?? 0),
        Number(this.usdAtConfirmation ?? 0),
      ],
    ];
    for (const [field, prior, next] of frozen) {
      if (prior !== next) {
        throw new Error(
          `Payment ${this.id}: '${field}' is frozen once the payment is ` +
            `COMPLETED (was '${prior}', got '${next}'). A settled payment's ` +
            'monetary fields cannot be mutated — issue a refund instead.',
        );
      }
    }
  }

  /**
   * USD drift between quote time and confirmation time — what the
   * operator gained (positive) or lost (negative) by accepting a
   * volatile-currency payment. Returns `0` when either side of the
   * comparison is missing or zero, so callers don't have to special-case
   * fiat-rail / stablecoin payments.
   */
  usdDrift(): number {
    if (!this.usdAtQuote || !this.usdAtConfirmation) return 0;
    return this.usdAtConfirmation - this.usdAtQuote;
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
  async recordPayment(options: RecordPaymentOptions): Promise<Journal> {
    if (this.status === PaymentStatus.COMPLETED) {
      throw new Error('Payment already recorded');
    }

    if (this.amount <= 0) {
      throw new Error('Payment amount must be positive');
    }

    // Dynamic import to avoid hard dependency on smrt-ledgers
    const { JournalCollection } = await import('@happyvertical/smrt-ledgers');

    // Create the journal collection
    const journalCollection = await JournalCollection.create(this.options);

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

    // Update payment record. Announce the verified settlement to the save-time
    // guard so the COMPLETED transition is accepted (the guard rejects any
    // other route into COMPLETED). A posted journal always carries an id;
    // fail fast rather than persist an empty-string FK if that invariant breaks.
    if (!journal.id) {
      throw new Error(
        'Payment.recordPayment: journal was posted but has no id',
      );
    }
    this.journalId = journal.id;
    this.status = PaymentStatus.COMPLETED;
    this.paidAt = new Date();
    settlementInProgress.add(this);
    await this.save();

    return journal;
  }

  /**
   * Get the linked journal entry (if recorded)
   */
  async getJournal(): Promise<Journal | null> {
    if (!this.journalId) return null;

    try {
      const { JournalCollection } = await import('@happyvertical/smrt-ledgers');
      const collection = await JournalCollection.create(this.options);
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
