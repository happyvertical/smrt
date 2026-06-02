/**
 * Secret model - Tenant-scoped encrypted secrets storage
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * Secret status values
 */
export type SecretStatus = 'active' | 'disabled' | 'expired';

/**
 * Secret represents an encrypted value stored per-tenant.
 *
 * Secrets are tenant-scoped and use envelope encryption:
 * - Each tenant has their own Data Encryption Key (TDEK)
 * - The TDEK is wrapped by the Application Master Key (AMK)
 * - Secret values are encrypted by the unwrapped TDEK
 *
 * **Security**: This model deliberately excludes API and MCP exposure
 * to prevent accidental secret leakage. Secrets are only accessible
 * via CLI commands or direct service calls.
 *
 * @example
 * ```typescript
 * import { SecretService } from '@happyvertical/smrt-secrets';
 *
 * const service = await SecretService.create({ db });
 *
 * await withTenant({ tenantId: 'tenant-123' }, async () => {
 *   // Store a secret
 *   await service.store('api-key', 'sk_live_xxx', { category: 'stripe' });
 *
 *   // Retrieve (auto-decrypts)
 *   const apiKey = await service.retrieve('api-key');
 * });
 * ```
 */
// Intentional exception to standards.md §7 (`@TenantScoped({ mode: 'optional' })`):
// `Secret` uses the inline `tenantScoped: true` form on `@smrt()` rather than the
// dedicated `@TenantScoped` decorator from `@happyvertical/smrt-tenancy`. The boolean
// form gives us required-mode tenant scoping without depending on the tenancy package
// at the model layer, while `SecretService` performs manual scoping by setting
// `context = tenantId` on each row. The `(slug, context)` upsert key derived from the
// base `SmrtObject` fields is what gives different tenants isolated namespaces for
// secret names — switching to the decorator without changing the upsert key would
// surface false-positive name collisions across tenants. See
// `packages/secrets/CLAUDE.md` "Known exceptions to monorepo standards" for context.
@smrt({
  tenantScoped: true,
  // NO API or MCP exposure for security
  api: { include: [] },
  mcp: { include: [] },
  // CLI runs in-process; secrets must never be reachable over HTTP, so
  // skipApiCheck acknowledges the cli.include / api.include divergence.
  cli: { include: ['list'], skipApiCheck: true }, // Only list names, not values
})
export class Secret extends SmrtObject {
  /**
   * Tenant that owns this secret. Also stored in context for per-tenant name uniqueness.
   */
  tenantId: string = '';

  /**
   * Unique name for the secret within the tenant
   */
  name: string = '';

  /**
   * Human-readable description
   */
  description: string = '';

  /**
   * Category for organization (e.g., 'database', 'api-key', 'oauth')
   */
  category: string = '';

  /**
   * JSON-encoded EncryptedEnvelope from @happyvertical/secrets
   */
  encryptedValue: string = '';

  /**
   * Version of the tenant key used to encrypt this secret
   */
  keyVersion: number = 1;

  /**
   * Current status of the secret
   */
  status: SecretStatus = 'active';

  /**
   * Optional expiration date
   */
  expiresAt: Date | null = null;

  /**
   * Last time this secret was accessed (decrypted)
   */
  lastAccessedAt: Date | null = null;

  /**
   * Number of times this secret has been accessed
   */
  accessCount: number = 0;

  /**
   * Additional metadata stored with the secret
   */
  metadata: Record<string, unknown> = {};

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.category !== undefined) this.category = options.category;
    if (options.encryptedValue !== undefined)
      this.encryptedValue = options.encryptedValue;
    if (options.keyVersion !== undefined) this.keyVersion = options.keyVersion;
    if (options.status !== undefined) this.status = options.status;
    if (options.expiresAt !== undefined) {
      this.expiresAt =
        options.expiresAt instanceof Date
          ? options.expiresAt
          : options.expiresAt
            ? new Date(options.expiresAt)
            : null;
    }
    if (options.lastAccessedAt !== undefined) {
      this.lastAccessedAt =
        options.lastAccessedAt instanceof Date
          ? options.lastAccessedAt
          : options.lastAccessedAt
            ? new Date(options.lastAccessedAt)
            : null;
    }
    if (options.accessCount !== undefined)
      this.accessCount = options.accessCount;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Check if the secret is currently active
   */
  isActive(): boolean {
    return this.status === 'active';
  }

  /**
   * Check if the secret has expired
   */
  isExpired(): boolean {
    if (!this.expiresAt) return false;
    return new Date() >= this.expiresAt;
  }

  /**
   * Check if the secret can be used (active and not expired)
   */
  isUsable(): boolean {
    return this.isActive() && !this.isExpired();
  }

  /**
   * Record an access to this secret
   */
  recordAccess(): void {
    this.lastAccessedAt = new Date();
    this.accessCount += 1;
  }

  /**
   * Disable the secret
   */
  disable(): void {
    this.status = 'disabled';
  }

  /**
   * Enable the secret
   */
  enable(): void {
    this.status = 'active';
  }
}
