import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  BillingInterval,
  JsonObject,
  PlanFeatureGrant,
  PlanThreshold,
  SubscriptionPlanStatus,
} from '../types.js';
import {
  normalizeFeatureGrants,
  parseJsonArray,
  parseJsonObject,
  stringifyJson,
} from '../utils.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_subscription_plans',
  api: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['plan_key'],
})
export class SubscriptionPlan extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  planKey: string = '';
  name: string = '';
  description: string = '';
  status: SubscriptionPlanStatus = 'active';
  sortOrder: number = 0;
  priceAmount: number = 0.0;
  currency: string = 'USD';
  billingInterval: BillingInterval = 'month';
  externalProvider: string = 'stripe';
  stripeProductId: string = '';
  stripePriceId: string = '';
  features: string = '[]';
  thresholds: string = '[]';
  metadata: string = '{}';

  constructor(options: any = {}) {
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
}

export default SubscriptionPlan;
