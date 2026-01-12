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
 * Configuration for a tenant-scoped class
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
 * Register a class as tenant-scoped
 *
 * Called by the @TenantScoped decorator or manually.
 *
 * @param className - Name of the class
 * @param config - Tenancy configuration (partial, defaults applied)
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
 * Unregister a class (for testing)
 */
export function unregisterTenantScopedClass(className: string): void {
  tenantScopedClasses.delete(className);
}

/**
 * Check if a class is registered as tenant-scoped
 *
 * Checks both the local registry (@TenantScoped decorator) and
 * the core ObjectRegistry (@smrt({ tenantScoped: true })).
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
 * Get the tenant-scoped configuration for a class
 *
 * Checks both the local registry (@TenantScoped decorator) and
 * the core ObjectRegistry (@smrt({ tenantScoped: true })).
 * Local registry takes precedence if class is registered in both.
 *
 * @returns Config if class is tenant-scoped, undefined otherwise
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
 * Get all registered tenant-scoped classes
 */
export function getAllTenantScopedClasses(): Map<string, TenantScopedConfig> {
  return new Map(tenantScopedClasses);
}

/**
 * Clear all registered classes (for testing)
 */
export function clearTenantScopedRegistry(): void {
  tenantScopedClasses.clear();
}
