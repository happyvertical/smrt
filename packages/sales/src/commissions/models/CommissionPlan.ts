/**
 * CommissionPlan — versioned commission calculation terms.
 *
 * A plan is identified by its `(planKey, version)` natural key. Versions are
 * ROWS, not edits: amending a plan inserts a `version + 1` draft (see
 * `CommissionPlanCollection.createAmendment`) and the prior version is never
 * rewritten. Once a row has been saved with status `active`, its calculation
 * identity (`components`, `currency`, `planKey`, `version`, `effectiveFrom`)
 * is frozen — re-saving with any of them changed throws (same
 * WeakMap-serialize pattern as commerce's `LicenseSale` rights snapshot).
 * Status transitions remain allowed on frozen rows.
 *
 * Generated write surface is deliberately narrow: `create` only (drafts),
 * NO generated update route — amendments are new rows, and status moves go
 * through the guarded transition methods / legal save-time edges.
 *
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  COMMISSION_BASES,
  type CommissionPlanComponent,
  type CommissionPlanOptions,
  type CommissionPlanStatus,
} from '../types.js';

/**
 * Legal status transitions, keyed by the prior persisted status.
 * `draft → active | retired`; `active → superseded | retired`;
 * `superseded` / `retired` are terminal. No-op re-saves and brand-new rows
 * are always permitted; this map governs *changes* to persisted rows only
 * (commerce pattern, S5 audit #1390 lineage).
 */
const PLAN_STATUS_TRANSITIONS: Record<
  CommissionPlanStatus,
  CommissionPlanStatus[]
> = {
  draft: ['active', 'retired'],
  active: ['superseded', 'retired'],
  superseded: [],
  retired: [],
};

/**
 * Module-scoped record of the status each plan instance was loaded with —
 * fallback for the save-time transition guard when the DB re-read is
 * unavailable. WeakMap keeps it out of the schema and GCs with the instance.
 */
const loadedPlanStatus = new WeakMap<CommissionPlan, CommissionPlanStatus>();

/**
 * Module-scoped record of the frozen calculation-identity snapshot captured
 * when a plan row is (or becomes) non-draft. Same rationale as commerce
 * `LicenseSale`: an instance field would become a persisted column, a
 * `Meta<T>` would round-trip and tautologically match — a WeakMap keyed by
 * the instance has no schema interaction and GCs with the instance.
 */
const frozenPlanSnapshot = new WeakMap<CommissionPlan, string>();

/**
 * Validate a components array. Throws a descriptive error on the first
 * violation. Exported for reuse by the calculation service's input guards
 * and by referral-terms builders that assemble component arrays.
 *
 * Rules:
 * - component keys are non-empty and unique within the plan
 * - `trigger` is a non-empty string (`'*'` matches every event kind)
 * - `basis` is one of {@link COMMISSION_BASES}
 * - basis `fixed` requires an integer `fixedAmountCents`
 * - every other basis requires `rate` in `[0, 1]`
 * - basis `custom` additionally requires a non-empty `customBasisKey`
 * - `recurrence.kind` (when present) is `one_time` or `recurring`;
 *   `maxOccurrences` / `windowMonths` (when present) are positive integers
 */
export function validateCommissionPlanComponents(
  components: CommissionPlanComponent[],
): void {
  if (!Array.isArray(components)) {
    throw new Error('CommissionPlan components must be an array');
  }
  const seen = new Set<string>();
  for (const component of components) {
    const label = component?.key || '<missing key>';
    if (!component || typeof component !== 'object') {
      throw new Error('CommissionPlan component must be an object');
    }
    if (!component.key || typeof component.key !== 'string') {
      throw new Error('CommissionPlan component requires a non-empty key');
    }
    if (seen.has(component.key)) {
      throw new Error(
        `CommissionPlan component keys must be unique — duplicate '${component.key}'`,
      );
    }
    seen.add(component.key);
    if (!component.trigger || typeof component.trigger !== 'string') {
      throw new Error(
        `CommissionPlan component '${label}' requires a non-empty trigger ('*' matches all kinds)`,
      );
    }
    if (!COMMISSION_BASES.includes(component.basis)) {
      throw new Error(
        `CommissionPlan component '${label}' has invalid basis '${component.basis}'`,
      );
    }
    if (component.basis === 'fixed') {
      if (
        typeof component.fixedAmountCents !== 'number' ||
        !Number.isInteger(component.fixedAmountCents)
      ) {
        throw new Error(
          `CommissionPlan component '${label}' with basis 'fixed' requires an integer fixedAmountCents`,
        );
      }
    } else {
      if (
        typeof component.rate !== 'number' ||
        !Number.isFinite(component.rate) ||
        component.rate < 0 ||
        component.rate > 1
      ) {
        throw new Error(
          `CommissionPlan component '${label}' with basis '${component.basis}' requires a rate in [0, 1]`,
        );
      }
    }
    if (component.basis === 'custom' && !component.customBasisKey) {
      throw new Error(
        `CommissionPlan component '${label}' with basis 'custom' requires a customBasisKey`,
      );
    }
    const recurrence = component.recurrence;
    if (recurrence !== undefined) {
      if (recurrence.kind !== 'one_time' && recurrence.kind !== 'recurring') {
        throw new Error(
          `CommissionPlan component '${label}' recurrence.kind must be 'one_time' or 'recurring'`,
        );
      }
      for (const [name, value] of [
        ['maxOccurrences', recurrence.maxOccurrences],
        ['windowMonths', recurrence.windowMonths],
      ] as const) {
        if (
          value !== undefined &&
          (!Number.isInteger(value) || (value as number) <= 0)
        ) {
          throw new Error(
            `CommissionPlan component '${label}' recurrence.${name} must be a positive integer`,
          );
        }
      }
    }
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  // (planKey, version) is the natural key — a retried create of the same
  // version upserts instead of duplicating.
  conflictColumns: ['plan_key', 'version'],
  // NO generated update route: amendments are new rows
  // (CommissionPlanCollection.createAmendment) and status transitions go
  // through the guarded methods. The save-time guards below still protect
  // any server-side write path.
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class CommissionPlan extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global plans). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Stable plan identity shared by every version of the plan. */
  @field({ required: true })
  planKey: string = '';

  /** Monotonic version within `planKey`. Amendments insert `max + 1`. */
  version: number = 1;

  /** Human-readable plan name. */
  name: string = '';

  /** Longer human-readable description of the terms. */
  description: string = '';

  /**
   * Lifecycle status — see {@link PLAN_STATUS_TRANSITIONS}. Mutate via
   * {@link activate} / {@link supersede} / {@link retire} (or a legal
   * single-step assignment; the save-time guard rejects illegal edges).
   */
  status: CommissionPlanStatus = 'draft';

  /** When this version takes effect. Frozen once the plan activates. */
  effectiveFrom: Date | null = null;

  /** ISO 4217 currency the plan's terms are denominated in. */
  currency: string = 'USD';

  /**
   * Calculation components as a JSON-string array — see
   * {@link CommissionPlanComponent}. Use {@link getComponents} /
   * {@link setComponents} (the setter validates).
   */
  components: string = '[]';

  /** Additional metadata as a JSON string. */
  metadata: string = '{}';

  constructor(options: CommissionPlanOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.planKey !== undefined) this.planKey = options.planKey;
    if (options.version !== undefined) this.version = options.version;
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.status !== undefined) this.status = options.status;
    if (options.effectiveFrom !== undefined)
      this.effectiveFrom = CommissionPlan.coerceDate(options.effectiveFrom);
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.components !== undefined) this.components = options.components;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Re-coerce date fields after the framework reapplies raw option values,
   * record the loaded status for the transition guard, and capture the
   * frozen snapshot when the row arrived already activated. The snapshot is
   * captured for every non-draft status (not just `active`) so a superseded
   * or retired version — history — can't be rewritten either.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    this.effectiveFrom = CommissionPlan.coerceDate(this.effectiveFrom);
    if (await this.isSaved()) {
      loadedPlanStatus.set(this, this.status);
      if (this.status !== 'draft') {
        frozenPlanSnapshot.set(this, this.serializeFrozenSnapshot());
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

  // -------- Components / metadata helpers --------

  /** Parse {@link components}; returns `[]` on empty/invalid JSON. */
  getComponents(): CommissionPlanComponent[] {
    if (!this.components) return [];
    try {
      const parsed = JSON.parse(this.components) as unknown;
      return Array.isArray(parsed) ? (parsed as CommissionPlanComponent[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Validate and store the components array. Throws on invalid components —
   * see {@link validateCommissionPlanComponents} for the rules.
   */
  setComponents(components: CommissionPlanComponent[]): void {
    validateCommissionPlanComponents(components);
    this.components = JSON.stringify(components);
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
   * Transition `draft → active`. Validates components first so no active
   * plan can carry malformed terms.
   */
  activate(): void {
    if (this.status !== 'draft') {
      throw new Error(
        `CommissionPlan ${this.planKey}@${this.version}: cannot activate from status '${this.status}'`,
      );
    }
    validateCommissionPlanComponents(this.getComponents());
    this.status = 'active';
  }

  /** Transition `active → superseded` (a newer version took over). */
  supersede(): void {
    if (this.status !== 'active') {
      throw new Error(
        `CommissionPlan ${this.planKey}@${this.version}: cannot supersede from status '${this.status}'`,
      );
    }
    this.status = 'superseded';
  }

  /** Transition `draft | active → retired` (terminal). */
  retire(): void {
    if (this.status !== 'draft' && this.status !== 'active') {
      throw new Error(
        `CommissionPlan ${this.planKey}@${this.version}: cannot retire from status '${this.status}'`,
      );
    }
    this.status = 'retired';
  }

  // -------- Save-time guards --------

  /**
   * Save with two guards:
   *
   * 1. **Status transition** — the about-to-be-written status must be a
   *    legal edge from the authoritative prior persisted status (re-read
   *    from the DB so a `create({ id: <existing>, _skipLoad: true })` upsert
   *    can't sidestep the guard — commerce pattern).
   * 2. **Frozen calculation identity** — once the row has been saved
   *    non-draft, `components` / `currency` / `planKey` / `version` /
   *    `effectiveFrom` must match the captured snapshot. Amend by inserting
   *    a new version instead.
   *
   * Activating saves also re-validate components, so an `active` row always
   * carries well-formed terms regardless of which write path set them.
   */
  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertStatusTransition(prior);
    this.assertFrozenIdentityUnchanged();
    if (this.status === 'active') {
      validateCommissionPlanComponents(this.getComponents());
    }
    const result = (await super.save()) as this;
    loadedPlanStatus.set(this, this.status);
    if (this.status !== 'draft' && !frozenPlanSnapshot.has(this)) {
      frozenPlanSnapshot.set(this, this.serializeFrozenSnapshot());
    }
    return result;
  }

  /**
   * Resolve the AUTHORITATIVE prior status from the database; fall back to
   * the loaded-status WeakMap only when the DB is unavailable. `undefined`
   * means no persisted row exists (genuinely new).
   */
  private async resolvePriorStatus(): Promise<
    CommissionPlanStatus | undefined
  > {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as CommissionPlanStatus;
        }
      } catch {
        // DB not ready — fall through to the in-memory record.
      }
    }
    return loadedPlanStatus.get(this);
  }

  private assertStatusTransition(
    prior: CommissionPlanStatus | undefined,
  ): void {
    if (prior === undefined) return; // new row — any starting status
    if (prior === this.status) return; // no-op re-save
    const allowed = PLAN_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `CommissionPlan ${this.planKey}@${this.version}: illegal status ` +
          `transition '${prior}' → '${this.status}'. Use activate() / ` +
          'supersede() / retire().',
      );
    }
  }

  private assertFrozenIdentityUnchanged(): void {
    const captured = frozenPlanSnapshot.get(this);
    if (!captured) return;
    const current = this.serializeFrozenSnapshot();
    if (captured !== current) {
      throw new Error(
        `CommissionPlan ${this.planKey}@${this.version}: components, ` +
          'currency, planKey, version, and effectiveFrom are immutable once ' +
          'the plan has been active. Create an amendment ' +
          '(CommissionPlanCollection.createAmendment) instead of editing ' +
          'this version.',
      );
    }
  }

  private serializeFrozenSnapshot(): string {
    // Stable key ordering so a no-op re-serialization matches.
    return JSON.stringify({
      planKey: this.planKey,
      version: this.version,
      currency: this.currency,
      components: this.components,
      effectiveFrom: this.effectiveFrom
        ? this.effectiveFrom.toISOString()
        : null,
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

export default CommissionPlan;
