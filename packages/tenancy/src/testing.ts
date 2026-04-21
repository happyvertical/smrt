/**
 * Testing Utilities for smrt-tenancy
 *
 * Helpers for testing tenant-scoped applications.
 *
 * @example
 * ```typescript
 * import { createTestTenantContext, resetTenancy } from '@happyvertical/smrt-tenancy/testing';
 *
 * beforeEach(() => {
 *   resetTenancy();  // Clear all state
 * });
 *
 * it('should filter by tenant', async () => {
 *   await createTestTenantContext({ tenantId: 'tenant-1' }, async () => {
 *     const docs = await collection.list({});
 *     // Only tenant-1 documents
 *   });
 * });
 * ```
 */

import {
  type MinimalTenantContext,
  type TenantContextData,
  withTenant,
} from './context.js';
import { disableTenancy, enableTenancy } from './interceptor.js';
import { clearTenantScopedRegistry } from './registry.js';

/**
 * Reset all tenancy state (for use in beforeEach/afterEach)
 *
 * This clears:
 * - Registered interceptors
 * - Tenant-scoped class registry
 *
 * @example
 * ```typescript
 * afterEach(() => {
 *   resetTenancy();
 * });
 * ```
 */
export function resetTenancy(): void {
  disableTenancy();
  clearTenantScopedRegistry();
}

/**
 * Create a test tenant context and run code within it
 *
 * Convenience wrapper around withTenant() with sensible defaults for testing.
 *
 * @param context - Tenant context (can be minimal, just tenantId)
 * @param fn - Async function to run in the context
 *
 * @example
 * ```typescript
 * await createTestTenantContext({ tenantId: 'test-tenant' }, async () => {
 *   const product = await collection.create({ name: 'Test' });
 *   expect(product.tenantId).toBe('test-tenant');
 * });
 * ```
 */
export async function createTestTenantContext<T>(
  context: MinimalTenantContext | TenantContextData,
  fn: () => Promise<T>,
): Promise<T> {
  return withTenant(context, fn);
}

/**
 * Create multiple tenant contexts for isolation testing
 *
 * @param tenantIds - Array of tenant IDs to create contexts for
 * @param fn - Function that receives an object mapping tenant IDs to context runners
 *
 * @example
 * ```typescript
 * await testTenantIsolation(['tenant-a', 'tenant-b'], async (tenants) => {
 *   // Create in tenant A
 *   const docA = await tenants['tenant-a'](async () => {
 *     return collection.create({ title: 'A doc' });
 *   });
 *
 *   // Verify not visible in tenant B
 *   await tenants['tenant-b'](async () => {
 *     const found = await collection.get(docA.id);
 *     expect(found).toBeNull();
 *   });
 * });
 * ```
 */
export async function testTenantIsolation<T>(
  tenantIds: string[],
  fn: (
    tenants: Record<string, <R>(runner: () => Promise<R>) => Promise<R>>,
  ) => Promise<T>,
): Promise<T> {
  const tenants: Record<string, <R>(runner: () => Promise<R>) => Promise<R>> =
    {};

  for (const tenantId of tenantIds) {
    tenants[tenantId] = async <R>(runner: () => Promise<R>) => {
      return withTenant({ tenantId }, runner);
    };
  }

  return fn(tenants);
}

/**
 * Options for `setupTestTenancy()`.
 *
 * @see setupTestTenancy
 */
export interface SetupTestTenancyOptions {
  /**
   * Enable tenancy interceptors
   * @default true
   */
  enableInterceptors?: boolean;

  /**
   * Raw query policy for tests
   * @default 'throw'
   */
  rawQueryPolicy?: 'throw' | 'warn' | 'allow';
}

/**
 * Set up tenancy for a test suite
 *
 * Call in beforeAll or at the start of tests to configure tenancy.
 *
 * @param options - Setup options
 *
 * @example
 * ```typescript
 * beforeAll(() => {
 *   setupTestTenancy({ enableInterceptors: true });
 * });
 *
 * afterAll(() => {
 *   resetTenancy();
 * });
 * ```
 */
export function setupTestTenancy(options: SetupTestTenancyOptions = {}): void {
  const { enableInterceptors = true, rawQueryPolicy = 'throw' } = options;

  // Clear any existing state
  resetTenancy();

  // Enable interceptors if requested
  if (enableInterceptors) {
    enableTenancy({ rawQueryPolicy });
  }
}

/**
 * Assert that executing `fn` throws a `TenantContextError`.
 *
 * Fails with a descriptive message if `fn` completes without throwing, or if
 * it throws a different error type.  Optionally verifies that the error message
 * contains a specific substring.
 *
 * Useful for testing that business-logic code correctly rejects calls that are
 * made outside a tenant context.
 *
 * @param fn - Async function that should throw `TenantContextError`.
 * @param messageContains - Optional substring the error message must include.
 *
 * @example
 * ```typescript
 * await assertTenantContextRequired(async () => {
 *   // No withTenant() in scope
 *   await documentCollection.list({});
 * });
 * ```
 *
 * @see assertTenantIsolationViolation
 * @see TenantContextError
 */
export async function assertTenantContextRequired(
  fn: () => Promise<unknown>,
  messageContains?: string,
): Promise<void> {
  try {
    await fn();
    throw new Error('Expected TenantContextError but no error was thrown');
  } catch (error: unknown) {
    const err = error as Error & { code?: string };
    if (err.code !== 'TENANT_CONTEXT_REQUIRED') {
      throw new Error(
        `Expected TenantContextError but got ${err.constructor.name}: ${err.message}`,
      );
    }
    if (messageContains && !err.message.includes(messageContains)) {
      throw new Error(
        `Expected error message to contain '${messageContains}' but got: ${err.message}`,
      );
    }
  }
}

/**
 * Assert that executing `fn` throws a `TenantIsolationError`.
 *
 * Fails with a descriptive message if `fn` completes without throwing, or if
 * it throws a different error type.  Optionally verifies that the error message
 * contains a specific substring.
 *
 * Use this to verify that cross-tenant data access attempts are correctly
 * blocked by the interceptor.
 *
 * @param fn - Async function that should throw `TenantIsolationError`.
 * @param messageContains - Optional substring the error message must include.
 *
 * @example
 * ```typescript
 * await withTenant({ tenantId: 'tenant-a' }, async () => {
 *   await assertTenantIsolationViolation(async () => {
 *     // Attempt to filter by a different tenant
 *     await collection.list({ where: { tenantId: 'tenant-b' } });
 *   });
 * });
 * ```
 *
 * @see assertTenantContextRequired
 * @see TenantIsolationError
 */
export async function assertTenantIsolationViolation(
  fn: () => Promise<unknown>,
  messageContains?: string,
): Promise<void> {
  try {
    await fn();
    throw new Error('Expected TenantIsolationError but no error was thrown');
  } catch (error: unknown) {
    const err = error as Error & { code?: string };
    if (err.code !== 'TENANT_ISOLATION_VIOLATION') {
      throw new Error(
        `Expected TenantIsolationError but got ${err.constructor.name}: ${err.message}`,
      );
    }
    if (messageContains && !err.message.includes(messageContains)) {
      throw new Error(
        `Expected error message to contain '${messageContains}' but got: ${err.message}`,
      );
    }
  }
}
