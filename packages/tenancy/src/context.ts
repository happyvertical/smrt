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
 * Data stored in tenant context
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
 * Minimal context for simple cases (just tenantId)
 */
export interface MinimalTenantContext {
  tenantId: string;
  permissions?: Set<string>;
  superAdminBypass?: boolean;
  metadata?: Record<string, unknown>;
}

// AsyncLocalStorage instance for tenant context
const tenantStorage = new AsyncLocalStorage<TenantContextData>();

/**
 * Get current tenant context (may be undefined if not in a tenant scope)
 */
export function getCurrentTenant(): TenantContextData | undefined {
  return tenantStorage.getStore();
}

/**
 * Get current tenant context or throw if not available
 *
 * @throws TenantContextError if no tenant context is set
 */
export function requireTenant(): TenantContextData {
  const ctx = tenantStorage.getStore();
  if (!ctx) {
    throw new TenantContextError(
      'No tenant context available. ' +
        'Ensure request is wrapped in withTenant() or middleware is configured.',
    );
  }
  return ctx;
}

/**
 * Get current tenant ID or throw if not available
 *
 * @throws TenantContextError if no tenant context is set
 */
export function requireTenantId(): string {
  return requireTenant().tenantId;
}

/**
 * Get current tenant ID if available (returns undefined if not in tenant scope)
 */
export function getTenantId(): string | undefined {
  return tenantStorage.getStore()?.tenantId;
}

/**
 * Check if we're currently in a tenant context
 */
export function hasTenantContext(): boolean {
  return tenantStorage.getStore() !== undefined;
}

/**
 * Check if super admin bypass is currently enabled
 */
export function isSuperAdminBypass(): boolean {
  return tenantStorage.getStore()?.superAdminBypass === true;
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
 * Run code within a tenant context (sync version)
 *
 * @param context - Tenant context data
 * @param fn - Sync function to run within the tenant context
 * @returns The function's return value
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
  // Run without any tenant context (undefined store)
  // Cast storage to allow undefined to avoid unsafe 'as any'
  return (
    tenantStorage as AsyncLocalStorage<TenantContextData | undefined>
  ).run(undefined, fn);
}

/**
 * Run code with super admin bypass enabled
 *
 * This keeps the tenant context but enables the superAdminBypass flag,
 * allowing cross-tenant operations while still having a "home" tenant.
 *
 * @param fn - Async function to run with bypass enabled
 */
export async function withSuperAdminBypass<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const current = tenantStorage.getStore();
  if (!current) {
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
 * TenantContext utility class for advanced context management
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
    const ctx = tenantStorage.getStore();
    if (!ctx) {
      // No context to bind, return function as-is
      return fn;
    }

    return ((...args: unknown[]) => {
      return tenantStorage.run(ctx, () => fn(...args));
    }) as T;
  },

  /**
   * Get the current context data (or undefined)
   */
  get current(): TenantContextData | undefined {
    return getCurrentTenant();
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
 * Error thrown when tenant context is required but not available
 */
export class TenantContextError extends Error {
  readonly code = 'TENANT_CONTEXT_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Error thrown when tenant isolation is violated
 */
export class TenantIsolationError extends Error {
  readonly code = 'TENANT_ISOLATION_VIOLATION';
  readonly tenantId?: string;
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
