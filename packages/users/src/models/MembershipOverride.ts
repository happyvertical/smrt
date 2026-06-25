/**
 * MembershipOverride model - per-user permission grant/deny
 * @packageDocumentation
 */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { OverrideEffect } from '../types/index.js';

/**
 * Constructor options for {@link MembershipOverride}.
 */
export interface MembershipOverrideOptions extends SmrtObjectOptions {
  membershipId?: string;
  permissionId?: string;
  effect?: OverrideEffect;
}

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
  // #1400: read-only generated REST + MCP surface — RBAC/identity writes go
  // through permission-gated services, not auth-only generated CRUD. mcp must
  // be explicit: an omitted mcp config generates the FULL tool surface.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
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
  @field({ type: 'text' })
  effect: OverrideEffect = OverrideEffect.GRANT;

  constructor(options: MembershipOverrideOptions = {}) {
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
