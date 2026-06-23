/**
 * Tenant-Scoped Class Registry
 *
 * Tracks which classes are tenant-scoped and their configuration.
 * Used by the interceptor to determine how to handle operations.
 *
 * This registry supports two patterns:
 * 1. @TenantScoped() decorator + tenantId field (original pattern)
 * 2. @smrt({ tenantScoped: true }) in smrt-core (Issue #688 pattern)
 *
 * Both patterns are automatically recognized by the interceptor.
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 * @see https://github.com/happyvertical/smrt/issues/688
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

/**
 * Resolved tenancy configuration for a single class, as stored in the registry.
 *
 * Every field has a concrete (non-optional) value — defaults are applied by
 * `registerTenantScopedClass()` when the class is registered via `@TenantScoped()`.
 *
 * @see TenantScopedOptions
 * @see registerTenantScopedClass
 */
export interface TenantScopedConfig {
  /**
   * Tenancy mode for this class
   * - 'required': Must have tenant context for all operations
   * - 'optional': Works with or without tenant context
   * @default 'required'
   */
  mode: 'required' | 'optional';

  /**
   * Field name containing tenant ID
   * @default 'tenantId'
   */
  field: string;

  /**
   * Auto-filter all queries by tenant
   * @default true
   */
  autoFilter: boolean;

  /**
   * Auto-populate tenant ID from context on create
   * @default true
   */
  autoPopulate: boolean;

  /**
   * Allow super admin bypass for this class
   * @default false
   */
  allowSuperAdminBypass: boolean;
}

const DEFAULT_CONFIG: TenantScopedConfig = {
  mode: 'required',
  field: 'tenantId',
  autoFilter: true,
  autoPopulate: true,
  allowSuperAdminBypass: false,
};

// Registry storing tenant-scoped class configurations
const tenantScopedClasses = new Map<string, TenantScopedConfig>();

/**
 * Register a class as tenant-scoped with the given configuration.
 *
 * Called automatically by the `@TenantScoped()` decorator.  You can also call
 * this directly when you cannot use decorators (e.g., third-party classes or
 * plain objects in tests).  Defaults from `DEFAULT_CONFIG` are merged over any
 * omitted options.
 *
 * Calling this again for the same `className` overwrites the previous entry.
 *
 * @param className - The class's `name` property (e.g., `'Document'`).
 * @param config - Partial tenancy configuration; omitted fields receive defaults.
 *
 * @example
 * ```typescript
 * // Manually register a class (e.g., for testing)
 * registerTenantScopedClass('Document', { mode: 'optional' });
 * ```
 *
 * @see TenantScoped
 * @see unregisterTenantScopedClass
 */
export function registerTenantScopedClass(
  className: string,
  config: Partial<TenantScopedConfig> = {},
): void {
  tenantScopedClasses.set(className, {
    ...DEFAULT_CONFIG,
    ...config,
  });
}

/**
 * Remove a class from the tenant-scoped registry.
 *
 * Primarily intended for test teardown — use `clearTenantScopedRegistry()` to
 * reset the entire registry at once.
 *
 * @param className - The class name to remove (e.g., `'Document'`).
 *
 * @see clearTenantScopedRegistry
 * @see registerTenantScopedClass
 */
export function unregisterTenantScopedClass(className: string): void {
  tenantScopedClasses.delete(className);
}

/**
 * Strip a qualified `@scope/pkg:ClassName` name down to its bare class name.
 *
 * `@TenantScoped` registers classes by their simple name (`target.name`), but
 * `ObjectRegistry.getInheritanceChain()` emits **qualified** names where a
 * class has package context. When walking the chain (see
 * `getInheritedTenantScopedConfig`) we therefore probe the local registry with
 * both the qualified entry and its simple suffix so qualified ancestors resolve
 * against the simple-name keys used by `@TenantScoped`.
 */
function toSimpleClassName(className: string): string {
  const idx = className.lastIndexOf(':');
  return idx === -1 ? className : className.slice(idx + 1);
}

/**
 * Resolve a class's OWN tenancy configuration — no STI inheritance.
 *
 * Checks the two registration mechanisms in order, with the local registry
 * taking precedence:
 * 1. The local registry populated by `@TenantScoped()` (keyed by simple name).
 * 2. The core `ObjectRegistry` populated by `@smrt({ tenantScoped: true })`.
 *
 * Both the given name and its simple form are probed against the local registry
 * so a qualified inheritance-chain entry still matches the simple-name keys the
 * decorator writes. Core-registry config is normalised into `TenantScopedConfig`.
 */
function getDirectTenantScopedConfig(
  className: string,
): TenantScopedConfig | undefined {
  // 1. Local registry (explicit @TenantScoped decorator).
  const localConfig =
    tenantScopedClasses.get(className) ??
    tenantScopedClasses.get(toSimpleClassName(className));
  if (localConfig) {
    return localConfig;
  }

  // 2. Core registry (@smrt({ tenantScoped: true }) pattern - Issue #688).
  const coreConfig = ObjectRegistry.getTenantScopedConfig(className);
  if (coreConfig) {
    // Convert core config to TenantScopedConfig format
    return {
      mode: coreConfig.mode,
      field: coreConfig.field,
      autoFilter: coreConfig.autoFilter,
      autoPopulate: coreConfig.autoPopulate,
      allowSuperAdminBypass: coreConfig.allowSuperAdminBypass,
    };
  }

  return undefined;
}

/**
 * Resolve tenancy configuration inherited from an STI/ancestor class.
 *
 * `@TenantScoped` (and `@smrt({ tenantScoped })`) register ONLY the exact class
 * decorated — recognition does NOT propagate to subclasses. Before #1596 this
 * meant an STI child with its own collection (the child is the collection's
 * `_itemClass`) was treated as non-tenant-scoped at runtime: the interceptor
 * skipped tenant filtering on its `list()`/`get()` (cross-tenant reads), skipped
 * tenant population in `beforeSave`, and skipped the raw-SQL policy. Manual
 * re-declaration on every child was the fragile pattern that already bit images
 * (#1407) and messages.
 *
 * We now walk the STI inheritance chain so any descendant of a tenant-scoped
 * base is recognized automatically and inherits the base's config. A subclass
 * of a tenant-scoped class is always itself tenant-scoped — there is no safe
 * reason for it to opt out — so the walk intentionally covers any inheritance
 * (the motivating leak is STI child collections, but this is correct for CTI
 * hierarchies too).
 *
 * Ancestors are walked from nearest-to-self toward the root, returning the
 * first tenant-scoped ancestor's config so a closer ancestor wins. The class's
 * OWN declaration is resolved by the direct lookup in `getTenantScopedConfig`
 * and always takes precedence over anything inherited here.
 */
function getInheritedTenantScopedConfig(
  className: string,
): TenantScopedConfig | undefined {
  // getInheritanceChain returns [root, ..., self] (qualified names where the
  // class has package context). It is cached by core and only reached here when
  // the direct lookup misses, so the per-call cost on non-tenant classes is a
  // cache hit plus this short loop. Returns [] for unregistered classes.
  const chain = ObjectRegistry.getInheritanceChain(className);
  // chain[length - 1] is the class itself (already covered by the direct
  // lookup); walk its ancestors from nearest to root.
  for (let i = chain.length - 2; i >= 0; i--) {
    const ancestorConfig = getDirectTenantScopedConfig(chain[i]);
    if (ancestorConfig) {
      return ancestorConfig;
    }
  }
  return undefined;
}

/**
 * Retrieve the resolved tenancy configuration for a class.
 *
 * Resolution order:
 * 1. The class's OWN declaration — local `@TenantScoped()` registry first, then
 *    the core `@smrt({ tenantScoped: true })` registry.
 * 2. STI inheritance — the nearest tenant-scoped ancestor's config (#1596).
 *
 * A class that declares its own tenancy never reaches step 2, so an explicit
 * child `@TenantScoped` always overrides the inherited base config.
 *
 * @param className - The class name to look up.
 * @returns The `TenantScopedConfig` if the class is tenant-scoped directly or
 *   by inheritance, or `undefined` if it is not.
 *
 * @see isTenantScopedClass
 * @see getAllTenantScopedClasses
 */
export function getTenantScopedConfig(
  className: string,
): TenantScopedConfig | undefined {
  // A class's own @TenantScoped / @smrt({ tenantScoped }) declaration wins.
  const direct = getDirectTenantScopedConfig(className);
  if (direct) {
    return direct;
  }
  // Otherwise inherit recognition from a tenant-scoped STI ancestor (#1596).
  return getInheritedTenantScopedConfig(className);
}

/**
 * Return `true` if the named class is tenant-scoped — directly (via
 * `@TenantScoped()` / `@smrt({ tenantScoped: true })`) or by inheriting from a
 * tenant-scoped STI ancestor (#1596).
 *
 * @param className - The class name to look up (e.g., `'Document'`).
 * @returns `true` if the class is tenant-scoped by any mechanism.
 *
 * @see getTenantScopedConfig
 * @see registerTenantScopedClass
 */
export function isTenantScopedClass(className: string): boolean {
  return getTenantScopedConfig(className) !== undefined;
}

/**
 * Return a snapshot of all classes registered via `@TenantScoped()`.
 *
 * Returns a new `Map` so mutations to the returned value do not affect the
 * internal registry.  Note that classes registered only through the core
 * `ObjectRegistry` (`@smrt({ tenantScoped: true })`) are **not** included in
 * this map.
 *
 * @returns A copy of the local tenant-scoped class registry, keyed by class name.
 *
 * @see isTenantScopedClass
 * @see getTenantScopedConfig
 */
export function getAllTenantScopedClasses(): Map<string, TenantScopedConfig> {
  return new Map(tenantScopedClasses);
}

/**
 * Remove all entries from the local tenant-scoped class registry.
 *
 * Intended for test teardown via `resetTenancy()`.  Does not affect
 * registrations held by the core `ObjectRegistry`.
 *
 * @see resetTenancy
 * @see unregisterTenantScopedClass
 */
export function clearTenantScopedRegistry(): void {
  tenantScopedClasses.clear();
}
