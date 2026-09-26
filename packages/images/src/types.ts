/**
 * Type definitions for @happyvertical/smrt-images package
 */

import type { AIClientOptions } from '@happyvertical/ai';
import type { AssetOptions } from '@happyvertical/smrt-assets';
import type { DecisionClient, DecisionConfig } from '@happyvertical/smrt-core';

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

/** One curated tag or subject that can be offered to typed categorization. */
export interface ImageLabelVocabularyEntry {
  /** Exact, case-sensitive name returned when the predicate is selected. */
  name: string;
  /** Optional explanation maintained by the caller. */
  description?: string;
}

/** Resolves an optional tag or subject vocabulary for one image. */
export type ImageLabelVocabularyResolver = (
  image: import('./image').Image,
) =>
  | readonly ImageLabelVocabularyEntry[]
  | undefined
  | Promise<readonly ImageLabelVocabularyEntry[] | undefined>;

/** Static image labels or a resolver for them. */
export type ImageLabelVocabulary =
  | readonly ImageLabelVocabularyEntry[]
  | ImageLabelVocabularyResolver;

/** Optional decision routing and curated vocabularies for `ImageCategorizer`. */
export interface ImageCategorizerOptions {
  /** Existing generation client configuration. */
  ai: AIClientOptions;
  /** Optional typed-decision client configuration or injected client. */
  decisions?: DecisionConfig | DecisionClient;
  /** Offered tags; absent tags keep the legacy generated result. */
  tagVocabulary?: ImageLabelVocabulary;
  /** Offered subjects; absent subjects keep the legacy generated result. */
  subjectVocabulary?: ImageLabelVocabulary;
}

/** One selected vocabulary label with the provider's predicate probability. */
export interface CategorizedImageLabel {
  name: string;
  probability: number;
}

/** Additive typed-decision metadata for vocabulary-constrained labels. */
export interface ImageCategorizationDecisionDetail {
  provenance: { provider: string; model: string };
  tags?: CategorizedImageLabel[];
  subjects?: CategorizedImageLabel[];
}

/**
 * Detailed categorization result. `result.confidence` is the existing
 * generative confidence, never a calibrated typed-decision confidence.
 */
export interface DetailedCategoryResult {
  result: CategoryResult;
  decision?: ImageCategorizationDecisionDetail;
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
