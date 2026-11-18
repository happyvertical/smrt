/**
 * The tenant scope of a read that no interceptor will narrow.
 *
 * An `optional`-mode tenant-scoped model read with no active tenant passes
 * the tenancy interceptor unfiltered. Request-facing reads (runtime REST, the
 * emitted SvelteKit routes) therefore add a scope of their own, resolved here
 * at request time from the live registry, so a model whose tenancy is
 * registered at runtime (`registerTenantScopedClass()`) is covered like one
 * declared in its manifest.
 *
 * The scope always names the column that records a row's owner — the field
 * the tenancy configuration names (`tenantScoped: { field }`) and every
 * runtime ownership column — never a literal `tenantId`, which on a model
 * owned through another field is an ordinary column.
 */

import {
  isTenantScopedClassResolved,
  resolveDispatchTenantScope,
} from './dispatch/tenant-resolver.js';
import { ObjectRegistry } from './registry';
import { whereColumnName } from './where-keys';

/**
 * Whether a class is tenant-scoped by any registration form: `@smrt({
 * tenantScoped })`, its manifest, or a runtime `@TenantScoped()` /
 * `registerTenantScopedClass()` registration reported by smrt-tenancy.
 */
function isTenantScopedModel(className: string): boolean {
  return (
    ObjectRegistry.isTenantScoped(className) ||
    !!ObjectRegistry.getConfig(className)?.tenantScoped ||
    isTenantScopedClassResolved(className)
  );
}

/**
 * The where keys that record a row's owner on a tenant-scoped class, one per
 * column: the configured tenancy field, then each runtime ownership column.
 * `['tenantId']` when the class is tenant-scoped but names none; `[]` when
 * it is not tenant-scoped.
 */
function tenantOwnershipKeys(className: string): string[] {
  if (!isTenantScopedModel(className)) return [];
  const byColumn = new Map<string, string>();
  const add = (key: string) => {
    const column = whereColumnName(key);
    if (!byColumn.has(column)) byColumn.set(column, key);
  };
  const configured = ObjectRegistry.getTenantScopedConfig(className)?.field;
  if (configured) add(configured);
  for (const column of ObjectRegistry.getRuntimeOwnershipColumns(className)) {
    add(column);
  }
  if (byColumn.size === 0) add('tenantId');
  return [...byColumn.values()];
}

/**
 * The scope of a read with no active tenant: `{ <ownership key>: null }` for
 * every ownership column, so only rows without an owner are served.
 *
 * `undefined` when the class is not tenant-scoped, tenancy is off, or a
 * tenant is active (the interceptor scopes the read to it). Apply it with
 * `applyWhereScope()` so no caller filter on those columns survives.
 *
 * @param className - Simple or qualified class name
 */
export function resolveAnonymousTenantReadScope(
  className: string,
): Record<string, null> | undefined {
  const keys = tenantOwnershipKeys(className);
  if (keys.length === 0) return undefined;
  const scope = resolveDispatchTenantScope();
  if (!scope.enforced || scope.tenantId !== null) return undefined;
  return Object.fromEntries(keys.map((key) => [key, null] as const));
}

/**
 * The tenant scope handed to a custom read action as part of its options:
 * `{ <ownership key>: <active tenant or null> }` for every ownership column.
 *
 * `undefined` when the class is not tenant-scoped, tenancy is off, or the
 * caller holds a super-admin bypass (`superAdminBypass`, which only
 * smrt-tenancy can tell).
 *
 * @param className - Simple or qualified class name
 */
export function resolveTenantReadOptionsScope(
  className: string,
  options: { superAdminBypass?: boolean } = {},
): Record<string, string | null> | undefined {
  if (options.superAdminBypass) return undefined;
  const keys = tenantOwnershipKeys(className);
  if (keys.length === 0) return undefined;
  const scope = resolveDispatchTenantScope();
  if (!scope.enforced) return undefined;
  return Object.fromEntries(keys.map((key) => [key, scope.tenantId] as const));
}
