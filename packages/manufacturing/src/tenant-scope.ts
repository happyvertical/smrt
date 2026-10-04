/**
 * Reading a structure in its owner's tenant: the owner's rows and global
 * ones, whatever tenant context is active.
 *
 * Under a tenant context the tenancy interceptor narrows every read to that
 * tenant, which hides global rows (a shared material, a global bill, global
 * stock); without a context it narrows nothing, which shows every tenant's
 * rows. Neither is a bill's structure. {@link readOwnAndGlobal} runs list
 * reads through `withTenantGlobalRead` (tenant rows plus global rows, refused
 * for a tenant the active context may not read), and callers keep
 * {@link isOwnOrGlobal} rows, which also covers tenancy being disabled.
 *
 * @packageDocumentation
 */

import {
  getCurrentTenant,
  withTenantGlobalRead,
} from '@happyvertical/smrt-tenancy';

/**
 * Run `read` so its list reads return `owner`'s rows and global ones. For a
 * global owner (`null`), reads see the active tenant's rows and global ones,
 * and callers keep the global rows.
 */
export function readOwnAndGlobal<T>(
  owner: string | null,
  read: () => Promise<T>,
): Promise<T> {
  const scope = owner ?? getCurrentTenant()?.tenantId ?? null;
  return scope ? withTenantGlobalRead(scope, read) : read();
}

/** `true` for a global row or one of `owner`'s rows. */
export function isOwnOrGlobal(
  row: { tenantId?: string | null },
  owner: string | null,
): boolean {
  const rowTenant = row.tenantId ?? null;
  return rowTenant === null || rowTenant === owner;
}
