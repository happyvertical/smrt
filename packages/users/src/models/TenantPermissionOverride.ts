/**
 * TenantPermissionOverride model - tenant-level permission grant/deny/inherit
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantPermissionEffect } from '../types/index.js';

/**
 * TenantPermissionOverride allows setting explicit permission values at the tenant level.
 *
 * This is used in hierarchical tenant structures to control permission inheritance.
 * Each override specifies whether a permission is:
 * - INHERIT: Use the parent tenant's value (default behavior)
 * - GRANT: Explicitly grant at this tenant level
 * - DENY: Explicitly deny at this tenant level (blocks inheritance)
 *
 * ## Resolution Order
 *
 * When resolving effective tenant permissions:
 * 1. Walk down the tenant hierarchy from root to target, accumulating permissions
 * 2. Apply each tenant's overrides (DENY blocks, GRANT adds)
 * 3. INHERIT means "use whatever the parent resolved to"
 *
 * @example
 * ```typescript
 * // Explicitly grant a permission at this tenant level
 * const override = await tenantPermissionOverrides.create({
 *   tenantId: tenant.id,
 *   permissionId: specialPermission.id,
 *   effect: TenantPermissionEffect.GRANT
 * });
 *
 * // Block a permission from being inherited (even if parent grants it)
 * const block = await tenantPermissionOverrides.create({
 *   tenantId: tenant.id,
 *   permissionId: dangerousPermission.id,
 *   effect: TenantPermissionEffect.DENY
 * });
 *
 * // Explicitly inherit (same as not having an override, but documents intent)
 * const inherit = await tenantPermissionOverrides.create({
 *   tenantId: tenant.id,
 *   permissionId: standardPermission.id,
 *   effect: TenantPermissionEffect.INHERIT
 * });
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
})
export class TenantPermissionOverride extends SmrtObject {
  /**
   * Foreign key to Tenant
   */
  @foreignKey('Tenant', { required: true })
  tenantId?: string;

  /**
   * Foreign key to Permission
   */
  @foreignKey('Permission', { required: true })
  permissionId?: string;

  /**
   * Effect of the override: inherit, grant, or deny
   */
  effect: TenantPermissionEffect = TenantPermissionEffect.INHERIT;

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.permissionId !== undefined)
      this.permissionId = options.permissionId;
    if (options.effect !== undefined) this.effect = options.effect;
  }

  /**
   * Check if this override inherits from parent
   */
  isInherit(): boolean {
    return this.effect === TenantPermissionEffect.INHERIT;
  }

  /**
   * Check if this override grants the permission
   */
  isGrant(): boolean {
    return this.effect === TenantPermissionEffect.GRANT;
  }

  /**
   * Check if this override denies the permission
   */
  isDeny(): boolean {
    return this.effect === TenantPermissionEffect.DENY;
  }

  /**
   * Check if this override has an explicit effect (not inherit)
   */
  hasExplicitEffect(): boolean {
    return this.effect !== TenantPermissionEffect.INHERIT;
  }
}
