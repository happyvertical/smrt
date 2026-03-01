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
  dateRange: { start: string; end: string };
  images?: SummaryArticleImage[];
  scope?: Record<string, string | number | undefined>;
  stats?: Record<string, number>;
}

export interface SummaryArticleOptions {
  startDate: Date | string;
  endDate: Date | string;
  filters?: Record<string, string>;
  style?: string;
  tone?: string;
}
