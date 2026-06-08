import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { JsonObject, Subscriber, SubscriberKind } from '../types.js';
import { parseJsonObject, stringifyJson } from '../utils.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_tenant_usage_metrics',
  api: { include: ['list', 'get', 'create'] },
  cli: true,
  mcp: { include: ['list', 'get'] },
})
export class TenantUsageMetric extends SmrtObject {
  @tenantId()
  tenantId?: string;

  /**
   * Discriminator for which subscriber identity recorded this usage.
   * `'tenant'` (default) preserves the legacy shape; `'external'` indicates
   * the subscriber is `subscriberExternalId` under the issuing `tenantId`.
   */
  subscriberKind: SubscriberKind = 'tenant';

  /**
   * Opaque caller-namespaced subscriber id when `subscriberKind === 'external'`.
   * Empty string when kind is `'tenant'`.
   */
  subscriberExternalId: string = '';

  metricKey: string = '';
  quantity: number = 0.0;
  windowStart: Date = new Date();
  windowEnd: Date = new Date();
  source: string = '';
  sourceId: string = '';
  dimensions: string = '{}';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.subscriberKind !== undefined)
      this.subscriberKind = options.subscriberKind;
    if (options.subscriberExternalId !== undefined)
      this.subscriberExternalId = options.subscriberExternalId;
    // Enforce the subscriber XOR invariant at the model boundary so generated
    // create endpoints can't persist usage rows whose subscriber kind and
    // external id are inconsistent.
    if (this.subscriberKind === 'tenant' && this.subscriberExternalId !== '') {
      throw new Error(
        'TenantUsageMetric: subscriberExternalId must be empty when ' +
          'subscriberKind is "tenant"',
      );
    }
    if (
      this.subscriberKind === 'external' &&
      this.subscriberExternalId === ''
    ) {
      throw new Error(
        'TenantUsageMetric: subscriberKind="external" requires a non-empty ' +
          'subscriberExternalId',
      );
    }
    if (options.metricKey !== undefined) this.metricKey = options.metricKey;
    if (options.quantity !== undefined) this.quantity = options.quantity;
    if (options.windowStart !== undefined)
      this.windowStart = options.windowStart;
    if (options.windowEnd !== undefined) this.windowEnd = options.windowEnd;
    if (options.source !== undefined) this.source = options.source;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.dimensions !== undefined) this.dimensions = options.dimensions;
  }

  /**
   * Project this row's polymorphic subscriber columns onto the
   * {@link Subscriber} discriminated union.
   */
  getSubscriber(): Subscriber | null {
    if (!this.tenantId) {
      return null;
    }
    if (this.subscriberKind === 'external') {
      if (!this.subscriberExternalId) {
        return null;
      }
      return {
        kind: 'external',
        tenantId: this.tenantId,
        externalId: this.subscriberExternalId,
      };
    }
    return { kind: 'tenant', tenantId: this.tenantId };
  }

  getDimensions(): JsonObject {
    return parseJsonObject(this.dimensions, {});
  }

  setDimensions(dimensions: JsonObject): void {
    this.dimensions = stringifyJson(dimensions);
  }
}

export default TenantUsageMetric;
