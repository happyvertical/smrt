/**
 * CommissionPayout — settlement batch for one earner in one currency.
 *
 * A payout gathers an earner's payable unsettled Commissions plus the
 * unsettled Adjustments of eligible commissions, stamps `payoutId` on those
 * EXACT rows, and records the totals it settled
 * (`totalAmountCents = commissionTotalCents + adjustmentTotalCents` —
 * enforced at save time). Batches are minted by
 * `CommissionPayoutService.createPayoutBatch`, idempotently via the
 * `idempotencyKey` natural key.
 *
 * The model is named CommissionPayout (table `commission_payouts`) to avoid
 * the global table-name collision with commerce `Payout` / legacy affiliates
 * `Payout` (`payouts`).
 *
 * Generated surface is FULLY read-only — list/get on api, mcp, AND cli.
 * Commerce Payout precedent ("a payout has no safe generated write"): the
 * status drives an outgoing remittance and the totals are the integrity
 * core, so the only legitimate writes are the service's creation path and
 * the guarded transition helpers below. The CLI is an independently
 * configured write surface — `cli: true` would regenerate the exact
 * create/update vector closed on api/mcp, so it is locked to list/get too.
 *
 * Lifecycle: `pending → approved → processing → completed | failed`, with
 * `failed` reachable from approved/processing and resettable to `pending`
 * only via {@link resetFromFailed}. Transition helpers mutate and stamp but
 * DO NOT save — the caller saves (same convention as Commission).
 *
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  CommissionPayoutOptions,
  CommissionPayoutStatus,
  PayoutMethod,
} from '../types.js';

/**
 * Legal status transitions, keyed by the prior persisted status.
 * `failed → pending` exists only for {@link resetFromFailed}. `completed`
 * is terminal. No-op re-saves and brand-new rows are always permitted;
 * this map governs *changes* to persisted rows only (commerce pattern).
 */
const PAYOUT_STATUS_TRANSITIONS: Record<
  CommissionPayoutStatus,
  CommissionPayoutStatus[]
> = {
  pending: ['approved'],
  approved: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: [],
  // FAILED is resettable to PENDING via resetFromFailed().
  failed: ['pending'],
};

/**
 * Module-scoped record of the status each payout instance was loaded with —
 * fallback for the save-time guard when the DB re-read is unavailable.
 */
const loadedPayoutStatus = new WeakMap<
  CommissionPayout,
  CommissionPayoutStatus
>();

@TenantScoped({ mode: 'optional' })
@smrt({
  // Idempotent settlement: a retried batch with the same idempotencyKey
  // resolves to the existing payout instead of double-paying.
  conflictColumns: ['idempotency_key'],
  // Fully read-only generated surface on ALL THREE surfaces — see the
  // class doc. Writes go through CommissionPayoutService and the guarded
  // transition helpers only.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class CommissionPayout extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global payouts). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The {@link Earner} being paid. Required. */
  @foreignKey('Earner', { required: true })
  earnerId: string = '';

  /** Start of the settlement period this batch covers (informational). */
  periodStart: Date | null = null;

  /** End of the settlement period this batch covers (informational). */
  periodEnd: Date | null = null;

  /** Σ amountCents of the Commissions this batch settled (integer cents). */
  commissionTotalCents: number = 0;

  /**
   * Σ signed amountCents of the Adjustments this batch settled (integer
   * cents; clawbacks make it negative).
   */
  adjustmentTotalCents: number = 0;

  /**
   * Net amount remitted — must equal
   * `commissionTotalCents + adjustmentTotalCents` (enforced on save).
   */
  totalAmountCents: number = 0;

  /** ISO 4217 currency of the batch. */
  currency: string = 'USD';

  /** Delivery method for this batch (defaulted from the Earner). */
  payoutMethod: PayoutMethod = 'bank_transfer';

  /**
   * Lifecycle status — see the class doc. Mutate via {@link approve} /
   * {@link markProcessing} / {@link complete} / {@link fail} /
   * {@link resetFromFailed}.
   */
  status: CommissionPayoutStatus = 'pending';

  /**
   * Payment reference recorded at completion (check number, transfer id,
   * …). Cleared by {@link resetFromFailed}.
   */
  paymentReference: string = '';

  /**
   * Opaque payout-provider reference (processor batch id, remittance file
   * id, …). Retained across failure/reset for audit.
   */
  providerRef: string = '';

  /** When the payout completed. */
  paidAt: Date | null = null;

  /**
   * Optional link to the commerce Invoice that papers this payout
   * (cross-package string reference — never a DDL foreign key).
   */
  @crossPackageRef('@happyvertical/smrt-commerce:Invoice')
  invoiceId: string = '';

  /** Operator notes — approval memos, failure reasons (append-only). */
  notes: string = '';

  /**
   * Idempotency natural key. Required. The payout service defaults it to
   * `` `${earnerId}:${currency}:${periodEnd ISO date}` `` when the caller
   * doesn't supply one.
   */
  @field({ required: true })
  idempotencyKey: string = '';

  /** Additional metadata as a JSON string. */
  metadata: string = '{}';

  constructor(options: CommissionPayoutOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.earnerId !== undefined) this.earnerId = options.earnerId;
    if (options.periodStart !== undefined)
      this.periodStart = CommissionPayout.coerceDate(options.periodStart);
    if (options.periodEnd !== undefined)
      this.periodEnd = CommissionPayout.coerceDate(options.periodEnd);
    if (options.commissionTotalCents !== undefined)
      this.commissionTotalCents = options.commissionTotalCents;
    if (options.adjustmentTotalCents !== undefined)
      this.adjustmentTotalCents = options.adjustmentTotalCents;
    if (options.totalAmountCents !== undefined)
      this.totalAmountCents = options.totalAmountCents;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.payoutMethod !== undefined)
      this.payoutMethod = options.payoutMethod;
    if (options.status !== undefined) this.status = options.status;
    if (options.paymentReference !== undefined)
      this.paymentReference = options.paymentReference;
    if (options.providerRef !== undefined)
      this.providerRef = options.providerRef;
    if (options.paidAt !== undefined)
      this.paidAt = CommissionPayout.coerceDate(options.paidAt);
    if (options.invoiceId !== undefined) this.invoiceId = options.invoiceId;
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.idempotencyKey !== undefined)
      this.idempotencyKey = options.idempotencyKey;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Re-coerce timestamp fields after the framework reapplies raw option /
   * hydrated row values, and record the loaded status for the save guard.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.periodStart = CommissionPayout.coerceDate(this.periodStart);
    this.periodEnd = CommissionPayout.coerceDate(this.periodEnd);
    this.paidAt = CommissionPayout.coerceDate(this.paidAt);
    if (await this.isSaved()) {
      loadedPayoutStatus.set(this, this.status);
    }
    return this;
  }

  // -------- Status predicates --------

  isPending(): boolean {
    return this.status === 'pending';
  }

  isApproved(): boolean {
    return this.status === 'approved';
  }

  isProcessing(): boolean {
    return this.status === 'processing';
  }

  isCompleted(): boolean {
    return this.status === 'completed';
  }

  isFailed(): boolean {
    return this.status === 'failed';
  }

  // -------- Transition methods (mutate only — caller saves) --------

  /** `pending → approved`. Does NOT save — the caller saves. */
  approve(): void {
    if (this.status !== 'pending') {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: cannot approve from status '${this.status}'`,
      );
    }
    // A batch whose reconciled membership nets to nothing (or a clawback
    // surplus) must never move toward remittance — such payouts exist only
    // as audit artifacts of a raced/interrupted claim pass.
    if (this.totalAmountCents <= 0) {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: cannot approve a batch with ` +
          `non-positive total (${this.totalAmountCents} cents)`,
      );
    }
    this.status = 'approved';
  }

  /** `approved → processing`. Does NOT save — the caller saves. */
  markProcessing(): void {
    if (this.status !== 'approved') {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: cannot mark processing from status '${this.status}'`,
      );
    }
    this.status = 'processing';
  }

  /**
   * `processing → completed`. Requires a payment reference — a completed
   * payout with no reference is untraceable. Stamps {@link paidAt}.
   * Does NOT save — the caller saves.
   */
  complete(paymentReference: string, now: Date = new Date()): void {
    if (this.status !== 'processing') {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: cannot complete from status '${this.status}'`,
      );
    }
    if (!paymentReference) {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: complete() requires a paymentReference`,
      );
    }
    this.status = 'completed';
    this.paymentReference = paymentReference;
    this.paidAt = now;
  }

  /**
   * `approved | processing → failed`. Appends the reason to {@link notes}.
   * Does NOT save — the caller saves.
   */
  fail(reason: string): void {
    if (this.status !== 'approved' && this.status !== 'processing') {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: cannot fail from status '${this.status}'`,
      );
    }
    this.status = 'failed';
    const memo = `Failed: ${reason ?? ''}`;
    this.notes = this.notes ? `${this.notes}\n${memo}` : memo;
  }

  /**
   * Operator-driven reset: `failed → pending` after fixing whatever broke.
   * Clears {@link paymentReference} and {@link paidAt} (the next attempt
   * gets fresh ones) but RETAINS {@link providerRef} and {@link notes} for
   * audit. The only path out of `failed`. Does NOT save — the caller saves.
   */
  resetFromFailed(): void {
    if (this.status !== 'failed') {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: cannot reset from status '${this.status}' — only failed payouts are resettable`,
      );
    }
    this.status = 'pending';
    this.paymentReference = '';
    this.paidAt = null;
  }

  // -------- Metadata helpers --------

  /** Parse {@link metadata}; returns `{}` on empty/invalid JSON. */
  getMetadata(): Record<string, unknown> {
    if (!this.metadata) return {};
    try {
      const parsed = JSON.parse(this.metadata) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Serialize and store {@link metadata}. */
  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data ?? {});
  }

  // -------- Save-time guards --------

  /**
   * Save with two guards (commerce pattern):
   *
   * 1. **Totals invariant** — `totalAmountCents` must equal
   *    `commissionTotalCents + adjustmentTotalCents` (exact integer
   *    arithmetic, no epsilon).
   * 2. **Status transition** — validated against the AUTHORITATIVE prior
   *    persisted status (re-read from the database so a
   *    `create({ id, _skipLoad: true })` upsert can't sidestep the guard).
   *    A `completed` payout additionally requires a payment reference,
   *    matching {@link complete}'s invariant, regardless of how the status
   *    was set.
   */
  override async save(): Promise<this> {
    this.validateTotals();
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    if (this.status === 'completed' && !this.paymentReference) {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: a completed payout requires a paymentReference (use complete()).`,
      );
    }
    const result = (await super.save()) as this;
    loadedPayoutStatus.set(this, this.status);
    return result;
  }

  /** Throws when the totals invariant doesn't hold. */
  validateTotals(): void {
    for (const [name, value] of [
      ['commissionTotalCents', this.commissionTotalCents],
      ['adjustmentTotalCents', this.adjustmentTotalCents],
      ['totalAmountCents', this.totalAmountCents],
    ] as const) {
      if (!Number.isInteger(value)) {
        throw new Error(
          `CommissionPayout ${this.id ?? '<new>'}: ${name} must be integer cents (got ${value}).`,
        );
      }
    }
    const expected = this.commissionTotalCents + this.adjustmentTotalCents;
    if (this.totalAmountCents !== expected) {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: totals invariant violated — ` +
          `commission=${this.commissionTotalCents} adjustment=${this.adjustmentTotalCents} ` +
          `total=${this.totalAmountCents} (expected total=${expected}).`,
      );
    }
  }

  private async resolvePriorStatus(): Promise<
    CommissionPayoutStatus | undefined
  > {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as CommissionPayoutStatus;
        }
      } catch {
        // DB not ready — fall through to the in-memory record.
      }
    }
    return loadedPayoutStatus.get(this);
  }

  private assertStatusTransition(
    prior: CommissionPayoutStatus | undefined,
  ): void {
    if (prior === undefined) return; // new row
    if (prior === this.status) return; // no-op re-save
    const allowed = PAYOUT_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `CommissionPayout ${this.id}: illegal status transition '${prior}' ` +
          `→ '${this.status}'. Use approve() / markProcessing() / ` +
          'complete() / fail() / resetFromFailed().',
      );
    }
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

export default CommissionPayout;
