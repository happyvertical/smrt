/**
 * DispatchSubscriptionCollection - Storage operations for dispatch subscriptions
 *
 * CRUD operations for the _smrt_dispatch_subscriptions system table.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import {
  DispatchSubscription,
  type DispatchSubscriptionData,
} from '../models/DispatchSubscription.js';

/**
 * Storage operations for subscriptions in _smrt_dispatch_subscriptions table
 */
export class DispatchSubscriptionCollection {
  /**
   * Insert or update a subscription (upsert on signal_type + subscriber)
   */
  static async upsert(
    db: DatabaseInterface,
    subscription: DispatchSubscription,
  ): Promise<void> {
    const row = subscription.toRow();
    await db.upsert(
      '_smrt_dispatch_subscriptions',
      ['signal_type', 'subscriber'],
      {
        id: row.id,
        signal_type: row.signal_type,
        subscriber: row.subscriber,
        handler: row.handler,
        delivery: row.delivery,
        enabled: row.enabled,
        tenant_id: row.tenant_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    );
  }

  /**
   * Get a subscription by ID
   */
  static async get(
    db: DatabaseInterface,
    id: string,
  ): Promise<DispatchSubscription | null> {
    const result = await db.single`
      SELECT * FROM _smrt_dispatch_subscriptions WHERE id = ${id}
    `;

    if (!result) return null;
    return DispatchSubscription.fromRow(result as DispatchSubscriptionData);
  }

  /**
   * Find subscription by signal type and subscriber
   */
  static async find(
    db: DatabaseInterface,
    signalType: string,
    subscriber: string,
  ): Promise<DispatchSubscription | null> {
    const result = await db.single`
      SELECT * FROM _smrt_dispatch_subscriptions
      WHERE signal_type = ${signalType} AND subscriber = ${subscriber}
    `;

    if (!result) return null;
    return DispatchSubscription.fromRow(result as DispatchSubscriptionData);
  }

  /**
   * Get all subscriptions for a subscriber
   */
  static async findBySubscriber(
    db: DatabaseInterface,
    subscriber: string,
    enabledOnly: boolean = true,
  ): Promise<DispatchSubscription[]> {
    let sql = `SELECT * FROM _smrt_dispatch_subscriptions WHERE subscriber = ?`;
    const params: unknown[] = [subscriber];

    if (enabledOnly) {
      sql += ' AND enabled = 1';
    }

    sql += ' ORDER BY signal_type ASC';

    const { rows } = await db.query(sql, ...params);
    return rows.map((row: Record<string, unknown>) =>
      DispatchSubscription.fromRow(row as unknown as DispatchSubscriptionData),
    );
  }

  /**
   * Get all subscriptions that match a signal type
   *
   * Uses SQL-level filtering for exact matches. Wildcard subscriptions
   * (containing '*') are fetched separately and filtered in memory since
   * pattern matching requires application-side regex evaluation.
   */
  static async findMatchingSubscribers(
    db: DatabaseInterface,
    signalType: string,
  ): Promise<DispatchSubscription[]> {
    // SQL-level: exact match subscriptions
    const { rows: exactRows } = await db.query(
      `SELECT * FROM _smrt_dispatch_subscriptions
       WHERE enabled = 1 AND signal_type = $1`,
      signalType,
    );

    const exactSubs = exactRows.map((row: Record<string, unknown>) =>
      DispatchSubscription.fromRow(row as unknown as DispatchSubscriptionData),
    );

    // SQL-level: wildcard subscriptions (contain '%' or '*')
    // Must be filtered in memory for pattern matching
    const { rows: wildcardRows } = await db.query(
      `SELECT * FROM _smrt_dispatch_subscriptions
       WHERE enabled = 1 AND signal_type LIKE '%*%'`,
    );

    const wildcardSubs = wildcardRows
      .map((row: Record<string, unknown>) =>
        DispatchSubscription.fromRow(
          row as unknown as DispatchSubscriptionData,
        ),
      )
      .filter((sub) => sub.matches(signalType));

    return [...exactSubs, ...wildcardSubs];
  }

  /**
   * Find all enabled subscriptions matching a signal type
   *
   * Alias for findMatchingSubscribers — used by emit() to determine
   * fan-out targets.
   */
  static async findBySignalType(
    db: DatabaseInterface,
    signalType: string,
  ): Promise<DispatchSubscription[]> {
    return this.findMatchingSubscribers(db, signalType);
  }

  /**
   * Get all unique signal types that a subscriber is subscribed to
   */
  static async getSignalTypes(
    db: DatabaseInterface,
    subscriber: string,
  ): Promise<string[]> {
    const { rows } = await db.query(
      `SELECT DISTINCT signal_type FROM _smrt_dispatch_subscriptions
       WHERE subscriber = ? AND enabled = 1`,
      subscriber,
    );

    return rows.map(
      (row: Record<string, unknown>) => row.signal_type as string,
    );
  }

  /**
   * List all subscriptions
   */
  static async list(
    db: DatabaseInterface,
    enabledOnly: boolean = false,
  ): Promise<DispatchSubscription[]> {
    let sql = 'SELECT * FROM _smrt_dispatch_subscriptions';
    if (enabledOnly) {
      sql += ' WHERE enabled = 1';
    }
    sql += ' ORDER BY subscriber ASC, signal_type ASC';

    const { rows } = await db.query(sql);
    return rows.map((row: Record<string, unknown>) =>
      DispatchSubscription.fromRow(row as unknown as DispatchSubscriptionData),
    );
  }

  /**
   * Delete a subscription
   */
  static async delete(db: DatabaseInterface, id: string): Promise<void> {
    await db.query(`DELETE FROM _smrt_dispatch_subscriptions WHERE id = ?`, id);
  }

  /**
   * Delete subscription by signal type and subscriber
   */
  static async deleteByKey(
    db: DatabaseInterface,
    signalType: string,
    subscriber: string,
  ): Promise<void> {
    await db.query(
      `DELETE FROM _smrt_dispatch_subscriptions WHERE signal_type = ? AND subscriber = ?`,
      signalType,
      subscriber,
    );
  }

  /**
   * Delete all subscriptions for a subscriber
   */
  static async deleteBySubscriber(
    db: DatabaseInterface,
    subscriber: string,
  ): Promise<void> {
    await db.query(
      `DELETE FROM _smrt_dispatch_subscriptions WHERE subscriber = ?`,
      subscriber,
    );
  }

  /**
   * Enable a subscription
   */
  static async enable(
    db: DatabaseInterface,
    signalType: string,
    subscriber: string,
  ): Promise<void> {
    await db.query(
      `UPDATE _smrt_dispatch_subscriptions SET enabled = 1, updated_at = ? WHERE signal_type = ? AND subscriber = ?`,
      new Date().toISOString(),
      signalType,
      subscriber,
    );
  }

  /**
   * Disable a subscription
   */
  static async disable(
    db: DatabaseInterface,
    signalType: string,
    subscriber: string,
  ): Promise<void> {
    await db.query(
      `UPDATE _smrt_dispatch_subscriptions SET enabled = 0, updated_at = ? WHERE signal_type = ? AND subscriber = ?`,
      new Date().toISOString(),
      signalType,
      subscriber,
    );
  }

  /**
   * Check if subscriptions table exists
   */
  static async tableExists(db: DatabaseInterface): Promise<boolean> {
    try {
      await db.query(`SELECT 1 FROM _smrt_dispatch_subscriptions LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }
}
