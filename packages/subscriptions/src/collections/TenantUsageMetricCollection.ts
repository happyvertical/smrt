import { SmrtCollection } from '@happyvertical/smrt-core';
import { TenantUsageMetric } from '../models/TenantUsageMetric.js';
import type {
  AiUsageSummary,
  RecordUsageOptions,
  SummarizeAiUsageOptions,
  SummarizeUsageOptions,
  UsageSummary,
} from '../types.js';
import {
  normalizeSubscriber,
  stringifyJson,
  subscriberToColumns,
} from '../utils.js';

export class TenantUsageMetricCollection extends SmrtCollection<TenantUsageMetric> {
  static readonly _itemClass = TenantUsageMetric;

  async recordUsage(options: RecordUsageOptions): Promise<TenantUsageMetric> {
    const subscriber = normalizeSubscriber({
      tenantId: options.tenantId,
      subscriberKind: options.subscriberKind,
      subscriberExternalId: options.subscriberExternalId,
    });
    const columns = subscriberToColumns(subscriber);
    const metric = await this.create({
      tenantId: columns.tenantId,
      subscriberKind: columns.subscriberKind,
      subscriberExternalId: columns.subscriberExternalId,
      metricKey: options.metricKey,
      quantity: options.quantity,
      windowStart: options.windowStart,
      windowEnd: options.windowEnd,
      source: options.source ?? '',
      sourceId: options.sourceId ?? '',
      dimensions: stringifyJson(options.dimensions ?? {}),
    });
    return metric;
  }

  /**
   * Legacy accessor — finds metrics for `subscriberKind = 'tenant'` under the
   * given tenant. External-kind rows scoped to the same tenant are excluded.
   */
  async findByTenantAndMetric(
    tenantId: string,
    metricKey: string,
  ): Promise<TenantUsageMetric[]> {
    return this.list({
      where: { tenantId, metricKey, subscriberKind: 'tenant' },
      orderBy: 'windowStart DESC',
    });
  }

  async summarizeUsage(options: SummarizeUsageOptions): Promise<UsageSummary> {
    const subscriber = normalizeSubscriber({
      tenantId: options.tenantId,
      subscriberKind: options.subscriberKind,
      subscriberExternalId: options.subscriberExternalId,
    });
    const columns = subscriberToColumns(subscriber);

    const where: Record<string, unknown> = {
      tenantId: columns.tenantId,
      subscriberKind: columns.subscriberKind,
      metricKey: options.metricKey,
      'windowStart <': options.window.end.toISOString(),
      'windowEnd >': options.window.start.toISOString(),
    };
    if (subscriber.kind === 'external') {
      where.subscriberExternalId = columns.subscriberExternalId;
    }

    const metrics = await this.list({ where });

    const baseSummary: UsageSummary = {
      tenantId: columns.tenantId,
      metricKey: options.metricKey,
      quantity: metrics.reduce((sum, metric) => sum + metric.quantity, 0),
      windowStart: options.window.start,
      windowEnd: options.window.end,
    };
    if (subscriber.kind === 'external') {
      return {
        ...baseSummary,
        subscriberKind: 'external',
        subscriberExternalId: subscriber.externalId,
      };
    }
    return baseSummary;
  }

  /**
   * Summarize persisted AI usage for a tenant within a window.
   *
   * Reads the framework `_smrt_ai_usage` system table via a raw aggregate
   * query. This deliberately uses `this.db.query` rather than the inherited
   * `query()`: those rows are framework usage records, not `TenantUsageMetric`
   * instances, so model hydration would discard the aggregate columns. Tenant
   * scoping is applied explicitly through the `tenant_id` filter.
   *
   * Named distinctly from the inherited `SmrtClass.summarizeAiUsage` (which
   * returns grouped stats across all tenants) to avoid overriding it.
   */
  async summarizeTenantAiUsage(
    options: SummarizeAiUsageOptions,
  ): Promise<AiUsageSummary> {
    const result = await this.db.query(
      `SELECT
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(estimated_cost), 0) AS estimated_cost,
          COUNT(*) AS request_count
        FROM _smrt_ai_usage
        WHERE tenant_id = ?
          AND created_at >= ?
          AND created_at < ?`,
      options.tenantId,
      options.window.start.toISOString(),
      options.window.end.toISOString(),
    );
    const row = firstRow(result);

    return {
      tenantId: options.tenantId,
      promptTokens: numberFromRow(row, 'prompt_tokens'),
      completionTokens: numberFromRow(row, 'completion_tokens'),
      totalTokens: numberFromRow(row, 'total_tokens'),
      estimatedCost: numberFromRow(row, 'estimated_cost'),
      requestCount: numberFromRow(row, 'request_count'),
      windowStart: options.window.start,
      windowEnd: options.window.end,
    };
  }
}

function firstRow(result: unknown): Record<string, unknown> {
  const rows = Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] })?.rows ?? []);
  return (rows[0] ?? {}) as Record<string, unknown>;
}

function numberFromRow(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    return Number.parseFloat(value) || 0;
  }
  return 0;
}
