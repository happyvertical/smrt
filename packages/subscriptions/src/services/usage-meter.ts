import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import type {
  AiUsageSummary,
  RecordUsageOptions,
  SummarizeAiUsageOptions,
  SummarizeUsageOptions,
  UsageSummary,
} from '../types.js';

export class TenantUsageMeter {
  constructor(
    private readonly metrics: TenantUsageMetricCollection,
    private readonly classOptions: SmrtClassOptions = {},
  ) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<TenantUsageMeter> {
    const metrics = await TenantUsageMetricCollection.create(classOptions);
    return new TenantUsageMeter(metrics, classOptions);
  }

  /**
   * Record one usage row.
   *
   * Accepts the polymorphic subscriber fields directly on the options object
   * (`subscriberKind`/`subscriberExternalId`); when omitted defaults to a
   * `'tenant'`-kind row keyed off `tenantId`. The collection layer enforces
   * the XOR invariant — passing `subscriberKind: 'external'` without a
   * non-empty `subscriberExternalId` throws.
   */
  async record(options: RecordUsageOptions): Promise<void> {
    await this.metrics.recordUsage(options);
  }

  /**
   * Summarize usage over a window for a given subscriber.
   *
   * The `ai.*` short-circuit only fires for `'tenant'`-kind subscribers since
   * the `_smrt_ai_usage` system table is tenant-scoped; external subscribers
   * fall through to the normal `_smrt_tenant_usage_metrics` aggregation.
   */
  async summarize(options: SummarizeUsageOptions): Promise<UsageSummary> {
    const aiSummary = await this.trySummarizeAiMetric(options);
    if (aiSummary) {
      return aiSummary;
    }

    return this.metrics.summarizeUsage(options);
  }

  async summarizeAiUsage(
    options: SummarizeAiUsageOptions,
  ): Promise<AiUsageSummary> {
    return this.metrics.summarizeTenantAiUsage(options);
  }

  getOptions(): SmrtClassOptions {
    return this.classOptions;
  }

  private async trySummarizeAiMetric(
    options: SummarizeUsageOptions,
  ): Promise<UsageSummary | null> {
    if (!options.metricKey.startsWith('ai.')) {
      return null;
    }
    // _smrt_ai_usage is tenant-scoped only; external subscribers must use the
    // standard usage path. Skip the short-circuit so the caller's recorded
    // usage rows are summed instead.
    const kind = options.subscriberKind ?? 'tenant';
    if (kind !== 'tenant') {
      return null;
    }

    const summary = await this.summarizeAiUsage({
      tenantId: options.tenantId,
      window: options.window,
    });

    const quantityByMetric: Record<string, number> = {
      'ai.tokens.prompt': summary.promptTokens,
      'ai.tokens.completion': summary.completionTokens,
      'ai.tokens.total': summary.totalTokens,
      'ai.cost.estimated': summary.estimatedCost,
      'ai.requests': summary.requestCount,
    };

    return {
      tenantId: options.tenantId,
      metricKey: options.metricKey,
      quantity: quantityByMetric[options.metricKey] ?? 0,
      windowStart: options.window.start,
      windowEnd: options.window.end,
    };
  }
}
