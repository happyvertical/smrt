/**
 * CLI Adapter for smrt-tenancy
 *
 * Provides utilities for setting up tenant context in CLI tools.
 *
 * @example
 * ```typescript
 * import { createCliContext } from '@happyvertical/smrt-tenancy/adapters';
 *
 * // Create context helper for CLI
 * const cliContext = createCliContext({
 *   resolveTenantId: () => process.env.TENANT_ID,
 * });
 *
 * // Run command in tenant context
 * await cliContext.run(async () => {
 *   await documentCollection.list({});
 * });
 * ```
 */

import {
  type TenantContextData,
  withSystemContext,
  withTenant,
} from '../context.js';

/**
 * Configuration for the CLI context runner created by `createCliContext()`.
 *
 * `resolveTenantId` is optional — when omitted (or when it returns
 * `null`/`undefined`) the `run()` method falls back to `withSystemContext()`.
 *
 * @see createCliContext
 * @see CliContextRunner
 */
export interface CliContextOptions {
  /**
   * Resolve tenant ID
   *
   * Common sources:
   * - Environment variable: () => process.env.TENANT_ID
   * - Command line argument: () => argv.tenant
   * - Config file: () => config.tenantId
   */
  resolveTenantId?: () =>
    | Promise<string | null | undefined>
    | string
    | null
    | undefined;

  /**
   * Resolve user ID (optional)
   */
  resolveUserId?: () =>
    | Promise<string | null | undefined>
    | string
    | null
    | undefined;

  /**
   * Default permissions for CLI operations
   */
  defaultPermissions?: Set<string>;

  /**
   * Run CLI as super admin by default
   * @default false
   */
  superAdminByDefault?: boolean;
}

/**
 * Context runner returned by `createCliContext()`.
 *
 * Provides four execution modes suitable for different CLI scenarios:
 * - `run()` — resolves the tenant from the configured options and runs code in
 *   that context; falls back to system context if no tenant is available.
 * - `runWithTenant()` — explicitly specify a tenant ID for this invocation.
 * - `runAsSystem()` — bypass all tenant checks (migration scripts, admin tools).
 * - `runAsSuperAdmin()` — tenant context with bypass flag enabled.
 *
 * @see createCliContext
 */
export interface CliContextRunner {
  /**
   * Run `fn` inside the tenant context resolved from the `CliContextOptions`.
   *
   * Falls back to `withSystemContext()` when no tenant ID is available.
   *
   * @param fn - Async function to execute.
   * @returns Promise resolving to the return value of `fn`.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Run `fn` inside the context of the specified tenant.
   *
   * @param tenantId - Tenant ID to set as context.
   * @param fn - Async function to execute.
   * @returns Promise resolving to the return value of `fn`.
   */
  runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Run `fn` in system context, bypassing all tenant checks.
   *
   * @param fn - Async function to execute.
   * @returns Promise resolving to the return value of `fn`.
   */
  runAsSystem<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Run `fn` with a tenant context and super admin bypass enabled.
   *
   * @param tenantId - Tenant ID to set as context.
   * @param fn - Async function to execute.
   * @returns Promise resolving to the return value of `fn`.
   */
  runAsSuperAdmin<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Create a CLI context runner
 *
 * @param options - Configuration options
 * @returns CLI context runner with various execution modes
 *
 * @example
 * ```typescript
 * const cli = createCliContext({
 *   resolveTenantId: () => process.env.TENANT_ID,
 *   superAdminByDefault: true,
 * });
 *
 * // Use resolved tenant
 * await cli.run(async () => {
 *   const docs = await collection.list({});
 *   console.log(`Found ${docs.length} documents`);
 * });
 *
 * // Override tenant
 * await cli.runWithTenant('other-tenant', async () => {
 *   // Operations in other-tenant context
 * });
 *
 * // System operations (no tenant)
 * await cli.runAsSystem(async () => {
 *   // Can access all data
 *   const allDocs = await collection.list({});
 * });
 * ```
 */
export function createCliContext(
  options: CliContextOptions = {},
): CliContextRunner {
  const {
    resolveTenantId,
    resolveUserId,
    defaultPermissions = new Set<string>(),
    superAdminByDefault = false,
  } = options;

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const tenantId = resolveTenantId ? await resolveTenantId() : null;

      if (!tenantId) {
        // No tenant configured - run in system context
        return withSystemContext(fn);
      }

      const userId = resolveUserId ? await resolveUserId() : undefined;

      const context: TenantContextData = {
        tenantId,
        userId: userId ?? undefined,
        permissions: defaultPermissions,
        superAdminBypass: superAdminByDefault,
      };

      return withTenant(context, fn);
    },

    async runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
      const userId = resolveUserId ? await resolveUserId() : undefined;

      const context: TenantContextData = {
        tenantId,
        userId: userId ?? undefined,
        permissions: defaultPermissions,
        superAdminBypass: superAdminByDefault,
      };

      return withTenant(context, fn);
    },

    async runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
      return withSystemContext(fn);
    },

    async runAsSuperAdmin<T>(
      tenantId: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      const userId = resolveUserId ? await resolveUserId() : undefined;

      const context: TenantContextData = {
        tenantId,
        userId: userId ?? undefined,
        permissions: defaultPermissions,
        superAdminBypass: true,
      };

      return withTenant(context, fn);
    },
  };
}

/**
 * Run an async function with a specific tenant ID set as context.
 *
 * Convenience wrapper around `withTenant()` for one-off CLI operations where
 * a full `CliContextRunner` is not needed.
 *
 * @param tenantId - Tenant ID to set as the active context.
 * @param fn - Async function to execute in the tenant context.
 * @returns Promise resolving to the return value of `fn`.
 *
 * @example
 * ```typescript
 * import { runWithTenant } from '@happyvertical/smrt-tenancy/adapters';
 *
 * await runWithTenant('tenant-123', async () => {
 *   await collection.list({});
 * });
 * ```
 *
 * @see createCliContext
 * @see runAsSystem
 */
export async function runWithTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withTenant({ tenantId }, fn);
}

/**
 * Run an async function in system context, bypassing all tenant checks.
 *
 * Convenience wrapper around `withSystemContext()` for one-off CLI operations
 * such as migration scripts or admin tooling that needs cross-tenant access.
 *
 * @param fn - Async function to execute in system context.
 * @returns Promise resolving to the return value of `fn`.
 *
 * @example
 * ```typescript
 * import { runAsSystem } from '@happyvertical/smrt-tenancy/adapters';
 *
 * await runAsSystem(async () => {
 *   const all = await collection.list({});
 *   console.log(`Total records: ${all.length}`);
 * });
 * ```
 *
 * @see runWithTenant
 * @see createCliContext
 */
export async function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemContext(fn);
}
