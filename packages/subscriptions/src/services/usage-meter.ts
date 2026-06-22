import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import type {
  AiUsageSummary,
  RecordUsageOptions,
  SummarizeAiUsageOptions,
  SummarizeUsageBatchOptions,
  SummarizeUsageOptions,
  UsageSummary,
} from '../types.js';
import { normalizeSubscriber } from '../utils.js';

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
    // Normalize at the boundary so the `ai.*` short-circuit and the standard
    // `summarizeUsage` path both refuse the same XOR violations (e.g. caller
    // passes subscriberExternalId without subscriberKind: 'external'). Without
    // this, the AI short-circuit would silently re-scope to tenant-wide
    // _smrt_ai_usage totals.
    normalizeSubscriber({
      tenantId: options.tenantId,
      subscriberKind: options.subscriberKind,
      subscriberExternalId: options.subscriberExternalId,
    });

    const aiSummary = await this.trySummarizeAiMetric(options);
    if (aiSummary) {
      return aiSummary;
    }

    return this.metrics.summarizeUsage(options);
  }

  async summarizeBatch(
    options: SummarizeUsageBatchOptions,
  ): Promise<UsageSummary[]> {
    const subscriber = normalizeSubscriber({
      tenantId: options.tenantId,
      subscriberKind: options.subscriberKind,
      subscriberExternalId: options.subscriberExternalId,
    });
    const metricKeys = Array.from(new Set(options.metricKeys));
    if (metricKeys.length === 0) {
      return [];
    }

    const useTenantAiSummary = subscriber.kind === 'tenant';
    const aiMetricKeys = useTenantAiSummary
      ? metricKeys.filter((metricKey) => metricKey.startsWith('ai.'))
      : [];
    const persistedMetricKeys = useTenantAiSummary
      ? metricKeys.filter((metricKey) => !metricKey.startsWith('ai.'))
      : metricKeys;

    const summaries = new Map<string, UsageSummary>();
    if (aiMetricKeys.length > 0) {
      const aiSummary = await this.summarizeAiUsage({
        tenantId: options.tenantId,
        window: options.window,
      });
      const quantityByMetric = aiQuantityByMetric(aiSummary);
      for (const metricKey of aiMetricKeys) {
        summaries.set(metricKey, {
          tenantId: options.tenantId,
          metricKey,
          quantity: quantityByMetric[metricKey] ?? 0,
          windowStart: options.window.start,
          windowEnd: options.window.end,
        });
      }
    }

    const persistedSummaries = await this.metrics.summarizeUsageBatch({
      ...options,
      metricKeys: persistedMetricKeys,
    });
    for (const summary of persistedSummaries) {
      summaries.set(summary.metricKey, summary);
    }

    return metricKeys.map(
      (metricKey) =>
        summaries.get(metricKey) ??
        emptyUsageSummary(subscriber, metricKey, options.window),
    );
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
      ...aiQuantityByMetric(summary),
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

function aiQuantityByMetric(summary: AiUsageSummary): Record<string, number> {
  return {
    'ai.tokens.prompt': summary.promptTokens,
    'ai.tokens.completion': summary.completionTokens,
    'ai.tokens.total': summary.totalTokens,
    'ai.cost.estimated': summary.estimatedCost,
    'ai.requests': summary.requestCount,
  };
}

function emptyUsageSummary(
  subscriber: ReturnType<typeof normalizeSubscriber>,
  metricKey: string,
  window: SummarizeUsageBatchOptions['window'],
): UsageSummary {
  const summary: UsageSummary = {
    tenantId: subscriber.tenantId,
    metricKey,
    quantity: 0,
    windowStart: window.start,
    windowEnd: window.end,
  };
  if (subscriber.kind === 'external') {
    return {
      ...summary,
      subscriberKind: 'external',
      subscriberExternalId: subscriber.externalId,
    };
  }
  return summary;
}
