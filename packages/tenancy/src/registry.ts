/**
 * Tenant-Scoped Class Registry
 *
 * Tracks which classes are tenant-scoped and their configuration.
 * Used by the interceptor to determine how to handle operations.
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 */

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
 */
export function isTenantScopedClass(className: string): boolean {
  return tenantScopedClasses.has(className);
}

/**
 * Get the tenant-scoped configuration for a class
 *
 * @returns Config if class is tenant-scoped, undefined otherwise
 */
export function getTenantScopedConfig(
  className: string,
): TenantScopedConfig | undefined {
  return tenantScopedClasses.get(className);
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
