/**
 * Vector Similarity Calculations
 *
 * Provides cosine similarity for semantic search.
 */

/**
 * Cosine similarity calculator for embedding vectors
 */
export class CosineSimilarity {
  /**
   * Calculate cosine similarity between two vectors
   *
   * @param a - First embedding vector
   * @param b - Second embedding vector
   * @returns Similarity score between -1 and 1 (higher = more similar)
   * @throws Error if vectors have different dimensions
   */
  static calculate(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(
        `Vector dimension mismatch: ${a.length} vs ${b.length}. ` +
          'Ensure all embeddings use the same model and dimensions.',
      );
    }

    if (a.length === 0) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);

    if (denominator === 0) {
      return 0;
    }

    return dotProduct / denominator;
  }

  /**
   * Calculate similarities between a query vector and multiple candidates
   *
   * @param query - Query embedding vector
   * @param candidates - Array of candidate vectors with IDs
   * @returns Array sorted by similarity (highest first)
   */
  static rankBySimilarity<T extends { id: string; embedding: number[] }>(
    query: number[],
    candidates: T[],
  ): Array<T & { similarity: number }> {
    const results = candidates.map((candidate) => ({
      ...candidate,
      similarity: CosineSimilarity.calculate(query, candidate.embedding),
    }));

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Filter candidates by minimum similarity threshold
   *
   * @param query - Query embedding vector
   * @param candidates - Array of candidate vectors
   * @param minSimilarity - Minimum similarity threshold (0-1)
   * @returns Filtered and sorted results
   */
  static filterBySimilarity<T extends { id: string; embedding: number[] }>(
    query: number[],
    candidates: T[],
    minSimilarity: number,
  ): Array<T & { similarity: number }> {
    return CosineSimilarity.rankBySimilarity(query, candidates).filter(
      (result) => result.similarity >= minSimilarity,
    );
  }
}
