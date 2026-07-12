import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { CommercialUsageService } from '@happyvertical/smrt-subscriptions';
import type { ServiceTimeEntry } from '../models/service-evidence.js';
import type {
  CommercialSnapshot,
  ServiceCommercialResolver,
} from './service-evidence-service.js';

export interface ProviderCompensationResolver {
  compensate(entry: ServiceTimeEntry): Promise<CommercialSnapshot>;
}

/** Bridges shared Professional Service evidence to #1925's effective pricing. */
export class SubscriptionServiceCommercialResolver
  implements ServiceCommercialResolver
{
  constructor(
    private readonly usage: CommercialUsageService,
    private readonly provider: ProviderCompensationResolver,
  ) {}

  static async create(
    options: SmrtClassOptions,
    provider: ProviderCompensationResolver,
  ): Promise<SubscriptionServiceCommercialResolver> {
    return new SubscriptionServiceCommercialResolver(
      await CommercialUsageService.create(options),
      provider,
    );
  }

  async priceClient(entry: ServiceTimeEntry): Promise<CommercialSnapshot> {
    if (!entry.id || !entry.tenantId)
      throw new Error(
        'Saved tenant-scoped ServiceTimeEntry is required for client pricing.',
      );
    const at = entry.endedAt ?? entry.startedAt ?? new Date();
    const metadata = entry.getMetadata();
    const usageEvent = await this.usage.record({
      tenantId: entry.tenantId,
      metricKey: 'duration.seconds',
      quantity: entry.durationSeconds,
      windowStart: at,
      windowEnd: at,
      source: 'service-time-entry',
      sourceId: entry.id,
      projectId:
        typeof metadata.projectId === 'string' ? metadata.projectId : undefined,
      workRefType:
        entry.workRefType ??
        (entry.caseId ? '@happyvertical/smrt-support:SupportCase' : undefined),
      workRefId: entry.workRefId ?? entry.caseId ?? undefined,
      provider: entry.participantKind,
      dimensions: {
        serviceKey: 'professional-services',
        source: entry.source,
        specialistId: entry.specialistId,
        agentRef: entry.agentRef || undefined,
      },
    });
    if (!usageEvent.id)
      throw new Error('Professional Service usage event was not persisted.');
    const charge = await this.usage.price({
      usageEventId: usageEvent.id,
      approved: true,
      at,
    });
    const snapshot = charge.getPricingSnapshot();
    return {
      amount: charge.amount,
      currency: charge.currency,
      version: String(snapshot.ruleKey ?? charge.pricingRuleId),
      strategy: String(snapshot.strategy ?? ''),
      terms: snapshot,
      sourceRef: `@happyvertical/smrt-subscriptions:ClientCharge:${charge.id}`,
    };
  }

  compensateProvider(entry: ServiceTimeEntry): Promise<CommercialSnapshot> {
    return this.provider.compensate(entry);
  }
}
