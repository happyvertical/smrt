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
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import type { Tenant } from '../models/Tenant.js';

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
 * Tenant permission inheritance chain result
 */
export interface TenantPermissionInheritanceResult {
  /** Effective tenant permissions (slugs) after inheritance resolution */
  permissions: Set<string>;
  /** Tenant IDs that contributed to the inheritance chain */
  contributingTenantIds: string[];
  /** Whether inheritance was active (at least one tenant in chain had inheritPermissions: true) */
  inheritanceActive: boolean;
}

/**
 * PermissionResolver resolves the effective permissions for a user in a tenant.
 *
 * Resolution algorithm:
 * 1. Resolve tenant hierarchy permissions (if hierarchical tenants are used)
 * 2. Get user's membership in the tenant
 * 3. Get base permissions from membership's role
 * 4. Get user's groups in the tenant
 * 5. Add permissions from group roles
 * 6. Apply membership overrides (grant/deny)
 *
 * DENY overrides take precedence over GRANT overrides at every level.
 *
 * ## Hierarchical Tenant Permissions
 *
 * When tenants are organized hierarchically, permissions can cascade from
 * parent tenants to child tenants. The cascade is controlled by:
 * - Parent's `cascadePermissions`: If true, parent pushes permissions down
 * - Child's `inheritPermissions`: If true, child accepts parent's permissions
 *
 * Child tenants can override inherited permissions using TenantPermissionOverride:
 * - INHERIT: Use parent's value (default)
 * - GRANT: Explicitly grant at this level
 * - DENY: Explicitly block (even if parent grants)
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
 *
 * // Resolve tenant-level permissions only (without user context)
 * const tenantPerms = await resolver.resolveTenantPermissions(tenantId);
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
  private tenantCollection!: TenantCollection;
  private tenantPermissionOverrideCollection!: TenantPermissionOverrideCollection;

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
    this.tenantCollection = await (TenantCollection as any).create(
      this.options,
    );
    this.tenantPermissionOverrideCollection = await (
      TenantPermissionOverrideCollection as any
    ).create(this.options);
  }

  // ============= Tenant Hierarchy Permission Resolution =============

  /**
   * Resolve effective permissions for a tenant, considering hierarchy inheritance.
   *
   * Algorithm:
   * 1. Get the tenant and its ancestors (from root to immediate parent)
   * 2. Batch fetch all permission overrides for the entire chain (single query)
   * 3. Walk down the chain, building up permissions:
   *    - Start with root tenant's permissions
   *    - For each child: if parent.cascadePermissions && child.inheritPermissions:
   *      - Merge parent's permissions
   *      - Apply child's overrides (GRANT adds, DENY removes)
   * 4. Return the final effective permission set
   */
  async resolveTenantPermissions(
    tenantId: string,
  ): Promise<TenantPermissionInheritanceResult> {
    const result: TenantPermissionInheritanceResult = {
      permissions: new Set<string>(),
      contributingTenantIds: [],
      inheritanceActive: false,
    };

    const tenant = await this.tenantCollection.get({ id: tenantId });
    if (!tenant) {
      return result;
    }

    // Get the inheritance chain from root to this tenant
    const ancestors =
      await this.tenantCollection.getAncestorsFromRoot(tenantId);
    const chain: Tenant[] = [...ancestors, tenant];

    // Batch fetch all permission overrides for the entire chain (single query)
    const chainTenantIds = chain.map((t) => t.id!);
    const allOverridesMap =
      await this.tenantPermissionOverrideCollection.getOverridesByEffectBatch(
        chainTenantIds,
      );

    // Build a set of permission IDs for batch lookup
    const allPermissionIds = new Set<string>();
    for (const overrides of allOverridesMap.values()) {
      for (const id of overrides.grantedPermissionIds) allPermissionIds.add(id);
      for (const id of overrides.deniedPermissionIds) allPermissionIds.add(id);
    }

    // Process each tenant in the chain
    let inheritedPermissions = new Set<string>();

    for (let i = 0; i < chain.length; i++) {
      const current = chain[i];
      const isFirst = i === 0;
      const previous = isFirst ? null : chain[i - 1];

      // Check if inheritance is active for this tenant
      const shouldInherit =
        !isFirst && previous?.cascadePermissions && current.inheritPermissions;

      if (shouldInherit) {
        result.inheritanceActive = true;
      }

      // Get this tenant's permission overrides from the batch result
      const overrides = allOverridesMap.get(current.id!) ?? {
        grantedPermissionIds: [],
        deniedPermissionIds: [],
        inheritedPermissionIds: [],
      };

      // Build this tenant's effective permissions
      const currentPermissions = new Set<string>();

      // Track if this tenant actually contributed to the permission set
      let contributed = false;

      // Start with inherited permissions if applicable
      if (shouldInherit && inheritedPermissions.size > 0) {
        for (const permId of inheritedPermissions) {
          currentPermissions.add(permId);
        }
        contributed = true;
      }

      // Apply grants
      for (const permId of overrides.grantedPermissionIds) {
        currentPermissions.add(permId);
        contributed = true;
      }

      // Apply denies (remove) - only counts as contribution if something was actually removed
      for (const permId of overrides.deniedPermissionIds) {
        if (currentPermissions.has(permId)) {
          currentPermissions.delete(permId);
          contributed = true;
        }
      }

      // Only add to contributingTenantIds if this tenant actually affected the final set
      if (contributed && !result.contributingTenantIds.includes(current.id!)) {
        result.contributingTenantIds.push(current.id!);
      }

      // This becomes the inherited set for the next iteration
      inheritedPermissions = currentPermissions;
    }

    // Batch fetch all permissions to get slugs
    if (allPermissionIds.size > 0) {
      const permissionsMap = await this.permissionCollection.findByIds(
        Array.from(allPermissionIds),
      );

      // Convert IDs to slugs in the result
      for (const permId of inheritedPermissions) {
        const perm = permissionsMap.get(permId);
        if (perm?.slug) {
          result.permissions.add(perm.slug);
        }
      }
    }

    return result;
  }

  /**
   * Get the inheritance chain for a tenant (for debugging/display purposes)
   */
  async getTenantInheritanceChain(
    tenantId: string,
  ): Promise<Array<{ tenant: Tenant; inherits: boolean; cascades: boolean }>> {
    const tenant = await this.tenantCollection.get({ id: tenantId });
    if (!tenant) {
      return [];
    }

    const ancestors =
      await this.tenantCollection.getAncestorsFromRoot(tenantId);
    const chain: Array<{
      tenant: Tenant;
      inherits: boolean;
      cascades: boolean;
    }> = [];

    for (let i = 0; i < ancestors.length; i++) {
      const current = ancestors[i];
      const next = i + 1 < ancestors.length ? ancestors[i + 1] : tenant;

      chain.push({
        tenant: current,
        inherits: false, // Root or ancestor doesn't inherit in this context
        cascades: current.cascadePermissions && next.inheritPermissions,
      });
    }

    // Add the target tenant
    chain.push({
      tenant: tenant,
      inherits: tenant.inheritPermissions && ancestors.length > 0,
      cascades: tenant.cascadePermissions,
    });

    return chain;
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

    const tenantPermissions = await this.resolveTenantPermissions(tenantId);
    for (const slug of tenantPermissions.permissions) {
      result.permissions.add(slug);
    }

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

    // 7. Remove denied overrides (DENY takes precedence over tenant, role,
    // group, and granted membership permissions)
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
