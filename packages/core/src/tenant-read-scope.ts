/**
 * The tenant scope of a request-facing read, resolved at request time.
 *
 * An `optional`-mode tenant-scoped model read with no active tenant passes
 * the tenancy interceptor unfiltered. Request-facing reads (runtime REST, the
 * emitted SvelteKit routes) therefore add a scope of their own, resolved here
 * from the live registry, so a model whose tenancy is registered at runtime
 * (`registerTenantScopedClass()`) is covered like one declared in its
 * manifest: its rows, its custom read actions, its tenant context and its
 * read cache policy.
 *
 * The scope always names the field that records a row's owner — the field
 * the tenancy configuration names (`tenantScoped: { field }`) and every
 * runtime ownership column, under the model's property name — never a literal
 * `tenantId`, which on a model owned through another field is an ordinary
 * column.
 *
 * Core cannot import smrt-tenancy. The request tenant context and the
 * super-admin bypass are reached through hooks smrt-tenancy installs when
 * tenancy is enabled ({@link setRequestTenantContextHooks}).
 */

import {
  isTenantScopedClassResolved,
  resolveDispatchTenantScope,
} from './dispatch/tenant-resolver.js';
import { ObjectRegistry } from './registry';
import { isRequestSuperAdminBypass } from './request-tenant-context';
import { resolveWhereKey, whereColumnName } from './where-keys';

/**
 * Whether a class is tenant-scoped right now, by any registration form:
 * `@smrt({ tenantScoped })`, its manifest, or a runtime `@TenantScoped()` /
 * `registerTenantScopedClass()` registration reported by smrt-tenancy.
 *
 * @param className - Simple or qualified class name
 */
export function isTenantScopedModel(className: string): boolean {
  return (
    ObjectRegistry.isTenantScoped(className) ||
    !!ObjectRegistry.getConfig(className)?.tenantScoped ||
    isTenantScopedClassResolved(className)
  );
}

/**
 * The ownership fields of a tenant-scoped class, as `property → column`, one
 * per column: the configured tenancy field, then each runtime ownership
 * column under the property the class declares for it (the column name only
 * when no declared property maps to it). `tenantId` when the class is
 * tenant-scoped but names none; empty when it is not tenant-scoped.
 */
function tenantOwnershipFields(className: string): Map<string, string> {
  const byColumn = new Map<string, string>();
  if (!isTenantScopedModel(className)) return new Map();
  const add = (property: string) => {
    const column = whereColumnName(property);
    if (!byColumn.has(column)) byColumn.set(column, property);
  };
  const configured = ObjectRegistry.getTenantScopedConfig(className)?.field;
  if (configured) add(configured);
  const runtimeColumns = ObjectRegistry.getRuntimeOwnershipColumns(className);
  if (runtimeColumns.size > 0) {
    // Fields the class declares or inherits (an STI child carries its
    // parent's ownership field), own declarations first.
    const propertyByColumn = new Map<string, string>();
    for (const owner of [
      className,
      ...ObjectRegistry.getInheritanceChain(className),
    ]) {
      for (const name of ObjectRegistry.getFields(owner).keys()) {
        const column = whereColumnName(name);
        if (!propertyByColumn.has(column)) propertyByColumn.set(column, name);
      }
    }
    for (const column of runtimeColumns) {
      add(propertyByColumn.get(column) ?? column);
    }
  }
  if (byColumn.size === 0) add('tenantId');
  return new Map([...byColumn].map(([column, property]) => [property, column]));
}

/**
 * The scope of a read with no active tenant: `{ <ownership field>: null }`
 * for every ownership field, so only rows without an owner are served.
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
  const fields = tenantOwnershipFields(className);
  if (fields.size === 0) return undefined;
  const scope = resolveDispatchTenantScope();
  if (!scope.enforced || scope.tenantId !== null) return undefined;
  return Object.fromEntries([...fields.keys()].map((key) => [key, null]));
}

/**
 * The options a custom read action receives, with the caller's say over
 * ownership taken away.
 *
 * On a tenant-scoped class with tenancy on, every caller entry naming an
 * ownership column — `tenantId` / `tenant_id` in any spelling, and each
 * ownership field under its property or column name — is removed, and the
 * scope is set under each ownership field's property name: the active
 * tenant, or `null` (rows without an owner) when none is active. Returned
 * unchanged when the class is not tenant-scoped, tenancy is off, or an
 * active super-admin bypass applies to this class (the class opts in with
 * `allowSuperAdminBypass`, as the tenancy interceptor requires). Every dispatch site of a custom read
 * action calls this, so an action reading `options.<field>` or
 * `options.tenantId` directly, or forwarding the object as a filter, sees
 * the same values everywhere.
 *
 * @param className - Simple or qualified class name of the model read
 * @param options - The options built from the request (may be undefined)
 */
export function scopeTenantReadOptions<T>(className: string, options: T): T {
  const fields = tenantOwnershipFields(className);
  if (fields.size === 0) return options;
  const scope = resolveDispatchTenantScope();
  if (!scope.enforced || isRequestSuperAdminBypass(className)) return options;
  if (options !== undefined && options !== null && typeof options !== 'object')
    return options;
  if (Array.isArray(options)) return options;
  const ownedColumns = new Set<string>(['tenant_id', ...fields.values()]);
  const scoped: Record<string, unknown> = {
    ...((options ?? {}) as Record<string, unknown>),
  };
  for (const key of Object.keys(scoped)) {
    if (ownedColumns.has(resolveWhereKey(key).column)) delete scoped[key];
  }
  for (const property of fields.keys()) scoped[property] = scope.tenantId;
  return scoped as T;
}
