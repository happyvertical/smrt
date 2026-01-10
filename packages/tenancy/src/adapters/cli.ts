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
 * Options for CLI context
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
 * CLI context runner interface
 */
export interface CliContextRunner {
  /**
   * Run code in tenant context resolved from options
   */
  run<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Run code with a specific tenant ID
   */
  runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Run code in system context (no tenant restrictions)
   */
  runAsSystem<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Run code as super admin (tenant context but bypass enabled)
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
 * Quick helper to run a function with a specific tenant ID
 *
 * Convenience for one-off operations.
 *
 * @param tenantId - Tenant ID
 * @param fn - Function to run
 *
 * @example
 * ```typescript
 * import { runWithTenant } from '@happyvertical/smrt-tenancy/adapters';
 *
 * await runWithTenant('tenant-123', async () => {
 *   await collection.list({});
 * });
 * ```
 */
export async function runWithTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withTenant({ tenantId }, fn);
}

/**
 * Quick helper to run a function without tenant context
 *
 * @param fn - Function to run
 */
export async function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemContext(fn);
}
