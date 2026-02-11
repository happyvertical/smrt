/**
 * Content component types
 *
 * Shared types for Article, Markdown, and other content components.
 */

/**
 * Article data structure
 * Matches database schema with snake_case fields
 */
export interface Article {
  /** Unique identifier */
  id: string;
  /** URL-friendly identifier */
  slug: string;
  /** Article title */
  title: string;
  /** Article description/summary */
  description: string | null;
  /** Publication date as ISO string */
  publish_date: string | null;
  /** Author name */
  author: string | null;
  /** Tags as JSON string or comma-separated list */
  tags: string;
}

/**
 * Props for the ArticleCard component
 */
export interface ArticleCardProps {
  /** Article data to display */
  article: Article;
  /** Show article excerpt/description */
  showExcerpt?: boolean;
  /** Show publication date */
  showDate?: boolean;
  /** Show author name */
  showAuthor?: boolean;
  /** Show tags */
  showTags?: boolean;
}

/**
 * Props for the ArticleList component
 */
export interface ArticleListProps {
  /** Array of articles to display */
  articles: Article[];
  /** Number of columns in grid (or 'auto') */
  columns?: number | 'auto';
  /** Show article excerpts */
  showExcerpt?: boolean;
  /** Show publication dates */
  showDate?: boolean;
  /** Show author names */
  showAuthor?: boolean;
  /** Show tags */
  showTags?: boolean;
  /** Message when no articles */
  emptyMessage?: string;
}

/**
 * Props for the Markdown component
 */
export interface MarkdownProps {
  /** Markdown content to render */
  content: string;
  /** Optional CSS class for styling */
  class?: string;
}
