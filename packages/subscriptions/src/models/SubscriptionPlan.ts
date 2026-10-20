import {
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import { extractPlanTerms } from '../plan-terms.js';
import type {
  BillingInterval,
  JsonObject,
  PlanFeatureGrant,
  PlanTerms,
  PlanThreshold,
  PricingMode,
  SubscriptionPlanOptions,
  SubscriptionPlanStatus,
} from '../types.js';
import {
  normalizeFeatureGrants,
  parseJsonArray,
  parseJsonObject,
  stringifyJson,
} from '../utils.js';
import type { SubscriptionPlanVersion } from './SubscriptionPlanVersion.js';

/** Effective date requested by {@link SubscriptionPlan.publishTerms}. */
const requestedEffectiveFrom = new WeakMap<SubscriptionPlan, Date>();
/** The persisted row a save is about to overwrite, read during validation. */
const priorTerms = new WeakMap<SubscriptionPlan, SubscriptionPlan>();
/** The latest version after the most recent save. */
const publishedVersions = new WeakMap<
  SubscriptionPlan,
  SubscriptionPlanVersion
>();

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_subscription_plans',
  api: { include: ['list', 'get', 'create', 'update'] },
  cli: { skipApiCheck: true },
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id', 'plan_key'],
})
export class SubscriptionPlan extends SmrtObject implements PlanTerms {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  planKey: string = '';
  name: string = '';
  description: string = '';
  status: SubscriptionPlanStatus = 'active';
  sortOrder: number = 0;
  /**
   * Plan price in **integer minor units** of {@link currency} — `$19.99` is
   * `1999`. The `= 0` initializer is load-bearing: SMRT maps an integer literal
   * to INTEGER and a decimal literal to DECIMAL, and money is exact (#2401).
   */
  priceAmount: number = 0;
  currency: string = 'USD';
  billingInterval: BillingInterval = 'month';
  pricingMode: PricingMode = 'fixed';
  minimumAmount: number = 0;
  suggestedAmount: number = 0;
  /** Optional provider binding; plan semantics never require a provider. */
  externalProvider: string | null = null;
  providerProductId: string | null = null;
  providerPriceId: string | null = null;
  /** @deprecated Use providerProductId. */
  stripeProductId: string | null = null;
  /** @deprecated Use providerPriceId. */
  stripePriceId: string | null = null;
  features: string = '[]';
  thresholds: string = '[]';
  metadata: string = '{}';

  constructor(options: SubscriptionPlanOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.planKey !== undefined) this.planKey = options.planKey;
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.status !== undefined) this.status = options.status;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
    if (options.priceAmount !== undefined)
      this.priceAmount = options.priceAmount;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.billingInterval !== undefined) {
      this.billingInterval = options.billingInterval;
    }
    if (options.externalProvider !== undefined) {
      this.externalProvider = options.externalProvider;
    }
    if (options.pricingMode !== undefined)
      this.pricingMode = options.pricingMode;
    if (options.minimumAmount !== undefined)
      this.minimumAmount = options.minimumAmount;
    if (options.suggestedAmount !== undefined)
      this.suggestedAmount = options.suggestedAmount;
    if (options.providerProductId !== undefined) {
      this.providerProductId = options.providerProductId;
    }
    if (options.providerPriceId !== undefined) {
      this.providerPriceId = options.providerPriceId;
    }
    if (options.stripeProductId !== undefined) {
      this.stripeProductId = options.stripeProductId;
    }
    if (options.stripePriceId !== undefined) {
      this.stripePriceId = options.stripePriceId;
    }
    if (options.features !== undefined) this.features = options.features;
    if (options.thresholds !== undefined) this.thresholds = options.thresholds;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  /** The versioned terms currently on this row (the latest published). */
  getTerms(): PlanTerms {
    return extractPlanTerms(this);
  }

  /**
   * Persist this plan. When its terms (status, price, pricing configuration,
   * feature grants or thresholds) differ from the latest published version —
   * or no version exists yet — the save then publishes the next immutable
   * {@link SubscriptionPlanVersion}, effective now (#4032). Use
   * {@link publishTerms} to choose a different effective date. Subscribers
   * keep the version pinned for their current period; the new terms apply
   * from their next renewal.
   *
   * A plan saved before versioning existed first records its pre-edit terms
   * as version 1, effective from its creation, so subscriptions sold under
   * them are not re-priced.
   *
   * The row is written before the version. If publishing fails the save
   * rejects with the row already updated; saving again publishes the
   * missing version. Wrap the call in `plan.withTransaction()` when the
   * adapter supports transactions and the two writes must be atomic.
   */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    const effectiveFrom = requestedEffectiveFrom.get(this) ?? new Date();
    requestedEffectiveFrom.delete(this);
    await super.save(options);
    const { publishPlanVersion } = await import('../plan-versioning.js');
    const prior = priorTerms.get(this);
    priorTerms.delete(this);
    publishedVersions.set(
      this,
      await publishPlanVersion(this, effectiveFrom, prior),
    );
    return this;
  }

  /**
   * Save this plan and publish its current terms as a version effective at
   * `effectiveFrom` (default now). A future date schedules an amendment: the
   * plan row shows the new terms immediately, but subscriptions starting or
   * renewing before that date pin the earlier version. Versions are
   * monotonic, so `effectiveFrom` may not precede the latest version's.
   *
   * @returns the latest version, which carries the saved terms.
   */
  async publishTerms(
    options: { effectiveFrom?: Date } = {},
  ): Promise<SubscriptionPlanVersion> {
    if (options.effectiveFrom) {
      requestedEffectiveFrom.set(this, options.effectiveFrom);
    }
    await this.save();
    const version = publishedVersions.get(this);
    if (!version) throw new Error('Plan version was not published');
    return version;
  }

  /** The version of this plan in force at `at` (default now). */
  async getVersionInForce(
    at = new Date(),
  ): Promise<SubscriptionPlanVersion | null> {
    if (!this.id) return null;
    const { SubscriptionPlanVersionCollection } = await import(
      '../collections/SubscriptionPlanVersionCollection.js'
    );
    const versions = await SubscriptionPlanVersionCollection.create({
      db: this.db,
    });
    return versions.findInForce(String(this.id), at);
  }

  getFeatureGrants(): PlanFeatureGrant[] {
    return normalizeFeatureGrants(
      parseJsonArray<string | PlanFeatureGrant>(this.features),
    );
  }

  setFeatureGrants(grants: Array<string | PlanFeatureGrant>): void {
    this.features = stringifyJson(normalizeFeatureGrants(grants));
  }

  getFeatureKeys(): string[] {
    return this.getFeatureGrants()
      .filter((grant) => grant.enabled !== false)
      .map((grant) => grant.featureKey);
  }

  getThresholds(): PlanThreshold[] {
    return parseJsonArray<PlanThreshold>(this.thresholds).filter(
      (threshold) => threshold.metricKey,
    );
  }

  setThresholds(thresholds: PlanThreshold[]): void {
    this.thresholds = stringifyJson(thresholds);
  }

  getMetadata(): JsonObject {
    return parseJsonObject(this.metadata, {});
  }

  setMetadata(metadata: JsonObject): void {
    this.metadata = stringifyJson(metadata);
  }

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    const { SubscriptionPlanCollection } = await import(
      '../collections/SubscriptionPlanCollection.js'
    );
    const plans = await SubscriptionPlanCollection.create({ db: this.db });
    const persisted =
      (this.id
        ? await plans.get({ id: String(this.id) }, { cache: false })
        : null) ??
      (await plans.findByPlanKey(
        this.tenantId ?? getTenantId() ?? null,
        this.planKey,
      ));
    // A concurrently created natural-key row must never be adopted after this
    // validation: its pricing terms may differ from the terms checked here.
    if (!persisted) this.requireInsertOnSave();
    else priorTerms.set(this, persisted);
    if (
      persisted &&
      (persisted.pricingMode !== this.pricingMode ||
        persisted.minimumAmount !== this.minimumAmount)
    ) {
      throw new Error(
        'Create a new plan to change pricing mode or minimum after persistence',
      );
    }
    if (!['free', 'fixed', 'pay_what_you_can'].includes(this.pricingMode)) {
      throw new Error('Invalid pricingMode');
    }
    if (this.pricingMode !== 'fixed' && this.priceAmount !== 0) {
      throw new Error(
        'priceAmount must be zero for free and pay_what_you_can plans',
      );
    }
    for (const [name, value] of [
      ['priceAmount', this.priceAmount],
      ['minimumAmount', this.minimumAmount],
      ['suggestedAmount', this.suggestedAmount],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          `${name} must be a non-negative integer minor-unit amount`,
        );
      }
    }
    if (
      this.pricingMode === 'pay_what_you_can' &&
      this.suggestedAmount > 0 &&
      this.suggestedAmount < this.minimumAmount
    ) {
      throw new Error('suggestedAmount must be at least minimumAmount');
    }
  }
}

export default SubscriptionPlan;
