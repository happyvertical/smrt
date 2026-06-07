import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { JsonObject, SubscriptionStatus } from '../types.js';
import { parseJsonObject, stringifyJson } from '../utils.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_tenant_subscriptions',
  api: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id'],
})
export class TenantSubscription extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('SubscriptionPlan')
  planId: string = '';

  status: SubscriptionStatus = 'incomplete';
  startedAt: Date = new Date();
  currentPeriodStart: Date | null = null;
  currentPeriodEnd: Date | null = null;
  trialEndsAt: Date | null = null;
  cancelAtPeriodEnd: boolean = false;
  canceledAt: Date | null = null;
  externalProvider: string = 'stripe';
  stripeCustomerId: string = '';
  stripeSubscriptionId: string = '';
  stripeCheckoutSessionId: string = '';
  metadata: string = '{}';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.planId !== undefined) this.planId = options.planId;
    if (options.status !== undefined) this.status = options.status;
    if (options.startedAt !== undefined) this.startedAt = options.startedAt;
    if (options.currentPeriodStart !== undefined) {
      this.currentPeriodStart = options.currentPeriodStart;
    }
    if (options.currentPeriodEnd !== undefined) {
      this.currentPeriodEnd = options.currentPeriodEnd;
    }
    if (options.trialEndsAt !== undefined)
      this.trialEndsAt = options.trialEndsAt;
    if (options.cancelAtPeriodEnd !== undefined) {
      this.cancelAtPeriodEnd = options.cancelAtPeriodEnd;
    }
    if (options.canceledAt !== undefined) this.canceledAt = options.canceledAt;
    if (options.externalProvider !== undefined) {
      this.externalProvider = options.externalProvider;
    }
    if (options.stripeCustomerId !== undefined) {
      this.stripeCustomerId = options.stripeCustomerId;
    }
    if (options.stripeSubscriptionId !== undefined) {
      this.stripeSubscriptionId = options.stripeSubscriptionId;
    }
    if (options.stripeCheckoutSessionId !== undefined) {
      this.stripeCheckoutSessionId = options.stripeCheckoutSessionId;
    }
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  isEntitled(now = new Date()): boolean {
    if (this.status !== 'active' && this.status !== 'trialing') {
      return false;
    }
    if (
      this.currentPeriodEnd &&
      this.currentPeriodEnd.getTime() < now.getTime()
    ) {
      return false;
    }
    return true;
  }

  getMetadata(): JsonObject {
    return parseJsonObject(this.metadata, {});
  }

  setMetadata(metadata: JsonObject): void {
    this.metadata = stringifyJson(metadata);
  }
}

export default TenantSubscription;
