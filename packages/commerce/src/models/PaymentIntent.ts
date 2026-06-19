/**
 * PaymentIntent — short-lived pre-payment commitment with multi-option
 * semantics.
 *
 * A PaymentIntent is a one-shot quote that locks a USD price for a fixed
 * window and lists one or more `PaymentOption`s describing different
 * payment rails (USDC-on-Base, BTC, Stripe, etc.) that can each satisfy
 * the intent. The first option that receives an incoming payment wins —
 * the intent transitions to {@link PaymentIntentStatus.PAID} and the
 * other options are implicitly retired. Later inbound funds to a
 * retired option must be flagged for refund by the consumer's
 * payment-routing layer.
 *
 * Distinct from `Estimate` (a long-form contract proposal STI subtype
 * of `Contract`): a `PaymentIntent` is short-lived (minutes, not days),
 * carries no line items, and exists to coordinate the moment-of-payment.
 *
 * Industry-neutral: any application that offers more than one route to
 * pay for the same thing — marketplaces, billing systems with multi-
 * provider checkout, agent-driven (x402) flows — benefits.
 *
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  PaymentIntentStatus,
  type PaymentOption,
  PaymentStatus,
} from '../types/index.js';

/**
 * Sub-cent rounding tolerance for native-amount reconciliation between the
 * winning PaymentOption and the referenced Payment row.
 */
const PAYMENT_INTENT_EPSILON = 0.01;

/**
 * Legal status transitions for a PaymentIntent, keyed by the prior persisted
 * status. Mirrors the state machine documented on {@link PaymentIntentStatus}
 * and enforced by the dedicated helpers, so a raw `status` mass-assignment on
 * the generated update route can't skip steps (e.g. `awaiting_payment →
 * issued`) or revive a terminal state.
 *
 * `awaiting_payment → paid → (issued | retired)`, with `expired` / `cancelled`
 * as alternate terminal exits from `awaiting_payment`. `issued` may still be
 * `retired` (a reversal after rights were issued).
 */
const PAYMENT_INTENT_STATUS_TRANSITIONS: Record<
  PaymentIntentStatus,
  PaymentIntentStatus[]
> = {
  [PaymentIntentStatus.AWAITING_PAYMENT]: [
    PaymentIntentStatus.PAID,
    PaymentIntentStatus.EXPIRED,
    PaymentIntentStatus.CANCELLED,
  ],
  [PaymentIntentStatus.PAID]: [
    PaymentIntentStatus.ISSUED,
    PaymentIntentStatus.RETIRED,
  ],
  [PaymentIntentStatus.ISSUED]: [PaymentIntentStatus.RETIRED],
  // Terminal states.
  [PaymentIntentStatus.RETIRED]: [],
  [PaymentIntentStatus.EXPIRED]: [],
  [PaymentIntentStatus.CANCELLED]: [],
};

/**
 * Module-scoped record of the status each PaymentIntent was loaded with, so
 * the save-time guard can detect a status being forced to PAID via raw
 * mass-assignment (bypassing the verified transition path). Same WeakMap
 * pattern as the rest of the package.
 */
const loadedIntentStatus = new WeakMap<PaymentIntent, PaymentIntentStatus>();

/**
 * Default price-lock window — 15 minutes is a reasonable middle ground:
 * long enough for a buyer to swap wallets / approve a Stripe payment,
 * short enough that volatile-currency drift stays bounded.
 */
const DEFAULT_PRICE_LOCK_WINDOW_MS = 15 * 60 * 1000;

@TenantScoped({ mode: 'optional' })
@smrt({
  // Natural-key idempotency: a consumer that retries `create` with the
  // same (offeringRef, licenseeEmail, idempotencyKey) within the
  // retention window will hit the existing row via upsert rather than
  // creating a duplicate. Tenant id is part of the key so the same
  // idempotency key never collides across tenants.
  conflictColumns: [
    'tenant_id',
    'offering_ref',
    'licensee_email',
    'idempotency_key',
  ],
  // ROOT FIX (S5 audit #1390 round 4): the generated create/update surface may
  // only set the quote-definition fields. The PAID-state backing fields
  // (`status`, `paymentId`, `paidOptionBackendId`) are EXCLUDED — they are set
  // exclusively by the verified `verifyAndMarkPaid()` / `markIssued()` path, so
  // a caller can never forge a PAID intent (or repoint one) through a generated
  // route. `paymentOptions` IS writable (a quote may be re-priced while
  // AWAITING_PAYMENT) but is frozen by `save()` once the intent is PAID/ISSUED
  // (codex HIGH#2). Timestamps + priceLockExpiresAt are derived and excluded.
  api: {
    include: ['list', 'get', 'create', 'update'],
    writable: [
      'skuId',
      'offeringRef',
      'licenseeEmail',
      'customerId',
      'paymentOptions',
      'usdPriceLocked',
      'priceLockWindowMs',
      'idempotencyKey',
      'notes',
    ],
  },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class PaymentIntent extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation. Nullable so the same model
   * can serve both per-tenant SaaS deployments and single-tenant /
   * global setups.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Plain string reference to the upstream `Sku` (from
   * `@happyvertical/smrt-products`) being purchased. Cross-package
   * reference — plain string, not `@foreignKey()`, to avoid the
   * circular dependency the framework warns against.
   *
   * Required for the marketplace flow; other consumers can leave it
   * empty if they don't model a catalog.
   */
  skuId: string = '';

  /**
   * Caller-supplied scope for the idempotency-key natural key. The
   * marketplace sets this to a `Sku` id, but the field is intentionally
   * abstract so other consumers (subscription tiers, donation tiers,
   * tipping flows) can scope idempotency by whatever granularity makes
   * sense.
   *
   * Empty string is permitted but disables the natural-key dedup —
   * every retry then creates a fresh row.
   */
  offeringRef: string = '';

  /**
   * The buyer's email address. The licensee on any downstream
   * `LicenseSale` (or similar rights-issuance row) is identified by
   * this email — high-tier purchases also create a `Customer` record
   * and set {@link customerId}, but most purchases get away with email
   * alone.
   */
  licenseeEmail: string = '';

  /**
   * Optional link to a `Customer` row for purchases that warrant a
   * full customer record (high-tier licensing, recurring buyers,
   * etc.). Cross-model reference is kept as a plain string to match
   * the rest of the package's cross-package convention.
   */
  customerId: string = '';

  /**
   * The payment rails the buyer can choose between to satisfy this
   * intent. Stored as a JSON column. See {@link PaymentOption} for
   * the per-option shape. Empty array means the intent is invalid /
   * mis-built; callers should reject save in that case.
   */
  paymentOptions: PaymentOption[] = [];

  /**
   * USD price locked at quote time. Stored at decimal precision.
   * Independent of any specific option's native-currency amount;
   * `usdPriceLocked` is the canonical "what this costs in USD"
   * number used downstream for reporting, tax, and drift accounting.
   */
  usdPriceLocked: number = 0.0;

  /**
   * Length of the price-lock window in milliseconds. Defaults to 15
   * minutes; consumers can override per-intent. Stored so a later
   * audit can see the original window even after {@link priceLockExpiresAt}
   * has passed.
   */
  priceLockWindowMs: number = DEFAULT_PRICE_LOCK_WINDOW_MS;

  /**
   * Wall-clock time at which the price lock expires. Set by the
   * constructor (or by `expire()` if you want to short-circuit a
   * specific intent). Once `Date.now()` passes this value and the
   * status is still `AWAITING_PAYMENT`, callers should treat the
   * intent as expired and refuse to record a payment against it.
   */
  priceLockExpiresAt: Date | null = null;

  /**
   * Current status — see {@link PaymentIntentStatus} for the state
   * machine. Mutate via the dedicated `markPaid` / `markIssued` /
   * `expire` / `cancel` / `retire` helpers rather than assigning
   * directly, so the helpers' invariant checks run.
   */
  status: PaymentIntentStatus = PaymentIntentStatus.AWAITING_PAYMENT;

  /**
   * Caller-supplied idempotency key. Combined with `tenantId`,
   * `offeringRef`, and `licenseeEmail`, this forms the natural key
   * registered in `conflictColumns` — a retried `create` with the
   * same tuple upserts the existing row instead of creating a
   * duplicate.
   *
   * Empty string disables natural-key dedup (every retry creates a
   * fresh row).
   */
  idempotencyKey: string = '';

  /**
   * `backendId` of the option that satisfied the intent. Set by
   * {@link markPaid}; remains empty for non-paid intents. Used by
   * {@link isOptionRetired} to flag inbound funds on the other
   * options as "needs refund".
   */
  paidOptionBackendId: string = '';

  /**
   * Plain string reference to the `Payment` row that satisfied the
   * intent. Cross-model reference matches the rest of the
   * package's convention.
   */
  paymentId: string = '';

  /**
   * When the intent transitioned to `PAID`.
   */
  paidAt: Date | null = null;

  /**
   * When the intent transitioned to `ISSUED`.
   */
  issuedAt: Date | null = null;

  /**
   * When the intent transitioned to `EXPIRED`.
   */
  expiredAt: Date | null = null;

  /**
   * When the intent transitioned to `CANCELLED`.
   */
  cancelledAt: Date | null = null;

  /**
   * When the intent transitioned to `RETIRED`.
   */
  retiredAt: Date | null = null;

  /**
   * Optional human-readable notes (e.g., support tickets, refund
   * memos, cancellation reasons). Append-only by convention.
   */
  notes: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.skuId !== undefined) this.skuId = options.skuId;
    if (options.offeringRef !== undefined)
      this.offeringRef = options.offeringRef;
    if (options.licenseeEmail !== undefined)
      this.licenseeEmail = options.licenseeEmail;
    if (options.customerId !== undefined) this.customerId = options.customerId;
    if (options.paymentOptions !== undefined)
      this.paymentOptions = PaymentIntent.normalizePaymentOptions(
        options.paymentOptions,
      );
    if (options.usdPriceLocked !== undefined)
      this.usdPriceLocked = options.usdPriceLocked;
    if (options.priceLockWindowMs !== undefined)
      this.priceLockWindowMs = options.priceLockWindowMs;
    if (options.priceLockExpiresAt !== undefined) {
      this.priceLockExpiresAt = PaymentIntent.coerceDate(
        options.priceLockExpiresAt,
      );
    }
    if (options.status !== undefined) this.status = options.status;
    if (options.idempotencyKey !== undefined)
      this.idempotencyKey = options.idempotencyKey;
    if (options.paidOptionBackendId !== undefined)
      this.paidOptionBackendId = options.paidOptionBackendId;
    if (options.paymentId !== undefined) this.paymentId = options.paymentId;
    if (options.paidAt !== undefined)
      this.paidAt = PaymentIntent.coerceDate(options.paidAt);
    if (options.issuedAt !== undefined)
      this.issuedAt = PaymentIntent.coerceDate(options.issuedAt);
    if (options.expiredAt !== undefined)
      this.expiredAt = PaymentIntent.coerceDate(options.expiredAt);
    if (options.cancelledAt !== undefined)
      this.cancelledAt = PaymentIntent.coerceDate(options.cancelledAt);
    if (options.retiredAt !== undefined)
      this.retiredAt = PaymentIntent.coerceDate(options.retiredAt);
    if (options.notes !== undefined) this.notes = options.notes;
  }

  /**
   * Re-normalize `paymentOptions` after the framework's
   * `initializePropertiesFromOptions` pass has overwritten the
   * constructor-set values with the raw cloned input, and stamp a
   * default `priceLockExpiresAt` so newly-created intents have a
   * concrete expiry without callers needing to compute it.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.paymentOptions = PaymentIntent.normalizePaymentOptions(
      this.paymentOptions as unknown,
    );
    this.priceLockExpiresAt = PaymentIntent.coerceDate(this.priceLockExpiresAt);
    this.paidAt = PaymentIntent.coerceDate(this.paidAt);
    this.issuedAt = PaymentIntent.coerceDate(this.issuedAt);
    this.expiredAt = PaymentIntent.coerceDate(this.expiredAt);
    this.cancelledAt = PaymentIntent.coerceDate(this.cancelledAt);
    this.retiredAt = PaymentIntent.coerceDate(this.retiredAt);
    if (!this.priceLockExpiresAt) {
      // Anchor the price-lock window to "now" if no explicit expiry
      // was supplied. Using the configured window so consumers that
      // override `priceLockWindowMs` get the right anchor.
      this.priceLockExpiresAt = new Date(
        Date.now() + (this.priceLockWindowMs || DEFAULT_PRICE_LOCK_WINDOW_MS),
      );
    }
    if (await this.isSaved()) {
      loadedIntentStatus.set(this, this.status);
    }
    return this;
  }

  /**
   * Save-time state-machine guard (S5 audit #1390 round 2).
   *
   * `status`, `paymentId`, and `paidOptionBackendId` are all mass-assignable on
   * the generated update route, and the sync `markPaid` helper trusts its
   * arguments. Two distinct attacks follow:
   *
   *  1. **Forge a PAID intent** — set `status: 'paid'` (or call bare `markPaid`)
   *     against a bogus / pending / non-matching Payment. This falsifies
   *     downstream "this was paid for" rights issuance.
   *  2. **Repoint an already-PAID intent** — leave `status: 'paid'` but swap
   *     `paymentId` / `paidOptionBackendId` to a bogus Payment after the fact.
   *     Round 1 only verified the *transition into* PAID, so an already-PAID
   *     row could be silently repointed with no re-verify. Likewise an intent
   *     forced straight to `ISSUED` (the terminal happy-path that gates rights
   *     issuance) was never required to have been backed by a real Payment.
   *
   * This guard therefore:
   *  - validates the status transition is legal (no `awaiting_payment → issued`
   *    skips, no reviving terminal states);
   *  - re-verifies the backing Payment on **every** save where the persisted
   *    status is PAID or ISSUED — not just the transition edge — so a repoint
   *    of the paid backing fields is caught.
   *
   * Re-verifying an unchanged PAID/ISSUED row is cheap (one Payment load) and
   * closes the repoint hole; freezing the backing fields would instead block
   * legitimate corrections, so we re-verify.
   */
  override async save(): Promise<this> {
    const priorRow = await this.loadPersistedRow();
    const prior = priorRow
      ? (priorRow.status as PaymentIntentStatus)
      : loadedIntentStatus.get(this);
    this.assertStatusTransition(prior);

    // Freeze the backing fields once the intent is already PAID/ISSUED in the
    // database (codex HIGH#2). Round 3 re-verified the backing Payment but did
    // so against the *mutable* in-memory `paymentOptions`, so a caller could
    // swap `paymentId` to a different completed Payment AND edit the matching
    // option's `nativeAmount` so the reconciliation still passed — silently
    // repointing a settled intent at unrelated funds. A PAID/ISSUED intent's
    // economic identity (paymentId + paidOptionBackendId + usdPriceLocked +
    // paymentOptions) is settled and must not change; corrections go through
    // `retire()` + a fresh intent.
    if (
      priorRow &&
      (priorRow.status === PaymentIntentStatus.PAID ||
        priorRow.status === PaymentIntentStatus.ISSUED)
    ) {
      this.assertBackingFieldsUnchanged(priorRow);
    }

    const persistingPaidOrIssued =
      this.status === PaymentIntentStatus.PAID ||
      this.status === PaymentIntentStatus.ISSUED;

    if (persistingPaidOrIssued) {
      await this.assertBackedByCompletedPayment();
    }

    const result = (await super.save()) as this;
    loadedIntentStatus.set(this, this.status);
    return result;
  }

  /**
   * Load the authoritative persisted row for this intent (S5 audit #1390 round
   * 4). Returns `undefined` when the intent has no `id` or no row exists yet
   * (truly new). Reading the DB directly — rather than trusting the
   * {@link loadedIntentStatus} WeakMap, which is only populated when
   * {@link initialize} hydrated the row — defeats the poisonable-prior-state
   * vector where `create({ id: <existing>, _skipLoad: true })` produces an
   * un-hydrated instance whose WeakMap entry is missing. A create-onto-existing
   * is thus correctly treated as an update.
   */
  private async loadPersistedRow(): Promise<Record<string, any> | undefined> {
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
   * Reject any change to the settled backing fields of an already-PAID/ISSUED
   * intent (codex HIGH#2). `paymentOptions` is compared structurally because
   * the winning option's `nativeAmount` is exactly what the reconciliation in
   * {@link assertBackedByCompletedPayment} binds against — letting it drift
   * would let a repointed `paymentId` match a doctored option.
   */
  private assertBackingFieldsUnchanged(priorRow: Record<string, any>): void {
    const frozen: Array<[string, unknown, unknown]> = [
      ['paymentId', priorRow.payment_id ?? '', this.paymentId],
      [
        'paidOptionBackendId',
        priorRow.paid_option_backend_id ?? '',
        this.paidOptionBackendId,
      ],
      [
        'usdPriceLocked',
        Number(priorRow.usd_price_locked ?? 0),
        Number(this.usdPriceLocked ?? 0),
      ],
    ];
    for (const [field, prior, next] of frozen) {
      if (prior !== next) {
        throw new Error(
          `PaymentIntent ${this.id}: '${field}' is frozen once the intent is ` +
            `PAID/ISSUED (was '${prior}', got '${next}'). A settled intent's ` +
            'backing fields cannot be repointed — retire() it and issue a new intent.',
        );
      }
    }

    const priorOptions = PaymentIntent.normalizePaymentOptions(
      priorRow.payment_options as unknown,
    );
    const nextOptions = PaymentIntent.normalizePaymentOptions(
      this.paymentOptions as unknown,
    );
    if (JSON.stringify(priorOptions) !== JSON.stringify(nextOptions)) {
      throw new Error(
        `PaymentIntent ${this.id}: 'paymentOptions' is frozen once the intent ` +
          'is PAID/ISSUED — the winning option backs the verified Payment ' +
          'reconciliation and cannot change. retire() it and issue a new intent.',
      );
    }
  }

  /**
   * Reject an illegal status flip done via raw field assignment. Compares the
   * about-to-be-written status against the status the row was loaded with.
   * No-op re-saves (status unchanged) and brand-new rows are allowed (the
   * backing-Payment verification still runs separately for PAID/ISSUED).
   */
  private assertStatusTransition(prior: PaymentIntentStatus | undefined): void {
    if (prior === undefined) return; // new row
    if (prior === this.status) return; // no-op re-save
    const allowed = PAYMENT_INTENT_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `PaymentIntent ${this.id}: illegal status transition '${prior}' → ` +
          `'${this.status}'. Use the guarded transition helpers ` +
          '(verifyAndMarkPaid / markIssued / expire / cancel / retire).',
      );
    }
  }

  /**
   * Verify the intent's `paidOptionBackendId` / `paymentId` reference a real,
   * COMPLETED, amount-matching Payment. Throws otherwise. Shared by
   * {@link verifyAndMarkPaid} (pre-transition) and the save-time guard
   * (catch-all for raw mass-assignment).
   */
  private async assertBackedByCompletedPayment(): Promise<void> {
    if (!this.paidOptionBackendId) {
      throw new Error(
        `PaymentIntent ${this.id}: cannot persist PAID status without a paidOptionBackendId`,
      );
    }
    if (!this.paymentId) {
      throw new Error(
        `PaymentIntent ${this.id}: cannot persist PAID status without a paymentId`,
      );
    }
    const option = this.getOption(this.paidOptionBackendId);
    if (!option) {
      throw new Error(
        `PaymentIntent ${this.id}: paidOptionBackendId '${this.paidOptionBackendId}' is not one of the listed options`,
      );
    }

    const { PaymentCollection } = await import(
      '../collections/PaymentCollection.js'
    );
    const payments = await (PaymentCollection as any).create(this.options);
    const payment = await payments.get({ id: this.paymentId });
    if (!payment) {
      throw new Error(
        `PaymentIntent ${this.id}: referenced Payment '${this.paymentId}' does not exist`,
      );
    }
    if (payment.status !== PaymentStatus.COMPLETED) {
      throw new Error(
        `PaymentIntent ${this.id}: Payment '${this.paymentId}' is not COMPLETED ` +
          `(status='${payment.status}'); cannot persist PAID intent against it`,
      );
    }
    const paymentNative =
      typeof payment.nativeAmount === 'number' && payment.nativeAmount > 0
        ? payment.nativeAmount
        : payment.amount;
    if (
      Math.abs(paymentNative - option.nativeAmount) > PAYMENT_INTENT_EPSILON
    ) {
      throw new Error(
        `PaymentIntent ${this.id}: Payment '${this.paymentId}' amount ${paymentNative} ` +
          `does not match option '${this.paidOptionBackendId}' nativeAmount ${option.nativeAmount}`,
      );
    }
  }

  // -------- Status helpers --------

  isAwaitingPayment(): boolean {
    return this.status === PaymentIntentStatus.AWAITING_PAYMENT;
  }

  isPaid(): boolean {
    return this.status === PaymentIntentStatus.PAID;
  }

  isIssued(): boolean {
    return this.status === PaymentIntentStatus.ISSUED;
  }

  isCancelled(): boolean {
    return this.status === PaymentIntentStatus.CANCELLED;
  }

  isRetired(): boolean {
    return this.status === PaymentIntentStatus.RETIRED;
  }

  /**
   * Terminal-state predicate: any status other than `AWAITING_PAYMENT`
   * is terminal (the intent will not accept further state changes
   * except the explicit `markIssued` after `PAID`).
   */
  isTerminal(): boolean {
    return this.status !== PaymentIntentStatus.AWAITING_PAYMENT;
  }

  /**
   * `Date.now()`-based predicate: has the price lock window passed?
   * Independent of `status` so callers can detect a stale-but-not-
   * yet-marked-EXPIRED intent (and call `expire()` to advance it).
   */
  isExpired(): boolean {
    if (this.status === PaymentIntentStatus.EXPIRED) return true;
    if (!this.priceLockExpiresAt) return false;
    return Date.now() > this.priceLockExpiresAt.getTime();
  }

  // -------- State transitions --------

  /**
   * Transition the intent to `PAID`, naming which option satisfied it
   * and which `Payment` row carries the funds. Implicitly retires the
   * other options — callers can check {@link isOptionRetired} to flag
   * later inbound funds for refund.
   *
   * Throws when called on a non-`AWAITING_PAYMENT` intent so a stale
   * caller can't accidentally overwrite a winning option with a
   * losing one.
   */
  markPaid(args: { backendId: string; paymentId: string }): void {
    if (this.status !== PaymentIntentStatus.AWAITING_PAYMENT) {
      throw new Error(
        `PaymentIntent ${this.id}: cannot transition to PAID from status '${this.status}'`,
      );
    }
    // Refuse stale quotes. A backend can report a payment after the price-lock
    // window has passed but before a cleanup job has run `expire()` — the
    // intent is still AWAITING_PAYMENT, yet honoring it would accept funds at
    // an expired USD price. `isExpired()` is status-independent (it checks
    // `priceLockExpiresAt`), so guard on it here; callers should `expire()`
    // and re-quote rather than record against a lapsed lock.
    if (this.isExpired()) {
      throw new Error(
        `PaymentIntent ${this.id}: price lock expired at ` +
          `${this.priceLockExpiresAt?.toISOString() ?? 'unknown'}; cannot record a ` +
          `payment against a stale quote (call expire() and re-quote)`,
      );
    }
    if (!args.backendId) {
      throw new Error(
        `PaymentIntent ${this.id}: markPaid requires a backendId`,
      );
    }
    const option = this.paymentOptions.find(
      (o) => o.backendId === args.backendId,
    );
    if (!option) {
      throw new Error(
        `PaymentIntent ${this.id}: backendId '${args.backendId}' is not one of the listed options`,
      );
    }
    this.status = PaymentIntentStatus.PAID;
    this.paidOptionBackendId = args.backendId;
    this.paymentId = args.paymentId ?? '';
    this.paidAt = new Date();
  }

  /**
   * Verify-then-transition variant of {@link markPaid} (S5 audit #1390).
   *
   * `markPaid` trusts the caller-supplied `paymentId` / `backendId` without
   * checking the referenced `Payment` actually exists, is `COMPLETED`, or
   * carries the amount the winning option quoted. That lets a caller mark an
   * intent PAID against a non-existent or still-pending payment. This method
   * loads the `Payment` row and enforces:
   *
   *  - the Payment exists,
   *  - it is `COMPLETED` (not pending / failed / cancelled / refunded),
   *  - and its amount reconciles with the winning option's `nativeAmount`
   *    (within sub-cent tolerance), falling back to the option vs. the
   *    Payment's settlement `amount` when no native rail is recorded.
   *
   * Only after those pass does it delegate to the sync `markPaid` for the
   * status-machine invariants.
   *
   * @param args.backendId  backendId of the option that was satisfied
   * @param args.paymentId  id of the Payment row carrying the funds (required)
   */
  async verifyAndMarkPaid(args: {
    backendId: string;
    paymentId: string;
  }): Promise<void> {
    if (!args.paymentId) {
      throw new Error(
        `PaymentIntent ${this.id}: verifyAndMarkPaid requires a paymentId`,
      );
    }
    const option = this.paymentOptions.find(
      (o) => o.backendId === args.backendId,
    );
    if (!option) {
      throw new Error(
        `PaymentIntent ${this.id}: backendId '${args.backendId}' is not one of the listed options`,
      );
    }

    const { PaymentCollection } = await import(
      '../collections/PaymentCollection.js'
    );
    const payments = await (PaymentCollection as any).create(this.options);
    const payment = await payments.get({ id: args.paymentId });
    if (!payment) {
      throw new Error(
        `PaymentIntent ${this.id}: referenced Payment '${args.paymentId}' does not exist`,
      );
    }
    if (payment.status !== PaymentStatus.COMPLETED) {
      throw new Error(
        `PaymentIntent ${this.id}: Payment '${args.paymentId}' is not COMPLETED ` +
          `(status='${payment.status}'); cannot mark intent PAID against it`,
      );
    }

    // Reconcile the amount the option quoted against what the payment moved.
    // Prefer the native-rail figure when present (volatile-currency rails),
    // otherwise compare against the settlement `amount`.
    const paymentNative =
      typeof payment.nativeAmount === 'number' && payment.nativeAmount > 0
        ? payment.nativeAmount
        : payment.amount;
    if (
      Math.abs(paymentNative - option.nativeAmount) > PAYMENT_INTENT_EPSILON
    ) {
      throw new Error(
        `PaymentIntent ${this.id}: Payment '${args.paymentId}' amount ${paymentNative} ` +
          `does not match option '${args.backendId}' nativeAmount ${option.nativeAmount}`,
      );
    }

    this.markPaid({ backendId: args.backendId, paymentId: args.paymentId });
  }

  /**
   * Transition a `PAID` intent to `ISSUED` once the downstream rights
   * / contract / fulfillment have been created. Idempotent — calling
   * twice is a no-op so callers don't have to guard against retries.
   */
  markIssued(): void {
    if (this.status === PaymentIntentStatus.ISSUED) return;
    if (this.status !== PaymentIntentStatus.PAID) {
      throw new Error(
        `PaymentIntent ${this.id}: cannot transition to ISSUED from status '${this.status}'`,
      );
    }
    this.status = PaymentIntentStatus.ISSUED;
    this.issuedAt = new Date();
  }

  /**
   * Move an `AWAITING_PAYMENT` intent to `EXPIRED`. Safe to call on
   * an already-expired intent (no-op). Throws on terminal non-
   * expired states so a confused caller can't undo a paid / issued
   * intent.
   */
  expire(): void {
    if (this.status === PaymentIntentStatus.EXPIRED) return;
    if (this.status !== PaymentIntentStatus.AWAITING_PAYMENT) {
      throw new Error(
        `PaymentIntent ${this.id}: cannot expire from status '${this.status}'`,
      );
    }
    this.status = PaymentIntentStatus.EXPIRED;
    this.expiredAt = new Date();
  }

  /**
   * Cancel an open intent. Only valid from `AWAITING_PAYMENT` —
   * a paid / issued intent is no longer the buyer's to cancel; that
   * path is a refund, modelled separately on `Payment`.
   */
  cancel(reason?: string): void {
    if (this.status !== PaymentIntentStatus.AWAITING_PAYMENT) {
      throw new Error(
        `PaymentIntent ${this.id}: cannot cancel from status '${this.status}'`,
      );
    }
    this.status = PaymentIntentStatus.CANCELLED;
    this.cancelledAt = new Date();
    if (reason) {
      this.notes = this.notes
        ? `${this.notes}\nCancelled: ${reason}`
        : `Cancelled: ${reason}`;
    }
  }

  /**
   * Mark a paid intent as retired — used when a previously-recorded
   * payment was reversed (chargeback, refund) and the intent should
   * not be considered "satisfied" anymore. Distinct from `cancel()`
   * which only applies to never-paid intents.
   */
  retire(reason?: string): void {
    if (
      this.status !== PaymentIntentStatus.PAID &&
      this.status !== PaymentIntentStatus.ISSUED
    ) {
      throw new Error(
        `PaymentIntent ${this.id}: cannot retire from status '${this.status}'`,
      );
    }
    this.status = PaymentIntentStatus.RETIRED;
    this.retiredAt = new Date();
    if (reason) {
      this.notes = this.notes
        ? `${this.notes}\nRetired: ${reason}`
        : `Retired: ${reason}`;
    }
  }

  // -------- Option helpers --------

  /**
   * Return the option whose `backendId` matches, or `undefined` if
   * no such option is on this intent. Useful for routing inbound
   * payments to the right option's `nativeAmount` / `payTo` for
   * verification.
   */
  getOption(backendId: string): PaymentOption | undefined {
    return this.paymentOptions.find((o) => o.backendId === backendId);
  }

  /**
   * `true` once the intent is paid and the given option was NOT the
   * winning one. Consumers use this to flag inbound funds to retired
   * options for refund. Returns `false` for the winning option, for
   * unpaid intents, and for an unknown `backendId`.
   */
  isOptionRetired(backendId: string): boolean {
    if (!this.isPaid() && !this.isIssued() && !this.isRetired()) return false;
    if (!this.paidOptionBackendId) return false;
    if (!this.getOption(backendId)) return false;
    return backendId !== this.paidOptionBackendId;
  }

  /**
   * The options that were NOT selected at payment time. Returns an
   * empty array for unpaid intents so callers can iterate without
   * special-casing.
   */
  getRetiredOptions(): PaymentOption[] {
    if (!this.paidOptionBackendId) return [];
    return this.paymentOptions.filter(
      (o) => o.backendId !== this.paidOptionBackendId,
    );
  }

  // -------- Normalization helpers --------

  /**
   * Defensive coercion for `paymentOptions` input. Accepts either an
   * already-parsed array or a JSON string (e.g. from a row whose
   * column was hand-edited or migrated from a different schema).
   * Drops entries that don't carry the required `backendId` /
   * `currency` / `payTo` / `nativeAmount` quartet so downstream
   * routing code can rely on the invariant.
   */
  private static normalizePaymentOptions(value: unknown): PaymentOption[] {
    if (value == null) return [];
    let parsed: unknown = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];
    const out: PaymentOption[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object') continue;
      const o = raw as Record<string, unknown>;
      const backendId = typeof o.backendId === 'string' ? o.backendId : '';
      const currency = typeof o.currency === 'string' ? o.currency : '';
      const payTo = typeof o.payTo === 'string' ? o.payTo : '';
      const nativeAmount =
        typeof o.nativeAmount === 'number' ? o.nativeAmount : Number.NaN;
      if (!backendId || !currency || !payTo || !Number.isFinite(nativeAmount)) {
        continue;
      }
      const option: PaymentOption = {
        backendId,
        currency,
        payTo,
        nativeAmount,
      };
      if (typeof o.chain === 'string' && o.chain) option.chain = o.chain;
      if (typeof o.memo === 'string' && o.memo) option.memo = o.memo;
      if (typeof o.x402Capable === 'boolean') {
        option.x402Capable = o.x402Capable;
      }
      if (typeof o.expiresAt === 'string' && o.expiresAt) {
        option.expiresAt = o.expiresAt;
      }
      out.push(option);
    }
    return out;
  }

  /**
   * Coerce a Date-ish input (Date / number / ISO string / null /
   * undefined) into a `Date | null`. The framework hands us strings
   * when hydrating from SQLite, numbers when round-tripping through
   * JSON, and Date instances from the application.
   */
  private static coerceDate(value: unknown): Date | null {
    if (value == null) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'number' || typeof value === 'string') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
}

export default PaymentIntent;
