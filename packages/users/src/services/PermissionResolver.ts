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
   *
   * Note: The 'as any' casts are required because SmrtCollection.create() has a
   * protected constructor pattern that TypeScript cannot infer correctly for
   * subclasses. This is a known limitation of the SMRT framework's static factory
   * pattern. See: https://github.com/happyvertical/smrt/issues/XXX
   */
  async initialize(): Promise<void> {
    // TypeScript cannot infer that Collection.create() returns the correct subclass type
    // due to the protected constructor pattern in SmrtCollection
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
   *
   * Algorithm:
   * 1. Get membership and collect all permission IDs from all sources
   * 2. Batch fetch all permissions in a single query
   * 3. Apply permissions from role, groups, and overrides
   * 4. DENY overrides take precedence over GRANT
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

    if (!membership.roleId) {
      return result;
    }

    // 2. Collect all permission IDs from all sources (no awaits in loops)
    const allPermissionIds: Set<string> = new Set();
    const rolePermissionIds: string[] = [];
    const groupRolePermissionIds: Map<string, string[]> = new Map();

    // 2a. Get base role permissions
    const baseRolePermIds =
      await this.rolePermissionCollection.getPermissionIds(membership.roleId);
    for (const id of baseRolePermIds) {
      allPermissionIds.add(id);
      rolePermissionIds.push(id);
    }

    // 2b. Get user's groups in the tenant (scoped to prevent cross-tenant leakage)
    const groupIds = await this.groupMemberCollection.getGroupIdsForTenant(
      userId,
      tenantId,
    );
    result.groupIds = groupIds;

    // 2c. Collect permissions from group roles
    for (const groupId of groupIds) {
      const groupRoleIds = await this.groupRoleCollection.getRoleIds(groupId);
      for (const roleId of groupRoleIds) {
        const permIds =
          await this.rolePermissionCollection.getPermissionIds(roleId);
        for (const id of permIds) {
          allPermissionIds.add(id);
        }
        groupRolePermissionIds.set(roleId, permIds);
      }
    }

    // 2d. Get membership overrides
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

    for (const id of grantedPermissionIds) {
      allPermissionIds.add(id);
    }
    for (const id of deniedPermissionIds) {
      allPermissionIds.add(id);
    }

    // 3. Batch fetch all permissions in a single query
    const permissionsMap = await this.permissionCollection.findByIds(
      Array.from(allPermissionIds),
    );

    // Build ID to slug mapping
    const permissionIdToSlug = new Map<string, string>();
    for (const [id, perm] of permissionsMap) {
      if (perm.slug) {
        permissionIdToSlug.set(id, perm.slug);
      }
    }

    // 4. Apply permissions from role
    for (const permId of rolePermissionIds) {
      const slug = permissionIdToSlug.get(permId);
      if (slug) {
        result.permissions.add(slug);
      }
    }

    // 5. Apply permissions from group roles
    for (const permIds of groupRolePermissionIds.values()) {
      for (const permId of permIds) {
        const slug = permissionIdToSlug.get(permId);
        if (slug) {
          result.permissions.add(slug);
        }
      }
    }

    // 6. Apply granted overrides
    for (const permId of grantedPermissionIds) {
      const slug = permissionIdToSlug.get(permId);
      if (slug) {
        result.permissions.add(slug);
      }
    }

    // 7. Remove denied overrides (DENY takes precedence)
    for (const permId of deniedPermissionIds) {
      const slug = permissionIdToSlug.get(permId);
      if (slug) {
        result.permissions.delete(slug);
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
