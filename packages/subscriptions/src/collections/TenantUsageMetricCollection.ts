import { SmrtCollection } from '@happyvertical/smrt-core';
import { TenantUsageMetric } from '../models/TenantUsageMetric.js';
import type {
  RecordUsageOptions,
  SummarizeUsageOptions,
  UsageSummary,
} from '../types.js';

export class TenantUsageMetricCollection extends SmrtCollection<TenantUsageMetric> {
  static readonly _itemClass = TenantUsageMetric;

  async recordUsage(options: RecordUsageOptions): Promise<TenantUsageMetric> {
    const metric = await this.create({
      tenantId: options.tenantId,
      metricKey: options.metricKey,
      quantity: options.quantity,
      windowStart: options.windowStart,
      windowEnd: options.windowEnd,
      source: options.source ?? '',
      sourceId: options.sourceId ?? '',
    });
    metric.setDimensions(options.dimensions ?? {});
    await metric.save();
    return metric;
  }

  async findByTenantAndMetric(
    tenantId: string,
    metricKey: string,
  ): Promise<TenantUsageMetric[]> {
    return this.list({
      where: { tenantId, metricKey },
      orderBy: 'windowStart DESC',
    });
  }

  async summarizeUsage(options: SummarizeUsageOptions): Promise<UsageSummary> {
    const metrics = await this.list({
      where: {
        tenantId: options.tenantId,
        metricKey: options.metricKey,
        'windowStart <': options.window.end.toISOString(),
        'windowEnd >': options.window.start.toISOString(),
      },
    });

    return {
      tenantId: options.tenantId,
      metricKey: options.metricKey,
      quantity: metrics.reduce((sum, metric) => sum + metric.quantity, 0),
      windowStart: options.window.start,
      windowEnd: options.window.end,
    };
  }
}
