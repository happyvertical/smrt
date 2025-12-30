/**
 * AnalyticsReport model - Saved report configurations and results
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
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
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'run'] },
  mcp: { include: ['list', 'get', 'run', 'analyze'] },
  cli: true,
})
export class AnalyticsReport extends SmrtObject {
  /**
   * Parent property ID (references AnalyticsProperty)
   */
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
   * AI-powered: Analyze report results
   */
  async analyzeResults(_options: any = {}): Promise<{
    action: string;
    analysis: string;
    insights: string;
  }> {
    const resultData = this.getResultData();
    const analysis = await this.do(`
      Analyze these analytics report results and provide insights:

      Report: ${this.name}
      Dimensions: ${this.dimensions}
      Metrics: ${this.metrics}
      Date Range: ${this.dateRangeStart} to ${this.dateRangeEnd}
      Row Count: ${this.rowCount}

      Data: ${JSON.stringify(resultData, null, 2)}

      Provide:
      1. Key findings
      2. Trends or patterns
      3. Actionable recommendations
    `);

    return {
      action: 'analyzeResults',
      analysis,
      insights: await this.do(
        'Summarize the top 3 insights from this report in bullet points',
      ),
    };
  }

  /**
   * AI-powered: Check if results show positive trends
   */
  async hasPositiveTrends(): Promise<boolean> {
    const resultData = this.getResultData();
    return await this.is(`
      Based on these report results, are the metrics showing positive trends?

      Metrics: ${this.metrics}
      Data: ${JSON.stringify(resultData)}

      Consider: user growth, engagement, conversions as positive indicators.
    `);
  }
}

export default AnalyticsReport;
