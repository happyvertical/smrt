/**
 * Tests for EmbeddingStorage
 */

import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
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
});
