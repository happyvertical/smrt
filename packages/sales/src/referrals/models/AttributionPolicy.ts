/**
 * AttributionPolicy — versioned attribution terms.
 *
 * A policy is identified by its `(policyKey, version)` natural key. Versions
 * are ROWS, not edits: amending a policy inserts a `version + 1` draft (see
 * `AttributionPolicyCollection.createAmendment`) and the prior version is
 * never rewritten. Once a row has been saved non-draft, its policy-defining
 * identity (window, credit mode, conflict behavior, eligibility flags and
 * lists, key/version, effectiveFrom) is frozen — re-saving with any of them
 * changed throws (same WeakMap-serialize pattern as commerce `LicenseSale`
 * and this package's `CommissionPlan`). Status transitions remain allowed on
 * frozen rows.
 *
 * Generated write surface is deliberately narrow: `create` only (drafts) —
 * amendments are new rows, and status moves go through the guarded
 * transition methods / legal save-time edges.
 *
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  ATTRIBUTION_CONFLICT_BEHAVIORS,
  ATTRIBUTION_CREDIT_MODES,
  type AttributionConflictBehavior,
  type AttributionCreditMode,
  type AttributionPolicyOptions,
  type AttributionPolicyStatus,
} from '../types.js';

/**
 * Legal status transitions, keyed by the prior persisted status.
 * `draft → active | retired`; `active → superseded | retired`;
 * `superseded` / `retired` are terminal. No-op re-saves and brand-new rows
 * are always permitted; this map governs *changes* to persisted rows only.
 */
const POLICY_STATUS_TRANSITIONS: Record<
  AttributionPolicyStatus,
  AttributionPolicyStatus[]
> = {
  draft: ['active', 'retired'],
  active: ['superseded', 'retired'],
  superseded: [],
  retired: [],
};

/**
 * Module-scoped record of the status each policy instance was loaded with —
 * fallback for the save-time transition guard when the DB re-read is
 * unavailable. WeakMap keeps it out of the schema and GCs with the instance.
 */
const loadedPolicyStatus = new WeakMap<
  AttributionPolicy,
  AttributionPolicyStatus
>();

/**
 * Module-scoped record of the frozen policy-identity snapshot captured when
 * a row is (or becomes) non-draft — same rationale as `CommissionPlan`.
 */
const frozenPolicySnapshot = new WeakMap<AttributionPolicy, string>();

/**
 * Validate a policy's terms. Throws a descriptive error on the first
 * violation. Called by {@link AttributionPolicy.activate} and by activating
 * saves so no active policy can carry malformed terms.
 */
export function validateAttributionPolicyTerms(
  policy: AttributionPolicy,
): void {
  if (!Number.isInteger(policy.windowDays) || policy.windowDays <= 0) {
    throw new Error(
      `AttributionPolicy ${policy.policyKey}@${policy.version}: windowDays must be a positive integer`,
    );
  }
  if (!ATTRIBUTION_CREDIT_MODES.includes(policy.creditMode)) {
    throw new Error(
      `AttributionPolicy ${policy.policyKey}@${policy.version}: invalid creditMode '${policy.creditMode}'`,
    );
  }
  if (!ATTRIBUTION_CONFLICT_BEHAVIORS.includes(policy.conflictBehavior)) {
    throw new Error(
      `AttributionPolicy ${policy.policyKey}@${policy.version}: invalid conflictBehavior '${policy.conflictBehavior}'`,
    );
  }
  for (const [name, raw] of [
    ['eligibleServices', policy.eligibleServices],
    ['eligibleCampaigns', policy.eligibleCampaigns],
    ['eligibleRegions', policy.eligibleRegions],
  ] as const) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || '[]');
    } catch {
      throw new Error(
        `AttributionPolicy ${policy.policyKey}@${policy.version}: ${name} must be a JSON array of strings`,
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error(
        `AttributionPolicy ${policy.policyKey}@${policy.version}: ${name} must be a JSON array of strings`,
      );
    }
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  // (tenantId, policyKey, version) is the natural key — a retried create
  // of the same version upserts instead of duplicating, and two tenants
  // can both own a policy key like 'default' without colliding.
  // NULL-tenant (global) rows opt out of upsert dedup on adapters where
  // NULLs compare distinct — the PaymentIntent natural-key convention.
  conflictColumns: ['tenant_id', 'policy_key', 'version'],
  // NO generated update route: amendments are new rows and status moves go
  // through the guarded transition methods.
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class AttributionPolicy extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global policies). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Stable policy identity shared by every version of the policy. */
  @field({ required: true })
  policyKey: string = '';

  /** Monotonic version within `policyKey`. Amendments insert `max + 1`. */
  version: number = 1;

  /**
   * Lifecycle status — see {@link POLICY_STATUS_TRANSITIONS}. Mutate via
   * {@link activate} / {@link supersede} / {@link retire} (or a legal
   * single-step assignment; the save-time guard rejects illegal edges).
   */
  status: AttributionPolicyStatus = 'draft';

  /** When this version takes effect. Frozen once the policy activates. */
  effectiveFrom: Date | null = null;

  /**
   * Attribution window in days: only touches occurring within `windowDays`
   * of the resolution instant are credit candidates, and attributed
   * referrals expire `windowDays` after attribution if never qualified.
   */
  windowDays: number = 30;

  /** How competing touches are credited. */
  creditMode: AttributionCreditMode = 'first_touch';

  /** Whether multi-referrer contention auto-resolves or forces review. */
  conflictBehavior: AttributionConflictBehavior = 'auto';

  /**
   * Whether a touch whose referrer IS the prospect (matching
   * `subjectProfileId`) may earn credit. Default false: self-referrals are
   * dropped from candidate sets.
   */
  allowSelfReferral: boolean = false;

  /**
   * Whether referrals of already-existing clients are eligible. Default
   * false: `AttributionService.resolve()` refuses outright when the caller
   * flags the prospect as an existing client.
   */
  allowExistingClients: boolean = false;

  /**
   * Eligible service keys as a JSON-string array — empty array means ALL
   * services are eligible. Interpretation belongs to the application layer
   * that maps its offerings onto service keys; this module records and
   * validates the list. Use {@link getEligibleServices}/{@link setEligibleServices}.
   */
  eligibleServices: string = '[]';

  /** Eligible campaign keys (JSON-string array; empty = all eligible). */
  eligibleCampaigns: string = '[]';

  /** Eligible region codes (JSON-string array; empty = all eligible). */
  eligibleRegions: string = '[]';

  /** Additional metadata as a JSON string (not part of the frozen identity). */
  metadata: string = '{}';

  constructor(options: AttributionPolicyOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.policyKey !== undefined) this.policyKey = options.policyKey;
    if (options.version !== undefined) this.version = options.version;
    if (options.status !== undefined) this.status = options.status;
    if (options.effectiveFrom !== undefined)
      this.effectiveFrom = AttributionPolicy.coerceDate(options.effectiveFrom);
    if (options.windowDays !== undefined) this.windowDays = options.windowDays;
    if (options.creditMode !== undefined) this.creditMode = options.creditMode;
    if (options.conflictBehavior !== undefined)
      this.conflictBehavior = options.conflictBehavior;
    if (options.allowSelfReferral !== undefined)
      this.allowSelfReferral = options.allowSelfReferral;
    if (options.allowExistingClients !== undefined)
      this.allowExistingClients = options.allowExistingClients;
    if (options.eligibleServices !== undefined)
      this.eligibleServices = options.eligibleServices;
    if (options.eligibleCampaigns !== undefined)
      this.eligibleCampaigns = options.eligibleCampaigns;
    if (options.eligibleRegions !== undefined)
      this.eligibleRegions = options.eligibleRegions;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Re-coerce date fields after the framework reapplies raw option values,
   * record the loaded status for the transition guard, and capture the
   * frozen snapshot when the row arrived already non-draft (superseded and
   * retired versions — history — can't be rewritten either).
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.effectiveFrom = AttributionPolicy.coerceDate(this.effectiveFrom);
    if (await this.isSaved()) {
      loadedPolicyStatus.set(this, this.status);
      if (this.status !== 'draft') {
        frozenPolicySnapshot.set(this, this.serializeFrozenSnapshot());
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

  // -------- Eligibility-list / metadata helpers --------

  /** Parse {@link eligibleServices}; returns `[]` on empty/invalid JSON. */
  getEligibleServices(): string[] {
    return AttributionPolicy.parseStringArray(this.eligibleServices);
  }

  /** Serialize and store {@link eligibleServices}. */
  setEligibleServices(services: string[]): void {
    this.eligibleServices = JSON.stringify(services ?? []);
  }

  /** Parse {@link eligibleCampaigns}; returns `[]` on empty/invalid JSON. */
  getEligibleCampaigns(): string[] {
    return AttributionPolicy.parseStringArray(this.eligibleCampaigns);
  }

  /** Serialize and store {@link eligibleCampaigns}. */
  setEligibleCampaigns(campaigns: string[]): void {
    this.eligibleCampaigns = JSON.stringify(campaigns ?? []);
  }

  /** Parse {@link eligibleRegions}; returns `[]` on empty/invalid JSON. */
  getEligibleRegions(): string[] {
    return AttributionPolicy.parseStringArray(this.eligibleRegions);
  }

  /** Serialize and store {@link eligibleRegions}. */
  setEligibleRegions(regions: string[]): void {
    this.eligibleRegions = JSON.stringify(regions ?? []);
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

  // -------- Status transitions --------

  /**
   * Transition `draft → active`. Validates the terms first so no active
   * policy can carry malformed window/mode/eligibility values.
   */
  activate(): void {
    if (this.status !== 'draft') {
      throw new Error(
        `AttributionPolicy ${this.policyKey}@${this.version}: cannot activate from status '${this.status}'`,
      );
    }
    validateAttributionPolicyTerms(this);
    this.status = 'active';
  }

  /** Transition `active → superseded` (a newer version took over). */
  supersede(): void {
    if (this.status !== 'active') {
      throw new Error(
        `AttributionPolicy ${this.policyKey}@${this.version}: cannot supersede from status '${this.status}'`,
      );
    }
    this.status = 'superseded';
  }

  /** Transition `draft | active → retired` (terminal). */
  retire(): void {
    if (this.status !== 'draft' && this.status !== 'active') {
      throw new Error(
        `AttributionPolicy ${this.policyKey}@${this.version}: cannot retire from status '${this.status}'`,
      );
    }
    this.status = 'retired';
  }

  // -------- Save-time guards --------

  /**
   * Save with two guards (CommissionPlan pattern):
   *
   * 1. **Status transition** — the about-to-be-written status must be a
   *    legal edge from the authoritative prior persisted status (re-read
   *    from the DB so a `create({ id: <existing>, _skipLoad: true })` upsert
   *    can't sidestep the guard).
   * 2. **Frozen policy identity** — once the row has been saved non-draft,
   *    every policy-defining field must match the captured snapshot. Amend
   *    by inserting a new version instead.
   */
  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    this.assertFrozenIdentityUnchanged();
    if (this.status === 'active') {
      validateAttributionPolicyTerms(this);
    }
    const result = (await super.save()) as this;
    loadedPolicyStatus.set(this, this.status);
    if (this.status !== 'draft' && !frozenPolicySnapshot.has(this)) {
      frozenPolicySnapshot.set(this, this.serializeFrozenSnapshot());
    }
    return result;
  }

  /**
   * Resolve the AUTHORITATIVE prior status from the database; fall back to
   * the loaded-status WeakMap only when the DB is unavailable. `undefined`
   * means no persisted row exists (genuinely new).
   */
  private async resolvePriorStatus(): Promise<
    AttributionPolicyStatus | undefined
  > {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as AttributionPolicyStatus;
        }
      } catch {
        // DB not ready — fall through to the in-memory record.
      }
    }
    return loadedPolicyStatus.get(this);
  }

  private assertStatusTransition(
    prior: AttributionPolicyStatus | undefined,
  ): void {
    if (prior === undefined) return; // new row — any starting status
    if (prior === this.status) return; // no-op re-save
    const allowed = POLICY_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `AttributionPolicy ${this.policyKey}@${this.version}: illegal status ` +
          `transition '${prior}' → '${this.status}'. Use activate() / ` +
          'supersede() / retire().',
      );
    }
  }

  private assertFrozenIdentityUnchanged(): void {
    const captured = frozenPolicySnapshot.get(this);
    if (!captured) return;
    const current = this.serializeFrozenSnapshot();
    if (captured !== current) {
      throw new Error(
        `AttributionPolicy ${this.policyKey}@${this.version}: the ` +
          'policy-defining fields are immutable once the policy has been ' +
          'active. Create an amendment ' +
          '(AttributionPolicyCollection.createAmendment) instead of editing ' +
          'this version.',
      );
    }
  }

  private serializeFrozenSnapshot(): string {
    // Stable key ordering so a no-op re-serialization matches. Booleans are
    // normalized through Boolean() so an adapter hydrating 0/1 never trips
    // the guard against a JS false/true assignment of the same value.
    return JSON.stringify({
      policyKey: this.policyKey,
      version: this.version,
      windowDays: this.windowDays,
      creditMode: this.creditMode,
      conflictBehavior: this.conflictBehavior,
      allowSelfReferral: Boolean(this.allowSelfReferral),
      allowExistingClients: Boolean(this.allowExistingClients),
      eligibleServices: this.eligibleServices,
      eligibleCampaigns: this.eligibleCampaigns,
      eligibleRegions: this.eligibleRegions,
      effectiveFrom: this.effectiveFrom
        ? this.effectiveFrom.toISOString()
        : null,
    });
  }

  private static parseStringArray(raw: string): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } catch {
      return [];
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

export default AttributionPolicy;
