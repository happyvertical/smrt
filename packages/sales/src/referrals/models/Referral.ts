/**
 * Referral — the introduction record.
 *
 * A Referral says "this referrer introduced this target under this program"
 * — the target is a GENERIC `(targetKind, targetId)` pair (lead,
 * opportunity, client, project, subscription, …) so the referrals module
 * never depends on CRM or any downstream domain.
 *
 * Lifecycle (save-time guarded against the AUTHORITATIVE prior persisted
 * status — commerce pattern):
 *
 * - `pending → attributed | under_review | disqualified | expired`
 * - `under_review → attributed | disqualified`
 * - `attributed → qualified | disqualified | expired`
 * - `qualified → disqualified` (rare clawback path)
 * - `disqualified` / `expired` are terminal.
 *
 * Transition methods ({@link markAttributed} / {@link markUnderReview} /
 * {@link markQualified} / {@link disqualify} / {@link markExpired}) mutate
 * and stamp timestamps but DO NOT save — the caller saves (one explicit
 * persistence point per mutation, matching the sibling modules).
 *
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ReferralOptions, ReferralStatus } from '../types.js';

/**
 * Legal status transitions, keyed by the prior persisted status. No-op
 * re-saves and brand-new rows are always permitted; this map governs
 * *changes* to persisted rows only.
 */
const REFERRAL_STATUS_TRANSITIONS: Record<ReferralStatus, ReferralStatus[]> = {
  pending: ['attributed', 'under_review', 'disqualified', 'expired'],
  under_review: ['attributed', 'disqualified'],
  attributed: ['qualified', 'disqualified', 'expired'],
  qualified: ['disqualified'],
  disqualified: [],
  expired: [],
};

/**
 * Module-scoped record of the status each Referral instance was loaded with
 * — fallback for the save-time transition guard when the DB re-read is
 * unavailable. WeakMap keeps it out of the schema and GCs with the instance.
 */
const loadedReferralStatus = new WeakMap<Referral, ReferralStatus>();

@TenantScoped({ mode: 'optional' })
@smrt({
  // No generated update route: lifecycle mutations go through the guarded
  // transition methods and the attribution/qualification services.
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Referral extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global referrals). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The Referrer credited with the introduction. Required. */
  @foreignKey('Referrer', { required: true })
  referrerId: string = '';

  /** The ReferralProgram the referral belongs to. Required. */
  @foreignKey('ReferralProgram', { required: true })
  programId: string = '';

  /** AttributionPolicy key resolved at attribution ('' until attributed). */
  policyKey: string = '';

  /** AttributionPolicy version resolved at attribution (0 until attributed). */
  policyVersion: number = 0;

  /**
   * Lifecycle status — see the module transition map. Mutate via the
   * transition methods; the save-time guard rejects illegal edges.
   */
  status: ReferralStatus = 'pending';

  /**
   * Generic qualifying target: what the introduction became/points at —
   * `('lead', <id>)`, `('opportunity', <id>)`, `('client', <id>)`,
   * `('subscription', <id>)`, … This module attaches no semantics to it.
   */
  targetKind: string = '';

  /** Identifier within the {@link targetKind} namespace. */
  targetId: string = '';

  /**
   * Credit share (0–1) this referral carries. `1.0` for sole attribution;
   * split attribution creates sibling Referrals whose fractions sum to 1.0
   * sharing one {@link splitGroupId}. Flows into Commission
   * `shareFraction` at earning time.
   */
  creditFraction: number = 1.0;

  /** Groups the sibling referrals of one split. Empty for unsplit rows. */
  splitGroupId: string = '';

  /** The winning ReferralTouch behind the attribution ('' for touchless awards). */
  @foreignKey('ReferralTouch')
  primaryTouchId: string = '';

  /** When the referral was attributed. */
  attributedAt: Date | null = null;

  /** When the referral was qualified. */
  qualifiedAt: Date | null = null;

  /**
   * When an attributed-but-unqualified referral lapses. Stamped at
   * attribution (`attributedAt + policy.windowDays`); enforced by
   * `ReferralCollection.sweepExpired()`.
   */
  expiresAt: Date | null = null;

  /**
   * The ReferralTermSnapshot frozen at qualification ('' until qualified).
   * Requalification repoints this at a NEW snapshot; old snapshots remain
   * as history.
   *
   * Deliberately a PLAIN string reference (not `@foreignKey`): the
   * snapshot's own `referralId` FK carries the relationship, and declaring
   * both directions would put a cycle in the model graph (breaking the
   * registry's topological initialization order). Services fetch the
   * snapshot by id explicitly.
   */
  snapshotId: string = '';

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: ReferralOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.referrerId !== undefined) this.referrerId = options.referrerId;
    if (options.programId !== undefined) this.programId = options.programId;
    if (options.policyKey !== undefined) this.policyKey = options.policyKey;
    if (options.policyVersion !== undefined)
      this.policyVersion = options.policyVersion;
    if (options.status !== undefined) this.status = options.status;
    if (options.targetKind !== undefined) this.targetKind = options.targetKind;
    if (options.targetId !== undefined) this.targetId = options.targetId;
    if (options.creditFraction !== undefined)
      this.creditFraction = options.creditFraction;
    if (options.splitGroupId !== undefined)
      this.splitGroupId = options.splitGroupId;
    if (options.primaryTouchId !== undefined)
      this.primaryTouchId = options.primaryTouchId;
    if (options.attributedAt !== undefined)
      this.attributedAt = Referral.coerceDate(options.attributedAt);
    if (options.qualifiedAt !== undefined)
      this.qualifiedAt = Referral.coerceDate(options.qualifiedAt);
    if (options.expiresAt !== undefined)
      this.expiresAt = Referral.coerceDate(options.expiresAt);
    if (options.snapshotId !== undefined) this.snapshotId = options.snapshotId;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Re-coerce date fields after the framework reapplies raw option values
   * and record the loaded status for the save-time transition guard.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.attributedAt = Referral.coerceDate(this.attributedAt);
    this.qualifiedAt = Referral.coerceDate(this.qualifiedAt);
    this.expiresAt = Referral.coerceDate(this.expiresAt);
    if (await this.isSaved()) {
      loadedReferralStatus.set(this, this.status);
    }
    return this;
  }

  // -------- Status predicates --------

  isAttributed(): boolean {
    return this.status === 'attributed';
  }

  isQualified(): boolean {
    return this.status === 'qualified';
  }

  /** Whether the referral sits in a terminal status. */
  isTerminal(): boolean {
    return this.status === 'disqualified' || this.status === 'expired';
  }

  // -------- Metadata helpers --------

  /** Parse {@link metadata}; returns `{}` on malformed content. */
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

  // -------- Status transitions (mutate; caller saves) --------

  /** Transition `pending → under_review` (conflict parked for humans). */
  markUnderReview(): void {
    if (this.status !== 'pending') {
      throw new Error(
        `Referral ${this.id ?? '<new>'}: cannot move to under_review from status '${this.status}'`,
      );
    }
    this.status = 'under_review';
  }

  /**
   * Transition `pending | under_review → attributed` and stamp
   * {@link attributedAt}.
   */
  markAttributed(at: Date = new Date()): void {
    if (this.status !== 'pending' && this.status !== 'under_review') {
      throw new Error(
        `Referral ${this.id ?? '<new>'}: cannot attribute from status '${this.status}'`,
      );
    }
    this.status = 'attributed';
    this.attributedAt = at;
  }

  /** Transition `attributed → qualified` and stamp {@link qualifiedAt}. */
  markQualified(at: Date = new Date()): void {
    if (this.status !== 'attributed') {
      throw new Error(
        `Referral ${this.id ?? '<new>'}: cannot qualify from status '${this.status}'`,
      );
    }
    this.status = 'qualified';
    this.qualifiedAt = at;
  }

  /**
   * Transition to `disqualified` (terminal). Legal from every non-terminal
   * status — including `qualified` (the rare clawback path).
   */
  disqualify(): void {
    if (this.isTerminal()) {
      throw new Error(
        `Referral ${this.id ?? '<new>'}: cannot disqualify from terminal status '${this.status}'`,
      );
    }
    this.status = 'disqualified';
  }

  /** Transition `pending | attributed → expired` (terminal). */
  markExpired(): void {
    if (this.status !== 'pending' && this.status !== 'attributed') {
      throw new Error(
        `Referral ${this.id ?? '<new>'}: cannot expire from status '${this.status}'`,
      );
    }
    this.status = 'expired';
  }

  // -------- Save-time guard --------

  /**
   * Validate the status transition before persisting, then save. A forged
   * `status` (e.g. un-expiring a referral or skipping straight to
   * qualified) is rejected regardless of how the instance was constructed.
   */
  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    const result = (await super.save()) as this;
    loadedReferralStatus.set(this, this.status);
    return result;
  }

  /**
   * Resolve the AUTHORITATIVE prior status from the database; fall back to
   * the loaded-status WeakMap only when the DB is unavailable (commerce
   * pattern — an upsert via `create({ id, _skipLoad: true })` can't
   * sidestep the guard).
   */
  private async resolvePriorStatus(): Promise<ReferralStatus | undefined> {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as ReferralStatus;
        }
      } catch {
        // DB not ready — fall through to the in-memory record.
      }
    }
    return loadedReferralStatus.get(this);
  }

  private assertStatusTransition(prior: ReferralStatus | undefined): void {
    if (prior === undefined) return; // new row — any starting status
    if (prior === this.status) return; // no-op re-save
    const allowed = REFERRAL_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Referral ${this.id ?? '<new>'}: illegal status transition ` +
          `'${prior}' → '${this.status}'.`,
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

export default Referral;
