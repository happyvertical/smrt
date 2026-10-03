import {
  CommercialUsageService,
  type CommercialUsageServiceOptions,
} from '@happyvertical/smrt-subscriptions';
import type { ServiceTimeEntry } from '@happyvertical/smrt-timesheets';
import type {
  CommercialSnapshot,
  ServiceCommercialResolver,
} from './service-evidence-service.js';

export interface ProviderCompensationResolver {
  compensate(entry: ServiceTimeEntry): Promise<CommercialSnapshot>;
}

/**
 * A support-case subtype (smrt-support's `ServiceTimeEntry`) carries `caseId` /
 * `specialistId`; the shared entry does not (#3288). Read them when present so
 * case-attached entries keep their usage-event work reference.
 */
function supportContext(entry: ServiceTimeEntry): {
  caseId: string | null;
  specialistId: string | null;
} {
  const fields = entry as unknown as Record<string, unknown>;
  return {
    caseId: typeof fields.caseId === 'string' ? fields.caseId : null,
    specialistId:
      typeof fields.specialistId === 'string' ? fields.specialistId : null,
  };
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
    options: CommercialUsageServiceOptions,
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
    const { caseId, specialistId } = supportContext(entry);
    const usageEvent = await this.usage.record({
      tenantId: entry.tenantId,
      metricKey: 'duration.seconds',
      quantity: entry.requireDurationSeconds(),
      windowStart: at,
      windowEnd: at,
      source: 'service-time-entry',
      sourceId: entry.id,
      projectId:
        typeof metadata.projectId === 'string' ? metadata.projectId : undefined,
      workRefType:
        entry.workRefType ??
        (caseId ? '@happyvertical/smrt-support:SupportCase' : undefined),
      workRefId: entry.workRefId ?? caseId ?? undefined,
      provider: entry.participantKind,
      dimensions: {
        serviceKey: 'professional-services',
        source: entry.source,
        specialistId,
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
