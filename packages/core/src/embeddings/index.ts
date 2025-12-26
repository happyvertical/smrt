/**
 * SMRT Embeddings Module
 *
 * Centralized embedding support for semantic search across SMRT objects.
 *
 * @example
 * ```typescript
 * import { EmbeddingProvider, EmbeddingStorage, CosineSimilarity } from './embeddings';
 *
 * // Create provider
 * const provider = new EmbeddingProvider(config, ai);
 *
 * // Generate embeddings
 * const embeddings = await provider.embed(['Hello world', 'Goodbye world']);
 *
 * // Store embeddings
 * await EmbeddingStorage.upsert(db, {
 *   objectClass: 'Article',
 *   objectId: '123',
 *   fieldName: 'title',
 *   contentHash: ContentHasher.hash('Hello world'),
 *   embedding: embeddings[0],
 *   model: provider.getModelName(),
 *   dimensions: provider.getDimensions()
 * });
 *
 * // Search by similarity
 * const results = CosineSimilarity.rankBySimilarity(queryEmbedding, candidates);
 * ```
 */

// Utilities
export { ContentHasher } from './hash';
// Provider
export { DEFAULT_EMBEDDING_CONFIG, EmbeddingProvider } from './provider';
export { CosineSimilarity } from './similarity';

// Storage
export { EmbeddingStorage } from './storage';
// Types
export type {
  BatchGenerateOptions,
  BatchGenerateResult,
  BatchProgressCallback,
  ClassEmbeddingConfig,
  EmbeddingProviderType,
  FindSimilarOptions,
  GenerateEmbeddingsOptions,
  ProjectEmbeddingConfig,
  ResolvedEmbeddingConfig,
  SemanticSearchOptions,
  StoredEmbedding,
} from './types';
