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
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import type { Membership } from '../models/Membership.js';
import { MAX_TENANT_HIERARCHY_DEPTH, type Tenant } from '../models/Tenant.js';
import {
  type AncestorReadPolicy,
  getConfiguredAncestorReadPolicy,
  isAncestorReadableSlug,
  type NormalizedAncestorReadPolicy,
  normalizeAncestorReadPolicy,
} from './AncestorReadPolicy.js';

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
  /**
   * Ancestor tenant id the resolving membership belongs to, when resolution
   * used opt-in hierarchical inheritance (no direct membership in the target
   * tenant; nearest ACTIVE ancestor membership whose role has
   * `inheritsToDescendants: true`). `null` for direct-membership resolution.
   */
  inheritedFromTenantId: string | null;
  /**
   * Descendant tenant ids whose memberships contributed declared, read-only
   * permissions under the opt-in ancestor-read policy (smrt#2939). Empty for
   * every resolution that did not use the policy — including every resolution
   * in an application that declares none.
   *
   * These ids report WHY a read operation is authorized at this tenant. They
   * are NOT a row-visibility grant for those tenants: the resolved permission
   * is the operation at the tenant being resolved, and row scoping stays with
   * the tenancy interceptor and RLS.
   */
  ancestorReadFromTenantIds: string[];
}

/**
 * Construction-time options for {@link PermissionResolver}.
 */
export interface PermissionResolverOptions {
  /**
   * Declared ancestor-read policy. When omitted (the default), the resolver
   * reads `packages.users.permissions.ancestorRead` from the application
   * config; when explicitly `null`, the policy is forced OFF regardless of
   * configuration. Pass a literal policy to bind one resolver without
   * touching global config (tests, embedded runtimes).
   */
  ancestorReadPolicy?: AncestorReadPolicy | null;
}

export interface PermissionResolutionOptions {
  /**
   * Membership row already resolved by the caller for this user/tenant.
   * Passing this lets request-scoped session loaders avoid re-querying the
   * same membership row before resolving permissions.
   *
   * Pass the RAW lookup result: an inactive row pins resolution to the empty
   * set (a suspended/pending direct membership stays effective), while an
   * explicit `null` asserts "no direct membership row exists" and makes the
   * resolver consider opt-in ancestor-membership inheritance. Leaving it
   * `undefined` lets the resolver perform its own lookup.
   */
  membership?: Membership | null;
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
  /**
   * Permission slugs explicitly DENY'd by a `TenantPermissionOverride` anywhere
   * in the tenant hierarchy. These are a HARD, tenant-wide block:
   * `resolvePermissions` subtracts them AFTER role + group grants are applied,
   * so a tenant-DENY overrides a permission a role/group otherwise grants. A
   * more-specific membership-override GRANT can still re-add a slug listed here;
   * a membership-override DENY stays absolute. (This set is independent of the
   * net `permissions` above, which only reflects DENY's effect on the inherited
   * cascade.)
   */
  deniedPermissions: Set<string>;
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
 * ## Hierarchical Membership-Role Inheritance (opt-in)
 *
 * Independent of the tenant-level cascade above, membership-role authority
 * can follow the hierarchy DOWN when a role is explicitly flagged
 * `inheritsToDescendants: true`: a user with no direct membership in the
 * target tenant resolves through the nearest ACTIVE ancestor membership
 * holding such a role. A direct membership row in the target tenant always
 * wins (including inactive rows, which resolve empty), child tenant-DENY
 * overrides still subtract from inherited grants, and with no flagged role
 * the resolver behaves exactly as before. See `resolvePermissions`.
 *
 * ## Declared read-only ancestor visibility (opt-in, smrt#2939)
 *
 * Both flows above move authority DOWN. A membership held on a DESCENDANT
 * contributes nothing at an ancestor, so a principal whose only membership is
 * on a child tenant resolves to the empty set at the root. When an application
 * declares `packages.users.permissions.ancestorRead`, such a principal
 * additionally receives the declared `<collection>.read` slugs at the
 * ancestor — read only, listed roles and collections only, bounded by
 * `maxDepth`, intersected with what the descendant role already holds, and
 * only when NO membership authorized the tenant at all. It is never lateral:
 * it authorizes the operation at the ancestor, not visibility of a sibling
 * tenant's rows, which the tenancy interceptor and RLS keep scoped. Off by
 * default. See {@link AncestorReadPolicy}.
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
  private readonly ancestorReadPolicyOverride:
    | AncestorReadPolicy
    | null
    | undefined;
  private membershipCollection!: MembershipCollection;
  private roleCollection!: RoleCollection;
  private rolePermissionCollection!: RolePermissionCollection;
  private membershipOverrideCollection!: MembershipOverrideCollection;
  private groupMemberCollection!: GroupMemberCollection;
  private groupRoleCollection!: GroupRoleCollection;
  private permissionCollection!: PermissionCollection;
  private tenantCollection!: TenantCollection;
  private tenantPermissionOverrideCollection!: TenantPermissionOverrideCollection;

  constructor(
    options: SmrtClassOptions,
    resolverOptions: PermissionResolverOptions = {},
  ) {
    this.options = options;
    this.ancestorReadPolicyOverride = resolverOptions.ancestorReadPolicy;
  }

  /**
   * The effective ancestor-read policy, or `null` when the feature is off.
   *
   * Resolved per call rather than cached on the instance so a configuration
   * change (or a test's `setConfig`) takes effect without rebuilding long-lived
   * resolvers. Resolution itself is uncached — the resolver reads live rows on
   * every call — so there is no permission cache to invalidate when a
   * membership, role, or the policy itself changes; request-scoped contexts
   * pick up the new answer on their next resolution.
   */
  private getAncestorReadPolicy(): NormalizedAncestorReadPolicy | null {
    if (this.ancestorReadPolicyOverride === null) {
      return null;
    }
    if (this.ancestorReadPolicyOverride !== undefined) {
      return normalizeAncestorReadPolicy(this.ancestorReadPolicyOverride);
    }
    return getConfiguredAncestorReadPolicy();
  }

  /**
   * Initialize collections
   *
   * Each collection is created via the inherited static `SmrtCollection.create()`
   * factory, which is generically typed to return the concrete subclass instance.
   */
  async initialize(): Promise<void> {
    this.membershipCollection = await MembershipCollection.create(this.options);
    this.roleCollection = await RoleCollection.create(this.options);
    this.rolePermissionCollection = await RolePermissionCollection.create(
      this.options,
    );
    this.membershipOverrideCollection =
      await MembershipOverrideCollection.create(this.options);
    this.groupMemberCollection = await GroupMemberCollection.create(
      this.options,
    );
    this.groupRoleCollection = await GroupRoleCollection.create(this.options);
    this.permissionCollection = await PermissionCollection.create(this.options);
    this.tenantCollection = await TenantCollection.create(this.options);
    this.tenantPermissionOverrideCollection =
      await TenantPermissionOverrideCollection.create(this.options);
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
      deniedPermissions: new Set<string>(),
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

    // Build a set of permission IDs for batch lookup. Also track every
    // tenant-level DENY id across the chain: tenant-DENY is a hard, tenant-wide
    // block that `resolvePermissions` subtracts from role/group grants too, so
    // it must be reported independently of the net inherited `permissions` set
    // (which only reflects DENY's effect on the cascade, not on roles).
    const allPermissionIds = new Set<string>();
    const deniedPermissionIds = new Set<string>();
    for (const overrides of allOverridesMap.values()) {
      for (const id of overrides.grantedPermissionIds) allPermissionIds.add(id);
      for (const id of overrides.deniedPermissionIds) {
        allPermissionIds.add(id);
        deniedPermissionIds.add(id);
      }
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

      // Record the slugs DENY'd at any tenant level so callers can enforce the
      // hard tenant-wide block over role/group grants — but NET against the
      // cascade's own resolution: a slug a more-specific tenant GRANT re-added
      // (so it survives in the net-granted `inheritedPermissions`) must NOT be
      // in the hard-block set, because the cascade already decided GRANT
      // (most-specific wins). Without this guard a parent-DENY + child-GRANT
      // slug would wrongly override the child GRANT and any role/group grant.
      for (const permId of deniedPermissionIds) {
        if (inheritedPermissions.has(permId)) continue;
        const perm = permissionsMap.get(permId);
        if (perm?.slug) {
          result.deniedPermissions.add(perm.slug);
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
   * Resolve all effective permissions for a user in a tenant.
   *
   * Precedence (broad -> specific, most-specific wins):
   *   tenant-inherited (cascade)
   *     -> role
   *     -> group roles
   *     -> tenant-DENY      (removes; overrides role/group grants, tenant-wide)
   *     -> membership GRANT (re-adds; most specific, can win over a tenant-DENY)
   *     -> membership DENY  (absolute; always wins)
   *
   * ## Membership selection
   *
   * A direct membership row in the target tenant always pins resolution to
   * itself: active rows resolve normally, inactive (pending/suspended) rows
   * resolve to the empty set — an explicit direct membership is authoritative
   * even when it attenuates or suspends a user who holds broader authority on
   * an ancestor tenant.
   *
   * Only when NO direct membership row exists does the resolver consider
   * opt-in hierarchical inheritance: it walks the tenant's ancestors (nearest
   * first) and resolves through the nearest ACTIVE ancestor membership whose
   * role has `inheritsToDescendants: true`. All later layers then run
   * unchanged against the TARGET tenant — the tenant cascade and tenant-DENY
   * block come from the target tenant (so a child tenant can still carve
   * authority out of an inherited role), group roles remain exact-tenant
   * (only groups the user belongs to in the target tenant contribute), and
   * membership GRANT/DENY overrides travel with the ancestor membership used.
   * With no role flagged `inheritsToDescendants`, resolution is identical to
   * the pre-inheritance behavior.
   *
   * Algorithm:
   * 1. Get membership (direct, or nearest inheritable ancestor membership)
   *    and collect all permission IDs from all sources
   * 2. Batch fetch all permissions in a single query
   * 3. Apply permissions from role, then groups
   * 4. Subtract tenant-level DENY'd slugs (hard tenant-wide block)
   * 5. Apply membership GRANT overrides (can re-add a tenant-DENY'd slug)
   * 6. Subtract membership DENY overrides (absolute precedence)
   */
  async resolvePermissions(
    userId: string,
    tenantId: string,
    options: PermissionResolutionOptions = {},
  ): Promise<PermissionResolutionResult> {
    const result: PermissionResolutionResult = {
      permissions: new Set<string>(),
      membershipId: null,
      roleId: null,
      groupIds: [],
      deniedPermissionIds: [],
      inheritedFromTenantId: null,
      ancestorReadFromTenantIds: [],
    };

    // 1. Get membership, reusing a request-scoped row when the caller already
    // resolved it for this exact user/tenant.
    let membership =
      options.membership === undefined
        ? await this.membershipCollection.findByUserAndTenant(userId, tenantId)
        : options.membership;

    if (membership) {
      // A direct membership row pins resolution to itself: a mismatched
      // caller-provided row is rejected, and an inactive row resolves empty
      // (suspension/pending in the target tenant is effective even for users
      // holding inheritable authority on an ancestor).
      if (membership.userId !== userId || membership.tenantId !== tenantId) {
        return result;
      }
      if (!membership.isActive()) {
        return result;
      }
    } else {
      // No direct membership row: opt-in nearest-ancestor inheritance.
      membership = await this.resolveInheritedMembership(userId, tenantId);
      if (!membership) {
        // Last resort: the opt-in, declared, read-only ancestor-read policy.
        // This runs ONLY when no membership authorized this tenant at all, so
        // it can never widen, re-add, or override authority a direct or
        // inherited membership already decided.
        return await this.applyAncestorReadPolicy(userId, tenantId, result);
      }
      result.inheritedFromTenantId = membership.tenantId ?? null;
    }

    result.membershipId = membership.id ?? null;
    result.roleId = membership.roleId ?? null;

    const tenantPermissions = await this.resolveTenantPermissions(tenantId);
    for (const slug of tenantPermissions.permissions) {
      result.permissions.add(slug);
    }

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

    // 6. Subtract tenant-level DENY'd slugs. A tenant-DENY is a HARD,
    // tenant-wide block that overrides role and group grants too — sitting just
    // above the most-specific membership overrides in precedence. It runs
    // BEFORE the membership GRANT pass so a more-specific membership GRANT (step
    // 7) can deliberately re-add a slug a tenant DENYs.
    for (const slug of tenantPermissions.deniedPermissions) {
      result.permissions.delete(slug);
    }

    // 7. Apply granted membership overrides (most specific GRANT; can re-add a
    // tenant-DENY'd slug).
    for (const permId of grantedPermissionIds) {
      const slug = permissionIdToSlug.get(permId);
      if (slug) {
        result.permissions.add(slug);
      }
    }

    // 8. Remove denied membership overrides (DENY takes absolute precedence over
    // tenant, role, group, and granted membership permissions).
    for (const permId of deniedPermissionIds) {
      const slug = permissionIdToSlug.get(permId);
      if (slug) {
        result.permissions.delete(slug);
      }
    }

    return result;
  }

  /**
   * The permission slugs a role grants through the role-permission catalog,
   * excluding every per-tenant, per-group, and per-membership override.
   */
  private async getRolePermissionSlugs(roleId: string): Promise<Set<string>> {
    const slugs = new Set<string>();
    if (!roleId) {
      return slugs;
    }
    const permissionIds =
      await this.rolePermissionCollection.getPermissionIds(roleId);
    if (permissionIds.length === 0) {
      return slugs;
    }
    const permissionsMap =
      await this.permissionCollection.findByIds(permissionIds);
    for (const permission of permissionsMap.values()) {
      if (permission?.slug) {
        slugs.add(permission.slug);
      }
    }
    return slugs;
  }

  /**
   * Contribute declared, read-only permissions from the user's memberships on
   * DESCENDANTS of the tenant being resolved (smrt#2939).
   *
   * Reached only when the user has neither a direct membership in `tenantId`
   * nor an inheritable ancestor membership — so this never competes with, or
   * re-adds to, an authority decision already made. With no declared policy
   * (the default) it returns the untouched empty result, which is exactly the
   * pre-policy behavior.
   *
   * What it grants and what it does NOT:
   *
   * - It grants the `<collection>.read` OPERATION at `tenantId`, intersected
   *   with BOTH the declared role's own catalog grants AND the principal's
   *   effective permissions in the contributing tenant. The role bound keeps
   *   the contribution inside what the ancestor declared, so a descendant
   *   administrator cannot widen it with a tenant GRANT, a group role, or a
   *   membership GRANT; the effective bound makes a membership DENY or a
   *   descendant-tenant DENY effective here too. Nothing that is not a `read`
   *   on a declared collection can pass ({@link isAncestorReadableSlug}).
   * - It does NOT grant visibility of any tenant's rows. A principal reading a
   *   tenant-scoped collection is still filtered by the tenancy interceptor and
   *   Postgres RLS to the tenant its context is bound to, so a member of child
   *   A authorized at the root still cannot read sibling child B's rows. Row
   *   scoping is the executor's job; this is authorization only.
   * - It is never lateral: only a STRICT ANCESTOR of the membership's tenant,
   *   within `maxDepth` hops, is affected. A sibling shares no such
   *   relationship and is unreachable by construction.
   * - Only a governed SYSTEM role (`tenantId` null, `isSystem: true`) can
   *   contribute, so a descendant tenant cannot opt itself in by minting a
   *   custom role whose slug collides with a declared one.
   *
   * A tenant-level DENY on the resolved tenant still subtracts, keeping the
   * tenant's own hard block authoritative over an inherited read.
   */
  private async applyAncestorReadPolicy(
    userId: string,
    tenantId: string,
    result: PermissionResolutionResult,
  ): Promise<PermissionResolutionResult> {
    const policy = this.getAncestorReadPolicy();
    if (!policy) {
      return result;
    }

    // Candidate memberships: the user's ACTIVE rows on some other tenant.
    const activeMemberships =
      await this.membershipCollection.findActiveByUser(userId);
    const candidates = activeMemberships.filter(
      (row) =>
        row.userId === userId &&
        !!row.roleId &&
        !!row.tenantId &&
        row.tenantId !== tenantId,
    );
    if (candidates.length === 0) {
      return result;
    }

    // Keep only memberships whose role slug is explicitly declared. Doing this
    // before any hierarchy work also bounds the tenant loads below.
    const roleIds = [...new Set(candidates.map((row) => row.roleId as string))];
    const roles = await this.roleCollection.listByIds(roleIds);
    const declaredRoleIds = new Set<string>();
    for (const role of roles) {
      const slug = typeof role.slug === 'string' ? role.slug.toLowerCase() : '';
      if (!role.id || !slug || !policy.roleSlugs.has(slug)) {
        continue;
      }
      // The declaration names a role SLUG, and slugs are not unique across a
      // hierarchy: a tenant-scoped custom role is created by whoever
      // administers that tenant, so a descendant could otherwise mint a role
      // named `member` and opt ITSELF into the ancestor's allow-list. Only a
      // governed SYSTEM role — `tenantId` null and `isSystem: true`, i.e. what
      // `RoleCollection.seedSystemRoles()` creates and what tenant
      // administration cannot forge or delete — can contribute upward. The
      // downward `inheritsToDescendants` flow has no equivalent exposure
      // because it flags the specific role row rather than matching a name.
      if (role.isSystem !== true) {
        continue;
      }
      if (role.tenantId !== null && role.tenantId !== undefined) {
        continue;
      }
      declaredRoleIds.add(role.id);
    }
    if (declaredRoleIds.size === 0) {
      return result;
    }

    const declaredCandidates = candidates.filter(
      (row) => row.roleId && declaredRoleIds.has(row.roleId),
    );
    if (declaredCandidates.length === 0) {
      return result;
    }

    // Verify each candidate tenant really is a descendant of `tenantId`,
    // link-by-link against loaded `parentTenantId` rows. The materialized
    // `hierarchyPath` is an authorization source here, so a stale, malformed,
    // or over-deep path fails closed exactly as the downward walk does.
    const candidateTenantIds = [
      ...new Set(declaredCandidates.map((row) => row.tenantId as string)),
    ];
    const candidateTenants =
      await this.tenantCollection.listByIds(candidateTenantIds);
    const verifiedDescendantIds = new Set<string>();
    for (const candidateTenant of candidateTenants) {
      if (
        await this.isVerifiedDescendantOf(
          candidateTenant,
          tenantId,
          policy.maxDepth,
        )
      ) {
        verifiedDescendantIds.add(candidateTenant.id as string);
      }
    }
    if (verifiedDescendantIds.size === 0) {
      return result;
    }

    const contributingMemberships = declaredCandidates.filter(
      (row) => row.tenantId && verifiedDescendantIds.has(row.tenantId),
    );
    if (contributingMemberships.length === 0) {
      return result;
    }

    // A slug travels upward only if it survives BOTH bounds: the declared
    // role's own catalog grants, and the principal's effective permissions in
    // the contributing tenant. The first keeps the contribution inside what
    // the ancestor declared; the second makes every DENY at home effective
    // here. Either alone is exploitable by the descendant tenant's own
    // administrator, in opposite directions.
    const granted = new Set<string>();
    const contributingTenantIds: string[] = [];
    for (const contributing of contributingMemberships) {
      const contributingTenantId = contributing.tenantId as string;

      // The DECLARED bound: the catalog grants of the declared system role
      // itself. The effective set below is a union of four sources, three of
      // which a descendant tenant's own administrator controls — that tenant's
      // TenantPermissionOverride GRANTs, its group roles (which may be bound
      // to tenant-scoped custom roles), and membership GRANT overrides. Taking
      // the effective set alone would let that administrator widen what
      // travels upward beyond the role the ancestor actually declared, which
      // is the same escalation the system-role requirement above closes for
      // slug collisions.
      const roleGrantSlugs = await this.getRolePermissionSlugs(
        contributing.roleId as string,
      );
      if (roleGrantSlugs.size === 0) {
        continue;
      }

      // The EFFECTIVE bound: what the principal actually holds in that tenant,
      // so a membership DENY or a descendant-tenant DENY that removed the
      // permission at home removes it here too.
      //
      // This cannot recurse: the contributing membership is passed explicitly,
      // so resolving the descendant takes the direct-membership branch and
      // never re-enters this policy.
      const own = await this.resolvePermissions(userId, contributingTenantId, {
        membership: contributing,
      });

      let contributed = false;
      for (const slug of own.permissions) {
        if (!roleGrantSlugs.has(slug)) {
          continue;
        }
        if (isAncestorReadableSlug(slug, policy)) {
          granted.add(slug);
          contributed = true;
        }
      }
      if (contributed) {
        contributingTenantIds.push(contributingTenantId);
      }
    }
    if (granted.size === 0) {
      return result;
    }

    // A tenant-level DENY on the tenant being resolved still wins.
    const tenantPermissions = await this.resolveTenantPermissions(tenantId);
    for (const slug of tenantPermissions.deniedPermissions) {
      granted.delete(slug);
    }
    if (granted.size === 0) {
      return result;
    }

    for (const slug of granted) {
      result.permissions.add(slug);
    }
    result.ancestorReadFromTenantIds = contributingTenantIds
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort();

    return result;
  }

  /**
   * True when `candidate` is a verified STRICT descendant of `ancestorId`,
   * no more than `maxDepth` hops below it.
   *
   * Uses the materialized `hierarchyPath` to locate the relationship, then
   * proves it by loading the whole chain and requiring an unbroken
   * `parentTenantId` link root -> ... -> candidate. Over-deep, self-
   * referential, duplicated, or inconsistent paths return false.
   */
  private async isVerifiedDescendantOf(
    candidate: Tenant | undefined,
    ancestorId: string,
    maxDepth: number,
  ): Promise<boolean> {
    if (!candidate?.id || candidate.id === ancestorId) {
      return false;
    }

    const ancestorIds = candidate.getAncestorIds();
    if (
      ancestorIds.length === 0 ||
      ancestorIds.length >= MAX_TENANT_HIERARCHY_DEPTH ||
      ancestorIds.includes(candidate.id) ||
      new Set(ancestorIds).size !== ancestorIds.length
    ) {
      return false;
    }

    const position = ancestorIds.indexOf(ancestorId);
    if (position < 0) {
      return false;
    }

    // Hops from the candidate up to the named ancestor. The immediate parent
    // is the last path entry, i.e. one hop.
    const depth = ancestorIds.length - position;
    if (depth > maxDepth) {
      return false;
    }

    const ancestors = await this.tenantCollection.listByIds(ancestorIds);
    const ancestorsById = new Map(
      ancestors.map((ancestor) => [ancestor.id, ancestor]),
    );
    let expectedParentId: string | null = null;
    for (const id of ancestorIds) {
      const ancestor = ancestorsById.get(id);
      if (!ancestor?.id) {
        return false;
      }
      if ((ancestor.parentTenantId ?? null) !== expectedParentId) {
        return false;
      }
      expectedParentId = ancestor.id;
    }

    return (candidate.parentTenantId ?? null) === expectedParentId;
  }

  /**
   * Find the membership to resolve through when the user has no direct
   * membership row in the target tenant.
   *
   * Walks the target tenant's ancestor chain (from the materialized
   * `hierarchyPath`, nearest ancestor first) and returns the nearest ACTIVE
   * ancestor membership whose role is explicitly flagged
   * `inheritsToDescendants: true`. Ancestor memberships that are inactive or
   * hold an unflagged role are skipped — they neither confer nor block
   * inheritance from higher ancestors. Attenuating a user in a specific
   * tenant is expressed with a direct membership row there (which pins
   * resolution) or a tenant-level DENY, not with an intermediate unflagged
   * membership.
   *
   * Fails closed (returns null, resolving to the empty set) when the tenant
   * is missing or its `hierarchyPath` is malformed: deeper than
   * `MAX_TENANT_HIERARCHY_DEPTH`, self-referential, containing duplicate
   * ancestor ids, or inconsistent with the actual `parentTenantId` chain
   * (e.g. a stale path naming an unrelated tenant).
   */
  private async resolveInheritedMembership(
    userId: string,
    tenantId: string,
  ): Promise<Membership | null> {
    const tenant = await this.tenantCollection.get({ id: tenantId });
    if (!tenant?.id) {
      return null;
    }

    // Ordered root -> immediate parent, per the materialized path.
    const ancestorIds = tenant.getAncestorIds();
    if (ancestorIds.length === 0) {
      return null;
    }

    // Malformed hierarchy paths fail closed: a well-formed path is bounded by
    // MAX_TENANT_HIERARCHY_DEPTH (at most MAX-1 ancestors), never contains the
    // tenant itself, and never repeats an ancestor.
    if (
      ancestorIds.length >= MAX_TENANT_HIERARCHY_DEPTH ||
      ancestorIds.includes(tenant.id) ||
      new Set(ancestorIds).size !== ancestorIds.length
    ) {
      return null;
    }

    // The materialized path is an authorization source here, so verify it
    // against the actual parent chain before trusting it: batch-load the
    // ancestors and require an unbroken parentTenantId link
    // root -> ... -> immediate parent -> target. A stale or inconsistent path
    // (e.g. naming a tenant that is not really an ancestor) fails closed.
    const ancestors = await this.tenantCollection.listByIds(ancestorIds);
    const ancestorsById = new Map(
      ancestors.map((ancestor) => [ancestor.id, ancestor]),
    );
    let expectedParentId: string | null = null;
    for (const ancestorId of ancestorIds) {
      const ancestor = ancestorsById.get(ancestorId);
      if (!ancestor?.id) {
        return null;
      }
      if ((ancestor.parentTenantId ?? null) !== expectedParentId) {
        return null;
      }
      expectedParentId = ancestor.id;
    }
    if ((tenant.parentTenantId ?? null) !== expectedParentId) {
      return null;
    }

    // One query for the user's ACTIVE memberships, intersected with the
    // ancestor chain. UNIQUE(userId, tenantId) guarantees at most one row per
    // ancestor.
    const activeMemberships =
      await this.membershipCollection.findActiveByUser(userId);
    if (activeMemberships.length === 0) {
      return null;
    }
    const membershipByTenantId = new Map<string, Membership>();
    for (const row of activeMemberships) {
      if (row.tenantId && row.userId === userId) {
        membershipByTenantId.set(row.tenantId, row);
      }
    }

    // Candidates ordered nearest ancestor first.
    const candidates: Membership[] = [];
    for (let i = ancestorIds.length - 1; i >= 0; i--) {
      const candidate = membershipByTenantId.get(ancestorIds[i]);
      if (candidate?.roleId) {
        candidates.push(candidate);
      }
    }
    if (candidates.length === 0) {
      return null;
    }

    // Batch load candidate roles; only an explicit `inheritsToDescendants:
    // true` role confers inheritance, and the nearest such membership wins.
    const roleIds = [
      ...new Set(candidates.map((candidate) => candidate.roleId as string)),
    ];
    const roles = await this.roleCollection.listByIds(roleIds);
    const inheritableRoleIds = new Set<string>();
    for (const role of roles) {
      if (role.id && role.inheritsToDescendants === true) {
        inheritableRoleIds.add(role.id);
      }
    }

    for (const candidate of candidates) {
      if (candidate.roleId && inheritableRoleIds.has(candidate.roleId)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Check if a user has a specific permission in a tenant
   */
  async hasPermission(
    userId: string,
    tenantId: string,
    permissionSlug: string,
    options: PermissionResolutionOptions = {},
  ): Promise<boolean> {
    const result = await this.resolvePermissions(userId, tenantId, options);
    return result.permissions.has(permissionSlug);
  }

  /**
   * Check if a user has all of the specified permissions
   */
  async hasAllPermissions(
    userId: string,
    tenantId: string,
    permissionSlugs: string[],
    options: PermissionResolutionOptions = {},
  ): Promise<boolean> {
    const result = await this.resolvePermissions(userId, tenantId, options);
    return permissionSlugs.every((slug) => result.permissions.has(slug));
  }

  /**
   * Check if a user has any of the specified permissions
   */
  async hasAnyPermission(
    userId: string,
    tenantId: string,
    permissionSlugs: string[],
    options: PermissionResolutionOptions = {},
  ): Promise<boolean> {
    const result = await this.resolvePermissions(userId, tenantId, options);
    return permissionSlugs.some((slug) => result.permissions.has(slug));
  }

  /**
   * Static factory method
   */
  static async create(
    options: SmrtClassOptions,
    resolverOptions: PermissionResolverOptions = {},
  ): Promise<PermissionResolver> {
    const resolver = new PermissionResolver(options, resolverOptions);
    await resolver.initialize();
    return resolver;
  }
}
