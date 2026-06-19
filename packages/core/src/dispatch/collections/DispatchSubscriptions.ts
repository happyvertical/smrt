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
import type { DispatchTenantScope } from '../tenant-resolver.js';

/**
 * Build a SQL tenant predicate fragment for subscription queries (S5 #1398).
 *
 * Mirrors the dispatch-row scoping, but subscription identity is *per tenant* —
 * a subscription belongs to exactly one scope, so an active tenant sees only its
 * own subscriptions (not also globals), preventing tenant B from finding/
 * mutating tenant A's (or a shared global) subscription row. Semantics:
 *
 *  - tenancy off / no scope → no predicate.
 *  - active tenant T → `tenant_id = ?`.
 *  - tenancy on, no active tenant → `tenant_id IS NULL` (global subs only).
 *
 * Uses `?` positional placeholders (these collection queries bind via the
 * sqlite-style `?` convention used elsewhere in this file).
 *
 * @returns The SQL fragment (without a leading `AND`), or `null` when no
 *   predicate applies. When a value is bound it is pushed onto `params`.
 */
function subscriptionTenantClause(
  scope: DispatchTenantScope | undefined,
  params: unknown[],
): string | null {
  if (!scope?.enforced) {
    return null;
  }
  if (scope.tenantId !== null) {
    params.push(scope.tenantId);
    return 'tenant_id = ?';
  }
  return 'tenant_id IS NULL';
}

/**
 * Storage operations for subscriptions in _smrt_dispatch_subscriptions table
 */
export class DispatchSubscriptionCollection {
  /**
   * Insert or update a subscription.
   *
   * Identity is tenant-scoped (S5 #1398): the conflict key is
   * `(tenant_id, signal_type, subscriber)` so the same (signal_type, subscriber)
   * pair can exist independently per tenant and one tenant cannot overwrite
   * another's subscription. Global (NULL tenant_id) subscriptions are deduped by
   * the NULL-aware upsert path in @happyvertical/sql.
   */
  static async upsert(
    db: DatabaseInterface,
    subscription: DispatchSubscription,
  ): Promise<void> {
    const row = subscription.toRow();
    await db.upsert(
      '_smrt_dispatch_subscriptions',
      ['tenant_id', 'signal_type', 'subscriber'],
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
   * Get all subscriptions for a subscriber, scoped to the active tenant (S5 #1398).
   */
  static async findBySubscriber(
    db: DatabaseInterface,
    subscriber: string,
    enabledOnly: boolean = true,
    tenantScope?: DispatchTenantScope,
  ): Promise<DispatchSubscription[]> {
    let sql = `SELECT * FROM _smrt_dispatch_subscriptions WHERE subscriber = ?`;
    const params: unknown[] = [subscriber];

    if (enabledOnly) {
      sql += ' AND enabled = 1';
    }

    const tenantClause = subscriptionTenantClause(tenantScope, params);
    if (tenantClause) {
      sql += ` AND ${tenantClause}`;
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
    tenantScope?: DispatchTenantScope,
  ): Promise<DispatchSubscription[]> {
    // SQL-level: exact match subscriptions (scoped to the active tenant).
    const exactParams: unknown[] = [signalType];
    let exactSql = `SELECT * FROM _smrt_dispatch_subscriptions
       WHERE enabled = 1 AND signal_type = ?`;
    const exactTenantClause = subscriptionTenantClause(
      tenantScope,
      exactParams,
    );
    if (exactTenantClause) {
      exactSql += ` AND ${exactTenantClause}`;
    }
    const { rows: exactRows } = await db.query(exactSql, ...exactParams);

    const exactSubs = exactRows.map((row: Record<string, unknown>) =>
      DispatchSubscription.fromRow(row as unknown as DispatchSubscriptionData),
    );

    // SQL-level: wildcard subscriptions (contain '*'), scoped to the tenant.
    // Must be filtered in memory for pattern matching.
    const wildcardParams: unknown[] = [];
    let wildcardSql = `SELECT * FROM _smrt_dispatch_subscriptions
       WHERE enabled = 1 AND signal_type LIKE '%*%'`;
    const wildcardTenantClause = subscriptionTenantClause(
      tenantScope,
      wildcardParams,
    );
    if (wildcardTenantClause) {
      wildcardSql += ` AND ${wildcardTenantClause}`;
    }
    const { rows: wildcardRows } = await db.query(
      wildcardSql,
      ...wildcardParams,
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
   * fan-out targets. Scoped to the active tenant (S5 #1398).
   */
  static async findBySignalType(
    db: DatabaseInterface,
    signalType: string,
    tenantScope?: DispatchTenantScope,
  ): Promise<DispatchSubscription[]> {
    return this.findMatchingSubscribers(db, signalType, tenantScope);
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
   * List all subscriptions, scoped to the active tenant (S5 #1398).
   */
  static async list(
    db: DatabaseInterface,
    enabledOnly: boolean = false,
    tenantScope?: DispatchTenantScope,
  ): Promise<DispatchSubscription[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (enabledOnly) {
      conditions.push('enabled = 1');
    }
    const tenantClause = subscriptionTenantClause(tenantScope, params);
    if (tenantClause) {
      conditions.push(tenantClause);
    }

    let sql = 'SELECT * FROM _smrt_dispatch_subscriptions';
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ' ORDER BY subscriber ASC, signal_type ASC';

    const { rows } = await db.query(sql, ...params);
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
   * Delete subscription by signal type and subscriber, scoped to the active
   * tenant (S5 #1398) so tenant B cannot delete tenant A's subscription.
   */
  static async deleteByKey(
    db: DatabaseInterface,
    signalType: string,
    subscriber: string,
    tenantScope?: DispatchTenantScope,
  ): Promise<void> {
    const params: unknown[] = [signalType, subscriber];
    let sql = `DELETE FROM _smrt_dispatch_subscriptions WHERE signal_type = ? AND subscriber = ?`;
    const tenantClause = subscriptionTenantClause(tenantScope, params);
    if (tenantClause) {
      sql += ` AND ${tenantClause}`;
    }
    await db.query(sql, ...params);
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
   * Enable a subscription, scoped to the active tenant (S5 #1398).
   */
  static async enable(
    db: DatabaseInterface,
    signalType: string,
    subscriber: string,
    tenantScope?: DispatchTenantScope,
  ): Promise<void> {
    const params: unknown[] = [
      new Date().toISOString(),
      signalType,
      subscriber,
    ];
    let sql = `UPDATE _smrt_dispatch_subscriptions SET enabled = 1, updated_at = ? WHERE signal_type = ? AND subscriber = ?`;
    const tenantClause = subscriptionTenantClause(tenantScope, params);
    if (tenantClause) {
      sql += ` AND ${tenantClause}`;
    }
    await db.query(sql, ...params);
  }

  /**
   * Disable a subscription, scoped to the active tenant (S5 #1398).
   */
  static async disable(
    db: DatabaseInterface,
    signalType: string,
    subscriber: string,
    tenantScope?: DispatchTenantScope,
  ): Promise<void> {
    const params: unknown[] = [
      new Date().toISOString(),
      signalType,
      subscriber,
    ];
    let sql = `UPDATE _smrt_dispatch_subscriptions SET enabled = 0, updated_at = ? WHERE signal_type = ? AND subscriber = ?`;
    const tenantClause = subscriptionTenantClause(tenantScope, params);
    if (tenantClause) {
      sql += ` AND ${tenantClause}`;
    }
    await db.query(sql, ...params);
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
