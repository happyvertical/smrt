/**
 * Embedding Storage Operations
 *
 * CRUD operations for the _smrt_embeddings system table.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { StoredEmbedding } from './types';

/**
 * Storage operations for embeddings in _smrt_embeddings table
 */
export class EmbeddingStorage {
  /**
   * Insert or update an embedding
   *
   * @param db - Database interface
   * @param data - Embedding data to store
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
