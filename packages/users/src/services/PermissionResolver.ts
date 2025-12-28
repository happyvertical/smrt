/**
 * PermissionResolver - Resolves effective permissions for a user in a tenant
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { GroupMemberCollection } from '../collections/GroupMemberCollection.js';
import { GroupRoleCollection } from '../collections/GroupRoleCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { MembershipOverrideCollection } from '../collections/MembershipOverrideCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';

/**
 * Permission resolution result
 */
export interface PermissionResolutionResult {
  /** Set of granted permission slugs */
  permissions: Set<string>;
  /** Membership ID used for resolution */
  membershipId: string | null;
  /** Role ID from membership */
  roleId: string | null;
  /** Group IDs that contributed permissions */
  groupIds: string[];
  /** Permission IDs explicitly denied */
  deniedPermissionIds: string[];
}

/**
 * PermissionResolver resolves the effective permissions for a user in a tenant.
 *
 * Resolution algorithm:
 * 1. Get user's membership in the tenant
 * 2. Get base permissions from membership's role
 * 3. Get user's groups in the tenant
 * 4. Add permissions from group roles
 * 5. Apply membership overrides (grant/deny)
 *
 * DENY overrides take precedence over GRANT overrides.
 *
 * @example
 * ```typescript
 * const resolver = new PermissionResolver(options);
 * await resolver.initialize();
 *
 * // Check single permission
 * const canCreate = await resolver.hasPermission(userId, tenantId, 'articles.create');
 *
 * // Get all permissions
 * const result = await resolver.resolvePermissions(userId, tenantId);
 * console.log(result.permissions); // Set<string>
 * ```
 */
export class PermissionResolver {
  private options: SmrtClassOptions;
  private membershipCollection!: MembershipCollection;
  private rolePermissionCollection!: RolePermissionCollection;
  private membershipOverrideCollection!: MembershipOverrideCollection;
  private groupMemberCollection!: GroupMemberCollection;
  private groupRoleCollection!: GroupRoleCollection;
  private permissionCollection!: PermissionCollection;

  constructor(options: SmrtClassOptions) {
    this.options = options;
  }

  /**
   * Initialize collections
   */
  async initialize(): Promise<void> {
    this.membershipCollection = await (MembershipCollection as any).create(
      this.options,
    );
    this.rolePermissionCollection = await (
      RolePermissionCollection as any
    ).create(this.options);
    this.membershipOverrideCollection = await (
      MembershipOverrideCollection as any
    ).create(this.options);
    this.groupMemberCollection = await (GroupMemberCollection as any).create(
      this.options,
    );
    this.groupRoleCollection = await (GroupRoleCollection as any).create(
      this.options,
    );
    this.permissionCollection = await (PermissionCollection as any).create(
      this.options,
    );
  }

  /**
   * Resolve all effective permissions for a user in a tenant
   */
  async resolvePermissions(
    userId: string,
    tenantId: string,
  ): Promise<PermissionResolutionResult> {
    const result: PermissionResolutionResult = {
      permissions: new Set<string>(),
      membershipId: null,
      roleId: null,
      groupIds: [],
      deniedPermissionIds: [],
    };

    // 1. Get membership
    const membership = await this.membershipCollection.findByUserAndTenant(
      userId,
      tenantId,
    );
    if (!membership || !membership.isActive()) {
      return result;
    }

    result.membershipId = membership.id ?? null;
    result.roleId = membership.roleId ?? null;

    // 2. Get base permissions from membership role
    if (!membership.roleId) {
      return result;
    }
    const rolePermissionIds =
      await this.rolePermissionCollection.getPermissionIds(membership.roleId);

    // Convert permission IDs to slugs
    const permissionIdToSlug = new Map<string, string>();
    for (const permId of rolePermissionIds) {
      const perm = await this.permissionCollection.get({ id: permId });
      if (perm?.slug) {
        permissionIdToSlug.set(permId, perm.slug);
        result.permissions.add(perm.slug);
      }
    }

    // 3. Get user's groups in the tenant
    const groupIds = await this.groupMemberCollection.getGroupIds(userId);
    result.groupIds = groupIds;

    // 4. Add permissions from group roles
    for (const groupId of groupIds) {
      const groupRoleIds = await this.groupRoleCollection.getRoleIds(groupId);
      for (const roleId of groupRoleIds) {
        const groupRolePermissionIds =
          await this.rolePermissionCollection.getPermissionIds(roleId);
        for (const permId of groupRolePermissionIds) {
          if (!permissionIdToSlug.has(permId)) {
            const perm = await this.permissionCollection.get({ id: permId });
            if (perm?.slug) {
              permissionIdToSlug.set(permId, perm.slug);
            }
          }
          const slug = permissionIdToSlug.get(permId);
          if (slug) {
            result.permissions.add(slug);
          }
        }
      }
    }

    // 5. Apply membership overrides
    if (!membership.id) {
      return result;
    }
    const membershipId = membership.id;
    const grantedPermissionIds =
      await this.membershipOverrideCollection.getGrantedPermissionIds(
        membershipId,
      );
    const deniedPermissionIds =
      await this.membershipOverrideCollection.getDeniedPermissionIds(
        membershipId,
      );

    result.deniedPermissionIds = deniedPermissionIds;

    // Add granted overrides
    for (const permId of grantedPermissionIds) {
      if (!permissionIdToSlug.has(permId)) {
        const perm = await this.permissionCollection.get({ id: permId });
        if (perm?.slug) {
          permissionIdToSlug.set(permId, perm.slug);
        }
      }
      const slug = permissionIdToSlug.get(permId);
      if (slug) {
        result.permissions.add(slug);
      }
    }

    // Remove denied overrides (DENY takes precedence)
    for (const permId of deniedPermissionIds) {
      const slug = permissionIdToSlug.get(permId);
      if (slug) {
        result.permissions.delete(slug);
      } else {
        // Look up the permission if not cached
        const perm = await this.permissionCollection.get({ id: permId });
        if (perm?.slug) {
          result.permissions.delete(perm.slug);
        }
      }
    }

    return result;
  }

  /**
   * Check if a user has a specific permission in a tenant
   */
  async hasPermission(
    userId: string,
    tenantId: string,
    permissionSlug: string,
  ): Promise<boolean> {
    const result = await this.resolvePermissions(userId, tenantId);
    return result.permissions.has(permissionSlug);
  }

  /**
   * Check if a user has all of the specified permissions
   */
  async hasAllPermissions(
    userId: string,
    tenantId: string,
    permissionSlugs: string[],
  ): Promise<boolean> {
    const result = await this.resolvePermissions(userId, tenantId);
    return permissionSlugs.every((slug) => result.permissions.has(slug));
  }

  /**
   * Check if a user has any of the specified permissions
   */
  async hasAnyPermission(
    userId: string,
    tenantId: string,
    permissionSlugs: string[],
  ): Promise<boolean> {
    const result = await this.resolvePermissions(userId, tenantId);
    return permissionSlugs.some((slug) => result.permissions.has(slug));
  }

  /**
   * Static factory method
   */
  static async create(options: SmrtClassOptions): Promise<PermissionResolver> {
    const resolver = new PermissionResolver(options);
    await resolver.initialize();
    return resolver;
  }
}
