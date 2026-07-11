/**
 * ReferralTermSnapshot — the terms frozen at qualification.
 *
 * When a Referral qualifies, `ReferralQualificationService` copies
 * EVERYTHING later earnings depend on into one immutable row: the resolved
 * agreement/plan/policy version references plus the CALCULATION INPUTS
 * themselves (`components`, `currency`, `clearingDays`, `approvalMode`).
 * `ReferralCommissionService` calculates exclusively from this row — never
 * from a live plan — so a plan amendment after qualification can NEVER
 * change what an already-qualified referral earns. Reproducibility over
 * convenience.
 *
 * FULLY immutable post-create: a save guard rejects ANY field change to a
 * persisted row (and blind writes onto an existing id from a non-hydrated
 * instance). Amended terms mean a NEW snapshot via
 * `ReferralQualificationService.requalify()` — the old row stands as
 * history, still referenced by any Commission it produced.
 *
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { CommissionPlanComponent } from '../../commissions/index.js';
import type {
  ReferralAgreementApprovalMode,
  ReferralTermSnapshotOptions,
} from '../types.js';

/**
 * Module-scoped record of each persisted snapshot's serialized state,
 * captured at hydration/first save. The save guard compares against it to
 * reject post-create mutations. WeakMap keeps it out of the schema and GCs
 * with the instance (commerce `LicenseSale` pattern).
 */
const persistedSnapshotState = new WeakMap<ReferralTermSnapshot, string>();

@TenantScoped({ mode: 'optional' })
@smrt({
  // Read-only generated surface: snapshots are minted exclusively by
  // ReferralQualificationService.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
})
export class ReferralTermSnapshot extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global rows). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The Referral this snapshot governs. Required. */
  @foreignKey('Referral', { required: true })
  referralId: string = '';

  /** Id of the ReferralAgreement the terms came from. */
  agreementId: string = '';

  /** Version of the agreement at qualification time. */
  agreementVersion: number = 0;

  /** CommissionPlan key the components were copied from. */
  planKey: string = '';

  /**
   * CommissionPlan version PINNED at qualification — when the agreement
   * left the version unpinned (`0`), this records the latest-active version
   * that was resolved.
   */
  planVersion: number = 0;

  /** AttributionPolicy key stamped on the referral at attribution. */
  policyKey: string = '';

  /** AttributionPolicy version stamped on the referral at attribution. */
  policyVersion: number = 0;

  /**
   * FROZEN copy of the plan's components JSON — THE calculation inputs.
   * Use {@link getComponents} for the typed array.
   */
  components: string = '[]';

  /** ISO 4217 currency the frozen terms are denominated in. */
  currency: string = 'USD';

  /** Clearing window (days) copied from the agreement. */
  clearingDays: number = 0;

  /** Approval mode copied from the agreement. */
  approvalMode: ReferralAgreementApprovalMode = 'manual';

  /** Additional metadata as a JSON string (immutable like every field). */
  metadata: string = '{}';

  constructor(options: ReferralTermSnapshotOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.referralId !== undefined) this.referralId = options.referralId;
    if (options.agreementId !== undefined)
      this.agreementId = options.agreementId;
    if (options.agreementVersion !== undefined)
      this.agreementVersion = options.agreementVersion;
    if (options.planKey !== undefined) this.planKey = options.planKey;
    if (options.planVersion !== undefined)
      this.planVersion = options.planVersion;
    if (options.policyKey !== undefined) this.policyKey = options.policyKey;
    if (options.policyVersion !== undefined)
      this.policyVersion = options.policyVersion;
    if (options.components !== undefined) this.components = options.components;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.clearingDays !== undefined)
      this.clearingDays = options.clearingDays;
    if (options.approvalMode !== undefined)
      this.approvalMode = options.approvalMode;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Capture the persisted state so the save guard can reject mutations. */
  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) {
      persistedSnapshotState.set(this, this.serializeState());
    }
    return this;
  }

  /**
   * Parse {@link components} into the typed plan-component array the
   * calculation service consumes; returns `[]` on empty/invalid JSON.
   */
  getComponents(): CommissionPlanComponent[] {
    if (!this.components) return [];
    try {
      const parsed = JSON.parse(this.components) as unknown;
      return Array.isArray(parsed) ? (parsed as CommissionPlanComponent[]) : [];
    } catch {
      return [];
    }
  }

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

  /**
   * Save with the full-immutability guard:
   *
   * - A hydrated persisted row must serialize IDENTICALLY to its captured
   *   state — any field change throws (no-op re-saves pass).
   * - An instance carrying an existing row's id WITHOUT having hydrated it
   *   (e.g. `create({ id, _skipLoad: true })`) is rejected outright — blind
   *   overwrites can't sidestep the comparison.
   */
  override async save(): Promise<this> {
    const captured = persistedSnapshotState.get(this);
    if (captured !== undefined) {
      if (captured !== this.serializeState()) {
        throw new Error(
          `ReferralTermSnapshot ${this.id ?? '<new>'}: snapshots are ` +
            'immutable once created. Requalify the referral ' +
            '(ReferralQualificationService.requalify) to snapshot new terms ' +
            'instead of editing this row.',
        );
      }
    } else if (this.id && (await this.isSaved())) {
      throw new Error(
        `ReferralTermSnapshot ${this.id}: refusing to overwrite an existing ` +
          'snapshot row from a non-hydrated instance — snapshots are ' +
          'immutable once created.',
      );
    }
    const result = (await super.save()) as this;
    persistedSnapshotState.set(this, this.serializeState());
    return result;
  }

  private serializeState(): string {
    // Stable key ordering so a no-op re-serialization matches.
    return JSON.stringify({
      tenantId: this.tenantId,
      referralId: this.referralId,
      agreementId: this.agreementId,
      agreementVersion: this.agreementVersion,
      planKey: this.planKey,
      planVersion: this.planVersion,
      policyKey: this.policyKey,
      policyVersion: this.policyVersion,
      components: this.components,
      currency: this.currency,
      clearingDays: this.clearingDays,
      approvalMode: this.approvalMode,
      metadata: this.metadata,
    });
  }
}

export default ReferralTermSnapshot;
