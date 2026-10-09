/**
 * AnalyticsReport model - Saved report configurations and results
 * @packageDocumentation
 */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  promptMessageOptions,
  smrtAnalyticsAnalyzeResultsPrompt,
  smrtAnalyticsHasPositiveTrendsPrompt,
} from '../prompts.js';
import { ReportFrequency, ReportStatus } from '../types/index.js';

/**
 * Options for constructing an {@link AnalyticsReport}.
 *
 * `metrics` is omitted from the {@link SmrtObjectOptions} base before being
 * re-declared: the framework option carries an observability `MetricsConfig`,
 * whereas this report field is a JSON-encoded list of analytics metrics.
 */
export interface AnalyticsReportOptions
  extends Omit<SmrtObjectOptions, 'metrics'> {
  tenantId?: string | null;
  propertyId?: string;
  name?: string;
  description?: string;
  dimensions?: string;
  metrics?: string;
  dateRangeStart?: string;
  dateRangeEnd?: string;
  dimensionFilter?: string;
  metricFilter?: string;
  orderBy?: string;
  maxResults?: number;
  status?: ReportStatus;
  frequency?: ReportFrequency;
  lastRunAt?: Date | null;
  nextRunAt?: Date | null;
  resultData?: string;
  rowCount?: number;
  lastError?: string;
}

/**
 * AnalyticsReport represents a saved report configuration with optional scheduling.
 *
 * @example
 * ```typescript
 * const report = await reports.create({
 *   propertyId: property.id,
 *   name: 'Weekly Traffic Report',
 *   dimensions: JSON.stringify([{ name: 'country' }, { name: 'deviceCategory' }]),
 *   metrics: JSON.stringify([{ name: 'activeUsers' }, { name: 'sessions' }]),
 *   frequency: ReportFrequency.WEEKLY
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'run'] },
  mcp: { include: ['list', 'get', 'run', 'analyze'] },
  cli: { skipApiCheck: true },
})
export class AnalyticsReport extends SmrtObject {
  /**
   * Tenant ID for multi-tenancy isolation (#1410).
   *
   * Reports persist `resultData` rows that may contain tenant-private metrics
   * and PII-bearing dimensions. Without tenant scoping the generated
   * `list`/`get` API returns every tenant's cached report data, and the
   * AI-powered `analyze`/`run` operations could run over another tenant's
   * rows. `@TenantScoped` auto-filters reads and binds writes to the tenant.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Parent property ID (references AnalyticsProperty)
   */
  @foreignKey('AnalyticsProperty')
  propertyId: string = '';

  /**
   * Report name
   */
  @field({
    description: 'A short name for the report, such as Weekly traffic.',
  })
  name: string = '';

  /**
   * Report description
   */
  @field({ description: 'What the report is for.' })
  description: string = '';

  /**
   * Dimensions to group by (JSON array)
   */
  @field({
    description:
      'What to break the figures down by, such as country or device, as a JSON list.',
  })
  dimensions: string = '[]';

  /**
   * Metrics to retrieve (JSON array)
   */
  @field({
    description:
      'What to count, such as active users or sessions, as a JSON list.',
  })
  metrics: string = '[]';

  /**
   * Date range start (relative or absolute)
   */
  @field({
    description:
      'Where the period begins: a date, or a relative value such as 7daysAgo.',
  })
  dateRangeStart: string = '7daysAgo';

  /**
   * Date range end (relative or absolute)
   */
  @field({
    description:
      'Where the period ends: a date, or a relative value such as today.',
  })
  dateRangeEnd: string = 'today';

  /**
   * Dimension filter expression (JSON)
   */
  dimensionFilter: string = '';

  /**
   * Metric filter expression (JSON)
   */
  metricFilter: string = '';

  /**
   * Sort order (JSON array)
   */
  orderBy: string = '[]';

  /**
   * Maximum results to return
   */
  maxResults: number = 0;

  /**
   * Report status
   */
  @field({
    description:
      'Where the report stands: draft, scheduled, running, completed or failed.',
  })
  status: ReportStatus = ReportStatus.DRAFT;

  /**
   * Scheduling frequency
   */
  @field({
    description:
      'How often the report repeats: once, daily, weekly or monthly.',
  })
  frequency: ReportFrequency = ReportFrequency.ONCE;

  /**
   * Last run timestamp
   */
  @field({ description: 'When the report last ran.' })
  lastRunAt: Date | null = null;

  /**
   * Next scheduled run
   */
  @field({ description: 'When the report is next due to run.' })
  nextRunAt: Date | null = null;

  /**
   * Cached result data (JSON)
   */
  resultData: string = '';

  /**
   * Row count from last run
   */
  @field({ description: 'How many rows the last run returned.' })
  rowCount: number = 0;

  /**
   * Error message from last failed run
   */
  @field({ description: 'Why the last run failed. Empty when it worked.' })
  lastError: string = '';

  constructor(options: AnalyticsReportOptions = {}) {
    // `AnalyticsReportOptions` re-types `metrics` as the report's JSON string,
    // which collides with the framework's `metrics?: MetricsConfig` observability
    // option on `SmrtObjectOptions`. The base never reads a string `metrics` as
    // config, so the value is forwarded unchanged; the assertion only reconciles
    // the two unrelated `metrics` types at the `super()` boundary.
    super(options as SmrtObjectOptions);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.propertyId !== undefined) this.propertyId = options.propertyId;
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.dimensions !== undefined) this.dimensions = options.dimensions;
    if (options.metrics !== undefined) this.metrics = options.metrics;
    if (options.dateRangeStart !== undefined)
      this.dateRangeStart = options.dateRangeStart;
    if (options.dateRangeEnd !== undefined)
      this.dateRangeEnd = options.dateRangeEnd;
    if (options.dimensionFilter !== undefined)
      this.dimensionFilter = options.dimensionFilter;
    if (options.metricFilter !== undefined)
      this.metricFilter = options.metricFilter;
    if (options.orderBy !== undefined) this.orderBy = options.orderBy;
    if (options.maxResults !== undefined) this.maxResults = options.maxResults;
    if (options.status !== undefined) this.status = options.status;
    if (options.frequency !== undefined) this.frequency = options.frequency;
    if (options.lastRunAt !== undefined) this.lastRunAt = options.lastRunAt;
    if (options.nextRunAt !== undefined) this.nextRunAt = options.nextRunAt;
    if (options.resultData !== undefined) this.resultData = options.resultData;
    if (options.rowCount !== undefined) this.rowCount = options.rowCount;
    if (options.lastError !== undefined) this.lastError = options.lastError;
  }

  /**
   * Get parsed dimensions
   */
  getDimensions(): Array<{ name: string }> {
    try {
      return JSON.parse(this.dimensions);
    } catch {
      return [];
    }
  }

  /**
   * Set dimensions
   */
  setDimensions(dimensions: Array<{ name: string }>): void {
    this.dimensions = JSON.stringify(dimensions);
  }

  /**
   * Get parsed metrics
   */
  getMetrics(): Array<{ name: string }> {
    try {
      return JSON.parse(this.metrics);
    } catch {
      return [];
    }
  }

  /**
   * Set metrics
   */
  setMetrics(metrics: Array<{ name: string }>): void {
    this.metrics = JSON.stringify(metrics);
  }

  /**
   * Get parsed result data
   */
  getResultData(): Record<string, unknown> | null {
    if (!this.resultData) return null;
    try {
      return JSON.parse(this.resultData);
    } catch {
      return null;
    }
  }

  /**
   * Set result data
   */
  setResultData(data: Record<string, unknown>): void {
    this.resultData = JSON.stringify(data);
  }

  /**
   * Mark report as running
   */
  markRunning(): void {
    this.status = ReportStatus.RUNNING;
    this.lastError = '';
  }

  /**
   * Mark report as completed with results
   */
  markCompleted(rowCount: number): void {
    this.status = ReportStatus.COMPLETED;
    this.lastRunAt = new Date();
    this.rowCount = rowCount;
    this.lastError = '';
    this.calculateNextRun();
  }

  /**
   * Mark report as failed
   */
  markFailed(error: string): void {
    this.status = ReportStatus.FAILED;
    this.lastRunAt = new Date();
    this.lastError = error;
    this.calculateNextRun();
  }

  /**
   * Calculate next scheduled run based on frequency
   */
  calculateNextRun(): void {
    if (this.frequency === ReportFrequency.ONCE) {
      this.nextRunAt = null;
      return;
    }

    const now = new Date();
    const next = new Date(now);

    switch (this.frequency) {
      case ReportFrequency.DAILY:
        next.setDate(next.getDate() + 1);
        break;
      case ReportFrequency.WEEKLY:
        next.setDate(next.getDate() + 7);
        break;
      case ReportFrequency.MONTHLY:
        next.setMonth(next.getMonth() + 1);
        break;
    }

    this.nextRunAt = next;
  }

  /**
   * Check if report is due to run
   */
  isDue(): boolean {
    if (this.frequency === ReportFrequency.ONCE) {
      return this.status === ReportStatus.SCHEDULED && !this.lastRunAt;
    }
    if (!this.nextRunAt) return false;
    return new Date() >= this.nextRunAt;
  }

  /**
   * AI-powered: Analyze report results.
   *
   * Uses the `smrtAnalytics.report.analyzeResults` prompt registered via
   * `@happyvertical/smrt-prompts`, allowing tenant- or instance-level
   * overrides of the template, model, and parameters at runtime.
   *
   * Internal identifiers (`id`, `propertyId`, `tenantId`, `lastError`, raw
   * `dimensionFilter` / `metricFilter` JSON) are excluded from the prompt
   * variables — see `../prompts.ts` for the exclusion rationale.
   *
   * **`resultData` is FORWARDED VERBATIM.** The persisted result rows are
   * JSON-stringified into the `reportData` variable; this package cannot
   * strip PII because the row schema is determined by which dimensions /
   * metrics the caller asked the analytics provider to return. If the
   * persisted rows contain `userPseudoId`, `clientId`, IP-derived
   * geolocation, or any other identifier, those fields WILL reach the AI
   * provider. Callers are responsible for excluding PII-bearing dimensions
   * before persisting, applying a column allowlist at the call site, or
   * overriding the prompt template via `PromptOverride`. The forwarding is
   * pinned by a regression test in
   * `__tests__/analytics-report-prompt.test.ts`.
   *
   * The previous implementation issued a second freeform `this.do()` call
   * to re-summarize "top 3 insights"; that behaviour is now folded into
   * the single registered template (which already asks for findings,
   * trends, and recommendations) — `insights` mirrors `analysis` so the
   * return shape is preserved without a redundant AI round-trip.
   */
  async analyzeResults(_options: Record<string, unknown> = {}): Promise<{
    action: string;
    analysis: string;
    insights: string;
  }> {
    const resultData = this.getResultData();

    // Resolve `db` from either the canonical `db` option or its `persistence`
    // alias so stored prompt overrides are honored on first call before
    // `getAiClient()` triggers full initialization. SmrtObject already types
    // both options on `SmrtClassOptions` so no `any` cast is needed — that
    // keeps a misspelt option name surfacing as a TypeScript error rather
    // than silently falling through.
    const db = this.options.db ?? this.options.persistence;

    // This model is `@TenantScoped` and declares a `tenantId` field, but we
    // still deliberately OMIT `tenantId` from the resolvePrompt options so the
    // resolver falls back to the AsyncLocalStorage tenancy context via
    // `getTenantId()`. Passing `this.tenantId` (which may be null for
    // tenant-agnostic rows) explicitly would short-circuit that fallback and
    // silently ignore tenant-specific prompt overrides active in the
    // surrounding `withTenant(...)` block.
    const resolvedPrompt = await resolvePrompt(
      smrtAnalyticsAnalyzeResultsPrompt.key,
      {
        db,
        variables: {
          reportName: this.name || '',
          reportDimensions: this.dimensions || '[]',
          reportMetrics: this.metrics || '[]',
          dateRangeStart: this.dateRangeStart || '',
          dateRangeEnd: this.dateRangeEnd || '',
          rowCount: String(this.rowCount),
          reportData: JSON.stringify(resultData, null, 2),
        },
      },
    );

    const ai = await this.getAiClient();
    const analysis = (
      await ai.message(
        resolvedPrompt.text,
        promptMessageOptions(resolvedPrompt.ai),
      )
    ).trim();

    return {
      action: 'analyzeResults',
      analysis,
      insights: analysis,
    };
  }

  /**
   * AI-powered: Check if results show positive trends.
   *
   * Uses the `smrtAnalytics.report.hasPositiveTrends` prompt registered
   * via `@happyvertical/smrt-prompts`. Only the metric labels and the
   * aggregate `resultData` JSON are sent to the AI provider — though as
   * with `analyzeResults`, `resultData` is forwarded verbatim and may
   * carry PII the caller persisted; see `analyzeResults` docstring and
   * `../prompts.ts`.
   *
   * When a typed-decision provider is configured and this object has no
   * registered tools, the resolved prompt is sent as one bounded predicate
   * request. The report's selected metrics and persisted aggregate data are
   * the complete decision state; object fields and internal filters are never
   * added. The decision uses the configured threshold (default `0.5`). A
   * configured uncertainty band falls back to the same resolved generative
   * prompt, matching `SmrtObject.evaluate()`; provider, capability, and
   * malformed-response errors propagate.
   *
   * Without a decision provider, or where tools require the generative route,
   * Boolean coercion uses `/^\s*(yes|true)\b/i` against the trimmed response.
   * The registered prompt template explicitly instructs the model to begin its
   * answer with the literal word "yes" or "no" so this legacy route remains
   * compatible; tenant overrides MUST preserve that leading-word convention.
   */
  async hasPositiveTrends(): Promise<boolean> {
    const resultData = this.getResultData();

    // See `analyzeResults` above for the typed-options + tenancy-fallback rationale.
    const db = this.options.db ?? this.options.persistence;

    const resolvedPrompt = await resolvePrompt(
      smrtAnalyticsHasPositiveTrendsPrompt.key,
      {
        db,
        variables: {
          reportMetrics: this.metrics || '[]',
          reportData: JSON.stringify(resultData),
        },
      },
    );

    // Typed decisions cannot call tools. Check this before resolving the
    // optional client so a tool-enabled report stays on its existing route.
    if (this.getAvailableTools().length === 0) {
      const config = this.getDecisionConfig();
      const threshold = config?.threshold ?? 0.5;
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw new Error(
          'Decision threshold must be a finite number in [0, 1].',
        );
      }
      const uncertaintyBand = config?.uncertaintyFallback?.band;
      if (
        uncertaintyBand !== undefined &&
        (!Number.isFinite(uncertaintyBand) ||
          uncertaintyBand < 0 ||
          uncertaintyBand > 1)
      ) {
        throw new Error(
          'Decision uncertainty fallback band must be a finite number in [0, 1].',
        );
      }

      const decision = await this.attemptDecision({
        state: {
          reportMetrics: this.metrics || '[]',
          reportData: JSON.stringify(resultData),
        },
        questions: {
          result: {
            type: 'predicate',
            instructions: `${resolvedPrompt.text}\n\nFor this predicate, only treat higher values as favorable for user growth, engagement, and conversions. Treat higher bounce or error rates as adverse. Do not infer a direction for an unknown metric. A date-range label alone does not establish comparable periods; if the supplied data is incomplete, lacks a comparable period, or is otherwise insufficient or ambiguous, answer false.`,
          },
        },
      });

      if (decision) {
        const answer = decision.answers.result;
        if (answer?.type !== 'predicate') {
          throw new Error('Decision provider returned no predicate result.');
        }

        const probability = answer.probability;
        if (uncertaintyBand !== undefined) {
          const outsideUncertaintyBand =
            probability < Math.max(0, threshold - uncertaintyBand) ||
            probability > Math.min(1, threshold + uncertaintyBand);
          if (outsideUncertaintyBand) {
            return probability >= threshold;
          }
        } else {
          return probability >= threshold;
        }
      }
    }

    const ai = await this.getAiClient();
    const response = (
      await ai.message(
        resolvedPrompt.text,
        promptMessageOptions(resolvedPrompt.ai),
      )
    ).trim();

    return /^\s*(yes|true)\b/i.test(response);
  }
}

export default AnalyticsReport;
