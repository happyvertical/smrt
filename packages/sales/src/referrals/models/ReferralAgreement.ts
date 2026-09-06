/**
 * ReferralAgreement — versioned per-Referrer terms binding.
 *
 * An agreement binds one Referrer to one ReferralProgram under specific
 * commission terms: which CommissionPlan key (optionally pinned to a
 * version), the clearing window, and the approval mode. Natural key
 * `(referrerId, programId, version)` — amendments insert `version + 1`
 * drafts (see `ReferralAgreementCollection.createAmendment`); prior versions
 * are never rewritten.
 *
 * Lifecycle: `draft → active | terminated`; `active → superseded |
 * terminated`; `superseded` / `terminated` are terminal. Activation requires
 * bound commercial terms and an immutable {@link executedAgreementId}.
 *
 * Immutability: once a row has been saved non-draft, its TERMS
 * (`referrerId`, `programId`, `version`, `commissionPlanKey`,
 * `commissionPlanVersion`, `clearingDays`, `approvalMode`, `effectiveFrom`)
 * are frozen via the WeakMap-serialize guard (commerce `LicenseSale`
 * pattern). Status transitions stay allowed and `effectiveTo` stays mutable
 * so an operator can end-date an agreement. Signed artifacts and signer/audit
 * evidence live only on immutable `ExecutedAgreement` records.
 *
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ReferralAgreementApprovalMode,
  ReferralAgreementOptions,
  ReferralAgreementStatus,
} from '../types.js';

/**
 * Legal status transitions, keyed by the prior persisted status. No-op
 * re-saves and brand-new rows are always permitted; this map governs
 * *changes* to persisted rows only.
 */
const AGREEMENT_STATUS_TRANSITIONS: Record<
  ReferralAgreementStatus,
  ReferralAgreementStatus[]
> = {
  draft: ['active', 'terminated'],
  active: ['superseded', 'terminated'],
  superseded: [],
  terminated: [],
};

/** Loaded-status record for the save-time transition guard (fallback). */
const loadedAgreementStatus = new WeakMap<
  ReferralAgreement,
  ReferralAgreementStatus
>();

/** Frozen terms snapshot, captured when a row is (or becomes) non-draft. */
const frozenAgreementSnapshot = new WeakMap<ReferralAgreement, string>();

@TenantScoped({ mode: 'optional' })
@smrt({
  // (referrerId, programId, version) is the natural key — a retried create
  // of the same version upserts instead of duplicating.
  conflictColumns: ['referrer_id', 'program_id', 'version'],
  // NO generated update route: amendments are new rows and status moves go
  // through the guarded transition methods.
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class ReferralAgreement extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global agreements). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The Referrer bound by this agreement. Required. */
  @foreignKey('Referrer', { required: true })
  referrerId: string = '';

  /** The ReferralProgram the agreement applies to. Required. */
  @foreignKey('ReferralProgram', { required: true })
  programId: string = '';

  /** Monotonic version within `(referrerId, programId)`. */
  version: number = 1;

  /**
   * Lifecycle status — see the module transition map. Mutate via
   * {@link activate} / {@link supersede} / {@link terminate}.
   */
  status: ReferralAgreementStatus = 'draft';

  /** Start of the effective window (`null` = effective immediately). */
  effectiveFrom: Date | null = null;

  /**
   * End of the effective window (`null` = open-ended). Deliberately NOT
   * frozen: end-dating an active agreement is a legitimate operation.
   */
  effectiveTo: Date | null = null;

  /**
   * The commissions-module CommissionPlan key these terms bind. Required to
   * activate.
   */
  commissionPlanKey: string = '';

  /**
   * Pinned plan version. `0` (default) means "resolve the latest ACTIVE
   * version at qualification time and pin it in the ReferralTermSnapshot";
   * `> 0` pins a specific version now.
   */
  commissionPlanVersion: number = 0;

  /**
   * Clearing window in days applied to commissions earned under these
   * terms (refund/chargeback holdback). Frozen into every snapshot.
   */
  clearingDays: number = 0;

  /** How earned commissions are approved downstream. */
  approvalMode: ReferralAgreementApprovalMode = 'manual';

  /** Current provider workflow while this version is being signed. */
  @foreignKey('AgreementExecution')
  executionId: string | null = null;

  /** Immutable executed evidence required before this version can activate. */
  @foreignKey('ExecutedAgreement')
  executedAgreementId: string | null = null;

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: ReferralAgreementOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.referrerId !== undefined) this.referrerId = options.referrerId;
    if (options.programId !== undefined) this.programId = options.programId;
    if (options.version !== undefined) this.version = options.version;
    if (options.status !== undefined) this.status = options.status;
    if (options.effectiveFrom !== undefined)
      this.effectiveFrom = ReferralAgreement.coerceDate(options.effectiveFrom);
    if (options.effectiveTo !== undefined)
      this.effectiveTo = ReferralAgreement.coerceDate(options.effectiveTo);
    if (options.commissionPlanKey !== undefined)
      this.commissionPlanKey = options.commissionPlanKey;
    if (options.commissionPlanVersion !== undefined)
      this.commissionPlanVersion = options.commissionPlanVersion;
    if (options.clearingDays !== undefined)
      this.clearingDays = options.clearingDays;
    if (options.approvalMode !== undefined)
      this.approvalMode = options.approvalMode;
    if (options.executionId !== undefined)
      this.executionId = options.executionId;
    if (options.executedAgreementId !== undefined)
      this.executedAgreementId = options.executedAgreementId;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Re-coerce date fields after the framework reapplies raw option values,
   * record the loaded status for the transition guard, and capture the
   * frozen terms snapshot when the row arrived already non-draft
   * (superseded / terminated history can't be rewritten either).
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.effectiveFrom = ReferralAgreement.coerceDate(this.effectiveFrom);
    this.effectiveTo = ReferralAgreement.coerceDate(this.effectiveTo);
    if (this.isPersisted) {
      loadedAgreementStatus.set(this, this.status);
      if (this.status !== 'draft') {
        frozenAgreementSnapshot.set(this, this.serializeFrozenTerms());
      }
    }
    return this;
  }

  // -------- Status predicates --------

  isDraft(): boolean {
    return this.status === 'draft';
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  /**
   * Whether the effective window contains `at` (`effectiveFrom` null =
   * always started; `effectiveTo` null = open-ended). Status is NOT part of
   * this check — combine with {@link isActive}.
   */
  isEffectiveAt(at: Date): boolean {
    if (this.effectiveFrom && at.getTime() < this.effectiveFrom.getTime()) {
      return false;
    }
    if (this.effectiveTo && at.getTime() > this.effectiveTo.getTime()) {
      return false;
    }
    return true;
  }

  // -------- JSON helpers --------

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

  // -------- Status transitions --------

  /**
   * Transition `draft → active`. Requires a non-empty
   * {@link commissionPlanKey} — an agreement without bound terms cannot
   * govern qualification.
   */
  activate(): void {
    if (this.status !== 'draft') {
      throw new Error(
        `ReferralAgreement ${this.referrerId}/${this.programId}@${this.version}: cannot activate from status '${this.status}'`,
      );
    }
    if (!this.commissionPlanKey) {
      throw new Error(
        `ReferralAgreement ${this.referrerId}/${this.programId}@${this.version}: commissionPlanKey is required to activate`,
      );
    }
    if (!this.executionId || !this.executedAgreementId) {
      throw new Error(
        `ReferralAgreement ${this.referrerId}/${this.programId}@${this.version}: AgreementExecution and immutable ExecutedAgreement evidence are required to activate`,
      );
    }
    this.status = 'active';
  }

  /** Bind the provider workflow to an unsigned draft. */
  bindExecution(executionId: string): void {
    if (this.status !== 'draft') {
      throw new Error('Only draft ReferralAgreements can bind an execution');
    }
    if (!executionId) throw new Error('executionId is required');
    if (this.executionId && this.executionId !== executionId) {
      throw new Error(
        'ReferralAgreement is already bound to another execution',
      );
    }
    this.executionId = executionId;
  }

  /** Bind immutable completed evidence to an unsigned draft. */
  bindExecutedAgreement(executedAgreementId: string): void {
    if (this.status !== 'draft') {
      throw new Error(
        'Only draft ReferralAgreements can bind executed evidence',
      );
    }
    if (!this.executionId) {
      throw new Error(
        'Bind the AgreementExecution before its executed evidence',
      );
    }
    if (!executedAgreementId)
      throw new Error('executedAgreementId is required');
    if (
      this.executedAgreementId &&
      this.executedAgreementId !== executedAgreementId
    ) {
      throw new Error(
        'ReferralAgreement is already bound to different executed evidence',
      );
    }
    this.executedAgreementId = executedAgreementId;
  }

  /** Transition `active → superseded` (a newer version took over). */
  supersede(): void {
    if (this.status !== 'active') {
      throw new Error(
        `ReferralAgreement ${this.referrerId}/${this.programId}@${this.version}: cannot supersede from status '${this.status}'`,
      );
    }
    this.status = 'superseded';
  }

  /** Transition `draft | active → terminated` (terminal). */
  terminate(): void {
    if (this.status !== 'draft' && this.status !== 'active') {
      throw new Error(
        `ReferralAgreement ${this.referrerId}/${this.programId}@${this.version}: cannot terminate from status '${this.status}'`,
      );
    }
    this.status = 'terminated';
  }

  // -------- Save-time guards --------

  /**
   * Save with two guards (CommissionPlan pattern):
   *
   * 1. **Status transition** — the about-to-be-written status must be a
   *    legal edge from the authoritative prior persisted status.
   * 2. **Frozen terms** — once the row has been saved non-draft, the terms
   *    fields must match the captured snapshot. Amend by inserting a new
   *    version instead.
   *
   * Activating saves also re-require {@link commissionPlanKey}.
   */
  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    this.assertFrozenTermsUnchanged();
    await this.assertNaturalKeyNotTaken();
    if (this.status === 'active') {
      if (!this.commissionPlanKey) {
        throw new Error(
          `ReferralAgreement ${this.referrerId}/${this.programId}@${this.version}: commissionPlanKey is required while active`,
        );
      }
      if (!this.executionId || !this.executedAgreementId) {
        throw new Error(
          `ReferralAgreement ${this.referrerId}/${this.programId}@${this.version}: AgreementExecution and ExecutedAgreement evidence are required while active`,
        );
      }
    }
    const result = (await super.save()) as this;
    loadedAgreementStatus.set(this, this.status);
    if (this.status !== 'draft' && !frozenAgreementSnapshot.has(this)) {
      frozenAgreementSnapshot.set(this, this.serializeFrozenTerms());
    }
    return result;
  }

  /**
   * Refuse a save whose `(referrerId, programId, version)` natural key
   * already belongs to a DIFFERENT row — the frozen-terms guard is
   * instance-local, so a fresh instance would otherwise upsert over the
   * persisted agreement (replacing legally frozen referral terms without
   * an amendment, and rotating the row id). Edit drafts by hydrating
   * them; change terms with
   * `ReferralAgreementCollection.createAmendment()`.
   */
  private async assertNaturalKeyNotTaken(): Promise<void> {
    if (!this.referrerId || !this.programId) return;
    try {
      const res = await this.db.query(
        `SELECT id FROM ${this.tableName} WHERE referrer_id = $1 AND program_id = $2 AND version = $3`,
        this.referrerId,
        this.programId,
        this.version,
      );
      const rows = Array.isArray(res)
        ? (res as Record<string, unknown>[])
        : ((res as { rows?: Record<string, unknown>[] }).rows ?? []);
      const taken = rows.find((row) => row.id !== this.id);
      if (taken) {
        throw new Error(
          `ReferralAgreement ${this.referrerId}/${this.programId}@${this.version}: ` +
            'this version already exists — agreement versions are ' +
            'immutable records. Hydrate the existing row to edit a draft, ' +
            'or create new terms with ' +
            'ReferralAgreementCollection.createAmendment().',
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('immutable')) {
        throw error;
      }
      // DB not ready / table absent — nothing persisted to collide with.
    }
  }

  private async resolvePriorStatus(): Promise<
    ReferralAgreementStatus | undefined
  > {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as ReferralAgreementStatus;
        }
      } catch {
        // DB not ready — fall through to the in-memory record.
      }
    }
    return loadedAgreementStatus.get(this);
  }

  private assertStatusTransition(
    prior: ReferralAgreementStatus | undefined,
  ): void {
    if (prior === undefined) return; // new row — any starting status
    if (prior === this.status) return; // no-op re-save
    const allowed = AGREEMENT_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `ReferralAgreement ${this.referrerId}/${this.programId}@${this.version}: ` +
          `illegal status transition '${prior}' → '${this.status}'. Use ` +
          'activate() / supersede() / terminate().',
      );
    }
  }

  private assertFrozenTermsUnchanged(): void {
    const captured = frozenAgreementSnapshot.get(this);
    if (!captured) return;
    const current = this.serializeFrozenTerms();
    if (captured !== current) {
      throw new Error(
        `ReferralAgreement ${this.referrerId}/${this.programId}@${this.version}: ` +
          'terms are immutable once the agreement has been active. Create ' +
          'an amendment (ReferralAgreementCollection.createAmendment) ' +
          'instead of editing this version.',
      );
    }
  }

  private serializeFrozenTerms(): string {
    // Stable key ordering so a no-op re-serialization matches.
    return JSON.stringify({
      referrerId: this.referrerId,
      programId: this.programId,
      version: this.version,
      commissionPlanKey: this.commissionPlanKey,
      commissionPlanVersion: this.commissionPlanVersion,
      clearingDays: this.clearingDays,
      approvalMode: this.approvalMode,
      effectiveFrom: this.effectiveFrom
        ? this.effectiveFrom.toISOString()
        : null,
      executionId: this.executionId,
      executedAgreementId: this.executedAgreementId,
    });
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

export default ReferralAgreement;
