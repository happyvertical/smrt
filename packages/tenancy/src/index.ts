/**
 * @happyvertical/smrt-tenancy
 *
 * Production-ready multi-tenancy framework for SMRT with automatic tenant isolation.
 *
 * @example Basic setup
 * ```typescript
 * import { enableTenancy, TenantScoped, tenantId, withTenant } from '@happyvertical/smrt-tenancy';
 * import { smrt, SmrtObject } from '@happyvertical/smrt-core';
 *
 * // 1. Enable tenancy globally (once at app startup)
 * enableTenancy();
 *
 * // 2. Mark classes as tenant-scoped with @tenantId decorator
 * @smrt()
 * @TenantScoped({ mode: 'optional' })
 * class Document extends SmrtObject {
 *   @tenantId({ nullable: true })
 *   tenantId: string | null = null;  // null = global document
 *
 *   title: string = '';
 * }
 *
 * // 3. Wrap requests in tenant context
 * await withTenant({ tenantId: 'tenant-123' }, async () => {
 *   // All queries automatically filtered by tenant
 *   const docs = await documentCollection.list({ where: { status: 'active' } });
 *   // Actually executes: WHERE tenant_id = 'tenant-123' AND status = 'active'
 * });
 * ```
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 * @see https://github.com/happyvertical/smrt/issues/829 - Decorator pattern for tenantId
 */

// ─────────────────────────────────────────────────────────────────────────────
// Framework Adapters
// ─────────────────────────────────────────────────────────────────────────────
export {
  type CliContextOptions,
  // CLI
  createCliContext,
  // Express
  createExpressMiddleware,
  // SvelteKit
  createSvelteKitHandle,
  type ExpressMiddlewareOptions,
  type SvelteKitHandleOptions,
} from './adapters/index.js';
// ─────────────────────────────────────────────────────────────────────────────
// Context Management
// ─────────────────────────────────────────────────────────────────────────────
export {
  enterTenantContext,
  // Context access
  getCurrentTenant,
  getTenantId,
  hasTenantContext,
  isSuperAdminBypass,
  type MinimalTenantContext,
  requireTenant,
  requireTenantId,
  // Advanced context utilities
  TenantContext,
  // Types
  type TenantContextData,
  // Errors
  TenantContextError,
  TenantIsolationError,
  withSuperAdminBypass,
  withSystemContext,
  // Context runners
  withTenant,
  withTenantSync,
} from './context.js';

// ─────────────────────────────────────────────────────────────────────────────
// Decorators
// ─────────────────────────────────────────────────────────────────────────────
export {
  // Class decorator
  TenantScoped,
  type TenantScopedOptions,
  // Property decorator (preferred)
  tenantId,
} from './decorators.js';

// ─────────────────────────────────────────────────────────────────────────────
// Field Types and Utilities
// ─────────────────────────────────────────────────────────────────────────────
export {
  getTenantIdFieldOptions,
  isTenantIdField,
  type TenantIdFieldDefinition,
  type TenantIdFieldOptions,
} from './fields.js';
// ─────────────────────────────────────────────────────────────────────────────
// Interceptor System
// ─────────────────────────────────────────────────────────────────────────────
export {
  // Interceptor factory
  createTenantInterceptor,
  disableTenancy,
  // Enable/disable tenancy
  enableTenancy,
  isTenancyEnabled,
  type RawQueryPolicy,
  // Types
  type TenantInterceptorOptions,
} from './interceptor.js';
// ─────────────────────────────────────────────────────────────────────────────
// Registry (for advanced use)
// ─────────────────────────────────────────────────────────────────────────────
export {
  clearTenantScopedRegistry,
  getAllTenantScopedClasses,
  getTenantScopedConfig,
  isTenantScopedClass,
  registerTenantScopedClass,
  type TenantScopedConfig,
  unregisterTenantScopedClass,
} from './registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Testing Utilities
// ─────────────────────────────────────────────────────────────────────────────
export {
  assertTenantContextRequired,
  assertTenantIsolationViolation,
  createTestTenantContext,
  resetTenancy,
  type SetupTestTenancyOptions,
  setupTestTenancy,
  testTenantIsolation,
} from './testing.js';
