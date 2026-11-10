/**
 * TenantCollection - Collection manager for Tenant objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  runTenantHierarchyReadScope,
} from '@happyvertical/smrt-tenancy';
import { Tenant } from '../models/Tenant.js';
import { TenantHierarchyError } from '../models/tenant-hierarchy.js';
import { TenantStatus } from '../types/index.js';

export { TenantHierarchyError };

/**
 * Options for creating a child tenant
 */
export interface CreateChildTenantOptions {
  name: string;
  slug?: string;
  description?: string;
  status?: TenantStatus;
  /** Override parent's cascade setting for this child. Default: true */
  inheritPermissions?: boolean;
  /** Whether this child cascades permissions to its children. Default: true */
  cascadePermissions?: boolean;
}

/** The verified actor supplied to a hierarchy read-scope authorizer. */
export interface TenantReadScopeAuthorizationContext {
  actorTenantId: string;
  actorUserId: string;
  rootTenantId: string;
  mode: 'catalog' | 'subtree';
}

/** Authorization must return exactly `true`; every other result fails closed. */
export type TenantReadScopeAuthorizer = (
  context: TenantReadScopeAuthorizationContext,
) => boolean | Promise<boolean>;

export interface TenantReadScopeOptions {
  /** Qualified tenant-scoped model identities whose list reads may widen. */
  collections: readonly string[];
  /** Owning service's affirmative permission decision for this scope. */
  authorize: TenantReadScopeAuthorizer;
}

/**
 * Collection for managing Tenant objects with hierarchical support.
 *
 * Provides methods for:
 * - Basic CRUD operations
 * - Hierarchy management (parent/child relationships)
 * - Tree traversal (ancestors, descendants, siblings)
 * - Hierarchy validation
 *
 * `hierarchyLevel` / `hierarchyPath` are derived from `parentTenantId` by
 * {@link Tenant.save} on every create, update, and move — any value supplied
 * in a create input is recomputed, because both are an authorization source
 * (smrt#3036).
 */
export class TenantCollection extends SmrtCollection<Tenant> {
  static readonly _itemClass = Tenant;

  // ============= Basic Query Methods =============

  /**
   * Find tenants by status
   */
  async findByStatus(status: TenantStatus): Promise<Tenant[]> {
    return await this.list({
      where: { status },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find all active tenants
   */
  async findActive(): Promise<Tenant[]> {
    return await this.findByStatus(TenantStatus.ACTIVE);
  }

  /**
   * Find tenant by slug
   */
  async findBySlug(slug: string): Promise<Tenant | null> {
    const results = await this.list({
      where: { slug },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  // ============= Hierarchy Query Methods =============

  /**
   * Find all root tenants (tenants with no parent)
   */
  async findRoots(): Promise<Tenant[]> {
    return await this.list({
      where: { parentTenantId: null },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find direct children of a tenant
   */
  async findChildren(parentTenantId: string): Promise<Tenant[]> {
    return await this.list({
      where: { parentTenantId },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find the parent tenant of a given tenant
   */
  async findParent(tenantId: string): Promise<Tenant | null> {
    const tenant = await this.get({ id: tenantId });
    if (!tenant?.parentTenantId) {
      return null;
    }
    return await this.get({ id: tenant.parentTenantId });
  }

  /**
   * Get all ancestors of a tenant, from immediate parent to root.
   * Uses the hierarchyPath for efficient lookup.
   */
  async getAncestors(tenantId: string): Promise<Tenant[]> {
    const tenant = await this.get({ id: tenantId });
    if (!tenant) {
      return [];
    }

    const ancestorIds = tenant.getAncestorIds();
    if (ancestorIds.length === 0) {
      return [];
    }

    // Batch fetch all ancestors
    const ancestorsList = await this.listByIds(ancestorIds);
    const ancestorsMap = new Map(ancestorsList.map((a) => [a.id, a]));

    // Return in order from immediate parent to root
    const ancestors: Tenant[] = [];
    for (let i = ancestorIds.length - 1; i >= 0; i--) {
      const ancestor = ancestorsMap.get(ancestorIds[i]);
      if (ancestor) {
        ancestors.push(ancestor);
      }
    }

    return ancestors;
  }

  /** Return ancestor IDs in the model's canonical root-to-parent order. */
  async getAncestorIds(tenantId: string): Promise<string[]> {
    const tenant = await this.get({ id: tenantId });
    return tenant?.getAncestorIds() ?? [];
  }

  /**
   * Get all ancestors in order from root to immediate parent.
   * Reverse of getAncestors.
   */
  async getAncestorsFromRoot(tenantId: string): Promise<Tenant[]> {
    const ancestors = await this.getAncestors(tenantId);
    return ancestors.reverse();
  }

  /**
   * Get all descendants of a tenant (all children, grandchildren, etc.)
   * Uses hierarchyPath prefix matching for efficient lookup.
   */
  async getDescendants(tenantId: string): Promise<Tenant[]> {
    const tenant = await this.get({ id: tenantId });
    if (!tenant?.id) {
      return [];
    }

    // Build the path prefix to search for
    const pathPrefix = tenant.hierarchyPath
      ? `${tenant.hierarchyPath}/${tenant.id}`
      : tenant.id;

    // Use database-level LIKE query for initial filtering
    // This is much more efficient than loading all tenants for large hierarchies
    const candidates = await this.list({
      where: {
        'hierarchyPath like': `${pathPrefix}%`,
      },
    });

    // Apply boundary check in memory to avoid false positives
    // Without the '/' check, "ancestor/tenant1" would incorrectly match "ancestor/tenant123"
    return candidates.filter(
      (t) =>
        t.hierarchyPath === pathPrefix ||
        t.hierarchyPath?.startsWith(`${pathPrefix}/`),
    );
  }

  /** Return descendant IDs without reimplementing materialized-path traversal. */
  async getDescendantIds(tenantId: string): Promise<string[]> {
    return (await this.getDescendants(tenantId)).flatMap((tenant) =>
      tenant.id ? [tenant.id] : [],
    );
  }

  /**
   * Get siblings of a tenant (other tenants with the same parent)
   */
  async getSiblings(tenantId: string): Promise<Tenant[]> {
    const tenant = await this.get({ id: tenantId });
    if (!tenant) {
      return [];
    }

    const siblings = await this.list({
      where: { parentTenantId: tenant.parentTenantId ?? null },
      orderBy: 'name ASC',
    });

    // Exclude self from siblings
    return siblings.filter((s) => s.id !== tenantId);
  }

  /**
   * Check if a tenant is an ancestor of another tenant
   */
  async isAncestorOf(
    potentialAncestorId: string,
    tenantId: string,
  ): Promise<boolean> {
    const tenant = await this.get({ id: tenantId });
    if (!tenant) {
      return false;
    }

    const ancestorIds = tenant.getAncestorIds();
    return ancestorIds.includes(potentialAncestorId);
  }

  /**
   * Check if a tenant is a descendant of another tenant
   */
  async isDescendantOf(
    potentialDescendantId: string,
    tenantId: string,
  ): Promise<boolean> {
    return await this.isAncestorOf(tenantId, potentialDescendantId);
  }

  /** Require `childId` to sit below `parentId`, failing closed otherwise. */
  async requireChildOf(parentId: string, childId: string): Promise<void> {
    if (!(await this.isAncestorOf(parentId, childId))) {
      throw new TenantHierarchyError(
        `Tenant ${childId} is not a descendant of ${parentId}`,
        'INVALID_OPERATION',
      );
    }
  }

  /**
   * Allow list reads for the active family's catalog rows, its ancestors, and
   * global rows. This never includes descendants or siblings.
   */
  async withTenantCatalogReadScope<T>(
    options: TenantReadScopeOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    const actor = this.requireReadScopeActor();
    const actorTenant = await this.get({ id: actor.tenantId });
    if (!actorTenant?.id) {
      throw new TenantHierarchyError(
        `Active tenant not found: ${actor.tenantId}`,
        'PARENT_NOT_FOUND',
      );
    }
    const ancestorIds = actorTenant.getAncestorIds();
    return await this.runAuthorizedReadScope(
      actor,
      actor.tenantId,
      'catalog',
      [...ancestorIds, actor.tenantId],
      true,
      options,
      callback,
    );
  }

  /**
   * Allow list reads for one authorized root and its descendants. Global and
   * ancestor rows remain unavailable so aggregate views cannot become catalog
   * lookups by accident.
   */
  async withTenantHierarchyContext<T>(
    rootTenantId: string,
    options: TenantReadScopeOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    const actor = this.requireReadScopeActor();
    const root = await this.get({ id: rootTenantId });
    if (!root?.id) {
      throw new TenantHierarchyError(
        `Tenant root not found: ${rootTenantId}`,
        'PARENT_NOT_FOUND',
      );
    }
    return await this.runAuthorizedReadScope(
      actor,
      rootTenantId,
      'subtree',
      [rootTenantId, ...(await this.getDescendantIds(rootTenantId))],
      false,
      options,
      callback,
    );
  }

  private requireReadScopeActor(): { tenantId: string; userId: string } {
    const actor = getCurrentTenant();
    if (!actor?.tenantId || !actor.userId) {
      throw new TenantHierarchyError(
        'Tenant hierarchy read scope requires an active tenant and user',
        'INVALID_OPERATION',
      );
    }
    return { tenantId: actor.tenantId, userId: actor.userId };
  }

  private async runAuthorizedReadScope<T>(
    actor: { tenantId: string; userId: string },
    rootTenantId: string,
    mode: TenantReadScopeAuthorizationContext['mode'],
    tenantIds: readonly string[],
    includeGlobal: boolean,
    options: TenantReadScopeOptions,
    callback: () => Promise<T>,
  ): Promise<T> {
    if (
      !Array.isArray(options.collections) ||
      options.collections.length === 0 ||
      typeof options.authorize !== 'function' ||
      typeof callback !== 'function'
    ) {
      throw new TenantHierarchyError(
        'Tenant hierarchy read scope requires collections, authorize, and callback',
        'INVALID_OPERATION',
      );
    }
    const authorized = await options.authorize({
      actorTenantId: actor.tenantId,
      actorUserId: actor.userId,
      rootTenantId,
      mode,
    });
    if (authorized !== true) {
      throw new TenantHierarchyError(
        'Tenant hierarchy read scope authorization was denied',
        'INVALID_OPERATION',
      );
    }
    return await runTenantHierarchyReadScope(
      {
        actorTenantId: actor.tenantId,
        actorUserId: actor.userId,
        collections: options.collections,
        includeGlobal,
        tenantIds,
      },
      callback,
    );
  }

  // ============= Hierarchy Management Methods =============

  /**
   * Create a child tenant under a parent.
   * `hierarchyLevel` and `hierarchyPath` are derived by {@link Tenant.save}.
   *
   * @throws {TenantHierarchyError} `PARENT_NOT_FOUND` or `MAX_DEPTH_EXCEEDED`.
   */
  async createChild(
    parentTenantId: string,
    options: CreateChildTenantOptions,
  ): Promise<Tenant> {
    return await this.create({
      name: options.name,
      slug: options.slug,
      description: options.description ?? '',
      status: options.status ?? TenantStatus.ACTIVE,
      parentTenantId: parentTenantId,
      cascadePermissions: options.cascadePermissions ?? true,
      inheritPermissions: options.inheritPermissions ?? true,
    });
  }

  /**
   * Move a tenant to a new parent (or to the root with `null`).
   *
   * {@link Tenant.save} checks the new parent is visible under the caller's
   * tenancy scope, recomputes the tenant's hierarchy fields from the real
   * parent chain and re-materializes every descendant, refusing the move
   * before writing anything when it would create a cycle or push any
   * descendant past `MAX_TENANT_HIERARCHY_DEPTH`.
   */
  async moveToParent(
    tenantId: string,
    newParentId: string | null,
  ): Promise<Tenant> {
    const tenant = await this.get({ id: tenantId });
    if (!tenant?.id) {
      throw new TenantHierarchyError(
        `Tenant not found: ${tenantId}`,
        'INVALID_OPERATION',
      );
    }

    if (newParentId === tenantId) {
      throw new TenantHierarchyError(
        'Cannot move tenant to itself',
        'CIRCULAR_REFERENCE',
      );
    }

    tenant.parentTenantId = newParentId;
    await tenant.save();
    return tenant;
  }

  /**
   * Make a tenant a root tenant (remove from hierarchy)
   */
  async makeRoot(tenantId: string): Promise<Tenant> {
    return await this.moveToParent(tenantId, null);
  }

  /**
   * Validate that a tenant hierarchy is consistent.
   * Returns validation errors if any.
   */
  async validateHierarchy(tenantId: string): Promise<string[]> {
    const errors: string[] = [];
    const tenant = await this.get({ id: tenantId });

    if (!tenant) {
      return [`Tenant not found: ${tenantId}`];
    }

    // Check parent exists if set
    if (tenant.parentTenantId) {
      const parent = await this.get({ id: tenant.parentTenantId });
      if (!parent) {
        errors.push(`Parent tenant not found: ${tenant.parentTenantId}`);
      } else {
        // Check hierarchy level
        if (tenant.hierarchyLevel !== parent.hierarchyLevel + 1) {
          errors.push(
            `Hierarchy level mismatch: expected ${parent.hierarchyLevel + 1}, got ${tenant.hierarchyLevel}`,
          );
        }

        // Check hierarchy path
        const expectedPath = parent.hierarchyPath
          ? `${parent.hierarchyPath}/${parent.id}`
          : parent.id;
        if (tenant.hierarchyPath !== expectedPath) {
          errors.push(
            `Hierarchy path mismatch: expected "${expectedPath}", got "${tenant.hierarchyPath}"`,
          );
        }
      }
    } else {
      // Root tenant checks
      if (tenant.hierarchyLevel !== 0) {
        errors.push(
          `Root tenant should have hierarchyLevel 0, got ${tenant.hierarchyLevel}`,
        );
      }
      if (tenant.hierarchyPath !== '') {
        errors.push(
          `Root tenant should have empty hierarchyPath, got "${tenant.hierarchyPath}"`,
        );
      }
    }

    // Check for circular reference (shouldn't be possible with path, but double-check)
    if (tenant.parentTenantId && tenant.id) {
      const ancestorIds = tenant.getAncestorIds();
      if (ancestorIds.includes(tenant.id)) {
        errors.push('Circular reference detected in hierarchy');
      }
    }

    return errors;
  }

  /**
   * Get the full hierarchy tree starting from a tenant.
   * Returns a nested structure useful for UI rendering.
   */
  async getTree(
    rootTenantId?: string,
  ): Promise<Array<Tenant & { children: Tenant[] }>> {
    const roots = rootTenantId
      ? [await this.get({ id: rootTenantId })]
      : await this.findRoots();

    const buildTree = async (
      tenant: Tenant | null,
    ): Promise<(Tenant & { children: Tenant[] }) | null> => {
      if (!tenant) return null;

      const children = await this.findChildren(tenant.id!);
      const childTrees = await Promise.all(children.map(buildTree));

      // Use Object.assign to preserve Tenant instance methods while adding children
      const tenantWithChildren = Object.assign(tenant, {
        children: childTrees.filter(Boolean) as Array<
          Tenant & { children: Tenant[] }
        >,
      });
      return tenantWithChildren as Tenant & { children: Tenant[] };
    };

    const trees = await Promise.all(roots.map(buildTree));
    return trees.filter(Boolean) as Array<Tenant & { children: Tenant[] }>;
  }
}
