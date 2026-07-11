/**
 * Commission — one earning record for one earner, one plan component, one
 * earning-event occurrence.
 *
 * Amounts are integer cents; `rate`/`shareFraction` are decimals in 0–1.
 * Every row stores snapshot references (`planKey`/`planVersion` plus a
 * generic polymorphic `termsSnapshotKind`/`termsSnapshotId` — the referrals
 * module points the latter at its ReferralTermSnapshot) and a JSON
 * `calculationTrace` sufficient to reproduce `amountCents`, so earnings stay
 * auditable after plans are superseded.
 *
 * Lifecycle is a STRICT forward chain — `pending → earned → approved →
 * payable → paid` — enforced at save time against the AUTHORITATIVE prior
 * persisted status (re-read from the database, commerce pattern), so neither
 * raw mass-assignment nor a `create({ id, _skipLoad: true })` upsert can skip
 * steps or roll back. Use the transition methods ({@link markEarned} /
 * {@link approve} / {@link markPayable} / {@link markPaid}); they mutate and
 * stamp timestamps but DO NOT save — the caller saves (one explicit
 * persistence point per mutation, matching commerce's markSent/markConfirmed
 * convention).
 *
 * Commissions are audit rows: the generated surface has no update or delete.
 * Corrections append {@link CommissionAdjustment} rows instead of editing.
 *
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  CommissionBasis,
  CommissionCalculationTrace,
  CommissionOptions,
  CommissionStatus,
} from '../types.js';

/**
 * Legal status transitions — the strict chain, keyed by prior persisted
 * status. No-op re-saves and brand-new rows are always permitted (imports /
 * fixtures may seed any status); this map governs *changes* to persisted
 * rows only.
 */
const COMMISSION_STATUS_TRANSITIONS: Record<
  CommissionStatus,
  CommissionStatus[]
> = {
  pending: ['earned'],
  earned: ['approved'],
  approved: ['payable'],
  payable: ['paid'],
  paid: [],
};

/**
 * Module-scoped record of the status each Commission instance was loaded
 * with — fallback for the save-time guard when the DB re-read is
 * unavailable. WeakMap keeps it out of the schema (commerce pattern).
 */
const loadedCommissionStatus = new WeakMap<Commission, CommissionStatus>();

@TenantScoped({ mode: 'optional' })
@smrt({
  // Idempotent creation: dedupeKey is the natural key so a retried
  // calculation upserts instead of duplicating.
  conflictColumns: ['dedupe_key'],
  // Audit rows: create/list/get only — no generated update or delete.
  // Lifecycle mutations happen through the guarded transition methods and
  // the settlement/payout services.
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  // High volume and mutation-sensitive — no CLI surface.
  cli: false,
})
export class Commission extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global rows). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The {@link Earner} this commission belongs to. Required. */
  @foreignKey('Earner', { required: true })
  earnerId: string = '';

  /** The {@link EarningEvent} evidence row this commission derives from. */
  @foreignKey('EarningEvent')
  earningEventId: string = '';

  /** Snapshot reference: plan key at calculation time. */
  planKey: string = '';

  /** Snapshot reference: plan version at calculation time. */
  planVersion: number = 0;

  /** Which plan component produced this commission. */
  componentKey: string = '';

  /**
   * Generic polymorphic reference to the terms snapshot that governed the
   * calculation (e.g. the referrals module sets
   * `('referral_term_snapshot', <id>)`). Free-form; this module attaches no
   * semantics beyond recording it in the dedupe key and trace.
   */
  termsSnapshotKind: string = '';

  /** Id of the terms snapshot named by {@link termsSnapshotKind}. */
  termsSnapshotId: string = '';

  /** How {@link baseAmountCents} was resolved from the event. */
  basis: CommissionBasis = 'gross';

  /** Base amount the rate was applied to, in integer cents. */
  baseAmountCents: number = 0;

  /** Rate applied (0–1). Recorded as `0` for `fixed`-basis commissions. */
  rate: number = 0.0;

  /** Split share applied (0–1). `1.0` for unsplit commissions. */
  shareFraction: number = 1.0;

  /**
   * Groups the sibling commissions of one split — every earner sharing an
   * event/component carries the same `splitGroupId`. Empty for unsplit rows.
   */
  splitGroupId: string = '';

  /** The earned amount in integer cents. */
  amountCents: number = 0;

  /** ISO 4217 currency (copied from the earning event). */
  currency: string = 'USD';

  /**
   * Lifecycle status — strict chain `pending → earned → approved → payable
   * → paid`. Mutate via the transition methods; the save-time guard rejects
   * illegal edges.
   */
  status: CommissionStatus = 'pending';

  /**
   * End of the clearing window (refund/chargeback holdback). `null` means
   * no clearing applies — the commission is immediately sweepable to
   * `earned` (see `CommissionSettlementService.sweepClearing`).
   */
  clearingEndsAt: Date | null = null;

  /** When the commission transitioned to `earned`. */
  earnedAt: Date | null = null;

  /** When the commission transitioned to `approved`. */
  approvedAt: Date | null = null;

  /** When the commission transitioned to `payable`. */
  payableAt: Date | null = null;

  /** When the commission transitioned to `paid`. */
  paidAt: Date | null = null;

  /**
   * The {@link CommissionPayout} batch that settled this commission. Empty
   * until a payout batch stamps it.
   */
  @foreignKey('CommissionPayout')
  payoutId: string = '';

  /** Copied from the earning event for reporting (generic source pair). */
  sourceKind: string = '';

  /** Copied from the earning event for reporting. */
  sourceId: string = '';

  /**
   * JSON-string {@link CommissionCalculationTrace} — everything needed to
   * reproduce {@link amountCents}. Use {@link getCalculationTrace} /
   * {@link setCalculationTrace}.
   */
  calculationTrace: string = '{}';

  /**
   * Idempotency natural key —
   * `` `${event.dedupeKey}:${terms}:${componentKey}:${earnerId}:${occurrenceIndex}` ``
   * (see `CommissionCalculationService`). Required.
   */
  @field({ required: true })
  dedupeKey: string = '';

  /** Additional metadata as a JSON string. */
  metadata: string = '{}';

  constructor(options: CommissionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.earnerId !== undefined) this.earnerId = options.earnerId;
    if (options.earningEventId !== undefined)
      this.earningEventId = options.earningEventId;
    if (options.planKey !== undefined) this.planKey = options.planKey;
    if (options.planVersion !== undefined)
      this.planVersion = options.planVersion;
    if (options.componentKey !== undefined)
      this.componentKey = options.componentKey;
    if (options.termsSnapshotKind !== undefined)
      this.termsSnapshotKind = options.termsSnapshotKind;
    if (options.termsSnapshotId !== undefined)
      this.termsSnapshotId = options.termsSnapshotId;
    if (options.basis !== undefined) this.basis = options.basis;
    if (options.baseAmountCents !== undefined)
      this.baseAmountCents = options.baseAmountCents;
    if (options.rate !== undefined) this.rate = options.rate;
    if (options.shareFraction !== undefined)
      this.shareFraction = options.shareFraction;
    if (options.splitGroupId !== undefined)
      this.splitGroupId = options.splitGroupId;
    if (options.amountCents !== undefined)
      this.amountCents = options.amountCents;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.status !== undefined) this.status = options.status;
    if (options.clearingEndsAt !== undefined)
      this.clearingEndsAt = Commission.coerceDate(options.clearingEndsAt);
    if (options.earnedAt !== undefined)
      this.earnedAt = Commission.coerceDate(options.earnedAt);
    if (options.approvedAt !== undefined)
      this.approvedAt = Commission.coerceDate(options.approvedAt);
    if (options.payableAt !== undefined)
      this.payableAt = Commission.coerceDate(options.payableAt);
    if (options.paidAt !== undefined)
      this.paidAt = Commission.coerceDate(options.paidAt);
    if (options.payoutId !== undefined) this.payoutId = options.payoutId;
    if (options.sourceKind !== undefined) this.sourceKind = options.sourceKind;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.calculationTrace !== undefined)
      this.calculationTrace = options.calculationTrace;
    if (options.dedupeKey !== undefined) this.dedupeKey = options.dedupeKey;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Re-coerce timestamp fields after the framework reapplies raw option /
   * hydrated row values, and record the loaded status for the save guard.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.clearingEndsAt = Commission.coerceDate(this.clearingEndsAt);
    this.earnedAt = Commission.coerceDate(this.earnedAt);
    this.approvedAt = Commission.coerceDate(this.approvedAt);
    this.payableAt = Commission.coerceDate(this.payableAt);
    this.paidAt = Commission.coerceDate(this.paidAt);
    if (await this.isSaved()) {
      loadedCommissionStatus.set(this, this.status);
    }
    return this;
  }

  // -------- Status predicates --------

  isPending(): boolean {
    return this.status === 'pending';
  }

  isEarned(): boolean {
    return this.status === 'earned';
  }

  isApproved(): boolean {
    return this.status === 'approved';
  }

  isPayable(): boolean {
    return this.status === 'payable';
  }

  isPaid(): boolean {
    return this.status === 'paid';
  }

  /** `true` once a payout batch has stamped {@link payoutId}. */
  isSettled(): boolean {
    return !!this.payoutId;
  }

  // -------- Transition methods (mutate only — caller saves) --------

  /**
   * `pending → earned` (clearing window passed). Stamps {@link earnedAt}.
   * Does NOT save — the caller saves.
   */
  markEarned(now: Date = new Date()): void {
    this.assertTransitionFrom('pending', 'earned');
    this.status = 'earned';
    this.earnedAt = now;
  }

  /**
   * `earned → approved` (operator/automation approved the earning).
   * Stamps {@link approvedAt}. Does NOT save — the caller saves.
   */
  approve(now: Date = new Date()): void {
    this.assertTransitionFrom('earned', 'approved');
    this.status = 'approved';
    this.approvedAt = now;
  }

  /**
   * `approved → payable` (released for the next payout batch).
   * Stamps {@link payableAt}. Does NOT save — the caller saves.
   */
  markPayable(now: Date = new Date()): void {
    this.assertTransitionFrom('approved', 'payable');
    this.status = 'payable';
    this.payableAt = now;
  }

  /**
   * `payable → paid` (its payout batch completed). Stamps {@link paidAt}.
   * Does NOT save — the caller saves.
   */
  markPaid(now: Date = new Date()): void {
    this.assertTransitionFrom('payable', 'paid');
    this.status = 'paid';
    this.paidAt = now;
  }

  private assertTransitionFrom(
    expected: CommissionStatus,
    next: CommissionStatus,
  ): void {
    if (this.status !== expected) {
      throw new Error(
        `Commission ${this.id ?? '<new>'}: cannot transition to '${next}' ` +
          `from status '${this.status}' (chain is pending → earned → ` +
          'approved → payable → paid)',
      );
    }
  }

  // -------- Trace / metadata helpers --------

  /** Parse {@link calculationTrace}; returns `null` on empty/invalid JSON. */
  getCalculationTrace(): CommissionCalculationTrace | null {
    if (!this.calculationTrace) return null;
    try {
      const parsed = JSON.parse(this.calculationTrace) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      const trace = parsed as CommissionCalculationTrace;
      return typeof trace.componentKey === 'string' &&
        typeof trace.baseAmountCents === 'number'
        ? trace
        : null;
    } catch {
      return null;
    }
  }

  /** Serialize and store {@link calculationTrace}. */
  setCalculationTrace(trace: CommissionCalculationTrace): void {
    this.calculationTrace = JSON.stringify(trace);
  }

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

  // -------- Save-time guard --------

  /**
   * Save-time state-machine guard (commerce pattern). Validates the status
   * transition against the AUTHORITATIVE prior persisted status — re-read
   * from the database so a `create({ id: <existing>, _skipLoad: true })`
   * upsert is correctly treated as an update rather than a guard-free new
   * row. Brand-new rows may start in any status (fixtures/imports); a
   * persisted row may only advance one legal step.
   */
  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    await this.assertDedupeKeyNotTaken();
    const result = (await super.save()) as this;
    loadedCommissionStatus.set(this, this.status);
    return result;
  }

  /**
   * Refuse a save whose `dedupeKey` already belongs to a DIFFERENT row —
   * commissions are audit rows, and the natural-key upsert would let a
   * fresh instance (generated `create`, or the loser of a calculation
   * race) overwrite the persisted amount/status and rotate the row id.
   * `CommissionCalculationService` treats this refusal as "someone else
   * already earned it" and returns the existing row.
   */
  private async assertDedupeKeyNotTaken(): Promise<void> {
    if (!this.dedupeKey) return;
    try {
      const res = await this.db.query(
        `SELECT id FROM ${this.tableName} WHERE dedupe_key = $1`,
        this.dedupeKey,
      );
      const rows = Array.isArray(res)
        ? (res as Record<string, unknown>[])
        : ((res as { rows?: Record<string, unknown>[] }).rows ?? []);
      const taken = rows.find((row) => row.id !== this.id);
      if (taken) {
        throw new Error(
          `Commission (dedupeKey '${this.dedupeKey}'): a commission with ` +
            'this dedupe key already exists — commissions are immutable ' +
            'audit rows; corrections append CommissionAdjustments.',
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('immutable')) {
        throw error;
      }
      // DB not ready / table absent — nothing persisted to collide with.
    }
  }

  private async resolvePriorStatus(): Promise<CommissionStatus | undefined> {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as CommissionStatus;
        }
      } catch {
        // DB not ready — fall through to the in-memory record.
      }
    }
    return loadedCommissionStatus.get(this);
  }

  private assertStatusTransition(prior: CommissionStatus | undefined): void {
    if (prior === undefined) return; // new row
    if (prior === this.status) return; // no-op re-save
    const allowed = COMMISSION_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Commission ${this.id}: illegal status transition '${prior}' → ` +
          `'${this.status}'. Use markEarned() / approve() / markPayable() ` +
          '/ markPaid().',
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

export default Commission;
