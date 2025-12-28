/**
 * MembershipOverride model - per-user permission grant/deny
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { OverrideEffect } from '../types/index.js';

/**
 * MembershipOverride allows granting or denying specific permissions
 * to a user beyond what their role and groups provide.
 *
 * Overrides are applied after role and group permissions are resolved.
 * DENY overrides take precedence over GRANT overrides.
 *
 * @example
 * ```typescript
 * // Grant a specific permission to a user
 * const override = await membershipOverrides.create({
 *   membershipId: membership.id,
 *   permissionId: specialPermission.id,
 *   effect: OverrideEffect.GRANT
 * });
 *
 * // Deny a permission (even if role grants it)
 * const deny = await membershipOverrides.create({
 *   membershipId: membership.id,
 *   permissionId: dangerousPermission.id,
 *   effect: OverrideEffect.DENY
 * });
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'delete'] },
  cli: true,
})
export class MembershipOverride extends SmrtObject {
  /**
   * Foreign key to Membership
   */
  @foreignKey('Membership', { required: true })
  membershipId?: string;

  /**
   * Foreign key to Permission
   */
  @foreignKey('Permission', { required: true })
  permissionId?: string;

  /**
   * Effect of the override: grant or deny
   */
  effect: OverrideEffect = OverrideEffect.GRANT;

  constructor(options: any = {}) {
    super(options);
    if (options.membershipId !== undefined)
      this.membershipId = options.membershipId;
    if (options.permissionId !== undefined)
      this.permissionId = options.permissionId;
    if (options.effect !== undefined) this.effect = options.effect;
  }

  /**
   * Check if this override grants the permission
   */
  isGrant(): boolean {
    return this.effect === OverrideEffect.GRANT;
  }

  /**
   * Check if this override denies the permission
   */
  isDeny(): boolean {
    return this.effect === OverrideEffect.DENY;
  }
}
