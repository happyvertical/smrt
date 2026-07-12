import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  JsonObject,
  Subscriber,
  SubscriberKind,
  TenantUsageMetricOptions,
} from '../types.js';
import {
  assertSubscriberInvariant,
  parseJsonObject,
  stringifyJson,
} from '../utils.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_tenant_usage_metrics',
  api: { include: ['list', 'get', 'create'] },
  cli: { include: ['list', 'get', 'create'] },
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
  projectId: string = '';
  workRefType: string = '';
  workRefId: string = '';
  provider: string = '';
  dimensions: string = '{}';

  constructor(options: TenantUsageMetricOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.subscriberKind !== undefined)
      this.subscriberKind = options.subscriberKind;
    if (options.subscriberExternalId !== undefined)
      this.subscriberExternalId = options.subscriberExternalId;
    // Construction-time guard; the same invariant is re-checked in
    // `validateBeforeSave` so the generated update path can't bypass it.
    assertSubscriberInvariant('TenantUsageMetric', {
      subscriberKind: this.subscriberKind,
      subscriberExternalId: this.subscriberExternalId,
    });
    if (options.metricKey !== undefined) this.metricKey = options.metricKey;
    if (options.quantity !== undefined) this.quantity = options.quantity;
    if (options.windowStart !== undefined)
      this.windowStart = options.windowStart;
    if (options.windowEnd !== undefined) this.windowEnd = options.windowEnd;
    if (options.source !== undefined) this.source = options.source;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.projectId !== undefined) this.projectId = options.projectId;
    if (options.workRefType !== undefined)
      this.workRefType = options.workRefType;
    if (options.workRefId !== undefined) this.workRefId = options.workRefId;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.dimensions !== undefined) this.dimensions = options.dimensions;
  }

  /** See `TenantSubscription.validateBeforeSave` for the rationale. */
  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    assertSubscriberInvariant('TenantUsageMetric', {
      subscriberKind: this.subscriberKind,
      subscriberExternalId: this.subscriberExternalId,
    });
    if (this.id) {
      const row = await this.db.get(this.tableName, { id: this.id });
      if (row) {
        const persisted = [
          row.tenant_id,
          row.subscriber_kind,
          row.subscriber_external_id,
          row.metric_key,
          row.quantity,
          row.window_start,
          row.window_end,
          row.source,
          row.source_id,
          row.project_id,
          row.work_ref_type,
          row.work_ref_id,
          row.provider,
          row.dimensions,
        ];
        const current = [
          this.tenantId,
          this.subscriberKind,
          this.subscriberExternalId,
          this.metricKey,
          this.quantity,
          this.windowStart,
          this.windowEnd,
          this.source,
          this.sourceId,
          this.projectId,
          this.workRefType,
          this.workRefId,
          this.provider,
          this.dimensions,
        ];
        if (
          persisted.some(
            (value, index) =>
              normalizeEvidence(value) !== normalizeEvidence(current[index]),
          )
        ) {
          throw new Error(
            'Usage events are immutable; record a new event instead.',
          );
        }
      }
    }
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

function normalizeEvidence(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(value) && Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }
  return String(value ?? '');
}
