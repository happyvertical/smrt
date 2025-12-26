/**
 * Content Hashing for Embedding Change Detection
 *
 * Uses SHA-256 to detect when content has changed and embeddings need regeneration.
 */

import { createHash } from 'node:crypto';

/**
 * Content hasher for embedding change detection
 */
export class ContentHasher {
  /**
   * Generate SHA-256 hash of content
   *
   * @param content - Text content to hash
   * @returns Hex-encoded hash string
   */
  static hash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Check if content has changed by comparing hashes
   *
   * @param content - Current content
   * @param previousHash - Previously stored hash
   * @returns True if content has changed
   */
  static hasChanged(content: string, previousHash: string): boolean {
    return ContentHasher.hash(content) !== previousHash;
  }

  /**
   * Generate hash for multiple fields combined
   *
   * @param fields - Object with field names and values
   * @returns Hex-encoded hash of combined content
   */
  static hashFields(fields: Record<string, string>): string {
    // Sort keys for deterministic ordering
    const sortedKeys = Object.keys(fields).sort();
    const combined = sortedKeys
      .map((key) => `${key}:${fields[key]}`)
      .join('\n');
    return ContentHasher.hash(combined);
  }
}
