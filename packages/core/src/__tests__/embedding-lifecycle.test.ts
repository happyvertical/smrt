/**
 * Integration tests for embedding lifecycle
 *
 * Tests:
 * 1. Generate embeddings for configured fields
 * 2. Store and retrieve embeddings
 * 3. Detect stale embeddings when content changes
 * 4. Clear embeddings
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { EmbeddingProvider } from '../embeddings/provider';
import { EmbeddingStorage } from '../embeddings/storage';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Mock embedding provider that returns deterministic embeddings
function createMockEmbeddings(text: string): number[] {
  // Create a simple hash-based embedding for testing
  // In real usage, this would be from an AI model
  const hash = text.split('').reduce((acc, char) => {
    return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
  }, 0);

  // Generate a 5-dimensional embedding for testing
  return [
    Math.sin(hash) * 0.5 + 0.5,
    Math.cos(hash) * 0.5 + 0.5,
    Math.sin(hash * 2) * 0.5 + 0.5,
    Math.cos(hash * 2) * 0.5 + 0.5,
    Math.sin(hash * 3) * 0.5 + 0.5,
  ];
}

// Test article with embeddings config
@smrt({
  embeddings: {
    fields: ['title', 'body'],
    autoGenerate: false, // Disable auto-generation for controlled testing
  },
})
class EmbeddingTestArticle extends SmrtObject {
  title: string = '';
  body: string = '';
  author: string = '';
}

class EmbeddingTestArticleCollection extends SmrtCollection<EmbeddingTestArticle> {
  static readonly _itemClass = EmbeddingTestArticle;
}

describe('Embedding Lifecycle', () => {
  let tempDir: string;
  let dbPath: string;
  let collection: EmbeddingTestArticleCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-embedding-test-'));
    dbPath = join(tempDir, 'articles.db');

    // Register collection
    ObjectRegistry.registerCollection(
      'EmbeddingTestArticle',
      EmbeddingTestArticleCollection,
    );

    // Create collection with mock AI
    collection = await EmbeddingTestArticleCollection.create({
      db: { type: 'sqlite', url: dbPath },
      ai: {
        // Mock AI client with embed method
        embed: async (texts: string | string[]) => {
          const textArray = Array.isArray(texts) ? texts : [texts];
          return {
            embeddings: textArray.map((t) => createMockEmbeddings(t)),
          };
        },
      } as any,
    });

    // Mock the EmbeddingProvider to use our mock embeddings
    vi.spyOn(EmbeddingProvider.prototype, 'embed').mockImplementation(
      async (texts: string | string[]) => {
        const textArray = Array.isArray(texts) ? texts : [texts];
        return textArray.map((t) => createMockEmbeddings(t));
      },
    );

    vi.spyOn(EmbeddingProvider.prototype, 'getModelName').mockReturnValue(
      'test-model',
    );
    vi.spyOn(EmbeddingProvider.prototype, 'getDimensions').mockReturnValue(5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('generateEmbeddings', () => {
    it('should generate embeddings for all configured fields', async () => {
      const article = await collection.create({
        title: 'Introduction to AI',
        body: 'Artificial intelligence is transforming the world...',
        author: 'John Doe',
      });
      await article.save();

      // Generate embeddings
      await article.generateEmbeddings();

      // Verify embeddings were stored for title and body (not author)
      const titleEmbedding = await article.getEmbedding('title');
      const bodyEmbedding = await article.getEmbedding('body');

      expect(titleEmbedding).not.toBeNull();
      expect(titleEmbedding).toHaveLength(5);
      expect(bodyEmbedding).not.toBeNull();
      expect(bodyEmbedding).toHaveLength(5);
    });

    it('should generate embeddings for specific fields only', async () => {
      const article = await collection.create({
        title: 'Machine Learning Basics',
        body: 'ML is a subset of AI...',
      });
      await article.save();

      // Generate embeddings for title only
      await article.generateEmbeddings({ fields: ['title'] });

      const titleEmbedding = await article.getEmbedding('title');
      const bodyEmbedding = await article.getEmbedding('body');

      expect(titleEmbedding).not.toBeNull();
      expect(bodyEmbedding).toBeNull();
    });

    it('should skip generation if content hash matches', async () => {
      const article = await collection.create({
        title: 'Deep Learning',
        body: 'Neural networks with many layers...',
      });
      await article.save();

      // Generate embeddings first time
      await article.generateEmbeddings();

      // Spy on storage upsert
      const upsertSpy = vi.spyOn(EmbeddingStorage, 'upsert');

      // Generate again without changes (should skip)
      await article.generateEmbeddings();

      // Should not have called upsert again (content unchanged)
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it('should regenerate if force option is true', async () => {
      const article = await collection.create({
        title: 'Reinforcement Learning',
        body: 'Learning through trial and error...',
      });
      await article.save();

      // Generate embeddings first time
      await article.generateEmbeddings();

      // Spy on storage upsert
      const upsertSpy = vi.spyOn(EmbeddingStorage, 'upsert');

      // Force regeneration
      await article.generateEmbeddings({ force: true });

      // Should have called upsert
      expect(upsertSpy).toHaveBeenCalled();
    });
  });

  describe('hasStaleEmbeddings', () => {
    it('should return true when no embeddings exist', async () => {
      const article = await collection.create({
        title: 'New Article',
        body: 'Fresh content...',
      });
      await article.save();

      const isStale = await article.hasStaleEmbeddings();
      expect(isStale).toBe(true);
    });

    it('should return false when embeddings are current', async () => {
      const article = await collection.create({
        title: 'Current Article',
        body: 'Up to date content...',
      });
      await article.save();
      await article.generateEmbeddings();

      const isStale = await article.hasStaleEmbeddings();
      expect(isStale).toBe(false);
    });

    it('should return true when content has changed', async () => {
      const article = await collection.create({
        title: 'Original Title',
        body: 'Original content...',
      });
      await article.save();
      await article.generateEmbeddings();

      // Modify content
      article.title = 'Updated Title';
      await article.save();

      const isStale = await article.hasStaleEmbeddings();
      expect(isStale).toBe(true);
    });
  });

  describe('getEmbedding', () => {
    it('should return null for non-existent embedding', async () => {
      const article = await collection.create({
        title: 'Test',
        body: 'Content',
      });
      await article.save();

      const embedding = await article.getEmbedding('title');
      expect(embedding).toBeNull();
    });

    it('should return stored embedding vector', async () => {
      const article = await collection.create({
        title: 'Embedding Test',
        body: 'Test content for embedding...',
      });
      await article.save();
      await article.generateEmbeddings();

      const embedding = await article.getEmbedding('title');

      expect(embedding).not.toBeNull();
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding?.every((v) => typeof v === 'number')).toBe(true);
    });
  });

  describe('clearEmbeddings', () => {
    it('should remove all embeddings for the object', async () => {
      const article = await collection.create({
        title: 'Article to Clear',
        body: 'Content to be cleared...',
      });
      await article.save();
      await article.generateEmbeddings();

      // Verify embeddings exist
      expect(await article.getEmbedding('title')).not.toBeNull();
      expect(await article.getEmbedding('body')).not.toBeNull();

      // Clear embeddings
      await article.clearEmbeddings();

      // Verify embeddings are gone
      expect(await article.getEmbedding('title')).toBeNull();
      expect(await article.getEmbedding('body')).toBeNull();
    });
  });

  describe('embedding persistence across loads', () => {
    it('should persist embeddings and retrieve after reload', async () => {
      const article = await collection.create({
        title: 'Persistent Article',
        body: 'Content that persists...',
      });
      await article.save();
      await article.generateEmbeddings();

      const originalEmbedding = await article.getEmbedding('title');

      // Load article from database
      const loadedArticle = await collection.get(article.id as string);
      expect(loadedArticle).not.toBeNull();

      const loadedEmbedding = await loadedArticle?.getEmbedding('title');

      expect(loadedEmbedding).toEqual(originalEmbedding);
    });
  });
});
