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
 * Return `true` if the named class is registered as tenant-scoped.
 *
 * Checks two sources in order:
 * 1. The local registry populated by `@TenantScoped()`.
 * 2. The core `ObjectRegistry` populated by `@smrt({ tenantScoped: true })`.
 *
 * @param className - The class name to look up (e.g., `'Document'`).
 * @returns `true` if the class is tenant-scoped by either mechanism.
 *
 * @see getTenantScopedConfig
 * @see registerTenantScopedClass
 */
export function isTenantScopedClass(className: string): boolean {
  // Check local registry first (explicit @TenantScoped decorator)
  if (tenantScopedClasses.has(className)) {
    return true;
  }
  // Check core registry (@smrt({ tenantScoped: true }) pattern - Issue #688)
  return ObjectRegistry.isTenantScoped(className);
}

/**
 * Retrieve the resolved tenancy configuration for a class.
 *
 * Checks two sources in order, with the local registry taking precedence:
 * 1. The local registry populated by `@TenantScoped()`.
 * 2. The core `ObjectRegistry` populated by `@smrt({ tenantScoped: true })`.
 *
 * When found in the core registry, the raw config is normalised into a
 * `TenantScopedConfig` with the same shape as locally registered classes.
 *
 * @param className - The class name to look up.
 * @returns The `TenantScopedConfig` if the class is tenant-scoped, or
 *   `undefined` if it is not registered in either source.
 *
 * @see isTenantScopedClass
 * @see getAllTenantScopedClasses
 */
export function getTenantScopedConfig(
  className: string,
): TenantScopedConfig | undefined {
  // Check local registry first (explicit @TenantScoped decorator)
  const localConfig = tenantScopedClasses.get(className);
  if (localConfig) {
    return localConfig;
  }

  // Check core registry (@smrt({ tenantScoped: true }) pattern - Issue #688)
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
