/**
 * AnalyticsReport model - Saved report configurations and results
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  promptMessageOptions,
  smrtAnalyticsAnalyzeResultsPrompt,
  smrtAnalyticsHasPositiveTrendsPrompt,
} from '../prompts.js';
import { ReportFrequency, ReportStatus } from '../types/index.js';

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
  cli: true,
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
  name: string = '';

  /**
   * Report description
   */
  description: string = '';

  /**
   * Dimensions to group by (JSON array)
   */
  dimensions: string = '[]';

  /**
   * Metrics to retrieve (JSON array)
   */
  metrics: string = '[]';

  /**
   * Date range start (relative or absolute)
   */
  dateRangeStart: string = '7daysAgo';

  /**
   * Date range end (relative or absolute)
   */
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
  status: ReportStatus = ReportStatus.DRAFT;

  /**
   * Scheduling frequency
   */
  frequency: ReportFrequency = ReportFrequency.ONCE;

  /**
   * Last run timestamp
   */
  lastRunAt: Date | null = null;

  /**
   * Next scheduled run
   */
  nextRunAt: Date | null = null;

  /**
   * Cached result data (JSON)
   */
  resultData: string = '';

  /**
   * Row count from last run
   */
  rowCount: number = 0;

  /**
   * Error message from last failed run
   */
  lastError: string = '';

  constructor(options: any = {}) {
    super(options);
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
  async analyzeResults(_options: any = {}): Promise<{
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
   * Boolean coercion uses `/^\s*(yes|true)\b/i` against the trimmed
   * response. The registered prompt template explicitly instructs the
   * model to begin its answer with the literal word "yes" or "no" so
   * this regex is reliable; tenant overrides MUST preserve that leading-
   * word convention or the boolean will silently fall to `false`.
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
