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
    const rows = await this.metrics.query(
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
      [
        options.tenantId,
        options.window.start.toISOString(),
        options.window.end.toISOString(),
      ],
    );
    const row = (rows[0] ?? {}) as unknown as Record<string, unknown>;

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
