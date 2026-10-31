/**
 * Tenant-local replay keys for commission evidence and settlement (#3305 D1).
 *
 * `earning_events.dedupe_key`, `commissions.dedupe_key` and
 * `commission_payouts.idempotency_key` are unique per tenant
 * (`(tenant_id, key)`), so every replay lookup and raw guard resolves ONE
 * owner: an explicit tenant, else the active tenant context (the owner the
 * tenancy interceptor gives a new row), else none (global rows only).
 * Background calculation and settlement run without a context, so services
 * pass the owning event's or earner's tenant explicitly. An administrative
 * system context carries no tenant and must name the intended one.
 *
 * @packageDocumentation
 */

import type { SmrtCollection, SmrtObject } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The owner a replay key resolves in. An active tenant context may only name
 * itself; the commission models do not opt into super-admin bypass (#2973),
 * so the bypass flag does not widen this.
 */
export function resolveReplayOwner(
  tenantId: string | null | undefined,
  label: string,
): string | null {
  const context = getCurrentTenant()?.tenantId;
  const owner = tenantId || context || null;
  if (owner && context && !same(owner, context)) {
    throw new TenantIsolationError(
      `Tenant isolation violation in ${label}: context tenant is '${context}' but the replay key belongs to '${owner}'`,
      { tenantId: context, attemptedTenantId: owner },
    );
  }
  return owner;
}

/**
 * The row filed under `value` in `column` by `owner` (null: a global row),
 * never another tenant's. Raw because a context-less background caller must
 * still be tenant-filtered; the predicate is explicit.
 */
export async function findByReplayKey<T extends SmrtObject>(
  collection: SmrtCollection<T>,
  column: 'dedupe_key' | 'idempotency_key',
  value: string,
  owner: string | null,
): Promise<T | null> {
  const rows = (await collection.query(
    owner
      ? `SELECT * FROM ${collection.tableName} WHERE ${column} = ? AND tenant_id = ? ORDER BY created_at, id`
      : `SELECT * FROM ${collection.tableName} WHERE ${column} = ? AND tenant_id IS NULL ORDER BY created_at, id`,
    owner ? [value, owner] : [value],
    { allowRawOnTenantScoped: true },
  )) as T[];
  return (
    rows.find((row) => {
      const tenant = (row as unknown as { tenantId?: string | null }).tenantId;
      return owner ? !!tenant && same(String(tenant), owner) : !tenant;
    }) ?? null
  );
}

/**
 * Fail closed when a tenant context writes a row it does not own. Run
 * before any raw key lookup so a guard never reveals another tenant's keys.
 */
export function assertWritableInContext(
  rowTenantId: string | null | undefined,
  label: string,
): void {
  const context = getCurrentTenant()?.tenantId;
  if (context && rowTenantId && !same(rowTenantId, context)) {
    throw new TenantIsolationError(
      `Tenant isolation violation in ${label}: context tenant '${context}' cannot write a row of tenant '${rowTenantId}'`,
      { tenantId: context, attemptedTenantId: rowTenantId },
    );
  }
}

/** A row's owner before the interceptor fills it in: its tenant, else the context's. */
export function rowOwner(
  rowTenantId: string | null | undefined,
): string | null {
  return rowTenantId || getCurrentTenant()?.tenantId || null;
}
