/**
 * Raw-SQL helpers for the messages collections' tenant/global lookups (#1596).
 *
 * The messages models are tenant-scoped: the STI bases (Message / Account /
 * Attachment) and EmailFolder carry `@TenantScoped`, and the STI children
 * (Email / EmailAccount) plus the CTI EmailAttachment now inherit that
 * recognition automatically through `@happyvertical/smrt-tenancy` (#1596).
 *
 * Under an active tenant context the interceptor rejects BOTH an explicit
 * `tenant_id IS NULL` filter routed through `list({ where: { tenantId: null } })`
 * (flagged as an isolation violation) AND unflagged raw SQL on a tenant-scoped
 * class. So the "global" and "tenant + globals" helpers must run raw with
 * `{ allowRawOnTenantScoped: true }` and carry the tenant predicate themselves.
 *
 * The bypass disables the interceptor's isolation guard, so `queryWithGlobals`
 * re-implements it (`assertTenantReadAllowed`): a caller under tenant-A must not
 * read tenant-B's rows by passing tenant-B's id (e.g. straight from untrusted
 * params). A system / super-admin-bypass context keeps the deliberate
 * cross-tenant capability for admin paths.
 *
 * STI **child** collections (`EmailCollection`, `EmailAccountCollection`) pass
 * their qualified `_meta_type` so the shared table never returns sibling
 * subtypes; STI **base** collections (`MessageCollection`, `AccountCollection`)
 * and CTI collections (`AttachmentCollection`, `EmailAttachmentCollection`,
 * `EmailFolderCollection`) pass none. Mirrors the images precedent
 * (`packages/images/src/images.ts`, #1407/#1400).
 */

import type { SmrtCollection } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';

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
 * @param collection - The tenant-scoped collection to query.
 * @param metaType - Qualified STI `_meta_type` to scope to (STI child
 *   collections); omit for STI base / CTI collections.
 */
export async function queryGlobal<T>(
  collection: SmrtCollection<any>,
  metaType?: string,
): Promise<T[]> {
  const where = metaType
    ? 'WHERE _meta_type = ? AND tenant_id IS NULL'
    : 'WHERE tenant_id IS NULL';
  const params = metaType ? [metaType] : [];
  return (await collection.query(
    `SELECT * FROM ${collection.tableName} ${where}`,
    params,
    { allowRawOnTenantScoped: true },
  )) as T[];
}

/**
 * Return a tenant's rows plus all global rows for a tenant-scoped collection.
 *
 * Fails closed (`assertTenantReadAllowed`) before issuing the bypassed query.
 *
 * @param collection - The tenant-scoped collection to query.
 * @param tenantId - The tenant id to include alongside globals.
 * @param label - `Class.method` identifier for the isolation error message.
 * @param metaType - Qualified STI `_meta_type` to scope to (STI child
 *   collections); omit for STI base / CTI collections.
 */
export async function queryWithGlobals<T>(
  collection: SmrtCollection<any>,
  tenantId: string,
  label: string,
  metaType?: string,
): Promise<T[]> {
  assertTenantReadAllowed(tenantId, label);
  const where = metaType
    ? 'WHERE _meta_type = ? AND (tenant_id = ? OR tenant_id IS NULL)'
    : 'WHERE tenant_id = ? OR tenant_id IS NULL';
  const params = metaType ? [metaType, tenantId] : [tenantId];
  return (await collection.query(
    `SELECT * FROM ${collection.tableName} ${where}`,
    params,
    { allowRawOnTenantScoped: true },
  )) as T[];
}
