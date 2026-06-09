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

import { createLogger } from '@happyvertical/logger';
import type { SmrtObject } from '@happyvertical/smrt-core';
import {
  type CollectionInterceptor,
  type DispatchBus,
  GlobalInterceptors,
  type InterceptorContext,
  type ListOptions,
  type QueryInterceptResult,
  type QueryOptions,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  isSystemContext,
  TenantContextError,
  TenantIsolationError,
} from './context.js';
import { getTenantScopedConfig, isTenantScopedClass } from './registry.js';

const logger = createLogger({ level: 'info' });

/**
 * Policy controlling what happens when raw SQL is executed against a
 * tenant-scoped class without an explicit bypass.
 *
 * - `'throw'` — Raises a `TenantIsolationError` (most secure; default).
 * - `'warn'`  — Logs a `console.warn` but allows the query to proceed (useful
 *               during migration periods).
 * - `'allow'` — Silently allows the query; not recommended for production.
 *
 * @see TenantInterceptorOptions.rawQueryPolicy
 * @see enableTenancy
 */
export type RawQueryPolicy = 'throw' | 'warn' | 'allow';

/**
 * Configuration options accepted by `createTenantInterceptor()` and
 * `enableTenancy()`.
 *
 * All options are optional; reasonable defaults are applied.  The callback
 * hooks (`onRawQuery`, `onMissingContext`, `onIsolationViolation`) are useful
 * for logging and alerting without altering the enforcement behaviour.
 *
 * @see createTenantInterceptor
 * @see enableTenancy
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

  /**
   * DispatchBus instance for emitting provisioning events on lifecycle changes.
   * When provided along with directoryClasses, afterSave/afterDelete hooks
   * emit dispatches like `directory.membership.created`.
   */
  dispatchBus?: DispatchBus;

  /**
   * Class names to emit directory dispatches for on save/delete lifecycle events.
   * Only classes listed here will trigger dispatch emissions.
   * @example ['Tenant', 'Membership', 'User']
   */
  directoryClasses?: string[];
}

const DEFAULT_OPTIONS: TenantInterceptorOptions = {
  rawQueryPolicy: 'throw',
};

/**
 * Extract a plain-object snapshot of an instance for dispatch payloads.
 *
 * Prefers `toJSON()` when available (all real SmrtObject instances) because
 * it returns only data fields and excludes internal handles like `_db`, `_ai`,
 * and `_fs` which may contain circular references (e.g. connection pools with
 * Timeout objects).
 *
 * @see https://github.com/happyvertical/smrt/issues/946
 */
function serializeInstance(
  instance: SmrtObject,
  className: string,
): Record<string, unknown> {
  // Documented exception to the "never call toJSON() directly" convention
  // (docs/content/standards.md §7): the interceptor must serialize whatever
  // instance is handed to it, including workspace stubs and plain-object
  // doubles used in unit tests whose classes may not extend SmrtObject and
  // therefore have no `transformJSON()` hook. Using `toJSON()` here is a
  // duck-typed fallback — when present, it strips framework-internal handles
  // for us; when absent, we fall through to manual key iteration below.
  if (typeof (instance as any).toJSON === 'function') {
    return { className, ...(instance as any).toJSON() };
  }

  // Fallback for plain-object stubs (e.g. in unit tests):
  // skip functions and framework-internal properties
  const result: Record<string, unknown> = { className };
  for (const key of Object.keys(instance)) {
    const value = (instance as any)[key];
    if (typeof value !== 'function') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Create a `CollectionInterceptor` that enforces tenant isolation on all
 * `SmrtCollection` operations.
 *
 * The returned interceptor hooks into the smrt-core `GlobalInterceptors`
 * pipeline at priority 100 (runs before all other interceptors) and
 * handles the following lifecycle hooks:
 *
 * | Hook          | Behaviour |
 * |---------------|-----------|
 * | `beforeList`  | Injects tenant filter into `WHERE`; validates explicit filters. |
 * | `beforeGet`   | Converts ID lookups to `{ id, tenantId }` filter objects. |
 * | `beforeSave`  | Auto-populates `tenantId`; validates existing values. |
 * | `beforeDelete`| Validates the instance's `tenantId` matches context. |
 * | `beforeQuery` | Enforces `rawQueryPolicy` on raw SQL calls. |
 * | `afterSave`   | Emits `directory.<class>.created/updated` via `dispatchBus`. |
 * | `afterDelete` | Emits `directory.<class>.deleted` via `dispatchBus`. |
 *
 * Use `enableTenancy()` to register the interceptor globally.  Call this
 * directly only when you need multiple interceptor instances (e.g., for
 * isolated tests or feature flags).
 *
 * @param options - Configuration for the interceptor.
 * @returns A `CollectionInterceptor` ready to be registered with
 *   `GlobalInterceptors.register()`.
 *
 * @example
 * ```typescript
 * import { createTenantInterceptor } from '@happyvertical/smrt-tenancy';
 * import { GlobalInterceptors } from '@happyvertical/smrt-core';
 *
 * const interceptor = createTenantInterceptor({ rawQueryPolicy: 'warn' });
 * GlobalInterceptors.register(interceptor);
 * ```
 *
 * @see enableTenancy
 * @see TenantInterceptorOptions
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

      // Check for system context (explicit bypass via withSystemContext)
      if (isSystemContext()) {
        return; // System context bypasses tenant checks
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

      // Check for system context (explicit bypass via withSystemContext)
      if (isSystemContext()) {
        return; // System context bypasses tenant checks
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

      // Check for system context (explicit bypass via withSystemContext)
      if (isSystemContext()) {
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
          logger.warn(`[smrt-tenancy] WARNING: ${message}`);
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

      // Stash isNew flag for afterSave dispatch detection
      if (opts.directoryClasses?.includes(className)) {
        const id = (instance as any).id;
        context.metadata = {
          ...context.metadata,
          _directoryIsNew: id === undefined || id === null,
        };
      }

      if (!isTenantScopedClass(className)) {
        return;
      }

      if (isSuperAdminBypass()) {
        return;
      }

      // Check for system context (explicit bypass via withSystemContext)
      if (isSystemContext()) {
        return; // System context bypasses tenant checks
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

      // Check for system context (explicit bypass via withSystemContext)
      if (isSystemContext()) {
        return; // System context bypasses tenant checks
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

    /**
     * After save: Emit directory dispatch for configured classes
     */
    async afterSave(
      instance: SmrtObject,
      context: InterceptorContext,
    ): Promise<void> {
      if (
        !opts.dispatchBus ||
        !opts.directoryClasses?.includes(context.className)
      )
        return;

      const rawIsNew = context.metadata?._directoryIsNew;
      const isNew =
        typeof rawIsNew === 'boolean' ? rawIsNew : (instance as any).id == null;
      const event = isNew
        ? `directory.${context.className.toLowerCase()}.created`
        : `directory.${context.className.toLowerCase()}.updated`;

      await opts.dispatchBus.emit(
        event,
        serializeInstance(instance, context.className),
        {
          source: 'smrt-tenancy',
          sourceId: (instance as any).id,
        },
      );
    },

    /**
     * After delete: Emit directory dispatch for configured classes
     */
    async afterDelete(
      instance: SmrtObject,
      context: InterceptorContext,
    ): Promise<void> {
      if (
        !opts.dispatchBus ||
        !opts.directoryClasses?.includes(context.className)
      )
        return;

      await opts.dispatchBus.emit(
        `directory.${context.className.toLowerCase()}.deleted`,
        serializeInstance(instance, context.className),
        {
          source: 'smrt-tenancy',
          sourceId: (instance as any).id,
        },
      );
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
    logger.warn(
      '[smrt-tenancy] Tenancy is already enabled. Call disableTenancy() first to reconfigure.',
    );
    return;
  }

  registeredInterceptor = createTenantInterceptor(options);
  GlobalInterceptors.register(registeredInterceptor);
  isEnabled = true;
}

/**
 * Disable global tenant enforcement.
 *
 * Unregisters the interceptor previously installed by `enableTenancy()` and
 * resets the internal enabled flag so `enableTenancy()` can be called again.
 * Idempotent — safe to call even when tenancy was never enabled.
 *
 * Common use-cases:
 * - Test teardown (via `resetTenancy()`).
 * - Temporarily disabling tenancy before reconfiguring with new options.
 *
 * @example
 * ```typescript
 * afterAll(() => {
 *   disableTenancy();
 * });
 * ```
 *
 * @see enableTenancy
 * @see isTenancyEnabled
 * @see resetTenancy
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
 * Return `true` if tenant enforcement is currently active.
 *
 * Reflects whether `enableTenancy()` has been called and the interceptor
 * has not yet been removed by `disableTenancy()`.
 *
 * @returns `true` when the tenant interceptor is registered, `false` otherwise.
 *
 * @see enableTenancy
 * @see disableTenancy
 */
export function isTenancyEnabled(): boolean {
  return isEnabled;
}
