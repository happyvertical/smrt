/**
 * TenantContext - AsyncLocalStorage-based tenant context propagation
 *
 * Provides request-scoped tenant context that flows through async operations.
 * This is the core of the tenancy system - all tenant isolation depends on
 * having a valid context.
 *
 * @example Basic usage with middleware
 * ```typescript
 * import { withTenant, requireTenantId } from '@happyvertical/smrt-tenancy';
 *
 * // In middleware (SvelteKit, Express, etc.)
 * await withTenant({ tenantId: 'tenant-123' }, async () => {
 *   // All code in this async tree has access to tenant context
 *   const id = requireTenantId();  // 'tenant-123'
 * });
 * ```
 *
 * @example Background job binding
 * ```typescript
 * import { TenantContext } from '@happyvertical/smrt-tenancy';
 *
 * // Bind a callback to preserve context across async boundaries
 * setTimeout(TenantContext.bind(() => {
 *   console.log(requireTenantId());  // Works!
 * }), 1000);
 * ```
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseInterface } from '@happyvertical/sql';

/**
 * Full data stored in tenant context for the current async execution scope.
 *
 * Created by `withTenant()` / `enterTenantContext()` and read by `getCurrentTenant()`,
 * `getTenantId()`, and the interceptor hooks. All fields except `tenantId` and
 * `permissions` are optional and may be populated lazily by higher-level packages
 * (e.g., `smrt-users`).
 *
 * @see withTenant
 * @see MinimalTenantContext
 */
export interface TenantContextData {
  /** Current tenant ID (required) */
  tenantId: string;

  /** Current tenant object (lazy-loaded if smrt-users is available) */
  tenant?: unknown;

  /** Current user ID (optional) */
  userId?: string;

  /** Current user object (lazy-loaded if smrt-users is available) */
  user?: unknown;

  /** Resolved permissions for this user in this tenant */
  permissions: Set<string>;

  /** Database connection for this tenant (if database-per-tenant strategy) */
  database?: DatabaseInterface;

  /** Super admin bypass enabled - allows cross-tenant operations */
  superAdminBypass?: boolean;

  /** Custom metadata for application-specific data */
  metadata?: Record<string, unknown>;
}

/**
 * Minimal context accepted by `withTenant()` and `withTenantSync()` when only a
 * tenant ID is known.
 *
 * `permissions` defaults to an empty `Set` when omitted. Use `TenantContextData`
 * when you also need to carry user info, database handles, or resolved permissions.
 *
 * @see TenantContextData
 * @see withTenant
 */
export interface MinimalTenantContext {
  /** Tenant identifier. */
  tenantId: string;
  /** Resolved permissions; defaults to an empty Set when omitted. */
  permissions?: Set<string>;
  /** When `true`, tenant auto-filtering is skipped for classes that allow super admin bypass. */
  superAdminBypass?: boolean;
  /** Arbitrary application-specific metadata to carry through the context. */
  metadata?: Record<string, unknown>;
}

// Sentinel symbol to mark system context (distinct from "no context")
const SYSTEM_CONTEXT_MARKER = Symbol.for('smrt:system-context');

// Storage type includes the marker for system context
type ContextStoreValue = TenantContextData | typeof SYSTEM_CONTEXT_MARKER;

// AsyncLocalStorage instance for tenant context
const tenantStorage = new AsyncLocalStorage<ContextStoreValue>();

/**
 * Get the current tenant context for this async execution scope.
 *
 * Returns `undefined` when called outside any tenant scope or inside a
 * `withSystemContext()` block (the system context marker is treated as "no
 * tenant data").  Prefer `requireTenant()` when a context is mandatory.
 *
 * @returns The active `TenantContextData`, or `undefined` if none is set.
 *
 * @example
 * ```typescript
 * const ctx = getCurrentTenant();
 * if (ctx) {
 *   console.log('Current tenant:', ctx.tenantId);
 * }
 * ```
 *
 * @see requireTenant
 * @see hasTenantContext
 */
export function getCurrentTenant(): TenantContextData | undefined {
  const store = tenantStorage.getStore();
  // Return undefined for system context marker (no tenant data available)
  if (store === SYSTEM_CONTEXT_MARKER) {
    return undefined;
  }
  return store;
}

/**
 * Get the current tenant context or throw if one is not available.
 *
 * Use this in business-logic code that must run inside a tenant scope.
 * For a non-throwing alternative use `getCurrentTenant()`.
 *
 * @returns The active `TenantContextData`.
 * @throws {TenantContextError} When no tenant context is set (code is outside
 *   any `withTenant()` call or the enclosing middleware has not run).
 *
 * @example
 * ```typescript
 * const { tenantId, permissions } = requireTenant();
 * ```
 *
 * @see getCurrentTenant
 * @see requireTenantId
 */
export function requireTenant(): TenantContextData {
  const ctx = tenantStorage.getStore();
  if (!ctx || ctx === SYSTEM_CONTEXT_MARKER) {
    throw new TenantContextError(
      'No tenant context available. ' +
        'Ensure request is wrapped in withTenant() or middleware is configured.',
    );
  }
  return ctx;
}

/**
 * Get the current tenant ID or throw if no tenant context is available.
 *
 * Shorthand for `requireTenant().tenantId`.
 *
 * @returns The active tenant ID string.
 * @throws {TenantContextError} When no tenant context is set.
 *
 * @example
 * ```typescript
 * const tenantId = requireTenantId();
 * const rows = await db.query(`SELECT * FROM docs WHERE tenant_id = ?`, [tenantId]);
 * ```
 *
 * @see getTenantId
 * @see requireTenant
 */
export function requireTenantId(): string {
  return requireTenant().tenantId;
}

/**
 * Get the current tenant ID without throwing.
 *
 * Returns `undefined` when called outside any tenant scope or inside a
 * `withSystemContext()` block.  Use `requireTenantId()` when a missing context
 * should be treated as an error.
 *
 * @returns The active tenant ID, or `undefined` if none is set.
 *
 * @example
 * ```typescript
 * const tenantId = getTenantId();
 * if (tenantId) {
 *   // Optional tenant-scoped logic
 * }
 * ```
 *
 * @see requireTenantId
 * @see hasTenantContext
 */
export function getTenantId(): string | undefined {
  const store = tenantStorage.getStore();
  if (store === SYSTEM_CONTEXT_MARKER) {
    return undefined;
  }
  return store?.tenantId;
}

/**
 * Check whether the current async execution scope has an active tenant context.
 *
 * Returns `false` both when there is no context at all and when code is running
 * inside `withSystemContext()` (the system marker is not a tenant context).
 *
 * @returns `true` if a `TenantContextData` is active, `false` otherwise.
 *
 * @example
 * ```typescript
 * if (hasTenantContext()) {
 *   console.log('Tenant:', getTenantId());
 * }
 * ```
 *
 * @see getTenantId
 * @see isSystemContext
 */
export function hasTenantContext(): boolean {
  const store = tenantStorage.getStore();
  // System context marker means no tenant context (even though storage is set)
  return store !== undefined && store !== SYSTEM_CONTEXT_MARKER;
}

/**
 * Check whether the current async execution scope was entered via `withSystemContext()`.
 *
 * A system context is explicitly set to bypass all tenant checks; it is distinct
 * from "no context" (undefined store).  When the store is undefined the
 * interceptor enforces tenant requirements; when it holds the system marker the
 * interceptor skips all checks.
 *
 * @returns `true` if inside a `withSystemContext()` call, `false` otherwise.
 *
 * @see withSystemContext
 * @see hasTenantContext
 */
export function isSystemContext(): boolean {
  return tenantStorage.getStore() === SYSTEM_CONTEXT_MARKER;
}

/**
 * Check whether the super admin bypass flag is set in the current tenant context.
 *
 * When `true`, the interceptor skips tenant auto-filtering for classes that have
 * `allowSuperAdminBypass: true` in their `@TenantScoped()` config.  Returns
 * `false` inside a system context (no tenant data is available).
 *
 * @returns `true` if super admin bypass is active, `false` otherwise.
 *
 * @see withSuperAdminBypass
 * @see TenantScopedOptions.allowSuperAdminBypass
 */
export function isSuperAdminBypass(): boolean {
  const store = tenantStorage.getStore();
  if (store === SYSTEM_CONTEXT_MARKER) {
    return false;
  }
  return store?.superAdminBypass === true;
}

/**
 * Run code within a tenant context (async version)
 *
 * @param context - Tenant context data (at minimum, tenantId)
 * @param fn - Async function to run within the tenant context
 * @returns Promise resolving to the function's return value
 *
 * @example
 * ```typescript
 * await withTenant({ tenantId: 'tenant-123' }, async () => {
 *   const id = requireTenantId();  // 'tenant-123'
 *   await doSomething();
 * });
 * ```
 */
export async function withTenant<T>(
  context: TenantContextData | MinimalTenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  const fullContext: TenantContextData = {
    permissions: new Set(),
    ...context,
  };
  return tenantStorage.run(fullContext, fn);
}

/**
 * Run synchronous code within a tenant context.
 *
 * Prefer `withTenant()` for async code.  Use this variant only when the
 * callback must be synchronous (e.g., initializing a module-level value that
 * is consumed synchronously downstream).
 *
 * @param context - Tenant context data (at minimum, `tenantId`).
 * @param fn - Synchronous function to run within the tenant context.
 * @returns The return value of `fn`.
 *
 * @example
 * ```typescript
 * const result = withTenantSync({ tenantId: 'tenant-123' }, () => {
 *   return computeSomethingSync();
 * });
 * ```
 *
 * @see withTenant
 */
export function withTenantSync<T>(
  context: TenantContextData | MinimalTenantContext,
  fn: () => T,
): T {
  const fullContext: TenantContextData = {
    permissions: new Set(),
    ...context,
  };
  return tenantStorage.run(fullContext, fn);
}

/**
 * Enter tenant context for the remainder of the current async execution
 *
 * This uses AsyncLocalStorage.enterWith() to establish context that persists
 * until the async resource completes. Useful for Express middleware where
 * the route handler executes after the middleware returns.
 *
 * @param context - Tenant context data
 *
 * @example Express middleware
 * ```typescript
 * app.use((req, res, next) => {
 *   const tenantId = req.headers['x-tenant-id'] as string;
 *   enterTenantContext({ tenantId });
 *   next();  // Route handlers now have tenant context
 * });
 * ```
 */
export function enterTenantContext(
  context: TenantContextData | MinimalTenantContext,
): void {
  const fullContext: TenantContextData = {
    permissions: new Set(),
    ...context,
  };
  tenantStorage.enterWith(fullContext);
}

/**
 * Run code in system context (bypasses tenant checks)
 *
 * Use this for:
 * - Migration scripts
 * - Admin tools that need cross-tenant access
 * - Background jobs that process multiple tenants
 *
 * System context is explicitly different from "no context" - it signals
 * that tenant checks should be bypassed, while no context means the
 * interceptor should enforce tenant requirements.
 *
 * @param fn - Async function to run without tenant context
 *
 * @example
 * ```typescript
 * await withSystemContext(async () => {
 *   // No tenant context - can access all data
 *   const allDocuments = await documentCollection.list({});
 * });
 * ```
 */
export async function withSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  // Run with system context marker (distinct from undefined/no context)
  return tenantStorage.run(SYSTEM_CONTEXT_MARKER, fn);
}

/**
 * Run async code with the super admin bypass flag enabled on the current
 * tenant context.
 *
 * Unlike `withSystemContext()`, this does **not** remove the tenant context —
 * the caller's `tenantId` remains intact.  The interceptor skips
 * auto-filtering only for classes that have `allowSuperAdminBypass: true` in
 * their `@TenantScoped()` config.
 *
 * A tenant context must already be active (i.e., this must be called from
 * within a `withTenant()` scope).  Use `withSystemContext()` if no tenant
 * context is available at all.
 *
 * @param fn - Async function to run with super admin bypass enabled.
 * @returns Promise resolving to the return value of `fn`.
 * @throws {TenantContextError} If called outside any tenant context.
 *
 * @example
 * ```typescript
 * await withTenant({ tenantId: 'admin-tenant' }, async () => {
 *   await withSuperAdminBypass(async () => {
 *     // Can read any tenant's AuditLog (if allowSuperAdminBypass: true)
 *     const logs = await auditLogCollection.list({});
 *   });
 * });
 * ```
 *
 * @see withSystemContext
 * @see isSuperAdminBypass
 */
export async function withSuperAdminBypass<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const current = tenantStorage.getStore();
  if (!current || current === SYSTEM_CONTEXT_MARKER) {
    throw new TenantContextError(
      'Cannot enable super admin bypass without a tenant context. ' +
        'Use withTenant() first or withSystemContext() instead.',
    );
  }

  const bypassContext: TenantContextData = {
    ...current,
    superAdminBypass: true,
  };

  return tenantStorage.run(bypassContext, fn);
}

/**
 * Namespace object providing advanced tenant context utilities.
 *
 * Contains helpers for binding callbacks, inspecting context state, and
 * running code with the context stored in a queued job payload.  These
 * utilities supplement the standalone exported functions for situations where
 * async context might otherwise be lost (e.g., `setTimeout`, event emitters,
 * message queue consumers).
 *
 * @example
 * ```typescript
 * import { TenantContext } from '@happyvertical/smrt-tenancy';
 *
 * // Preserve context across a setTimeout
 * setTimeout(TenantContext.bind(() => {
 *   console.log(getTenantId()); // context is intact
 * }), 500);
 *
 * // Process a queued job
 * await TenantContext.runWithJobContext(job, async () => {
 *   await processJob(job);
 * });
 * ```
 */
export const TenantContext = {
  /**
   * Bind a callback to the current tenant context
   *
   * Use this when passing callbacks to setTimeout, event emitters,
   * or other APIs that might lose the async context.
   *
   * @param fn - Function to bind to current context
   * @returns Wrapped function that will run in the original context
   *
   * @example
   * ```typescript
   * // Without bind - context is lost
   * setTimeout(() => {
   *   console.log(getTenantId());  // undefined!
   * }, 1000);
   *
   * // With bind - context is preserved
   * setTimeout(TenantContext.bind(() => {
   *   console.log(getTenantId());  // 'tenant-123'
   * }), 1000);
   * ```
   */
  bind<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const store = tenantStorage.getStore();
    if (!store) {
      // No context to bind, return function as-is
      return fn;
    }

    // Preserve the context (including system context marker)
    return ((...args: unknown[]) => {
      return tenantStorage.run(store, () => fn(...args));
    }) as T;
  },

  /**
   * Get the current context data (or undefined for system/no context)
   */
  get current(): TenantContextData | undefined {
    return getCurrentTenant();
  },

  /**
   * Check if we're in system context
   */
  get isSystem(): boolean {
    return isSystemContext();
  },

  /**
   * Run code with context from a job/message payload
   *
   * Useful for processing queued jobs that include tenant metadata.
   *
   * @param job - Job object with tenantId in metadata
   * @param fn - Function to run in the job's tenant context
   *
   * @example
   * ```typescript
   * const job = await queue.pop();
   * await TenantContext.runWithJobContext(job, async () => {
   *   await processJob(job);
   * });
   * ```
   */
  async runWithJobContext<T>(
    job: { metadata?: { tenantId?: string }; tenantId?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    const tenantId = job.metadata?.tenantId ?? job.tenantId;
    if (!tenantId) {
      throw new TenantContextError(
        'Job does not contain tenant information. ' +
          'Ensure jobs include tenantId in metadata or as a top-level field.',
      );
    }

    return withTenant({ tenantId }, fn);
  },
};

/**
 * Error thrown when a tenant context is required but not available.
 *
 * Raised by `requireTenant()`, `requireTenantId()`, and the tenant interceptor
 * when a `@TenantScoped({ mode: 'required' })` operation is attempted outside
 * any `withTenant()` scope.
 *
 * The `code` property is always `'TENANT_CONTEXT_REQUIRED'` and can be used for
 * programmatic error handling.
 *
 * @example
 * ```typescript
 * try {
 *   const tenantId = requireTenantId();
 * } catch (err) {
 *   if (err instanceof TenantContextError) {
 *     // err.code === 'TENANT_CONTEXT_REQUIRED'
 *   }
 * }
 * ```
 *
 * @see requireTenant
 * @see requireTenantId
 * @see TenantIsolationError
 */
export class TenantContextError extends Error {
  /** Stable error code; always `'TENANT_CONTEXT_REQUIRED'`. */
  readonly code = 'TENANT_CONTEXT_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Error thrown when a tenant isolation boundary is crossed.
 *
 * Raised by the tenant interceptor when:
 * - A `list()` or `get()` query explicitly filters by a tenant ID that does not
 *   match the current context tenant.
 * - A `save()` or `delete()` is attempted on an object whose `tenantId` field
 *   belongs to a different tenant than the current context.
 * - A raw SQL query is executed against a tenant-scoped class without an
 *   explicit bypass (when `rawQueryPolicy` is `'throw'`).
 *
 * The `code` property is always `'TENANT_ISOLATION_VIOLATION'`.
 *
 * @example
 * ```typescript
 * try {
 *   await collection.list({ where: { tenantId: 'other-tenant' } });
 * } catch (err) {
 *   if (err instanceof TenantIsolationError) {
 *     // err.tenantId          — context tenant
 *     // err.attemptedTenantId — tenant that was attempted
 *   }
 * }
 * ```
 *
 * @see TenantContextError
 * @see createTenantInterceptor
 */
export class TenantIsolationError extends Error {
  /** Stable error code; always `'TENANT_ISOLATION_VIOLATION'`. */
  readonly code = 'TENANT_ISOLATION_VIOLATION';
  /** The tenant ID that is active in the current context. */
  readonly tenantId?: string;
  /** The tenant ID that was attempted (and rejected). */
  readonly attemptedTenantId?: string;

  constructor(
    message: string,
    details?: { tenantId?: string; attemptedTenantId?: string },
  ) {
    super(message);
    this.name = 'TenantIsolationError';
    this.tenantId = details?.tenantId;
    this.attemptedTenantId = details?.attemptedTenantId;
  }
}
