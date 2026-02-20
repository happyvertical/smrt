/**
 * Tests for EmbeddingStorage
 */

import type { VectorCapabilities } from '@happyvertical/sql';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CREATE_SMRT_EMBEDDINGS_TABLE } from '../../system/schema';
import { EmbeddingStorage } from '../storage';

describe('EmbeddingStorage', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    // Create in-memory SQLite database
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    // Create the embeddings table
    await db.query(CREATE_SMRT_EMBEDDINGS_TABLE);
  });

  describe('upsert', () => {
    it('should store a new embedding', async () => {
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'content',
        contentHash: 'abc123',
        embedding,
        model: 'text-embedding-3-small',
        dimensions: 5,
        provider: 'ai',
      });

      const stored = await EmbeddingStorage.get(
        db,
        'Article',
        'article-123',
        'content',
        'text-embedding-3-small',
      );

      expect(stored).not.toBeNull();
      expect(stored?.embedding).toEqual(embedding);
      expect(stored?.content_hash).toBe('abc123');
    });

    it('should update existing embedding', async () => {
      const embedding1 = [0.1, 0.2, 0.3];
      const embedding2 = [0.4, 0.5, 0.6];

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'content',
        contentHash: 'hash1',
        embedding: embedding1,
        model: 'test-model',
        dimensions: 3,
      });

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'content',
        contentHash: 'hash2',
        embedding: embedding2,
        model: 'test-model',
        dimensions: 3,
      });

      const stored = await EmbeddingStorage.get(
        db,
        'Article',
        'article-123',
        'content',
        'test-model',
      );

      expect(stored?.embedding).toEqual(embedding2);
      expect(stored?.content_hash).toBe('hash2');
    });

    it('should store embeddings for different fields', async () => {
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'title',
        contentHash: 'title-hash',
        embedding: [1, 0, 0],
        model: 'test-model',
        dimensions: 3,
      });

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'body',
        contentHash: 'body-hash',
        embedding: [0, 1, 0],
        model: 'test-model',
        dimensions: 3,
      });

      const titleEmbedding = await EmbeddingStorage.get(
        db,
        'Article',
        'article-123',
        'title',
        'test-model',
      );
      const bodyEmbedding = await EmbeddingStorage.get(
        db,
        'Article',
        'article-123',
        'body',
        'test-model',
      );

      expect(titleEmbedding?.embedding).toEqual([1, 0, 0]);
      expect(bodyEmbedding?.embedding).toEqual([0, 1, 0]);
    });
  });

  describe('get', () => {
    it('should return null for non-existent embedding', async () => {
      const result = await EmbeddingStorage.get(
        db,
        'NonExistent',
        'id-123',
        'field',
        'model',
      );

      expect(result).toBeNull();
    });

    it('should return stored embedding with all fields', async () => {
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'content',
        contentHash: 'test-hash',
        embedding: [0.1, 0.2, 0.3],
        model: 'test-model',
        dimensions: 3,
        provider: 'local',
      });

      const result = await EmbeddingStorage.get(
        db,
        'Article',
        'article-123',
        'content',
        'test-model',
      );

      expect(result).toMatchObject({
        object_class: 'Article',
        object_id: 'article-123',
        field_name: 'content',
        content_hash: 'test-hash',
        model: 'test-model',
        dimensions: 3,
        provider: 'local',
      });
      expect(result?.embedding).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe('getForObject', () => {
    it('should get all embeddings for an object', async () => {
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'title',
        contentHash: 'hash1',
        embedding: [0.1],
        model: 'test-model',
        dimensions: 1,
      });

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'body',
        contentHash: 'hash2',
        embedding: [0.2],
        model: 'test-model',
        dimensions: 1,
      });

      const results = await EmbeddingStorage.getForObject(
        db,
        'Article',
        'article-123',
      );

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.field_name).sort()).toEqual([
        'body',
        'title',
      ]);
    });
  });

  describe('listForClass', () => {
    beforeEach(async () => {
      // Set up test data
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-1',
        fieldName: 'content',
        contentHash: 'hash1',
        embedding: [0.1, 0.2],
        model: 'test-model',
        dimensions: 2,
      });

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-2',
        fieldName: 'content',
        contentHash: 'hash2',
        embedding: [0.3, 0.4],
        model: 'test-model',
        dimensions: 2,
      });

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-1',
        fieldName: 'title',
        contentHash: 'hash3',
        embedding: [0.5, 0.6],
        model: 'test-model',
        dimensions: 2,
      });

      await EmbeddingStorage.upsert(db, {
        objectClass: 'BlogPost',
        objectId: 'post-1',
        fieldName: 'content',
        contentHash: 'hash4',
        embedding: [0.7, 0.8],
        model: 'test-model',
        dimensions: 2,
      });
    });

    it('should list embeddings by class and field', async () => {
      const results = await EmbeddingStorage.listForClass(
        db,
        'Article',
        'content',
        'test-model',
      );

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.object_id).sort()).toEqual([
        'article-1',
        'article-2',
      ]);
    });

    it('should filter by model', async () => {
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-1',
        fieldName: 'content',
        contentHash: 'hash-other',
        embedding: [0.9, 1.0],
        model: 'other-model',
        dimensions: 2,
      });

      const results = await EmbeddingStorage.listForClass(
        db,
        'Article',
        'content',
        'test-model',
      );

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.model === 'test-model')).toBe(true);
    });

    it('should return empty array for no matches', async () => {
      const results = await EmbeddingStorage.listForClass(
        db,
        'NonExistent',
        'field',
        'model',
      );

      expect(results).toEqual([]);
    });
  });

  describe('deleteForObject', () => {
    it('should delete all embeddings for an object', async () => {
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'title',
        contentHash: 'hash1',
        embedding: [0.1],
        model: 'test-model',
        dimensions: 1,
      });

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'body',
        contentHash: 'hash2',
        embedding: [0.2],
        model: 'test-model',
        dimensions: 1,
      });

      await EmbeddingStorage.deleteForObject(db, 'Article', 'article-123');

      const results = await EmbeddingStorage.getForObject(
        db,
        'Article',
        'article-123',
      );

      expect(results).toHaveLength(0);
    });

    it('should not affect other objects', async () => {
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-1',
        fieldName: 'content',
        contentHash: 'hash1',
        embedding: [0.1],
        model: 'test-model',
        dimensions: 1,
      });

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-2',
        fieldName: 'content',
        contentHash: 'hash2',
        embedding: [0.2],
        model: 'test-model',
        dimensions: 1,
      });

      await EmbeddingStorage.deleteForObject(db, 'Article', 'article-1');

      const article2 = await EmbeddingStorage.get(
        db,
        'Article',
        'article-2',
        'content',
        'test-model',
      );

      expect(article2).not.toBeNull();
    });
  });

  describe('delete (specific)', () => {
    it('should delete embedding for specific field and model', async () => {
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'title',
        contentHash: 'hash1',
        embedding: [0.1],
        model: 'test-model',
        dimensions: 1,
      });

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-123',
        fieldName: 'body',
        contentHash: 'hash2',
        embedding: [0.2],
        model: 'test-model',
        dimensions: 1,
      });

      await EmbeddingStorage.delete(
        db,
        'Article',
        'article-123',
        'title',
        'test-model',
      );

      const title = await EmbeddingStorage.get(
        db,
        'Article',
        'article-123',
        'title',
        'test-model',
      );
      const body = await EmbeddingStorage.get(
        db,
        'Article',
        'article-123',
        'body',
        'test-model',
      );

      expect(title).toBeNull();
      expect(body).not.toBeNull();
    });
  });

  describe('tableExists', () => {
    it('should return true when table exists', async () => {
      const exists = await EmbeddingStorage.tableExists(db);
      expect(exists).toBe(true);
    });

    it('should return false when table does not exist', async () => {
      // Create a fresh database without system schema
      const freshDb = await getDatabase({ type: 'sqlite', url: ':memory:' });
      const exists = await EmbeddingStorage.tableExists(freshDb);
      expect(exists).toBe(false);
    });
  });

  describe('getObjectIdsWithEmbeddings', () => {
    it('should return object IDs with embeddings for a field', async () => {
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-1',
        fieldName: 'content',
        contentHash: 'hash1',
        embedding: [0.1],
        model: 'test-model',
        dimensions: 1,
      });

      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-2',
        fieldName: 'content',
        contentHash: 'hash2',
        embedding: [0.2],
        model: 'test-model',
        dimensions: 1,
      });

      const ids = await EmbeddingStorage.getObjectIdsWithEmbeddings(
        db,
        'Article',
        'content',
      );

      expect(ids.sort()).toEqual(['article-1', 'article-2']);
    });
  });

  describe('searchSimilar (in-memory fallback)', () => {
    beforeEach(async () => {
      // Store embeddings: article-1 is most similar to [1,0,0]
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-1',
        fieldName: 'content',
        contentHash: 'h1',
        embedding: [0.9, 0.1, 0.0],
        model: 'test-model',
        dimensions: 3,
      });
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-2',
        fieldName: 'content',
        contentHash: 'h2',
        embedding: [0.1, 0.9, 0.0],
        model: 'test-model',
        dimensions: 3,
      });
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-3',
        fieldName: 'content',
        contentHash: 'h3',
        embedding: [0.0, 0.1, 0.9],
        model: 'test-model',
        dimensions: 3,
      });
    });

    it('should rank results by cosine similarity without vector capability', async () => {
      const results = await EmbeddingStorage.searchSimilar(
        db,
        'Article',
        [1, 0, 0],
        { field: 'content', model: 'test-model', limit: 3 },
      );

      expect(results).toHaveLength(3);
      expect(results[0].objectId).toBe('article-1');
      expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    });

    it('should respect limit option', async () => {
      const results = await EmbeddingStorage.searchSimilar(
        db,
        'Article',
        [1, 0, 0],
        { field: 'content', model: 'test-model', limit: 1 },
      );

      expect(results).toHaveLength(1);
      expect(results[0].objectId).toBe('article-1');
    });

    it('should filter by minSimilarity', async () => {
      const results = await EmbeddingStorage.searchSimilar(
        db,
        'Article',
        [1, 0, 0],
        {
          field: 'content',
          model: 'test-model',
          limit: 10,
          minSimilarity: 0.9,
        },
      );

      // Only article-1 has high similarity to [1,0,0]
      expect(results.length).toBeLessThanOrEqual(1);
      if (results.length > 0) {
        expect(results[0].objectId).toBe('article-1');
      }
    });

    it('should return empty for non-existent class', async () => {
      const results = await EmbeddingStorage.searchSimilar(
        db,
        'NonExistent',
        [1, 0, 0],
        { field: 'content', model: 'test-model' },
      );

      expect(results).toHaveLength(0);
    });
  });

  describe('searchSimilar (with mock vector capability)', () => {
    it('should delegate to vector.search when capability is provided', async () => {
      const mockVector: VectorCapabilities = {
        search: vi.fn().mockResolvedValue([
          { id: 'emb-1', object_id: 'article-1', distance: 0.1 },
          { id: 'emb-2', object_id: 'article-2', distance: 0.5 },
        ]),
        ensureColumn: vi.fn(),
        ensureIndex: vi.fn(),
        upsertVector: vi.fn(),
      };

      const results = await EmbeddingStorage.searchSimilar(
        db,
        'Article',
        [1, 0, 0],
        { field: 'content', model: 'test-model', limit: 5 },
        mockVector,
      );

      expect(mockVector.search).toHaveBeenCalledOnce();
      const searchArgs = (mockVector.search as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(searchArgs[0]).toBe('_smrt_embeddings'); // table
      expect(searchArgs[1]).toBe('embedding_vector'); // column
      expect(searchArgs[2]).toEqual([1, 0, 0]); // query embedding
      const searchOptions = searchArgs[3];
      expect(searchOptions.where).toBe(
        'object_class = $2 AND field_name = $3 AND model = $4',
      );
      expect(searchOptions.params).toEqual([
        'Article',
        'content',
        'test-model',
      ]);
      expect(searchOptions.limit).toBe(5);
      expect(searchOptions.metric).toBe('cosine');

      expect(results).toHaveLength(2);
      // Distance 0.1 → similarity 0.9
      expect(results[0].objectId).toBe('article-1');
      expect(results[0].similarity).toBeCloseTo(0.9);
      // Distance 0.5 → similarity 0.5
      expect(results[1].objectId).toBe('article-2');
      expect(results[1].similarity).toBeCloseTo(0.5);
    });

    it('should fall back to in-memory when vector.search throws', async () => {
      // Store some data for in-memory fallback
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-1',
        fieldName: 'content',
        contentHash: 'h1',
        embedding: [0.9, 0.1, 0.0],
        model: 'test-model',
        dimensions: 3,
      });

      const mockVector: VectorCapabilities = {
        search: vi.fn().mockRejectedValue(new Error('pgvector not installed')),
        ensureColumn: vi.fn(),
        ensureIndex: vi.fn(),
        upsertVector: vi.fn(),
      };

      const results = await EmbeddingStorage.searchSimilar(
        db,
        'Article',
        [1, 0, 0],
        { field: 'content', model: 'test-model' },
        mockVector,
      );

      // Should still return results via in-memory fallback
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].objectId).toBe('article-1');
    });

    it('should convert cosine distance to similarity correctly', async () => {
      const mockVector: VectorCapabilities = {
        search: vi.fn().mockResolvedValue([
          { id: 'e1', object_id: 'obj-identical', distance: 0.0 },
          { id: 'e2', object_id: 'obj-orthogonal', distance: 1.0 },
          { id: 'e3', object_id: 'obj-opposite', distance: 2.0 },
        ]),
        ensureColumn: vi.fn(),
        ensureIndex: vi.fn(),
        upsertVector: vi.fn(),
      };

      const results = await EmbeddingStorage.searchSimilar(
        db,
        'Test',
        [1, 0, 0],
        { limit: 10, minSimilarity: -1 },
        mockVector,
      );

      expect(results).toHaveLength(3);
      // distance 0 → similarity 1
      expect(results[0].similarity).toBeCloseTo(1.0);
      // distance 1 → similarity 0
      expect(results[1].similarity).toBeCloseTo(0.0);
      // distance 2 → similarity -1
      expect(results[2].similarity).toBeCloseTo(-1.0);
    });

    it('should filter by minSimilarity after distance conversion', async () => {
      const mockVector: VectorCapabilities = {
        search: vi.fn().mockResolvedValue([
          { id: 'e1', object_id: 'obj-close', distance: 0.1 },
          { id: 'e2', object_id: 'obj-far', distance: 1.5 },
        ]),
        ensureColumn: vi.fn(),
        ensureIndex: vi.fn(),
        upsertVector: vi.fn(),
      };

      const results = await EmbeddingStorage.searchSimilar(
        db,
        'Test',
        [1, 0, 0],
        { limit: 10, minSimilarity: 0.5 },
        mockVector,
      );

      // Only obj-close (similarity 0.9) passes minSimilarity 0.5
      expect(results).toHaveLength(1);
      expect(results[0].objectId).toBe('obj-close');
    });
  });

  describe('upsert with vector capability', () => {
    it('should call vector.upsertVector when capability is provided', async () => {
      const mockVector: VectorCapabilities = {
        search: vi.fn(),
        ensureColumn: vi.fn(),
        ensureIndex: vi.fn(),
        upsertVector: vi.fn().mockResolvedValue(undefined),
      };

      await EmbeddingStorage.upsert(
        db,
        {
          objectClass: 'Article',
          objectId: 'article-1',
          fieldName: 'content',
          contentHash: 'h1',
          embedding: [0.1, 0.2, 0.3],
          model: 'test-model',
          dimensions: 3,
        },
        mockVector,
      );

      // Should store JSON embedding normally
      const stored = await EmbeddingStorage.get(
        db,
        'Article',
        'article-1',
        'content',
        'test-model',
      );
      expect(stored?.embedding).toEqual([0.1, 0.2, 0.3]);

      // Should also call vector.upsertVector
      expect(mockVector.upsertVector).toHaveBeenCalledWith(
        '_smrt_embeddings',
        {
          object_class: 'Article',
          object_id: 'article-1',
          field_name: 'content',
          model: 'test-model',
        },
        'embedding_vector',
        [0.1, 0.2, 0.3],
      );
    });

    it('should not fail if vector.upsertVector throws', async () => {
      const mockVector: VectorCapabilities = {
        search: vi.fn(),
        ensureColumn: vi.fn(),
        ensureIndex: vi.fn(),
        upsertVector: vi
          .fn()
          .mockRejectedValue(new Error('column does not exist')),
      };

      // Should not throw
      await EmbeddingStorage.upsert(
        db,
        {
          objectClass: 'Article',
          objectId: 'article-1',
          fieldName: 'content',
          contentHash: 'h1',
          embedding: [0.1, 0.2, 0.3],
          model: 'test-model',
          dimensions: 3,
        },
        mockVector,
      );

      // JSON storage should still work
      const stored = await EmbeddingStorage.get(
        db,
        'Article',
        'article-1',
        'content',
        'test-model',
      );
      expect(stored).not.toBeNull();
    });

    it('should work without vector capability (unchanged behavior)', async () => {
      await EmbeddingStorage.upsert(db, {
        objectClass: 'Article',
        objectId: 'article-1',
        fieldName: 'content',
        contentHash: 'h1',
        embedding: [0.1, 0.2, 0.3],
        model: 'test-model',
        dimensions: 3,
      });

      const stored = await EmbeddingStorage.get(
        db,
        'Article',
        'article-1',
        'content',
        'test-model',
      );
      expect(stored?.embedding).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe('ensureVectorStorage', () => {
    it('should call ensureColumn and ensureIndex on the vector capability', async () => {
      const mockVector: VectorCapabilities = {
        search: vi.fn(),
        ensureColumn: vi.fn().mockResolvedValue(undefined),
        ensureIndex: vi.fn().mockResolvedValue(undefined),
        upsertVector: vi.fn(),
      };

      await EmbeddingStorage.ensureVectorStorage(db, 768, mockVector);

      expect(mockVector.ensureColumn).toHaveBeenCalledWith(
        '_smrt_embeddings',
        'embedding_vector',
        768,
      );
      expect(mockVector.ensureIndex).toHaveBeenCalledWith(
        '_smrt_embeddings',
        'embedding_vector',
        { dimensions: 768, metric: 'cosine', type: 'hnsw' },
      );
    });
  });
});
