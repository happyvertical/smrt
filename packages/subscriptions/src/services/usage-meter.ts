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

  async record(options: RecordUsageOptions): Promise<void> {
    await this.metrics.recordUsage(options);
  }

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
