/**
 * DispatchCollection - Storage operations for dispatch messages
 *
 * CRUD operations for the _smrt_dispatch system table.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { Dispatch, type DispatchData } from '../models/Dispatch.js';
import type { DispatchTenantScope } from '../tenant-resolver.js';
import type {
  DispatchCleanupOptions,
  DispatchCleanupResult,
  DispatchListOptions,
  DispatchRetryOptions,
  DispatchStatus,
} from '../types.js';

/**
 * Build the SQL tenant predicate for the active scope (S5 #1398).
 *
 * Appends a parameterized condition to `conditions` (and the corresponding
 * value to `params`) based on the resolved {@link DispatchTenantScope}:
 *
 *  - tenancy off / no scope → no predicate (pre-tenancy behavior)
 *  - `enforced` + active tenant T → `(tenant_id = ? OR tenant_id IS NULL)`
 *  - `enforced` + no active tenant → `tenant_id IS NULL` (fail-closed global)
 *
 * @param placeholder - Engine-specific positional placeholder (e.g. `$3`) used
 *   when a tenant id value is bound. Ignored for the no-value branches.
 * @returns `true` when a value placeholder was consumed (so the caller can
 *   advance its param index), `false` otherwise.
 */
function pushTenantPredicate(
  conditions: string[],
  params: unknown[],
  scope: DispatchTenantScope | undefined,
  placeholder: string,
): boolean {
  if (!scope?.enforced) {
    return false;
  }
  if (scope.tenantId !== null) {
    conditions.push(`(tenant_id = ${placeholder} OR tenant_id IS NULL)`);
    params.push(scope.tenantId);
    return true;
  }
  conditions.push('tenant_id IS NULL');
  return false;
}

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
         processed_at, processed_by, target_subscriber, correlation_id, tenant_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
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
      row.tenant_id,
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
   * Get a dispatch by ID (unscoped).
   *
   * Internal/system use only — applies no tenant filter. Public reads go
   * through the DispatchBus, which uses {@link getScoped} so a caller cannot
   * fetch another tenant's dispatch by id (S5 #1398).
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
   * Get a dispatch by ID, enforcing the active tenant scope (S5 #1398).
   *
   * Applies the same tenant predicate as {@link list}/{@link findPending}, so a
   * cross-tenant or out-of-scope id lookup returns `null` rather than leaking
   * the row. The scope is derived server-side by the DispatchBus.
   */
  static async getScoped(
    db: DatabaseInterface,
    id: string,
    tenantScope?: DispatchTenantScope,
  ): Promise<Dispatch | null> {
    const conditions: string[] = ['id = $1'];
    const params: unknown[] = [id];

    pushTenantPredicate(conditions, params, tenantScope, '$2');

    const { rows } = await db.query(
      `SELECT * FROM _smrt_dispatch WHERE ${conditions.join(' AND ')} LIMIT 1`,
      ...params,
    );

    if (rows.length === 0) return null;
    return Dispatch.fromRow(rows[0] as unknown as DispatchData);
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

    if (options.correlationId !== undefined) {
      conditions.push(`correlation_id = $${paramIndex++}`);
      params.push(options.correlationId);
    }

    // Tenant isolation (S5 #1398). Scope is derived server-side by the bus;
    // callers cannot widen it. See DispatchListOptions.tenantScope.
    if (
      pushTenantPredicate(
        conditions,
        params,
        options.tenantScope,
        `$${paramIndex}`,
      )
    ) {
      paramIndex++;
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
   * @param tenantScope - Active tenant scope (S5 #1398). Derived server-side by
   *   the bus; restricts results so a subscriber in one tenant cannot see
   *   another tenant's dispatch. See {@link pushTenantPredicate} for the exact
   *   semantics (off → no filter; active tenant → that tenant + global; on but
   *   no tenant → global only).
   */
  static async findPending(
    db: DatabaseInterface,
    signalTypes: string[],
    limit: number = 100,
    subscriber?: string,
    tenantScope?: DispatchTenantScope,
  ): Promise<Dispatch[]> {
    if (signalTypes.length === 0) {
      return [];
    }

    let paramIndex = 1;
    const placeholders = signalTypes.map(() => `$${paramIndex++}`).join(', ');
    const conditions: string[] = [
      "status = 'pending'",
      `type IN (${placeholders})`,
    ];
    const params: unknown[] = [...signalTypes];

    if (subscriber) {
      conditions.push(
        `(target_subscriber IS NULL OR target_subscriber = $${paramIndex++})`,
      );
      params.push(subscriber);
    }

    if (
      pushTenantPredicate(conditions, params, tenantScope, `$${paramIndex}`)
    ) {
      paramIndex++;
    }

    const sql = `SELECT * FROM _smrt_dispatch
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ASC LIMIT $${paramIndex}`;
    params.push(limit);

    const { rows } = await db.query(sql, ...params);

    return rows.map((row: Record<string, unknown>) =>
      Dispatch.fromRow(row as unknown as DispatchData),
    );
  }

  /**
   * Atomically claim a pending dispatch for processing (S5 #1398).
   *
   * Performs a conditional `UPDATE ... WHERE id = ? AND status = 'pending'`
   * (plus the tenant predicate for the active scope) and reports whether the
   * row was claimed by THIS call. Only the caller whose update affected a row
   * may run the handler, which closes the claim TOCTOU window where a `process`
   * filter-then-update could let two workers (or a tenant-scoped and a
   * system-scoped processor) both pick up the same compete/global dispatch.
   *
   * On a successful claim the dispatch's status/attempts/updated_at are
   * advanced in the DB; the in-memory `dispatch` instance is updated to match
   * so the caller can proceed to `update()` it to completed/failed.
   *
   * @returns `true` if this call claimed the dispatch, `false` if another
   *   worker already moved it out of `pending` (or it is not visible in scope).
   */
  static async claim(
    db: DatabaseInterface,
    dispatch: Dispatch,
    tenantScope?: DispatchTenantScope,
  ): Promise<boolean> {
    dispatch.markProcessing();
    const row = dispatch.toRow();

    const conditions: string[] = ['id = $4', "status = 'pending'"];
    const params: unknown[] = [
      row.status,
      row.attempts,
      row.updated_at,
      row.id,
    ];
    let paramIndex = 5;

    if (
      pushTenantPredicate(conditions, params, tenantScope, `$${paramIndex}`)
    ) {
      paramIndex++;
    }

    const { rowCount } = await db.query(
      `UPDATE _smrt_dispatch
         SET status = $1, attempts = $2, updated_at = $3
       WHERE ${conditions.join(' AND ')}`,
      ...params,
    );

    return (rowCount ?? 0) > 0;
  }

  /**
   * Find failed dispatches eligible for retry.
   *
   * @param tenantScope - Active tenant scope (S5 #1398). Derived server-side by
   *   the bus; restricts retryable rows to the active tenant (plus global) so a
   *   tenant's `retry()` cannot reset another tenant's failed dispatches. See
   *   {@link pushTenantPredicate} for the exact semantics.
   */
  static async findRetryable(
    db: DatabaseInterface,
    options: DispatchRetryOptions = {},
    tenantScope?: DispatchTenantScope,
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

    if (
      pushTenantPredicate(conditions, params, tenantScope, `$${paramIndex}`)
    ) {
      paramIndex++;
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
   * Cleanup old dispatches.
   *
   * @param tenantScope - Active tenant scope (S5 #1398). Derived server-side by
   *   the bus; restricts deletions to the active tenant (plus global) so a
   *   tenant's `cleanup()` cannot delete another tenant's dispatches. See
   *   {@link pushTenantPredicate} for the exact semantics.
   */
  static async cleanup(
    db: DatabaseInterface,
    options: DispatchCleanupOptions = {},
    tenantScope?: DispatchTenantScope,
  ): Promise<DispatchCleanupResult> {
    const result: DispatchCleanupResult = {
      completedDeleted: 0,
      failedDeleted: 0,
    };

    if (options.completedOlderThanDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - options.completedOlderThanDays);

      const conditions: string[] = [
        "status = 'completed'",
        'processed_at < $1',
      ];
      const params: unknown[] = [cutoff.toISOString()];
      pushTenantPredicate(conditions, params, tenantScope, '$2');

      const { rowCount } = await db.query(
        `DELETE FROM _smrt_dispatch WHERE ${conditions.join(' AND ')}`,
        ...params,
      );
      result.completedDeleted = rowCount || 0;
    }

    if (options.failedOlderThanDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - options.failedOlderThanDays);

      const conditions: string[] = ["status = 'failed'", 'updated_at < $1'];
      const params: unknown[] = [cutoff.toISOString()];
      pushTenantPredicate(conditions, params, tenantScope, '$2');

      const { rowCount } = await db.query(
        `DELETE FROM _smrt_dispatch WHERE ${conditions.join(' AND ')}`,
        ...params,
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
