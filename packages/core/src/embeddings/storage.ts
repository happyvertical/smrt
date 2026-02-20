/**
 * Embedding Storage Operations
 *
 * CRUD operations for the _smrt_embeddings system table.
 * Supports both JSON-based and native vector storage strategies.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface, VectorCapabilities } from '@happyvertical/sql';
import { CosineSimilarity } from './similarity';
import type { StoredEmbedding } from './types';

/** Column name for native vector storage */
const VECTOR_COLUMN = 'embedding_vector';

/**
 * Storage operations for embeddings in _smrt_embeddings table
 */
export class EmbeddingStorage {
  /**
   * Insert or update an embedding
   *
   * @param db - Database interface
   * @param data - Embedding data to store
   * @param vector - Optional vector capabilities for native storage
   */
  static async upsert(
    db: DatabaseInterface,
    data: {
      objectClass: string;
      objectId: string;
      fieldName: string;
      contentHash: string;
      embedding: number[];
      model: string;
      dimensions: number;
      provider?: string;
    },
    vector?: VectorCapabilities,
  ): Promise<void> {
    const now = new Date().toISOString();
    const id = randomUUID();

    await db.upsert(
      '_smrt_embeddings',
      ['object_class', 'object_id', 'field_name', 'model'],
      {
        id,
        object_class: data.objectClass,
        object_id: data.objectId,
        field_name: data.fieldName,
        content_hash: data.contentHash,
        embedding: JSON.stringify(data.embedding),
        model: data.model,
        dimensions: data.dimensions,
        provider: data.provider || null,
        created_at: now,
        updated_at: now,
      },
    );

    // Also store native vector if capability is available
    if (vector) {
      try {
        await vector.upsertVector(
          '_smrt_embeddings',
          {
            object_class: data.objectClass,
            object_id: data.objectId,
            field_name: data.fieldName,
            model: data.model,
          },
          VECTOR_COLUMN,
          data.embedding,
        );
      } catch (error) {
        // Log but don't fail — JSON fallback is always available
        console.warn(
          `[embeddings] Failed to store native vector: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Search for similar embeddings using the best available strategy.
   *
   * When vector capabilities are provided, delegates to database-level
   * vector search. Otherwise falls back to loading all embeddings and
   * computing cosine similarity in memory.
   *
   * @param db - Database interface
   * @param objectClass - Class name to search within
   * @param embedding - Query embedding vector
   * @param options - Search options
   * @param vector - Optional vector capabilities for native search
   * @returns Array of { objectId, similarity } ranked by similarity (highest first)
   */
  static async searchSimilar(
    db: DatabaseInterface,
    objectClass: string,
    embedding: number[],
    options: {
      field?: string;
      model?: string;
      limit?: number;
      minSimilarity?: number;
    } = {},
    vector?: VectorCapabilities,
  ): Promise<Array<{ objectId: string; similarity: number }>> {
    const { field, model, limit = 10, minSimilarity = 0 } = options;

    // Native vector search path
    if (vector) {
      try {
        // Build WHERE clause for class/field/model filtering.
        // Parameter numbering starts at $2 because vector.search() reserves
        // $1 for the query vector embedding in its internal SQL query.
        const conditions: string[] = ['object_class = $2'];
        const params: any[] = [objectClass];

        if (field) {
          conditions.push(`field_name = $${params.length + 2}`);
          params.push(field);
        }

        if (model) {
          conditions.push(`model = $${params.length + 2}`);
          params.push(model);
        }

        const results = await vector.search(
          '_smrt_embeddings',
          VECTOR_COLUMN,
          embedding,
          {
            limit,
            metric: 'cosine',
            where: conditions.join(' AND '),
            params,
          },
        );

        // Convert cosine distance (0=identical, 2=opposite) to similarity (1=identical, -1=opposite)
        return results
          .map((r) => ({
            objectId: r.object_id as string,
            similarity: 1 - r.distance,
          }))
          .filter((r) => r.similarity >= minSimilarity);
      } catch (error) {
        // Fall back to in-memory search on vector search failure
        console.warn(
          `[embeddings] Native vector search failed, falling back to in-memory: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // In-memory fallback: load all embeddings and compute cosine similarity
    const storedEmbeddings = await EmbeddingStorage.listForClass(
      db,
      objectClass,
      field,
      model,
    );

    if (storedEmbeddings.length === 0) {
      return [];
    }

    return storedEmbeddings
      .map((stored) => ({
        objectId: stored.object_id,
        similarity: CosineSimilarity.calculate(embedding, stored.embedding),
      }))
      .filter((item) => item.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Ensure the native vector column and index exist on _smrt_embeddings.
   * Called once during initialization when storage: 'native' is configured.
   *
   * @param db - Database interface
   * @param dimensions - Vector dimensions
   * @param vector - Vector capabilities
   */
  static async ensureVectorStorage(
    _db: DatabaseInterface,
    dimensions: number,
    vector: VectorCapabilities,
  ): Promise<void> {
    await vector.ensureColumn('_smrt_embeddings', VECTOR_COLUMN, dimensions);
    await vector.ensureIndex('_smrt_embeddings', VECTOR_COLUMN, {
      dimensions,
      metric: 'cosine',
      type: 'hnsw',
    });
  }

  /**
   * Get a specific embedding
   *
   * @param db - Database interface
   * @param objectClass - Class name
   * @param objectId - Object ID
   * @param fieldName - Field name
   * @param model - Model used
   * @returns Stored embedding or null
   */
  static async get(
    db: DatabaseInterface,
    objectClass: string,
    objectId: string,
    fieldName: string,
    model: string,
  ): Promise<StoredEmbedding | null> {
    const result = await db.single`
      SELECT * FROM _smrt_embeddings
      WHERE object_class = ${objectClass}
        AND object_id = ${objectId}
        AND field_name = ${fieldName}
        AND model = ${model}
    `;

    if (!result) return null;

    return EmbeddingStorage.parseRow(result);
  }

  /**
   * Get all embeddings for an object
   *
   * @param db - Database interface
   * @param objectClass - Class name
   * @param objectId - Object ID
   * @returns Array of stored embeddings
   */
  static async getForObject(
    db: DatabaseInterface,
    objectClass: string,
    objectId: string,
  ): Promise<StoredEmbedding[]> {
    const { rows } = await db.query(
      `SELECT * FROM _smrt_embeddings WHERE object_class = ? AND object_id = ?`,
      objectClass,
      objectId,
    );

    return rows.map((row: Record<string, unknown>) =>
      EmbeddingStorage.parseRow(row),
    );
  }

  /**
   * List embeddings for a class (optionally filtered by field and model)
   *
   * @param db - Database interface
   * @param objectClass - Class name
   * @param fieldName - Optional field filter
   * @param model - Optional model filter
   * @returns Array of stored embeddings
   */
  static async listForClass(
    db: DatabaseInterface,
    objectClass: string,
    fieldName?: string,
    model?: string,
  ): Promise<StoredEmbedding[]> {
    let sql = `SELECT * FROM _smrt_embeddings WHERE object_class = ?`;
    const params: unknown[] = [objectClass];

    if (fieldName) {
      sql += ` AND field_name = ?`;
      params.push(fieldName);
    }

    if (model) {
      sql += ` AND model = ?`;
      params.push(model);
    }

    const { rows } = await db.query(sql, ...params);

    return rows.map((row: Record<string, unknown>) =>
      EmbeddingStorage.parseRow(row),
    );
  }

  /**
   * Get object IDs that have embeddings for a specific field
   *
   * @param db - Database interface
   * @param objectClass - Class name
   * @param fieldName - Field name
   * @returns Array of object IDs
   */
  static async getObjectIdsWithEmbeddings(
    db: DatabaseInterface,
    objectClass: string,
    fieldName: string,
  ): Promise<string[]> {
    const { rows } = await db.query(
      `SELECT DISTINCT object_id FROM _smrt_embeddings
       WHERE object_class = ? AND field_name = ?`,
      objectClass,
      fieldName,
    );

    return rows.map((row: Record<string, unknown>) => row.object_id as string);
  }

  /**
   * Delete all embeddings for an object
   *
   * @param db - Database interface
   * @param objectClass - Class name
   * @param objectId - Object ID
   */
  static async deleteForObject(
    db: DatabaseInterface,
    objectClass: string,
    objectId: string,
  ): Promise<void> {
    await db.query(
      `DELETE FROM _smrt_embeddings WHERE object_class = ? AND object_id = ?`,
      objectClass,
      objectId,
    );
  }

  /**
   * Delete a specific embedding
   *
   * @param db - Database interface
   * @param objectClass - Class name
   * @param objectId - Object ID
   * @param fieldName - Field name
   * @param model - Model used
   */
  static async delete(
    db: DatabaseInterface,
    objectClass: string,
    objectId: string,
    fieldName: string,
    model: string,
  ): Promise<void> {
    await db.query(
      `DELETE FROM _smrt_embeddings
       WHERE object_class = ? AND object_id = ? AND field_name = ? AND model = ?`,
      objectClass,
      objectId,
      fieldName,
      model,
    );
  }

  /**
   * Check if embedding table exists
   *
   * @param db - Database interface
   * @returns True if table exists
   */
  static async tableExists(db: DatabaseInterface): Promise<boolean> {
    try {
      await db.query(`SELECT 1 FROM _smrt_embeddings LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse a database row into StoredEmbedding
   */
  private static parseRow(row: Record<string, unknown>): StoredEmbedding {
    return {
      id: row.id as string,
      object_class: row.object_class as string,
      object_id: row.object_id as string,
      field_name: row.field_name as string,
      content_hash: row.content_hash as string,
      embedding: JSON.parse(row.embedding as string) as number[],
      model: row.model as string,
      dimensions: row.dimensions as number,
      provider: row.provider as string | undefined,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
