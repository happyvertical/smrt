import type { SmrtCollection, SmrtObject } from '@happyvertical/smrt-core';
import {
  assertTenantReadAllowed,
  getCurrentTenant,
} from '@happyvertical/smrt-tenancy';

/**
 * The tenant a keyed lookup resolves in: an explicit `tenantId` when the
 * caller passes one, else the active tenant context, else none (global rows
 * only). A system context carries no tenant, so an administrative caller
 * selects a tenant explicitly rather than reading every tenant's rows.
 */
export function resolveLookupTenantId(
  tenantId: string | null | undefined,
): string | null {
  if (typeof tenantId === 'string' && tenantId) {
    return tenantId;
  }
  if (tenantId === null) {
    return null;
  }
  return getCurrentTenant()?.tenantId ?? null;
}

/**
 * Load the row whose natural key is `(tenant_id, <column>)` (#3305 M1).
 *
 * Keys are unique per tenant, so the same key may exist once per tenant and
 * once as a global (NULL-tenant) row. With a tenant this returns that tenant's
 * row, else — when `globalFallback` is set — the global row; never another
 * tenant's. Without a tenant only a global row is returned. An active tenant
 * context cannot read another tenant's rows by passing its id.
 */
export async function getByTenantKey<T extends SmrtObject>(
  collection: SmrtCollection<T>,
  column: string,
  value: string,
  options: {
    tenantId?: string | null;
    globalFallback: boolean;
    label: string;
  },
): Promise<T | null> {
  const tenantId = resolveLookupTenantId(options.tenantId);
  if (tenantId) {
    assertTenantReadAllowed(tenantId, options.label);
  }
  const sql = tenantId
    ? options.globalFallback
      ? `SELECT * FROM ${collection.tableName} WHERE ${column} = ? AND (tenant_id = ? OR tenant_id IS NULL)`
      : `SELECT * FROM ${collection.tableName} WHERE ${column} = ? AND tenant_id = ?`
    : `SELECT * FROM ${collection.tableName} WHERE ${column} = ? AND tenant_id IS NULL`;
  const rows = (await collection.query(
    // Deterministic winner if engines without NULL-equal unique indexes
    // ever let duplicate global rows race in.
    `${sql} ORDER BY created_at, id`,
    tenantId ? [value, tenantId] : [value],
    { allowRawOnTenantScoped: true },
  )) as T[];
  const rowTenant = (row: T) => {
    const value = (row as unknown as { tenantId?: string | null }).tenantId;
    return value ? String(value).toLowerCase() : null;
  };
  const wanted = tenantId?.toLowerCase() ?? null;
  return (
    (wanted ? rows.find((row) => rowTenant(row) === wanted) : undefined) ??
    rows.find((row) => rowTenant(row) === null) ??
    null
  );
}
