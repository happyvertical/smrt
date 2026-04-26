/**
 * Integration tests for semantic search
 *
 * Tests:
 * 1. semanticSearch with text query
 * 2. findSimilar between objects
 * 3. findSimilarToEmbedding with raw vectors
 * 4. generateMissingEmbeddings batch operation
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { EmbeddingProvider } from '../embeddings/provider';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Create embeddings that cluster similar content together
// This simulates how real embeddings work - similar text = similar vectors
function createSemanticEmbeddings(text: string): number[] {
  const lowerText = text.toLowerCase();

  // Create base values based on topic detection
  let techScore = 0;
  let sportScore = 0;
  let scienceScore = 0;

  // Detect technology terms
  if (
    lowerText.includes('ai') ||
    lowerText.includes('machine learning') ||
    lowerText.includes('software') ||
    lowerText.includes('computer') ||
    lowerText.includes('algorithm')
  ) {
    techScore = 0.9;
  }

  // Detect sports terms
  if (
    lowerText.includes('football') ||
    lowerText.includes('basketball') ||
    lowerText.includes('sports') ||
    lowerText.includes('team') ||
    lowerText.includes('game')
  ) {
    sportScore = 0.9;
  }

  // Detect science terms
  if (
    lowerText.includes('physics') ||
    lowerText.includes('chemistry') ||
    lowerText.includes('biology') ||
    lowerText.includes('experiment') ||
    lowerText.includes('research')
  ) {
    scienceScore = 0.9;
  }

  // Add some variation based on text hash
  const hash = text.split('').reduce((acc, char) => {
    return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
  }, 0);

  const variation = Math.sin(hash) * 0.1;

  // Return 5-dimensional embedding
  return [
    techScore + variation,
    sportScore + variation,
    scienceScore + variation,
    Math.abs(Math.sin(hash)) * 0.5, // Random dimension
    Math.abs(Math.cos(hash)) * 0.5, // Random dimension
  ];
}

// Test document with embeddings config
@smrt({
  embeddings: {
    fields: ['content'],
    autoGenerate: false,
  },
})
class SearchTestDocument extends SmrtObject {
  title: string = '';
  content: string = '';
  category: string = '';
}

class SearchTestDocumentCollection extends SmrtCollection<SearchTestDocument> {
  static readonly _itemClass = SearchTestDocument;
}

describe('Semantic Search', () => {
  let tempDir: string;
  let dbPath: string;
  let collection: SearchTestDocumentCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-search-test-'));
    dbPath = join(tempDir, 'documents.db');

    // Register collection
    ObjectRegistry.registerCollection(
      'SearchTestDocument',
      SearchTestDocumentCollection,
    );

    // Create collection with mock AI
    collection = await SearchTestDocumentCollection.create({
      db: { type: 'sqlite', url: dbPath },
      ai: {
        embed: async (texts: string | string[]) => {
          const textArray = Array.isArray(texts) ? texts : [texts];
          return {
            embeddings: textArray.map((t) => createSemanticEmbeddings(t)),
          };
        },
      } as any,
    });

    // Mock the EmbeddingProvider
    vi.spyOn(EmbeddingProvider.prototype, 'embed').mockImplementation(
      async (texts: string | string[]) => {
        const textArray = Array.isArray(texts) ? texts : [texts];
        return textArray.map((t) => createSemanticEmbeddings(t));
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

  async function seedDocuments() {
    // Create diverse documents
    const docs = [
      {
        title: 'AI Revolution',
        content:
          'Machine learning and AI are transforming software development with new algorithms.',
        category: 'tech',
      },
      {
        title: 'Deep Learning Guide',
        content:
          'Neural networks and computer vision represent the future of AI.',
        category: 'tech',
      },
      {
        title: 'Championship Finals',
        content:
          'The football team won the championship game against their rivals.',
        category: 'sports',
      },
      {
        title: 'Basketball Season',
        content:
          'The basketball team is preparing for the upcoming sports season.',
        category: 'sports',
      },
      {
        title: 'Quantum Physics',
        content:
          'New research in physics experiments reveals quantum phenomena.',
        category: 'science',
      },
      {
        title: 'Biology Discovery',
        content: 'Scientists made a breakthrough in biology research.',
        category: 'science',
      },
    ];

    const created = [];
    for (const doc of docs) {
      const article = await collection.create(doc);
      await article.save();
      await article.generateEmbeddings();
      created.push(article);
    }

    return created;
  }

  describe('semanticSearch', () => {
    it('should find documents similar to query text', async () => {
      await seedDocuments();

      // Search for AI-related content
      const results = await collection.semanticSearch(
        'artificial intelligence and machine learning',
        { limit: 3 },
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(3);

      // Results should have similarity scores
      expect(results[0]._similarity).toBeDefined();
      expect(typeof results[0]._similarity).toBe('number');

      // Results should be sorted by similarity (highest first)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]._similarity).toBeGreaterThanOrEqual(
          results[i]._similarity,
        );
      }
    });

    it('should filter by minimum similarity', async () => {
      await seedDocuments();

      // Search with high similarity threshold
      const results = await collection.semanticSearch('software and AI', {
        minSimilarity: 0.5,
      });

      // All results should meet threshold
      for (const result of results) {
        expect(result._similarity).toBeGreaterThanOrEqual(0.5);
      }
    });

    it('should apply additional where filters', async () => {
      await seedDocuments();

      // Search within specific category
      const results = await collection.semanticSearch('research', {
        where: { category: 'science' },
      });

      // All results should be in science category
      for (const result of results) {
        expect(result.category).toBe('science');
      }
    });

    it('should return empty array when no embeddings exist', async () => {
      // Create document without generating embeddings
      const doc = await collection.create({
        title: 'No Embeddings',
        content: 'This document has no embeddings',
      });
      await doc.save();

      const results = await collection.semanticSearch('test query');
      expect(results).toEqual([]);
    });
  });

  describe('findSimilar', () => {
    it('should find documents similar to a given object', async () => {
      const docs = await seedDocuments();

      // Find documents similar to the first AI article
      const aiArticle = docs[0];
      const similar = await collection.findSimilar(aiArticle, { limit: 3 });

      expect(similar.length).toBeGreaterThan(0);
      expect(similar.length).toBeLessThanOrEqual(3);

      // Should not include the source document (excludeSelf: true by default)
      const ids = similar.map((s) => s.id);
      expect(ids).not.toContain(aiArticle.id);

      // Results should have similarity scores
      expect(similar[0]._similarity).toBeDefined();
    });

    it('should accept object ID as input', async () => {
      const docs = await seedDocuments();

      const results = await collection.findSimilar(docs[0].id as string, {
        limit: 2,
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('should include self when excludeSelf is false', async () => {
      const docs = await seedDocuments();

      const similar = await collection.findSimilar(docs[0], {
        limit: 5,
        excludeSelf: false,
      });

      const ids = similar.map((s) => s.id);
      expect(ids).toContain(docs[0].id);

      // Self should have similarity of 1.0
      const self = similar.find((s) => s.id === docs[0].id);
      expect(self?._similarity).toBeCloseTo(1.0, 5);
    });

    it('should throw error for object without embeddings', async () => {
      const doc = await collection.create({
        title: 'No Embeddings',
        content: 'No embeddings generated',
      });
      await doc.save();

      await expect(collection.findSimilar(doc)).rejects.toThrow(
        /No embedding found/,
      );
    });
  });

  describe('findSimilarToEmbedding', () => {
    it('should find documents by raw embedding vector', async () => {
      await seedDocuments();

      // Create an embedding similar to tech content
      const techEmbedding = [0.9, 0.1, 0.1, 0.3, 0.3];

      const results = await collection.findSimilarToEmbedding(techEmbedding, {
        limit: 3,
      });

      expect(results.length).toBeGreaterThan(0);

      // Results should have similarity scores
      expect(results[0]._similarity).toBeDefined();
    });

    it('should filter by minimum similarity', async () => {
      await seedDocuments();

      const embedding = [0.5, 0.5, 0.5, 0.5, 0.5];

      const results = await collection.findSimilarToEmbedding(embedding, {
        minSimilarity: 0.8,
      });

      for (const result of results) {
        expect(result._similarity).toBeGreaterThanOrEqual(0.8);
      }
    });
  });

  describe('generateMissingEmbeddings', () => {
    it('should generate embeddings for documents without them', async () => {
      // Create documents without embeddings
      for (let i = 0; i < 5; i++) {
        const doc = await collection.create({
          title: `Document ${i}`,
          content: `Content for document ${i}`,
        });
        await doc.save();
      }

      // Generate missing embeddings
      const stats = await collection.generateMissingEmbeddings();

      expect(stats.generated).toBe(5);
      expect(stats.skipped).toBe(0);
    });

    it('should skip documents with current embeddings', async () => {
      // Create and generate embeddings
      const doc = await collection.create({
        title: 'Already Embedded',
        content: 'This document already has embeddings',
      });
      await doc.save();
      await doc.generateEmbeddings();

      // Try to generate again
      const stats = await collection.generateMissingEmbeddings();

      expect(stats.generated).toBe(0);
      expect(stats.skipped).toBe(1);
    });

    it('should regenerate embeddings when the resolved model changes', async () => {
      const getModelName = vi.mocked(EmbeddingProvider.prototype.getModelName);
      getModelName.mockReturnValue('legacy-model');

      const doc = await collection.create({
        title: 'Migrated Model',
        content: 'This document has embeddings from an older model',
      });
      await doc.save();
      await doc.generateEmbeddings();

      getModelName.mockReturnValue('current-model');

      const stats = await collection.generateMissingEmbeddings();

      expect(stats.generated).toBe(1);
      expect(stats.skipped).toBe(0);
    });

    it('should report progress', async () => {
      // Create documents
      for (let i = 0; i < 3; i++) {
        const doc = await collection.create({
          title: `Progress Doc ${i}`,
          content: `Content ${i}`,
        });
        await doc.save();
      }

      const progressUpdates: Array<{ completed: number; total: number }> = [];

      await collection.generateMissingEmbeddings({
        onProgress: (progress) => {
          progressUpdates.push({ ...progress });
        },
      });

      expect(progressUpdates.length).toBe(3);
      expect(progressUpdates[0]).toEqual({ completed: 1, total: 3 });
      expect(progressUpdates[2]).toEqual({ completed: 3, total: 3 });
    });

    it('should process in batches', async () => {
      // Create more documents than batch size
      for (let i = 0; i < 10; i++) {
        const doc = await collection.create({
          title: `Batch Doc ${i}`,
          content: `Batch content ${i}`,
        });
        await doc.save();
      }

      const stats = await collection.generateMissingEmbeddings({
        batchSize: 3,
      });

      expect(stats.generated).toBe(10);
    });
  });
});
