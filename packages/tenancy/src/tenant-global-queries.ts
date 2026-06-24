/**
 * Shared raw-SQL helpers for tenant-scoped collections' "global" and
 * "tenant + globals" lookups (#1600).
 *
 * Most domain models are `@TenantScoped`. Their collections historically
 * hand-rolled two helpers the OLD way:
 *
 * ```typescript
 * async findGlobal()         { return this.list({ where: { tenantId: null } }); }
 * async findWithGlobals(tid) { return this.query(
 *   `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`, [tid]); }
 * ```
 *
 * Under an ACTIVE tenant context with tenancy enabled (default
 * `rawQueryPolicy: 'throw'`) BOTH break:
 *  - `findGlobal()` routes an explicit `tenant_id IS NULL` filter through
 *    `list()`, which the interceptor flags as an isolation violation → throws.
 *  - `findWithGlobals()` issues unflagged raw SQL on a tenant-scoped class,
 *    which `beforeQuery` blocks → throws.
 *  - `findWithGlobals()` also trusts the caller-supplied `tenantId`, so once the
 *    raw bypass is added a caller under tenant-A could read tenant-B by passing
 *    B's id.
 *
 * These helpers run raw with `{ allowRawOnTenantScoped: true }` (carrying the
 * tenant predicate themselves), and `queryWithGlobals` re-implements the
 * isolation guard the bypass disables (`assertTenantReadAllowed`): a caller
 * under tenant-A must not read tenant-B's rows by passing tenant-B's id. A
 * system / super-admin-bypass context keeps the deliberate cross-tenant
 * capability for admin paths.
 *
 * STI scoping is derived automatically from the collection's item class via
 * `collection.getStiChildMetaType()` (smrt-core), which mirrors the
 * `_meta_type` scoping `list()` applies: STI **child** collections scope the
 * shared table to their own subtype, while STI **base** and CTI collections do
 * not (a base legitimately spans subtypes; CTI tables have no `_meta_type`).
 * Callers never hand-classify their collection. Promoted from
 * `@happyvertical/smrt-messages` (#1596) so every package shares one
 * implementation.
 */

import type { SmrtCollection, SmrtObject } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
} from './context.js';

/**
 * Fail closed when an active tenant context requests a different tenant's rows.
 *
 * @param tenantId - The tenant id the caller asked for.
 * @param label - `Class.method` identifier for the error message.
 * @throws {TenantIsolationError} when a non-bypass tenant context is active and
 *   does not match `tenantId`.
 */
export function assertTenantReadAllowed(tenantId: string, label: string): void {
  const tenantContext = getCurrentTenant();
  if (
    tenantContext &&
    !isSuperAdminBypass() &&
    tenantContext.tenantId !== tenantId
  ) {
    throw new TenantIsolationError(
      `Tenant isolation violation in ${label}: context tenant is ` +
        `'${tenantContext.tenantId}' but query requested '${tenantId}'`,
      { tenantId: tenantContext.tenantId, attemptedTenantId: tenantId },
    );
  }
}

/**
 * Return all global (tenant-less) rows for a tenant-scoped collection.
 *
 * STI child collections are auto-scoped to their own `_meta_type` (via
 * `collection.getStiChildMetaType()`) so the shared table never returns sibling
 * subtypes; STI base / CTI collections are not scoped.
 *
 * @param collection - The tenant-scoped collection to query.
 */
export async function queryGlobal<T, M extends SmrtObject = SmrtObject>(
  collection: SmrtCollection<M>,
): Promise<T[]> {
  const metaType = collection.getStiChildMetaType();
  const where = metaType
    ? 'WHERE _meta_type = ? AND tenant_id IS NULL'
    : 'WHERE tenant_id IS NULL';
  const params = metaType ? [metaType] : [];
  return (await collection.query(
    `SELECT * FROM ${collection.tableName} ${where}`,
    params,
    { allowRawOnTenantScoped: true },
  )) as unknown as T[];
}

/**
 * Return a tenant's rows plus all global rows for a tenant-scoped collection.
 *
 * Fails closed (`assertTenantReadAllowed`) before issuing the bypassed query.
 * STI child collections are auto-scoped to their own `_meta_type` (via
 * `collection.getStiChildMetaType()`); STI base / CTI collections are not.
 *
 * @param collection - The tenant-scoped collection to query.
 * @param tenantId - The tenant id to include alongside globals.
 * @param label - `Class.method` identifier for the isolation error message.
 */
export async function queryWithGlobals<T, M extends SmrtObject = SmrtObject>(
  collection: SmrtCollection<M>,
  tenantId: string,
  label: string,
): Promise<T[]> {
  assertTenantReadAllowed(tenantId, label);
  const metaType = collection.getStiChildMetaType();
  const where = metaType
    ? 'WHERE _meta_type = ? AND (tenant_id = ? OR tenant_id IS NULL)'
    : 'WHERE tenant_id = ? OR tenant_id IS NULL';
  const params = metaType ? [metaType, tenantId] : [tenantId];
  return (await collection.query(
    `SELECT * FROM ${collection.tableName} ${where}`,
    params,
    { allowRawOnTenantScoped: true },
  )) as unknown as T[];
}
