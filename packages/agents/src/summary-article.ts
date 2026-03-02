/**
 * Canonical types for agent summary article generation.
 * All agents that implement summaryArticle() must return SummaryArticleResult.
 */

export interface SummaryArticleImage {
  url: string;
  alt?: string;
  caption?: string;
}

export interface SummaryArticleResult {
  title: string;
  summary: string;
  body: string;
  /** ISO 8601 date strings for the covered period */
  dateRange: { start: Date | string; end: Date | string };
  images?: SummaryArticleImage[];
  scope?: Partial<Record<string, string | number>>;
  stats?: Record<string, number>;
}

export interface SummaryArticleOptions {
  startDate: Date | string;
  endDate: Date | string;
  filters?: Record<string, string>;
  style?: string;
  tone?: string;
}
