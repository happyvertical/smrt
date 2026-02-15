/**
 * Type definitions for @happyvertical/smrt-images package
 */

import type { AssetOptions } from '@happyvertical/smrt-assets';

/**
 * Options for creating an Image instance
 */
export interface ImageOptions extends AssetOptions {
  width?: number;
  height?: number;
  alt?: string;
}

/**
 * Result from AI-powered image categorization
 */
export interface CategoryResult {
  tags: string[];
  description: string;
  confidence: number;
  subjects: string[];
}

/**
 * Options for image search queries
 */
export interface ImageSearchOptions {
  tags?: string[];
  minWidth?: number;
  minHeight?: number;
  orientation?: 'landscape' | 'portrait' | 'square';
  limit?: number;
  offset?: number;
}

/**
 * Options for derived image creation
 */
export interface DeriveOptions {
  /** Number of results (default 1) */
  count?: number;
  /** Output dimensions (e.g., '1024x1024') */
  size?: string;
  /** Style hint */
  style?: string;
}

/**
 * Result from image metadata extraction
 */
export interface ImageMetadataResult {
  width: number;
  height: number;
  format: string;
  mimeType: string;
  exif?: Record<string, unknown>;
}
