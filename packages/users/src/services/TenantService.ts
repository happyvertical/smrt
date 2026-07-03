/**
 * TenantService - Manages tenant creation with configurable policies
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import type { Membership } from '../models/Membership.js';
import type { Tenant } from '../models/Tenant.js';
import {
  DEFAULT_ROLE_SLUGS,
  DEFAULT_TENANT_POLICY,
  MembershipStatus,
  type TenantPolicy,
} from '../types/index.js';

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
    this.tenantCollection = await TenantCollection.create(this.options);
    this.membershipCollection = await MembershipCollection.create(this.options);
    this.roleCollection = await RoleCollection.create(this.options);

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
   * @param options - Optional slug override
   * @returns The created tenant and membership
   */
  async createTenantWithOwnership(
    userId: string,
    name: string,
    options?: { slug?: string },
  ): Promise<TenantWithOwnershipResult> {
    // Check if user can create
    if (!(await this.canCreateTenant(userId))) {
      throw new Error(
        `User has reached maximum tenant limit (${this.policy.maxTenants})`,
      );
    }

    // Create tenant
    const tenant = await this.tenantCollection.create({
      name,
      slug: options?.slug,
    });
    await tenant.save();

    // Get owner role
    const ownerRole = await this.roleCollection.findBySlug(
      DEFAULT_ROLE_SLUGS.OWNER,
    );
    if (!ownerRole) {
      throw new Error('Owner role not found - run seedSystemRoles first');
    }

    // Create ownership membership
    const membership = await this.membershipCollection.create({
      userId,
      tenantId: tenant.id as string,
      roleId: ownerRole.id as string,
      status: MembershipStatus.ACTIVE,
    });
    await membership.save();

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

    const ownerRole = await this.roleCollection.findBySlug(
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

    const ownerRole = await this.roleCollection.findBySlug(
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
   * Note: This does not cascade delete related records (memberships, etc.).
   * The caller should handle cleanup of related data if needed.
   *
   * @throws Error if user cannot delete the tenant (with specific reason)
   */
  async deleteTenant(userId: string, tenantId: string): Promise<void> {
    const error = await this.getDeleteTenantError(userId, tenantId);
    if (error) {
      throw new Error(error);
    }

    const tenant = await this.tenantCollection.get(tenantId);
    if (tenant) {
      await tenant.delete();
    }
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
    const ownerRole = await this.roleCollection.findBySlug(
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
