/**
 * Type definitions for @have/tags package
 */

import type { SmrtObjectOptions } from '@smrt/core';

/**
 * Options for creating a Tag instance
 */
export interface TagOptions extends SmrtObjectOptions {
  slug?: string;
  name?: string;
  context?: string;
  parentSlug?: string;
  level?: number;
  description?: string;
  metadata?: string | Record<string, any>;
}

/**
 * Options for creating a TagAlias instance
 */
export interface TagAliasOptions extends SmrtObjectOptions {
  tagSlug?: string;
  alias?: string;
  language?: string;
  context?: string;
}

/**
 * Tag metadata structure (flexible, application-specific)
 */
export interface TagMetadata {
  // UI Styling
  color?: string;
  backgroundColor?: string;
  icon?: string;
  emoji?: string;

  // Usage Statistics
  usageCount?: number;
  lastUsed?: string;
  trending?: boolean;

  // Display Configuration
  featured?: boolean;
  sortOrder?: number;
  showInNav?: boolean;
  displayFormat?: string;

  // Custom Application Data
  aiGenerated?: boolean;
  confidence?: number;
  source?: string;
  reviewStatus?: string;

  // Allow any other properties
  [key: string]: any;
}

/**
 * Tag hierarchy result structure
 */
export interface TagHierarchy {
  ancestors: import('./tag').Tag[];
  current: import('./tag').Tag;
  descendants: import('./tag').Tag[];
}
