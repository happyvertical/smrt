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
         processed_at, processed_by, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        type = ?, source = ?, source_id = ?, payload = ?, status = ?,
        attempts = ?, last_error = ?, processed_at = ?, processed_by = ?,
        metadata = ?, updated_at = ?
       WHERE id = ?`,
      row.type,
      row.source,
      row.source_id,
      row.payload,
      row.status,
      row.attempts,
      row.last_error,
      row.processed_at,
      row.processed_by,
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

    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }

    if (options.source) {
      conditions.push('source = ?');
      params.push(options.source);
    }

    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
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
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options.offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const { rows } = await db.query(sql, ...params);
    return rows.map((row: Record<string, unknown>) =>
      Dispatch.fromRow(row as unknown as DispatchData),
    );
  }

  /**
   * Find pending dispatches for a set of signal types
   */
  static async findPending(
    db: DatabaseInterface,
    signalTypes: string[],
    limit: number = 100,
  ): Promise<Dispatch[]> {
    if (signalTypes.length === 0) {
      return [];
    }

    const placeholders = signalTypes.map(() => '?').join(', ');
    const { rows } = await db.query(
      `SELECT * FROM _smrt_dispatch
       WHERE status = 'pending'
       AND type IN (${placeholders})
       ORDER BY created_at ASC
       LIMIT ?`,
      ...signalTypes,
      limit,
    );

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

    if (options.maxAttempts) {
      conditions.push('attempts < ?');
      params.push(options.maxAttempts);
    }

    if (options.olderThan) {
      conditions.push('created_at < ?');
      params.push(options.olderThan.toISOString());
    }

    if (options.signalTypes && options.signalTypes.length > 0) {
      const placeholders = options.signalTypes.map(() => '?').join(', ');
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
    await db.query(`DELETE FROM _smrt_dispatch WHERE id = ?`, id);
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
        `DELETE FROM _smrt_dispatch WHERE status = 'completed' AND processed_at < ?`,
        cutoff.toISOString(),
      );
      result.completedDeleted = rowCount || 0;
    }

    if (options.failedOlderThanDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - options.failedOlderThanDays);

      const { rowCount } = await db.query(
        `DELETE FROM _smrt_dispatch WHERE status = 'failed' AND updated_at < ?`,
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
