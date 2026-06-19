/**
 * Payout — operator-to-supplier outgoing remittance.
 *
 * A Payout sits on the opposite side of a {@link Payment}: it tracks
 * funds *leaving* the operator's wallet and arriving at a vendor's
 * payout address. The two are kept as distinct models (rather than
 * overloading `Payment` with a `direction` field) because the status
 * machine, chain semantics, and audit story differ.
 *
 * Industry-neutral: any operator that ingests one payment and remits
 * funds to a third party — marketplaces, payment processors with
 * Connect-style fan-out, royalty distributors, escrow services —
 * benefits.
 *
 * MVP scope: no currency conversion. The payout's amounts and currency
 * mirror the originating Payment's native currency, and the vendor
 * needs a matching `Vendor.payoutAddresses` entry to receive funds.
 * Filtering at quote time (`PaymentIntent.paymentOptions`) is the
 * consumer's job; the model just enforces the natural-key invariant
 * and the status machine.
 *
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { PayoutStatus } from '../types/index.js';
import { Vendor } from './Vendor.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Payout extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation. Nullable so global / single-
   * tenant deployments work too.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * The source {@link Payment} that funded this payout. Plain string
   * reference (FK convention: `@foreignKey('ModelName')` would be
   * fine within the package, but `Payment` lives in this same
   * package — staying with a string keeps the dependency graph
   * clean and matches how `PaymentIntent` references `Payment`).
   */
  paymentId: string = '';

  /**
   * The destination {@link Vendor}. Foreign-key constrained because
   * Vendor lives in this same package and a hard reference catches
   * dangling payouts at insert time.
   */
  @foreignKey(Vendor)
  vendorId: string = '';

  /**
   * Total funds moved, in the originating payment's native currency.
   * Stored at decimal precision (matches `Payment.amount` /
   * `Payment.nativeAmount` convention).
   */
  grossAmount: number = 0.0;

  /**
   * Operator's take from `grossAmount`. Must equal
   * `grossAmount - supplierNet` at save time — the model enforces
   * the invariant via `validateAmounts()`.
   */
  operatorFee: number = 0.0;

  /**
   * Net funds the supplier receives. Must equal
   * `grossAmount - operatorFee` at save time.
   */
  supplierNet: number = 0.0;

  /**
   * Native currency the funds are denominated in — payout-rail-
   * qualified, matching `Payment.nativeCurrency` and
   * `Vendor.payoutAddresses` keys (`USDC-base`, `BTC`, `USD-stripe`,
   * etc.).
   */
  currency: string = '';

  /**
   * The `PaymentBackend` adapter id used to send the payout. For a
   * marketplace this typically matches the source `Payment.backendId`
   * (currency-match settlement, no conversion); other consumers can
   * use a different backend if they bridge currencies elsewhere.
   */
  backendId: string = '';

  /**
   * Outgoing chain transaction hash, gateway settlement id, or
   * (for not-yet-broadcast BTC payouts) a PSBT identifier. Set when
   * the payout transitions to `SENT`. Empty until then.
   */
  backendTxRef: string = '';

  /**
   * Current status — see {@link PayoutStatus} for the state machine.
   * Mutate via `markSent` / `markConfirmed` / `markFailed` /
   * `resetFromFailed` rather than direct assignment so the
   * transition invariants run.
   */
  status: PayoutStatus = PayoutStatus.PENDING;

  /**
   * When the payout transitioned to `SENT`.
   */
  sentAt: Date | null = null;

  /**
   * When the payout transitioned to `CONFIRMED`.
   */
  confirmedAt: Date | null = null;

  /**
   * When the payout transitioned to `FAILED`.
   */
  failedAt: Date | null = null;

  /**
   * Caller-supplied human-readable failure reason. Empty for non-
   * failed payouts. Cleared by `resetFromFailed()`.
   */
  failureReason: string = '';

  /**
   * Append-only operator notes — chargeback memos, manual-retry
   * justifications, etc.
   */
  notes: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.paymentId !== undefined) this.paymentId = options.paymentId;
    if (options.vendorId !== undefined) this.vendorId = options.vendorId;
    if (options.grossAmount !== undefined)
      this.grossAmount = options.grossAmount;
    if (options.operatorFee !== undefined)
      this.operatorFee = options.operatorFee;
    if (options.supplierNet !== undefined)
      this.supplierNet = options.supplierNet;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.backendId !== undefined) this.backendId = options.backendId;
    if (options.backendTxRef !== undefined)
      this.backendTxRef = options.backendTxRef;
    if (options.status !== undefined) this.status = options.status;
    if (options.sentAt !== undefined)
      this.sentAt = Payout.coerceDate(options.sentAt);
    if (options.confirmedAt !== undefined)
      this.confirmedAt = Payout.coerceDate(options.confirmedAt);
    if (options.failedAt !== undefined)
      this.failedAt = Payout.coerceDate(options.failedAt);
    if (options.failureReason !== undefined)
      this.failureReason = options.failureReason;
    if (options.notes !== undefined) this.notes = options.notes;
  }

  /**
   * Re-coerce timestamp fields after the framework reapplies raw option
   * values during initialization.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.sentAt = Payout.coerceDate(this.sentAt);
    this.confirmedAt = Payout.coerceDate(this.confirmedAt);
    this.failedAt = Payout.coerceDate(this.failedAt);
    return this;
  }

  // -------- Status predicates --------

  isPending(): boolean {
    return this.status === PayoutStatus.PENDING;
  }

  isSent(): boolean {
    return this.status === PayoutStatus.SENT;
  }

  isConfirmed(): boolean {
    return this.status === PayoutStatus.CONFIRMED;
  }

  isFailed(): boolean {
    return this.status === PayoutStatus.FAILED;
  }

  /**
   * Transition `PENDING → SENT`. Requires `backendTxRef` — without a
   * way to identify the outgoing transaction the payout cannot be
   * tracked further. Throws on any other source status so a confused
   * caller can't accidentally roll back a confirmed payout.
   */
  markSent(backendTxRef: string): void {
    if (this.status !== PayoutStatus.PENDING) {
      throw new Error(
        `Payout ${this.id}: cannot transition to SENT from status '${this.status}'`,
      );
    }
    if (!backendTxRef) {
      throw new Error(`Payout ${this.id}: markSent requires a backendTxRef`);
    }
    this.backendTxRef = backendTxRef;
    this.status = PayoutStatus.SENT;
    this.sentAt = new Date();
  }

  /**
   * Transition `SENT → CONFIRMED`. Throws if called from any other
   * status — confirmations on a pending payout would mean a chain
   * confirmation arrived before the application even recorded the
   * outgoing tx, which is a code bug worth surfacing rather than
   * silently fixing.
   */
  markConfirmed(): void {
    if (this.status !== PayoutStatus.SENT) {
      throw new Error(
        `Payout ${this.id}: cannot transition to CONFIRMED from status '${this.status}'`,
      );
    }
    this.status = PayoutStatus.CONFIRMED;
    this.confirmedAt = new Date();
  }

  /**
   * Move the payout to `FAILED`. Valid from `PENDING` (couldn't even
   * broadcast) or `SENT` (broadcast but chain rejected). Confirmed
   * payouts cannot fail — that path is a refund, modelled separately.
   */
  markFailed(reason: string): void {
    if (
      this.status !== PayoutStatus.PENDING &&
      this.status !== PayoutStatus.SENT
    ) {
      throw new Error(
        `Payout ${this.id}: cannot transition to FAILED from status '${this.status}'`,
      );
    }
    this.status = PayoutStatus.FAILED;
    this.failedAt = new Date();
    this.failureReason = reason ?? '';
  }

  /**
   * Operator-driven reset: move a `FAILED` payout back to `PENDING`
   * after fixing whatever broke. Clears the failure metadata and the
   * old `backendTxRef` (the next attempt will have a new one).
   * Distinct from `markFailed` reflexivity — the issue spec says
   * "failed is terminal but allows manual reset via explicit method".
   */
  resetFromFailed(): void {
    if (this.status !== PayoutStatus.FAILED) {
      throw new Error(
        `Payout ${this.id}: cannot reset from status '${this.status}' — only FAILED is resettable`,
      );
    }
    this.status = PayoutStatus.PENDING;
    this.sentAt = null;
    this.confirmedAt = null;
    this.failedAt = null;
    this.failureReason = '';
    // Drop the old tx ref so the next markSent attempt gets a fresh one.
    this.backendTxRef = '';
  }

  /**
   * Throws if the gross/fee/net invariant doesn't hold. Tolerates a
   * sub-cent rounding fuzz (`EPSILON = 0.01`) to match the rest of
   * the smrt-ledgers package's tolerance.
   */
  validateAmounts(): void {
    const EPSILON = 0.01;
    // Non-negativity guard (S5 audit #1390). A negative operatorFee would let
    // an operator manufacture a supplierNet larger than the gross it took in
    // (paying out more than it received); negative gross/net are nonsensical.
    for (const [field, value] of [
      ['grossAmount', this.grossAmount],
      ['operatorFee', this.operatorFee],
      ['supplierNet', this.supplierNet],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(
          `Payout ${this.id ?? '<new>'}: ${field} must be a non-negative number (got ${value}).`,
        );
      }
    }
    const expectedNet = this.grossAmount - this.operatorFee;
    if (Math.abs(this.supplierNet - expectedNet) > EPSILON) {
      throw new Error(
        `Payout ${this.id ?? '<new>'}: amount invariant violated — ` +
          `gross=${this.grossAmount} fee=${this.operatorFee} net=${this.supplierNet} ` +
          `(expected net=${expectedNet})`,
      );
    }
  }

  /**
   * Save with an amount-invariant guard, so a bad gross/fee/net triple
   * can't slip into the persisted row. Direct field manipulation
   * bypasses the helpers — this is the catch-all.
   */
  override async save(): Promise<this> {
    this.validateAmounts();
    return super.save() as Promise<this>;
  }

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

export default Payout;
