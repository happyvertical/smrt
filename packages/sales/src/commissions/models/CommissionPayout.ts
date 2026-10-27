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
 * only via {@link resetFromFailed}, and `rejected` the terminal
 * operator-decline exit from pending/approved (see {@link reject} — the
 * membership release lives in
 * `CommissionPayoutService.transitionPayoutForSource`). Transition helpers
 * mutate and stamp but DO NOT save — the caller saves (same convention as
 * Commission).
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
import {
  type CommissionPayoutOptions,
  type CommissionPayoutStatus,
  PAYOUT_METHODS,
  PAYOUT_METHODS_REQUIRING_DESTINATION,
  type PayoutDestination,
  type PayoutMethod,
} from '../types.js';
import { validatePayoutDestination } from './Earner.js';

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
  pending: ['approved', 'rejected'],
  approved: ['processing', 'failed', 'rejected'],
  processing: ['completed', 'failed'],
  completed: [],
  // FAILED is resettable to PENDING via resetFromFailed().
  failed: ['pending'],
  // REJECTED is terminal — the batch was declined and its membership
  // released; the released rows settle through a FUTURE batch instead.
  rejected: [],
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
  @field({ description: 'The affiliate being paid.' })
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
  @field({
    description: 'The total being paid, in the smallest unit of the currency.',
  })
  totalAmountCents: number = 0;

  /** ISO 4217 currency of the batch. */
  @field({ description: 'The currency of the payment.' })
  currency: string = 'USD';

  /** Delivery method for this batch (defaulted from the Earner). */
  payoutMethod: PayoutMethod = 'bank_transfer';

  /**
   * Routing descriptor captured at batch creation, never the live Earner's
   * preference. Routing is immutable after the first save, including pending
   * and failed/reset batches; reject and create a new batch to change it.
   * Legacy/manual methods have no typed descriptor (`{}`).
   */
  payoutDestination: string = '{}';

  /**
   * Lifecycle status — see the class doc. Mutate via {@link approve} /
   * {@link markProcessing} / {@link complete} / {@link fail} /
   * {@link resetFromFailed}.
   */
  @field({ description: 'Whether the payment is waiting, sent or failed.' })
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
  @field({ description: 'When the payment went out.' })
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
  @field({
    required: true,
    description: 'A reference that stops the same payout being made twice.',
  })
  idempotencyKey: string = '';

  /**
   * DERIVED single-source stamp: when every member commission — and every
   * member adjustment's parent commission — shares exactly one non-empty
   * `(sourceKind, sourceId)`, that source is stamped here; otherwise both
   * stay `''` (mixed-source, unknown-source, or empty membership). The
   * payout service maintains the stamp from VERIFIED claimed membership at
   * batch/repair time (`restampPayoutSource` is the backfill for payouts
   * minted before the stamp existed). It is the index behind the
   * source-scoped payout-history listing, which still re-verifies
   * membership per page — never an authorization input by itself.
   */
  sourceKind: string = '';

  /** Id half of the derived single-source stamp — see {@link sourceKind}. */
  @field({ indexed: true })
  sourceId: string = '';

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
    if (options.payoutDestination !== undefined)
      this.payoutDestination = options.payoutDestination;
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
    if (options.sourceKind !== undefined) this.sourceKind = options.sourceKind;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
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

  isRejected(): boolean {
    return this.status === 'rejected';
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
    this.validateRouting(true);
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
   * `pending | approved → rejected` (operator declined the batch before
   * remittance started). Terminal — there is no reset from rejected; the
   * released membership settles through a future batch. Requires a reason,
   * appended to {@link notes}. This mutates the payout only: use
   * `CommissionPayoutService.transitionPayoutForSource` to reject, which
   * also RELEASES the batch's membership (clears `payoutId` on its
   * commissions and adjustments) in the same operation — a rejected payout
   * that kept its rows stamped would strand them unsettleable forever.
   * Does NOT save — the caller saves.
   */
  reject(reason: string): void {
    if (this.status !== 'pending' && this.status !== 'approved') {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: cannot reject from status '${this.status}' — processing/terminal batches use fail()/resetFromFailed()`,
      );
    }
    if (!reason) {
      throw new Error(
        `CommissionPayout ${this.id ?? '<new>'}: reject() requires a reason`,
      );
    }
    this.status = 'rejected';
    const memo = `Rejected: ${reason}`;
    this.notes = this.notes ? `${this.notes}\n${memo}` : memo;
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

  /** Read the batch's validated routing snapshot, never a live Earner. */
  getPayoutDestination(): PayoutDestination | null {
    return this.validateRouting(false);
  }

  /** Set a descriptor before first persistence; save enforces routing freeze. */
  setPayoutDestination(destination: PayoutDestination | null): void {
    if (destination) validatePayoutDestination(destination);
    this.payoutDestination = JSON.stringify(destination ?? {});
    if (destination) this.payoutMethod = destination.method;
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
    await this.assertRoutingUnchanged();
    const prior = await this.resolvePriorStatus();
    // Legacy typed batches have no historical route to backfill. Keep
    // administrative saves/restamping possible while refusing payment progress.
    this.validateRouting(
      prior !== this.status &&
        ['approved', 'processing', 'completed'].includes(this.status),
    );
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

  private validateRouting(
    requireDestination: boolean,
  ): PayoutDestination | null {
    const label = `CommissionPayout ${this.id ?? '<new>'}`;
    if (!(PAYOUT_METHODS as readonly string[]).includes(this.payoutMethod)) {
      throw new Error(`${label}: unknown payoutMethod '${this.payoutMethod}'`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.payoutDestination);
    } catch {
      throw new Error(`${label}: payoutDestination must be valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label}: payoutDestination must be a JSON object`);
    }
    if (Object.keys(parsed).length > 0) {
      validatePayoutDestination(parsed as PayoutDestination);
      const destination = parsed as PayoutDestination;
      if (destination.method !== this.payoutMethod) {
        throw new Error(
          `${label}: payoutDestination method does not match payoutMethod`,
        );
      }
      return destination;
    }
    if (
      requireDestination &&
      (PAYOUT_METHODS_REQUIRING_DESTINATION as readonly string[]).includes(
        this.payoutMethod,
      )
    ) {
      throw new Error(
        `${label}: ${this.payoutMethod} requires a payoutDestination snapshot; reject and recreate the batch`,
      );
    }
    return null;
  }

  /** Authoritative read also closes blind-id and natural-key upsert doors. */
  private async assertRoutingUnchanged(): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT CAST(id AS VARCHAR) AS id, payout_method, payout_destination FROM ${this.tableName} WHERE id = ? OR idempotency_key = ?`,
      this.id ?? null,
      this.idempotencyKey || null,
    );
    for (const row of rows) {
      if (row.id !== this.id) {
        throw new Error(
          'CommissionPayout: existing batch routing is immutable; reuse its idempotency key through the payout service',
        );
      }
      // Existing rows migrated without a descriptor intentionally stay empty;
      // never infer historical routing from today's mutable Earner preference.
      const priorDestination = String(row.payout_destination ?? '{}');
      const canonical = (raw: string) => {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return JSON.stringify(
          Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b)),
        );
      };
      if (
        row.payout_method !== this.payoutMethod ||
        canonical(priorDestination) !== canonical(this.payoutDestination)
      ) {
        throw new Error(
          'CommissionPayout: routing is immutable; reject and recreate the batch',
        );
      }
    }
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
          'complete() / fail() / reject() / resetFromFailed().',
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
