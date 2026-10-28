import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  TenantScoped,
  tenantId,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import {
  enabledFeatureKeys,
  extractPlanTerms,
  validThresholds,
} from '../plan-terms.js';
import type {
  BillingInterval,
  PlanFeatureGrant,
  PlanTerms,
  PlanThreshold,
  PricingMode,
  SubscriptionPlanStatus,
  SubscriptionPlanVersionOptions,
} from '../types.js';
import { normalizeFeatureGrants, parseJsonArray } from '../utils.js';

const PRICING_MODES: PricingMode[] = ['free', 'fixed', 'pay_what_you_can'];

/**
 * An immutable, effective-dated snapshot of a plan's terms (#4032).
 *
 * `SubscriptionPlan` is the stable tier identity; each change to its terms
 * (status, price, pricing configuration, feature grants, thresholds) publishes
 * the next version. A version is in force from `effectiveFrom` until the next
 * version's `effectiveFrom`; before its first version's `effectiveFrom` a plan
 * resolves to that first version. Subscriptions pin the version in force when
 * their period starts, so a later amendment never changes a paid period.
 *
 * Versions are append-only: updates and deletes are refused.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_subscription_plan_versions',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  // plan_id is globally unique, so this key needs no (nullable) tenant_id.
  conflictColumns: ['plan_id', 'version'],
  hooks: { beforeDelete: 'refuseDelete' },
})
export class SubscriptionPlanVersion extends SmrtObject implements PlanTerms {
  /** Always the owning plan's tenant (null for a legacy global plan). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The stable tier identity this version belongs to. */
  @field({ description: 'The plan this version belongs to.' })
  @foreignKey('SubscriptionPlan')
  planId: string = '';

  /** The plan's natural key, copied for auditing and resolution output. */
  @field({
    description: 'The plan code at the time this version was published.',
  })
  planKey: string = '';
  /** 1-based sequence within the plan; contiguous and monotonic. */
  @field({
    description: 'Which version of the plan this is, counting from 1.',
  })
  version: number = 0;
  /** Start of this version's effective interval. */
  @field({
    description: 'The date and time from which these terms apply.',
  })
  effectiveFrom: Date = new Date();
  /** Plan name when this version was published (display only). */
  @field({
    description: 'What the plan was called when this version was published.',
  })
  name: string = '';
  @field({
    description:
      'Whether the plan was a draft, on sale (active) or archived under this version.',
  })
  status: SubscriptionPlanStatus = 'active';
  /** Integer minor units of {@link currency}. */
  @field({
    description:
      'What the plan cost each billing period under this version, in cents.',
  })
  priceAmount: number = 0;
  @field({ description: 'The currency the price is in, such as USD.' })
  currency: string = 'USD';
  @field({
    description:
      'How often the subscriber was billed: every day, week, month or year.',
  })
  billingInterval: BillingInterval = 'month';
  @field({
    description:
      'Whether the plan was free, had a fixed price, or let the subscriber choose what to pay.',
  })
  pricingMode: PricingMode = 'fixed';
  /** Integer minor units. */
  @field({
    description:
      'For a pay-what-you-can plan, the least a subscriber could pay, in cents.',
  })
  minimumAmount: number = 0;
  /** Integer minor units. */
  @field({
    description:
      'For a pay-what-you-can plan, the amount suggested to the subscriber, in cents.',
  })
  suggestedAmount: number = 0;
  features: string = '[]';
  thresholds: string = '[]';

  constructor(options: SubscriptionPlanVersionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.planId !== undefined) this.planId = options.planId;
    if (options.planKey !== undefined) this.planKey = options.planKey;
    if (options.version !== undefined) this.version = options.version;
    if (options.effectiveFrom !== undefined)
      this.effectiveFrom = options.effectiveFrom;
    if (options.name !== undefined) this.name = options.name;
    if (options.status !== undefined) this.status = options.status;
    if (options.priceAmount !== undefined)
      this.priceAmount = options.priceAmount;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.billingInterval !== undefined)
      this.billingInterval = options.billingInterval;
    if (options.pricingMode !== undefined)
      this.pricingMode = options.pricingMode;
    if (options.minimumAmount !== undefined)
      this.minimumAmount = options.minimumAmount;
    if (options.suggestedAmount !== undefined)
      this.suggestedAmount = options.suggestedAmount;
    if (options.features !== undefined) this.features = options.features;
    if (options.thresholds !== undefined) this.thresholds = options.thresholds;
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  getTerms(): PlanTerms {
    return extractPlanTerms(this);
  }

  getFeatureGrants(): PlanFeatureGrant[] {
    return normalizeFeatureGrants(
      parseJsonArray<string | PlanFeatureGrant>(this.features),
    );
  }

  getFeatureKeys(): string[] {
    return enabledFeatureKeys(this);
  }

  getThresholds(): PlanThreshold[] {
    return validThresholds(this);
  }

  /** Append-only: a version is corrected by publishing the next one. */
  protected refuseDelete(): void {
    throw new Error(
      'Subscription plan versions are append-only; publish a new version instead of deleting.',
    );
  }

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    if (this.isPersisted) {
      throw new Error(
        'Subscription plan versions are immutable; publish a new version instead.',
      );
    }
    // A colliding (tenant, plan, version) must fail, never adopt the row.
    this.requireInsertOnSave();
    if (!Number.isSafeInteger(this.version) || this.version < 1) {
      throw new Error('Plan version must be a positive integer');
    }
    if (
      !(this.effectiveFrom instanceof Date) ||
      Number.isNaN(this.effectiveFrom.getTime())
    ) {
      throw new Error('Plan version effectiveFrom must be a valid date');
    }
    if (!PRICING_MODES.includes(this.pricingMode)) {
      throw new Error('Invalid pricingMode');
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
    const { SubscriptionPlanCollection } = await import(
      '../collections/SubscriptionPlanCollection.js'
    );
    const { SubscriptionPlanVersionCollection } = await import(
      '../collections/SubscriptionPlanVersionCollection.js'
    );
    // Ownership reads name the owner explicitly, so a system-context read
    // cannot cross a tenant: the tenancy save interceptor has already bound
    // this.tenantId to the caller's tenant.
    const owner = this.tenantId ?? null;
    const [plan, latest] = await withSystemContext(async () => {
      const plans = await SubscriptionPlanCollection.create({ db: this.db });
      const versions = await SubscriptionPlanVersionCollection.create({
        db: this.db,
      });
      return Promise.all([
        plans.get({ id: this.planId, tenantId: owner }, { cache: false }),
        versions.findLatest(this.planId, owner),
      ]);
    });
    if (!plan || plan.planKey !== this.planKey) {
      throw new Error('Plan version must belong to an existing plan');
    }
    const expected = (latest?.version ?? 0) + 1;
    if (this.version !== expected) {
      throw new Error(`Next version of plan ${plan.planKey} is ${expected}`);
    }
    if (
      latest &&
      this.effectiveFrom.getTime() < latest.effectiveFrom.getTime()
    ) {
      throw new Error(
        `Plan ${plan.planKey} version ${latest.version} is effective from ` +
          `${latest.effectiveFrom.toISOString()}; a later version cannot start earlier`,
      );
    }
  }
}

export default SubscriptionPlanVersion;
