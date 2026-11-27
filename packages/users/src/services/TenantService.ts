/**
 * TenantService - Manages tenant creation with configurable policies
 * @packageDocumentation
 */

import {
  isEmbeddedDatabase,
  type SmrtClassOptions,
  type SmrtCollectionOptions,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { CliAuthRequestCollection } from '../collections/CliAuthRequestCollection.js';
import { GroupCollection } from '../collections/GroupCollection.js';
import { GroupMemberCollection } from '../collections/GroupMemberCollection.js';
import { GroupRoleCollection } from '../collections/GroupRoleCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { MembershipOverrideCollection } from '../collections/MembershipOverrideCollection.js';
import { ResourceGrantCollection } from '../collections/ResourceGrantCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantGuestGrantCollection } from '../collections/TenantGuestGrantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import type { Membership } from '../models/Membership.js';
import type { Tenant } from '../models/Tenant.js';
import {
  DEFAULT_ROLE_SLUGS,
  DEFAULT_TENANT_POLICY,
  MembershipStatus,
  type TenantPolicy,
} from '../types/index.js';
import { withoutListBounds } from './authorization-read-options.js';

/** Delete every row of `rows` (already loaded), one by one so hooks fire. */
async function deleteAll(rows: Array<{ delete(): Promise<unknown> }>) {
  for (const row of rows) await row.delete();
}

/**
 * Remove every row that references `tenantId`, children before parents. Runs
 * inside the caller's transaction (`options.db` is the tx handle).
 * See {@link TenantService.deleteTenant} for the per-table decisions.
 */
async function removeTenantDependents(
  options: SmrtCollectionOptions,
  tenantId: string,
): Promise<void> {
  const where = { tenantId };

  // Sessions first: CLI auth requests reference them.
  const sessions = await (await SessionCollection.create(options)).list({
    where,
  });
  const cliRequests = await CliAuthRequestCollection.create(options);
  await deleteAll(await cliRequests.list({ where }));
  for (const session of sessions) {
    // `sessionId` is sensitive, so it cannot be a list() filter.
    await cliRequests.db.query(
      `DELETE FROM ${cliRequests.tableName} WHERE session_id = ?`,
      session.id,
    );
  }
  await deleteAll(sessions);

  // Memberships (and the invitations that are memberships) and overrides.
  const memberships = await MembershipCollection.create(options);
  const overrides = await MembershipOverrideCollection.create(options);
  for (const membership of await memberships.findByTenant(tenantId)) {
    await deleteAll(
      await overrides.list({
        where: { membershipId: membership.id as string },
      }),
    );
    await membership.delete();
  }

  // Groups with their members and roles.
  const groups = await GroupCollection.create(options);
  const groupMembers = await GroupMemberCollection.create(options);
  const groupRoles = await GroupRoleCollection.create(options);
  for (const group of await groups.list({ where })) {
    const groupId = group.id as string;
    await deleteAll(await groupMembers.list({ where: { groupId } }));
    await deleteAll(await groupRoles.list({ where: { groupId } }));
    await group.delete();
  }

  // Tenant-scoped roles (system roles have no tenant).
  const roles = await RoleCollection.create(options);
  const rolePermissions = await RolePermissionCollection.create(options);
  for (const role of await roles.findTenantRoles(tenantId)) {
    await deleteAll(
      await rolePermissions.list({ where: { roleId: role.id as string } }),
    );
    await role.delete();
  }

  // Resource grants form a tree through parentGrantId: delete leaves first.
  const resourceGrants = await (
    await ResourceGrantCollection.create(options)
  ).list({ where });
  let remaining = resourceGrants;
  while (remaining.length > 0) {
    const referenced = new Set(remaining.map((g) => g.parentGrantId));
    const leaves = remaining.filter((g) => !referenced.has(g.id as string));
    if (leaves.length === 0) {
      throw new Error('Resource grant hierarchy is cyclic.');
    }
    await deleteAll(leaves);
    remaining = remaining.filter((g) => !leaves.includes(g));
  }

  await deleteAll(
    await (
      await TenantPermissionOverrideCollection.create(options)
    ).findByTenant(tenantId),
  );
  await deleteAll(
    await (await TenantGuestGrantCollection.create(options)).findByTenant(
      tenantId,
    ),
  );
}

/**
 * Result of tenant creation with ownership
 */
export interface TenantWithOwnershipResult {
  tenant: Tenant;
  membership: Membership;
}

/**
 * Result of ensureTenantForUser
 */
export interface EnsureTenantResult {
  /** The tenant (null if flexible mode and no existing tenant) */
  tenant: Tenant | null;
  /** The membership (null if no tenant) */
  membership: Membership | null;
  /** Whether a new tenant was created */
  created: boolean;
}

/**
 * TenantService manages tenant creation with configurable policies.
 *
 * Policies:
 * - `flexible`: No tenant created on signup, user can have zero tenants
 * - `personal`: Auto-create personal tenant on first login, can delete all
 * - `required`: Auto-create personal tenant, must keep at least one
 *
 * @example
 * ```typescript
 * const tenantService = new TenantService(options, {
 *   mode: 'personal',
 *   maxTenants: 5,
 *   defaultName: 'My Workspace',
 * });
 * await tenantService.initialize();
 *
 * // During OIDC login
 * const { tenant, membership, created } = await tenantService.ensureTenantForUser(
 *   user.id,
 *   { email: user.email, name: user.name }
 * );
 *
 * // Creating additional tenants
 * if (await tenantService.canCreateTenant(user.id)) {
 *   const { tenant } = await tenantService.createTenantWithOwnership(
 *     user.id,
 *     'New Organization'
 *   );
 * }
 * ```
 */
export class TenantService {
  private options: SmrtClassOptions;
  private policy: TenantPolicy;
  private tenantCollection!: TenantCollection;
  private membershipCollection!: MembershipCollection;
  private roleCollection!: RoleCollection;

  constructor(options: SmrtClassOptions, policy?: TenantPolicy) {
    this.options = options;
    this.policy = policy ?? DEFAULT_TENANT_POLICY;
  }

  /**
   * Initialize collections
   */
  async initialize(): Promise<void> {
    // Tenant quota and ownership checks count memberships; a list bound in
    // the caller's options would undercount and lift maxTenants (#3048).
    const options = withoutListBounds(this.options);
    this.tenantCollection = await TenantCollection.create(options);
    this.membershipCollection = await MembershipCollection.create(options);
    this.roleCollection = await RoleCollection.create(options);

    // Seed system roles if needed
    await this.roleCollection.seedSystemRoles();
  }

  /**
   * Get the current policy
   */
  getPolicy(): TenantPolicy {
    return { ...this.policy };
  }

  /**
   * Create a tenant and make the user the owner
   *
   * @param userId - The user to make owner
   * @param name - Tenant name
   * @param options - Optional slug override and trusted provisioning identities
   * @returns The created tenant and membership
   */
  async createTenantWithOwnership(
    userId: string,
    name: string,
    options?: {
      slug?: string;
      /** Server-owned IDs only. Use the caller's provisioning transaction. */
      reservedIdentity?: { tenantId?: string; membershipId?: string };
    },
  ): Promise<TenantWithOwnershipResult> {
    // Check if user can create
    if (!(await this.canCreateTenant(userId))) {
      throw new Error(
        `User has reached maximum tenant limit (${this.policy.maxTenants})`,
      );
    }

    const ownerRole = await this.roleCollection.findSystemRoleBySlug(
      DEFAULT_ROLE_SLUGS.OWNER,
    );
    if (!ownerRole?.id) {
      throw new Error('Owner role not found - run seedSystemRoles first');
    }

    const identity = options?.reservedIdentity;
    const tenant = await this.tenantCollection.create({
      id: identity?.tenantId,
      _insertOnly: identity !== undefined,
      name,
      slug: options?.slug,
    });
    const membership = await this.membershipCollection.create({
      id: identity?.membershipId,
      _insertOnly: identity !== undefined,
      userId,
      tenantId: tenant.id as string,
      roleId: ownerRole.id,
      status: MembershipStatus.ACTIVE,
    });

    return { tenant, membership };
  }

  /**
   * Check if a user can create a new tenant
   *
   * Returns false if maxTenants limit is reached (0 = unlimited)
   */
  async canCreateTenant(userId: string): Promise<boolean> {
    if (this.policy.maxTenants === 0) {
      return true; // Unlimited
    }

    const ownerRole = await this.roleCollection.findSystemRoleBySlug(
      DEFAULT_ROLE_SLUGS.OWNER,
    );
    if (!ownerRole) {
      // Fail closed if owner role is not configured
      return false;
    }

    const memberships =
      await this.membershipCollection.findActiveByUser(userId);
    const ownedCount = memberships.filter(
      (m) => m.roleId === ownerRole.id,
    ).length;

    return ownedCount < this.policy.maxTenants;
  }

  /**
   * Get a specific error message explaining why a tenant cannot be deleted.
   *
   * @returns Error message if deletion is not allowed, or null if allowed.
   */
  private async getDeleteTenantError(
    userId: string,
    tenantId: string,
  ): Promise<string | null> {
    // Check user has an active membership for this tenant
    const membership = await this.membershipCollection.findByUserAndTenant(
      userId,
      tenantId,
    );
    if (!membership || membership.status !== MembershipStatus.ACTIVE) {
      return 'You are not a member of this tenant or it does not exist.';
    }

    const ownerRole = await this.roleCollection.findSystemRoleBySlug(
      DEFAULT_ROLE_SLUGS.OWNER,
    );
    if (!ownerRole) {
      return 'Owner role is not configured. Cannot determine deletion permissions.';
    }

    if (membership.roleId !== ownerRole.id) {
      return 'Only the tenant owner can delete this tenant.';
    }

    // For 'required' policy, check if this is the last tenant
    if (this.policy.mode === 'required') {
      const allMemberships =
        await this.membershipCollection.findActiveByUser(userId);
      const ownerMemberships = allMemberships.filter(
        (m) => m.roleId === ownerRole.id,
      );

      if (ownerMemberships.length <= 1) {
        return 'Cannot delete your last tenant. Policy requires at least one tenant.';
      }
    }

    return null;
  }

  /**
   * Check if a user can delete a specific tenant
   *
   * Returns false if:
   * - User is not an active member
   * - User is not the owner
   * - Policy is 'required' and this is the last tenant
   */
  async canDeleteTenant(userId: string, tenantId: string): Promise<boolean> {
    const error = await this.getDeleteTenantError(userId, tenantId);
    return error === null;
  }

  /**
   * Delete a tenant
   *
   * Everything that references the tenant is removed in the SAME transaction
   * as the tenant (the foreign keys are NO ACTION, there is no CASCADE), so a
   * failed delete leaves all of it in place. The set below mirrors every table
   * with a foreign key to `tenants` in this package; a test walks the schema
   * and fails when a new one appears without a decision here.
   *
   * Deleted with the tenant (the data is meaningless without it):
   * - guest grants (#5196) and permission overrides;
   * - memberships (this is also how pending invitations go: an invitation is
   *   a membership row) and their membership overrides;
   * - sessions bound to the tenant (the holders are signed out; child
   *   sessions fall with their parent) and CLI auth requests for the tenant
   *   or for one of those sessions;
   * - groups with their members and group roles;
   * - tenant-scoped roles with their role permissions (system roles have no
   *   tenant and stay);
   * - resource grants, leaves first.
   *
   * Refused (nothing is deleted): a tenant that still has child tenants, since
   * deleting a whole subtree is a separate, explicit decision. A role of this
   * tenant still referenced from outside it also fails the delete.
   *
   * Other packages that reference the tenant are not touched; a remaining
   * reference fails the whole delete.
   *
   * @throws Error if user cannot delete the tenant (with specific reason)
   */
  async deleteTenant(userId: string, tenantId: string): Promise<void> {
    const error = await this.getDeleteTenantError(userId, tenantId);
    if (error) {
      throw new Error(error);
    }

    const db = this.tenantCollection.db;
    if (typeof db.transaction !== 'function') {
      throw new Error(
        'Deleting a tenant requires database transaction support.',
      );
    }
    await withEmbeddedWriteTransaction(
      db,
      isEmbeddedDatabase(db),
      async (tx) => {
        const options = { ...withoutListBounds(this.options), db: tx };
        const tenants = await TenantCollection.create(options);
        const children = await tenants.list({
          where: { parentTenantId: tenantId },
          limit: 1,
        });
        if (children.length > 0) {
          throw new Error(
            'Cannot delete a tenant that has child tenants. Delete or move them first.',
          );
        }
        await removeTenantDependents(options, tenantId);
        const tenant = await tenants.get(tenantId);
        if (tenant) {
          await tenant.delete();
        }
      },
    );
  }

  /**
   * Ensure a tenant exists for the user based on policy
   *
   * Called during OIDC login to apply tenant policy:
   * - `flexible`: Returns first existing tenant or null (no auto-create)
   * - `personal`/`required`: Creates default tenant if none exists
   *
   * @param userId - The user ID
   * @param userInfo - User info for naming the auto-created tenant
   * @returns Tenant and membership (may be null in flexible mode)
   */
  async ensureTenantForUser(
    userId: string,
    userInfo: { email?: string; name?: string },
  ): Promise<EnsureTenantResult> {
    // Get existing memberships
    const memberships =
      await this.membershipCollection.findActiveByUser(userId);

    // If user has tenants, return the first one
    if (memberships.length > 0) {
      const firstMembership = memberships[0];
      const tenant = await this.tenantCollection.get(
        firstMembership.tenantId as string,
      );

      return {
        tenant: tenant ?? null,
        membership: firstMembership,
        created: false,
      };
    }

    // No existing tenants - apply policy
    if (this.policy.mode === 'flexible') {
      // Flexible mode: don't auto-create
      return {
        tenant: null,
        membership: null,
        created: false,
      };
    }

    // Personal or required mode: create default tenant
    // Use user's name for personalized tenant name, or fall back to policy default
    const tenantName = userInfo.name
      ? `${userInfo.name}'s Workspace`
      : this.policy.defaultName;

    const { tenant, membership } = await this.createTenantWithOwnership(
      userId,
      tenantName,
    );

    return {
      tenant,
      membership,
      created: true,
    };
  }

  /**
   * Get all tenants for a user (where they are owner)
   */
  async getOwnedTenants(userId: string): Promise<Tenant[]> {
    const ownerRole = await this.roleCollection.findSystemRoleBySlug(
      DEFAULT_ROLE_SLUGS.OWNER,
    );
    if (!ownerRole) {
      return [];
    }

    const memberships =
      await this.membershipCollection.findActiveByUser(userId);
    const ownerMemberships = memberships.filter(
      (m) => m.roleId === ownerRole.id,
    );

    // Fetch all tenants in parallel to avoid N+1 queries
    const tenantPromises = ownerMemberships.map((m) =>
      this.tenantCollection.get(m.tenantId as string),
    );
    const tenantsOrNull = await Promise.all(tenantPromises);

    return tenantsOrNull.filter((tenant): tenant is Tenant => tenant !== null);
  }

  /**
   * Static factory method
   */
  static async create(
    options: SmrtClassOptions,
    policy?: TenantPolicy,
  ): Promise<TenantService> {
    const service = new TenantService(options, policy);
    await service.initialize();
    return service;
  }
}
