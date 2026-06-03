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
import { PaymentIntentStatus, type PaymentOption } from '../types/index.js';

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
  api: { include: ['list', 'get', 'create', 'update'] },
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
    return this;
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
