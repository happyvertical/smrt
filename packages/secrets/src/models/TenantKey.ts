/**
 * TenantKey model - Tracks per-tenant Data Encryption Keys (TDEKs)
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * Key status values
 */
export type TenantKeyStatus = 'active' | 'rotating' | 'retired' | 'compromised';

/**
 * TenantKey tracks the per-tenant Data Encryption Keys (TDEKs).
 *
 * Each tenant has one or more TDEKs stored in wrapped form. The wrapped key
 * can only be decrypted using the Application Master Key (AMK).
 *
 * **Key Lifecycle**:
 * 1. `active` - Current key used for encryption
 * 2. `rotating` - Transitional state during rotation
 * 3. `retired` - Old key kept for decryption of existing secrets
 * 4. `compromised` - Key marked as compromised, should not be used
 *
 * **Note**: This model is NOT tenant-scoped itself because it tracks
 * keys FOR tenants, not secrets owned BY tenants.
 *
 * @example
 * ```typescript
 * // Get active key for a tenant
 * const key = await tenantKeys.get({
 *   tenantId: 'tenant-123',
 *   status: 'active'
 * });
 *
 * // List all key versions for a tenant
 * const versions = await tenantKeys.list({
 *   where: { tenantId: 'tenant-123' },
 *   orderBy: 'version DESC'
 * });
 * ```
 */
// Intentional exception to standards.md §7 (`@TenantScoped({ mode: 'optional' })`):
// `TenantKey` is deliberately NOT tenant-scoped — neither via the decorator nor via
// `tenantScoped: true` on `@smrt()`. The row carries a `tenantId` column because each
// TDEK belongs to a tenant, but the model itself must remain queryable across tenants
// (e.g. cross-tenant key-rotation tooling, AMK rewrap jobs, super-admin auditing).
// Adding the tenancy interceptor here would silently filter out keys the rotation
// service needs to inspect. See `packages/secrets/CLAUDE.md` "Known exceptions to
// monorepo standards" for the full rationale.
@smrt({
  // NOT tenant-scoped - this model tracks keys FOR tenants
  api: { include: [] }, // No API exposure
  mcp: { include: [] }, // No MCP exposure
  // CLI runs in-process for key-rotation tooling and audit; HTTP exposure is
  // intentionally excluded, so skipApiCheck acknowledges the divergence.
  cli: { include: ['list', 'get'], skipApiCheck: true },
})
export class TenantKey extends SmrtObject {
  /**
   * Tenant ID this key belongs to
   */
  tenantId: string = '';

  /**
   * Wrapped key data (format: wrappedKey:iv:authTag)
   */
  wrappedKey: string = '';

  /**
   * ID of the AMK used to wrap this key
   */
  amkKeyId: string = '';

  /**
   * Current status of the key
   */
  status: TenantKeyStatus = 'active';

  /**
   * Version number (increments on rotation)
   */
  version: number = 1;

  /**
   * Recommended rotation date
   */
  rotateAfter: Date | null = null;

  /**
   * When the key was retired (if applicable)
   */
  retiredAt: Date | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.wrappedKey !== undefined) this.wrappedKey = options.wrappedKey;
    if (options.amkKeyId !== undefined) this.amkKeyId = options.amkKeyId;
    if (options.status !== undefined) this.status = options.status;
    if (options.version !== undefined) this.version = options.version;
    if (options.rotateAfter !== undefined) {
      this.rotateAfter =
        options.rotateAfter instanceof Date
          ? options.rotateAfter
          : options.rotateAfter
            ? new Date(options.rotateAfter)
            : null;
    }
    if (options.retiredAt !== undefined) {
      this.retiredAt =
        options.retiredAt instanceof Date
          ? options.retiredAt
          : options.retiredAt
            ? new Date(options.retiredAt)
            : null;
    }
  }

  /**
   * Check if this key is currently active
   */
  isActive(): boolean {
    return this.status === 'active';
  }

  /**
   * Check if this key needs rotation
   */
  needsRotation(): boolean {
    if (!this.rotateAfter) return false;
    return new Date() >= this.rotateAfter;
  }

  /**
   * Check if this key is retired
   */
  isRetired(): boolean {
    return this.status === 'retired';
  }

  /**
   * Check if this key is compromised
   */
  isCompromised(): boolean {
    return this.status === 'compromised';
  }

  /**
   * Check if this key can be used for decryption
   * (active or retired keys can decrypt)
   */
  canDecrypt(): boolean {
    return this.status === 'active' || this.status === 'retired';
  }

  /**
   * Check if this key can be used for encryption
   * (only active keys should encrypt)
   */
  canEncrypt(): boolean {
    return this.status === 'active';
  }

  /**
   * Mark this key as retired
   */
  retire(): void {
    this.status = 'retired';
    this.retiredAt = new Date();
  }

  /**
   * Mark this key as compromised
   */
  markCompromised(): void {
    this.status = 'compromised';
  }
}
