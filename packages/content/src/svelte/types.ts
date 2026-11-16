/**
 * Content component types
 *
 * Shared types for Article, Markdown, and other content components.
 */

import type { ContentBodyFormat, ContentBodyImage } from '../body-format.js';

export interface ContentBodyEditorChange {
  body: string;
  bodyFormat: ContentBodyFormat;
  images: ContentBodyImage[];
}

/** The person asked to change a picture in the story (see `onRequestImageChange`). */
export interface ContentBodyImageChangeRequest {
  /** The picture's index among the body's images. */
  index: number;
  /** Its stored asset id, when it has one. */
  assetId: string | null;
  /** Its alt text. */
  alt: string;
  /** Its source URL as shown in the editor. */
  src: string;
  /**
   * True when it came from pressing and holding the picture: the host opens
   * its request box already listening for speech.
   */
  listen: boolean;
  /** Where the picture is on screen (viewport pixels), to anchor a popover. */
  rect: { top: number; left: number; width: number; height: number };
}

export type ContentReviewStatusTone =
  | 'neutral'
  | 'danger'
  | 'warning'
  | 'success';
export type ContentReviewStatusIcon = 'content' | 'facts' | 'safety' | 'custom';

export interface ContentReviewStatusTrayItem {
  id: string;
  icon: ContentReviewStatusIcon;
  label: string;
  tone: ContentReviewStatusTone;
  status: string;
}

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
  /** Tags as JSON string, comma-separated list, or parsed string array */
  tags: string | string[];
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
