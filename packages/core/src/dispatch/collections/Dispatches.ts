/**
 * DispatchCollection - Storage operations for dispatch messages
 *
 * CRUD operations for the _smrt_dispatch system table.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { Dispatch, type DispatchData } from '../models/Dispatch.js';
import type {
  DispatchCleanupOptions,
  DispatchCleanupResult,
  DispatchListOptions,
  DispatchRetryOptions,
  DispatchStatus,
} from '../types.js';

/**
 * Storage operations for dispatches in _smrt_dispatch table
 */
export class DispatchCollection {
  /**
   * Insert a new dispatch
   */
  static async insert(
    db: DatabaseInterface,
    dispatch: Dispatch,
  ): Promise<void> {
    const row = dispatch.toRow();
    await db.query(
      `INSERT INTO _smrt_dispatch
        (id, type, source, source_id, payload, status, attempts, last_error,
         processed_at, processed_by, target_subscriber, correlation_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      row.id,
      row.type,
      row.source,
      row.source_id,
      row.payload,
      row.status,
      row.attempts,
      row.last_error,
      row.processed_at,
      row.processed_by,
      row.target_subscriber,
      row.correlation_id,
      row.metadata,
      row.created_at,
      row.updated_at,
    );
  }

  /**
   * Update an existing dispatch
   */
  static async update(
    db: DatabaseInterface,
    dispatch: Dispatch,
  ): Promise<void> {
    const row = dispatch.toRow();
    await db.query(
      `UPDATE _smrt_dispatch SET
        type = $1, source = $2, source_id = $3, payload = $4, status = $5,
        attempts = $6, last_error = $7, processed_at = $8, processed_by = $9,
        target_subscriber = $10, correlation_id = $11, metadata = $12, updated_at = $13
       WHERE id = $14`,
      row.type,
      row.source,
      row.source_id,
      row.payload,
      row.status,
      row.attempts,
      row.last_error,
      row.processed_at,
      row.processed_by,
      row.target_subscriber,
      row.correlation_id,
      row.metadata,
      row.updated_at,
      row.id,
    );
  }

  /**
   * Get a dispatch by ID
   */
  static async get(
    db: DatabaseInterface,
    id: string,
  ): Promise<Dispatch | null> {
    const result = await db.single`
      SELECT * FROM _smrt_dispatch WHERE id = ${id}
    `;

    if (!result) return null;
    return Dispatch.fromRow(result as DispatchData);
  }

  /**
   * List dispatches with filtering
   */
  static async list(
    db: DatabaseInterface,
    options: DispatchListOptions = {},
  ): Promise<Dispatch[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(options.status);
    }

    if (options.source) {
      conditions.push(`source = $${paramIndex++}`);
      params.push(options.source);
    }

    if (options.type) {
      conditions.push(`type = $${paramIndex++}`);
      params.push(options.type);
    }

    if (options.targetSubscriber) {
      conditions.push(`target_subscriber = $${paramIndex++}`);
      params.push(options.targetSubscriber);
    }

    if (options.correlationId) {
      conditions.push(`correlation_id = $${paramIndex++}`);
      params.push(options.correlationId);
    }

    let sql = 'SELECT * FROM _smrt_dispatch';
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    // Whitelist allowed orderBy values to prevent SQL injection
    const allowedOrderBy = [
      'created_at DESC',
      'created_at ASC',
      'updated_at DESC',
      'updated_at ASC',
      'type',
      'type DESC',
      'type ASC',
      'status',
      'status DESC',
      'status ASC',
      'source',
      'source DESC',
      'source ASC',
    ];
    const safeOrderBy =
      options.orderBy && allowedOrderBy.includes(options.orderBy)
        ? options.orderBy
        : 'created_at DESC';
    sql += ` ORDER BY ${safeOrderBy}`;

    // Use parameterized queries for limit/offset
    if (options.limit !== undefined) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset !== undefined) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const { rows } = await db.query(sql, ...params);
    return rows.map((row: Record<string, unknown>) =>
      Dispatch.fromRow(row as unknown as DispatchData),
    );
  }

  /**
   * Find pending dispatches for a set of signal types
   *
   * @param subscriber - When provided, filters to dispatches with no target
   *   or targeted specifically at this subscriber (for fan-out delivery)
   */
  static async findPending(
    db: DatabaseInterface,
    signalTypes: string[],
    limit: number = 100,
    subscriber?: string,
  ): Promise<Dispatch[]> {
    if (signalTypes.length === 0) {
      return [];
    }

    let paramIndex = 1;
    const placeholders = signalTypes.map(() => `$${paramIndex++}`).join(', ');
    let sql = `SELECT * FROM _smrt_dispatch
       WHERE status = 'pending'
       AND type IN (${placeholders})`;

    const params: unknown[] = [...signalTypes];

    if (subscriber) {
      sql += ` AND (target_subscriber IS NULL OR target_subscriber = $${paramIndex++})`;
      params.push(subscriber);
    }

    sql += ` ORDER BY created_at ASC LIMIT $${paramIndex}`;
    params.push(limit);

    const { rows } = await db.query(sql, ...params);

    return rows.map((row: Record<string, unknown>) =>
      Dispatch.fromRow(row as unknown as DispatchData),
    );
  }

  /**
   * Find failed dispatches eligible for retry
   */
  static async findRetryable(
    db: DatabaseInterface,
    options: DispatchRetryOptions = {},
  ): Promise<Dispatch[]> {
    const conditions: string[] = ["status = 'failed'"];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.maxAttempts) {
      conditions.push(`attempts < $${paramIndex++}`);
      params.push(options.maxAttempts);
    }

    if (options.olderThan) {
      conditions.push(`created_at < $${paramIndex++}`);
      params.push(options.olderThan.toISOString());
    }

    if (options.signalTypes && options.signalTypes.length > 0) {
      const placeholders = options.signalTypes
        .map(() => `$${paramIndex++}`)
        .join(', ');
      conditions.push(`type IN (${placeholders})`);
      params.push(...options.signalTypes);
    }

    const { rows } = await db.query(
      `SELECT * FROM _smrt_dispatch WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
      ...params,
    );

    return rows.map((row: Record<string, unknown>) =>
      Dispatch.fromRow(row as unknown as DispatchData),
    );
  }

  /**
   * Count dispatches by status
   */
  static async countByStatus(
    db: DatabaseInterface,
    status: DispatchStatus,
  ): Promise<number> {
    const result = await db.single`
      SELECT COUNT(*) as count FROM _smrt_dispatch WHERE status = ${status}
    `;
    return (result as { count: number })?.count || 0;
  }

  /**
   * Delete a dispatch
   */
  static async delete(db: DatabaseInterface, id: string): Promise<void> {
    await db.query(`DELETE FROM _smrt_dispatch WHERE id = $1`, id);
  }

  /**
   * Cleanup old dispatches
   */
  static async cleanup(
    db: DatabaseInterface,
    options: DispatchCleanupOptions = {},
  ): Promise<DispatchCleanupResult> {
    const result: DispatchCleanupResult = {
      completedDeleted: 0,
      failedDeleted: 0,
    };

    if (options.completedOlderThanDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - options.completedOlderThanDays);

      const { rowCount } = await db.query(
        `DELETE FROM _smrt_dispatch WHERE status = 'completed' AND processed_at < $1`,
        cutoff.toISOString(),
      );
      result.completedDeleted = rowCount || 0;
    }

    if (options.failedOlderThanDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - options.failedOlderThanDays);

      const { rowCount } = await db.query(
        `DELETE FROM _smrt_dispatch WHERE status = 'failed' AND updated_at < $1`,
        cutoff.toISOString(),
      );
      result.failedDeleted = rowCount || 0;
    }

    return result;
  }

  /**
   * Check if dispatch table exists
   */
  static async tableExists(db: DatabaseInterface): Promise<boolean> {
    try {
      await db.query(`SELECT 1 FROM _smrt_dispatch LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }
}
