/**
 * Embedding Types for SMRT Framework
 *
 * Types for centralized embedding storage and semantic search.
 */

/**
 * Embedding provider type
 */
export type EmbeddingProviderType = 'local' | 'ai' | 'auto';

/**
 * Project-level embedding configuration (from smrt.config)
 */
export interface ProjectEmbeddingConfig {
  /**
   * Standard dimensions for the project
   * @default 768
   */
  dimensions: number;

  /**
   * Embedding provider type
   * - 'local': Use local Node.js model (@huggingface/transformers or
   *   @xenova/transformers)
   * - 'ai': Use AI library (OpenAI, etc.)
   * - 'auto': Prefer configured AI embeddings, otherwise use local embeddings
   *   when explicitly invoked
   * @default 'auto'
   */
  provider: EmbeddingProviderType;

  /**
   * Local model to use (when provider is 'local' or 'auto')
   * @default 'Xenova/bge-base-en-v1.5'
   */
  localModel?: string;

  /**
   * AI model to use (when provider is 'ai' or fallback)
   * @default 'text-embedding-3-small'
   */
  aiModel?: string;

  /**
   * Whether to fallback to AI if local fails
   * @default true
   */
  fallbackToAI?: boolean;

  /**
   * Storage mode for embeddings
   * - 'json': Store as JSON text, in-memory similarity (works everywhere)
   * - 'native': Use database vector operations when available, fallback to json
   * @default 'json'
   */
  storage?: 'json' | 'native';
}

/**
 * Per-class embedding configuration (from @smrt decorator)
 */
export interface ClassEmbeddingConfig {
  /**
   * Fields to generate embeddings for
   */
  fields: string[];

  /**
   * Override provider for this class
   */
  provider?: EmbeddingProviderType;

  /**
   * Auto-generate embeddings on save
   * @default true
   */
  autoGenerate?: boolean;

  /**
   * Only regenerate if content changed (hash-based detection)
   * @default true
   */
  regenerateOnChange?: boolean;

  /**
   * Combined field for semantic search
   * Creates a virtual embedding from multiple fields
   */
  combinedField?: {
    /**
     * Name of the virtual field (e.g., 'content')
     */
    name: string;
    /**
     * Template for combining fields (e.g., '{title}\n\n{body}')
     */
    template: string;
  };
}

/**
 * Resolved embedding configuration (project + class merged)
 */
export interface ResolvedEmbeddingConfig extends ClassEmbeddingConfig {
  /**
   * Dimensions for this class (from project or override)
   */
  dimensions: number;

  /**
   * Resolved provider
   */
  provider: EmbeddingProviderType;

  /**
   * Local model to use
   */
  localModel: string;

  /**
   * AI model to use
   */
  aiModel: string;

  /**
   * Fallback behavior
   */
  fallbackToAI: boolean;
}

/**
 * Stored embedding record in _smrt_embeddings table
 */
export interface StoredEmbedding {
  /**
   * Unique identifier
   */
  id: string;

  /**
   * Class name of the source object
   */
  object_class: string;

  /**
   * ID of the source object
   */
  object_id: string;

  /**
   * Field name that was embedded
   */
  field_name: string;

  /**
   * SHA-256 hash of the source content
   */
  content_hash: string;

  /**
   * Embedding vector (as number array)
   */
  embedding: number[];

  /**
   * Model used to generate the embedding
   */
  model: string;

  /**
   * Number of dimensions
   */
  dimensions: number;

  /**
   * Provider used ('local' or 'ai')
   */
  provider?: string;

  /**
   * Creation timestamp
   */
  created_at: Date;

  /**
   * Last update timestamp
   */
  updated_at: Date;
}

/**
 * Options for embedding generation
 */
export interface GenerateEmbeddingsOptions {
  /**
   * Override which fields to embed
   */
  fields?: string[];

  /**
   * Override provider
   */
  provider?: EmbeddingProviderType;

  /**
   * Force regeneration even if content unchanged
   */
  force?: boolean;
}

/**
 * Options for semantic search
 */
export interface SemanticSearchOptions {
  /**
   * Field to search (default: combined field or first configured field)
   */
  field?: string;

  /**
   * Maximum results
   * @default 10
   */
  limit?: number;

  /**
   * Minimum cosine similarity (0-1)
   * @default 0
   */
  minSimilarity?: number;

  /**
   * Additional SQL filters
   */
  where?: Record<string, unknown>;
}

/**
 * Options for finding similar objects
 */
export interface FindSimilarOptions
  extends Omit<SemanticSearchOptions, 'where'> {
  /**
   * Exclude the source object from results
   * @default true
   */
  excludeSelf?: boolean;
}

/**
 * Result of batch embedding generation
 */
export interface BatchGenerateResult {
  /**
   * Number of objects that had embeddings generated
   */
  generated: number;

  /**
   * Number of objects skipped (unchanged content)
   */
  skipped: number;
}

/**
 * Progress callback for batch operations
 */
export type BatchProgressCallback = (progress: {
  completed: number;
  total: number;
}) => void;

/**
 * Options for batch embedding generation
 */
export interface BatchGenerateOptions {
  /**
   * Number of objects to process at once
   * @default 50
   */
  batchSize?: number;

  /**
   * Progress callback
   */
  onProgress?: BatchProgressCallback;
}
