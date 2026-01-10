/**
 * Tenant Interceptor - Core enforcement mechanism
 *
 * Registers with GlobalInterceptors in smrt-core to automatically:
 * - Filter queries by tenant ID
 * - Validate tenant context on save/delete
 * - Block or audit raw SQL on tenant-scoped classes
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 */

import type { SmrtObject } from '@happyvertical/smrt-core';
import {
  type CollectionInterceptor,
  GlobalInterceptors,
  type InterceptorContext,
  type ListOptions,
  type QueryInterceptResult,
  type QueryOptions,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  TenantContextError,
  TenantIsolationError,
} from './context.js';
import { getTenantScopedConfig, isTenantScopedClass } from './registry.js';

/**
 * Configuration for raw SQL query handling on tenant-scoped classes
 */
export type RawQueryPolicy = 'throw' | 'warn' | 'allow';

/**
 * Options for configuring the tenant interceptor
 */
export interface TenantInterceptorOptions {
  /**
   * Policy for raw SQL queries on tenant-scoped classes
   * - 'throw': Throw error (most secure, default)
   * - 'warn': Log warning but allow (for migration)
   * - 'allow': Silently allow (not recommended for production)
   * @default 'throw'
   */
  rawQueryPolicy?: RawQueryPolicy;

  /**
   * Called when a raw query is attempted on a tenant-scoped class
   * Useful for logging/auditing
   */
  onRawQuery?: (
    className: string,
    sql: string,
    context: InterceptorContext,
  ) => void;

  /**
   * Called when tenant context is missing for a tenant-scoped operation
   */
  onMissingContext?: (
    className: string,
    operation: string,
    context: InterceptorContext,
  ) => void;

  /**
   * Called when an isolation violation is detected
   */
  onIsolationViolation?: (
    className: string,
    expectedTenantId: string,
    actualTenantId: string,
    context: InterceptorContext,
  ) => void;
}

const DEFAULT_OPTIONS: TenantInterceptorOptions = {
  rawQueryPolicy: 'throw',
};

/**
 * Create a tenant interceptor instance
 */
export function createTenantInterceptor(
  options: TenantInterceptorOptions = {},
): CollectionInterceptor {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return {
    name: 'smrt-tenancy',
    priority: 100, // High priority - should run first

    /**
     * Before list: Add tenant filter to queries
     */
    beforeList(
      className: string,
      listOptions: ListOptions,
      context: InterceptorContext,
    ): ListOptions | undefined {
      // Check if this class is tenant-scoped
      if (!isTenantScopedClass(className)) {
        return; // Not tenant-scoped, pass through
      }

      // Check for super admin bypass
      if (isSuperAdminBypass()) {
        return; // Bypass enabled, pass through
      }

      const config = getTenantScopedConfig(className);
      const tenantContext = getCurrentTenant();

      // If no tenant context and mode is 'required', throw
      if (!tenantContext) {
        if (config?.mode === 'required') {
          opts.onMissingContext?.(className, 'list', context);
          throw new TenantContextError(
            `Tenant context required for listing ${className}. ` +
              `Use withTenant() or configure TenantContext middleware.`,
          );
        }
        return; // Mode is 'optional', allow without filtering
      }

      // Add tenant filter to where clause
      const tenantField = config?.field || 'tenantId';
      const where = listOptions.where || {};

      // Check if tenant filter is already present
      if (tenantField in where) {
        // Validate it matches context
        const existingFilter = where[tenantField];
        if (existingFilter !== tenantContext.tenantId) {
          opts.onIsolationViolation?.(
            className,
            tenantContext.tenantId,
            String(existingFilter),
            context,
          );
          throw new TenantIsolationError(
            `Tenant isolation violation in ${className} query: ` +
              `context tenant is '${tenantContext.tenantId}' but query filters by '${existingFilter}'`,
            {
              tenantId: tenantContext.tenantId,
              attemptedTenantId: String(existingFilter),
            },
          );
        }
        return; // Filter already correct
      }

      // Inject tenant filter
      return {
        ...listOptions,
        where: {
          ...where,
          [tenantField]: tenantContext.tenantId,
        },
      };
    },

    /**
     * Before get: Add tenant filter to single record fetches
     */
    beforeGet(
      className: string,
      filter: string | Record<string, unknown>,
      context: InterceptorContext,
    ): string | Record<string, unknown> | undefined {
      if (!isTenantScopedClass(className)) {
        return;
      }

      if (isSuperAdminBypass()) {
        return;
      }

      const config = getTenantScopedConfig(className);
      const tenantContext = getCurrentTenant();

      if (!tenantContext) {
        if (config?.mode === 'required') {
          opts.onMissingContext?.(className, 'get', context);
          throw new TenantContextError(
            `Tenant context required for getting ${className}. ` +
              `Use withTenant() or configure TenantContext middleware.`,
          );
        }
        return;
      }

      const tenantField = config?.field || 'tenantId';

      // If filter is a string (ID), convert to object filter with tenant
      if (typeof filter === 'string') {
        return {
          id: filter,
          [tenantField]: tenantContext.tenantId,
        };
      }

      // Add tenant filter to object
      if (!(tenantField in filter)) {
        return {
          ...filter,
          [tenantField]: tenantContext.tenantId,
        };
      }

      // Validate existing filter
      if (filter[tenantField] !== tenantContext.tenantId) {
        opts.onIsolationViolation?.(
          className,
          tenantContext.tenantId,
          String(filter[tenantField]),
          context,
        );
        throw new TenantIsolationError(
          `Tenant isolation violation in ${className} get: ` +
            `context tenant is '${tenantContext.tenantId}' but query filters by '${filter[tenantField]}'`,
          {
            tenantId: tenantContext.tenantId,
            attemptedTenantId: String(filter[tenantField]),
          },
        );
      }

      return;
    },

    /**
     * Before query: Handle raw SQL on tenant-scoped classes
     */
    beforeQuery(
      className: string,
      queryOptions: QueryOptions,
      context: InterceptorContext,
    ): QueryInterceptResult | undefined {
      if (!isTenantScopedClass(className)) {
        return;
      }

      // Check for explicit bypass flag
      if (queryOptions.allowRawOnTenantScoped) {
        opts.onRawQuery?.(className, queryOptions.sql, context);
        return; // Explicitly allowed
      }

      if (isSuperAdminBypass()) {
        opts.onRawQuery?.(className, queryOptions.sql, context);
        return;
      }

      // Handle based on policy
      const message =
        `Raw SQL query attempted on tenant-scoped class ${className}. ` +
        `Use list()/get() for automatic tenant filtering, or call ` +
        `query() with { allowRawOnTenantScoped: true } if you're handling ` +
        `tenant filtering manually.`;

      opts.onRawQuery?.(className, queryOptions.sql, context);

      switch (opts.rawQueryPolicy) {
        case 'throw':
          throw new TenantIsolationError(message);

        case 'warn':
          console.warn(`[smrt-tenancy] WARNING: ${message}`);
          return;
        default:
          return;
      }
    },

    /**
     * Before save: Validate tenant ID is set and matches context
     */
    beforeSave(instance: SmrtObject, context: InterceptorContext): void {
      // Use context.className which is always correct
      // (instance.constructor.name may not match for proxies or plain objects in tests)
      const className = context.className;

      if (!isTenantScopedClass(className)) {
        return;
      }

      if (isSuperAdminBypass()) {
        return;
      }

      const config = getTenantScopedConfig(className);
      const tenantField = config?.field || 'tenantId';
      const instanceTenantId = (instance as any)[tenantField];

      const tenantContext = getCurrentTenant();

      // Check if tenant context is required
      if (!tenantContext) {
        if (config?.mode === 'required') {
          opts.onMissingContext?.(className, 'save', context);
          throw new TenantContextError(
            `Tenant context required for saving ${className}. ` +
              `Use withTenant() or configure TenantContext middleware.`,
          );
        }
        return; // Mode is 'optional'
      }

      // Auto-populate tenant ID if not set
      if (!instanceTenantId && config?.autoPopulate !== false) {
        (instance as any)[tenantField] = tenantContext.tenantId;
        return;
      }

      // Validate tenant ID matches context
      if (instanceTenantId && instanceTenantId !== tenantContext.tenantId) {
        opts.onIsolationViolation?.(
          className,
          tenantContext.tenantId,
          instanceTenantId,
          context,
        );
        throw new TenantIsolationError(
          `Tenant isolation violation: cannot save ${className} with ` +
            `tenantId '${instanceTenantId}' in context of tenant '${tenantContext.tenantId}'`,
          {
            tenantId: tenantContext.tenantId,
            attemptedTenantId: instanceTenantId,
          },
        );
      }
    },

    /**
     * Before delete: Validate instance belongs to current tenant
     */
    beforeDelete(instance: SmrtObject, context: InterceptorContext): void {
      // Use context.className which is always correct
      const className = context.className;

      if (!isTenantScopedClass(className)) {
        return;
      }

      if (isSuperAdminBypass()) {
        return;
      }

      const config = getTenantScopedConfig(className);
      const tenantField = config?.field || 'tenantId';
      const instanceTenantId = (instance as any)[tenantField];

      const tenantContext = getCurrentTenant();

      if (!tenantContext) {
        if (config?.mode === 'required') {
          opts.onMissingContext?.(className, 'delete', context);
          throw new TenantContextError(
            `Tenant context required for deleting ${className}. ` +
              `Use withTenant() or configure TenantContext middleware.`,
          );
        }
        return;
      }

      // Validate tenant ID matches
      if (instanceTenantId && instanceTenantId !== tenantContext.tenantId) {
        opts.onIsolationViolation?.(
          className,
          tenantContext.tenantId,
          instanceTenantId,
          context,
        );
        throw new TenantIsolationError(
          `Tenant isolation violation: cannot delete ${className} with ` +
            `tenantId '${instanceTenantId}' in context of tenant '${tenantContext.tenantId}'`,
          {
            tenantId: tenantContext.tenantId,
            attemptedTenantId: instanceTenantId,
          },
        );
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration Functions
// ─────────────────────────────────────────────────────────────────────────────

let isEnabled = false;
let registeredInterceptor: CollectionInterceptor | null = null;

/**
 * Enable tenant enforcement globally
 *
 * Call this once at application startup to enable automatic tenant isolation.
 *
 * @param options - Configuration options
 *
 * @example
 * ```typescript
 * // In your app initialization
 * import { enableTenancy } from '@happyvertical/smrt-tenancy';
 *
 * enableTenancy({
 *   rawQueryPolicy: 'throw',
 *   onMissingContext: (className, operation) => {
 *     console.error(`Missing tenant context for ${operation} on ${className}`);
 *   }
 * });
 * ```
 */
export function enableTenancy(options: TenantInterceptorOptions = {}): void {
  if (isEnabled) {
    console.warn(
      '[smrt-tenancy] Tenancy is already enabled. Call disableTenancy() first to reconfigure.',
    );
    return;
  }

  registeredInterceptor = createTenantInterceptor(options);
  GlobalInterceptors.register(registeredInterceptor);
  isEnabled = true;
}

/**
 * Disable tenant enforcement
 *
 * Use this for testing or when you need to temporarily disable tenancy.
 */
export function disableTenancy(): void {
  if (!isEnabled || !registeredInterceptor) {
    return;
  }

  GlobalInterceptors.unregister(registeredInterceptor);
  registeredInterceptor = null;
  isEnabled = false;
}

/**
 * Check if tenant enforcement is enabled
 */
export function isTenancyEnabled(): boolean {
  return isEnabled;
}
