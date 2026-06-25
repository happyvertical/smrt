/**
 * TenantCollection - Collection manager for Tenant objects
 * @packageDocumentation
 */

import { SmrtCollection, type SmrtCreateInput } from '@happyvertical/smrt-core';
import { MAX_TENANT_HIERARCHY_DEPTH, Tenant } from '../models/Tenant.js';
import { TenantStatus } from '../types/index.js';

/**
 * Error thrown when tenant hierarchy operations fail
 */
export class TenantHierarchyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'CIRCULAR_REFERENCE'
      | 'MAX_DEPTH_EXCEEDED'
      | 'PARENT_NOT_FOUND'
      | 'INVALID_OPERATION',
  ) {
    super(message);
    this.name = 'TenantHierarchyError';
  }
}

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

/**
 * Collection for managing Tenant objects with hierarchical support.
 *
 * Provides methods for:
 * - Basic CRUD operations
 * - Hierarchy management (parent/child relationships)
 * - Tree traversal (ancestors, descendants, siblings)
 * - Hierarchy path maintenance
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
    if (!tenant || !tenant.parentTenantId) {
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
    if (!tenant || !tenant.id) {
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

  // ============= Hierarchy Management Methods =============

  /**
   * Create a child tenant under a parent.
   * Automatically sets hierarchyLevel and hierarchyPath.
   */
  async createChild(
    parentTenantId: string,
    options: CreateChildTenantOptions,
  ): Promise<Tenant> {
    const parent = await this.get({ id: parentTenantId });
    if (!parent?.id) {
      throw new TenantHierarchyError(
        `Parent tenant not found: ${parentTenantId}`,
        'PARENT_NOT_FOUND',
      );
    }

    // Check depth limit
    const newLevel = parent.hierarchyLevel + 1;
    if (newLevel >= MAX_TENANT_HIERARCHY_DEPTH) {
      throw new TenantHierarchyError(
        `Maximum hierarchy depth (${MAX_TENANT_HIERARCHY_DEPTH}) exceeded`,
        'MAX_DEPTH_EXCEEDED',
      );
    }

    // Build hierarchy path
    const newPath = parent.hierarchyPath
      ? `${parent.hierarchyPath}/${parent.id}`
      : parent.id;

    const child = await this.create({
      name: options.name,
      slug: options.slug,
      description: options.description ?? '',
      status: options.status ?? TenantStatus.ACTIVE,
      parentTenantId: parentTenantId,
      hierarchyLevel: newLevel,
      hierarchyPath: newPath,
      cascadePermissions: options.cascadePermissions ?? true,
      inheritPermissions: options.inheritPermissions ?? true,
    });

    await child.save();
    return child;
  }

  /**
   * Move a tenant to a new parent.
   * Updates hierarchyLevel and hierarchyPath for the tenant and all descendants.
   */
  async moveToParent(
    tenantId: string,
    newParentId: string | null,
  ): Promise<Tenant> {
    const tenant = await this.get({ id: tenantId });
    if (!tenant || !tenant.id) {
      throw new TenantHierarchyError(
        `Tenant not found: ${tenantId}`,
        'INVALID_OPERATION',
      );
    }

    // Validate not moving to self
    if (newParentId === tenantId) {
      throw new TenantHierarchyError(
        'Cannot move tenant to itself',
        'CIRCULAR_REFERENCE',
      );
    }

    // Validate not moving to a descendant
    if (newParentId) {
      const isDescendant = await this.isDescendantOf(newParentId, tenantId);
      if (isDescendant) {
        throw new TenantHierarchyError(
          'Cannot move tenant to one of its descendants',
          'CIRCULAR_REFERENCE',
        );
      }
    }

    // Fetch descendants BEFORE any changes (uses current hierarchyPath for lookup)
    const descendants = await this.getDescendants(tenantId);

    let newLevel: number;
    let newPath: string;

    if (newParentId === null) {
      // Moving to root
      newLevel = 0;
      newPath = '';
    } else {
      const newParent = await this.get({ id: newParentId });
      if (!newParent) {
        throw new TenantHierarchyError(
          `New parent tenant not found: ${newParentId}`,
          'PARENT_NOT_FOUND',
        );
      }

      newLevel = newParent.hierarchyLevel + 1;

      // Check depth limit (considering descendants)
      const maxDescendantDepth = descendants.reduce(
        (max, d) => Math.max(max, d.hierarchyLevel - tenant.hierarchyLevel),
        0,
      );

      if (newLevel + maxDescendantDepth >= MAX_TENANT_HIERARCHY_DEPTH) {
        throw new TenantHierarchyError(
          `Moving would exceed maximum hierarchy depth (${MAX_TENANT_HIERARCHY_DEPTH})`,
          'MAX_DEPTH_EXCEEDED',
        );
      }

      newPath = newParent.hierarchyPath
        ? `${newParent.hierarchyPath}/${newParent.id}`
        : newParent.id!;
    }

    // Calculate the path prefix for descendants
    const oldPath = tenant.hierarchyPath
      ? `${tenant.hierarchyPath}/${tenant.id}`
      : tenant.id;
    const newPathForDescendants = newPath
      ? `${newPath}/${tenant.id}`
      : tenant.id;

    // Update the tenant
    const levelDelta = newLevel - tenant.hierarchyLevel;
    tenant.parentTenantId = newParentId;
    tenant.hierarchyLevel = newLevel;
    tenant.hierarchyPath = newPath;
    await tenant.save();

    // Update all descendants (using the list fetched before changes)
    for (const descendant of descendants) {
      // Validate descendant has hierarchyPath - missing path indicates data corruption
      if (!descendant.hierarchyPath) {
        throw new TenantHierarchyError(
          `Descendant tenant ${descendant.id} has no hierarchyPath while updating hierarchy from ${oldPath} to ${newPathForDescendants}`,
          'INVALID_OPERATION',
        );
      }

      // Validate descendant path starts with expected prefix
      if (!descendant.hierarchyPath.startsWith(oldPath)) {
        throw new TenantHierarchyError(
          `Descendant tenant ${descendant.id} has hierarchyPath "${descendant.hierarchyPath}" which does not start with expected prefix "${oldPath}"`,
          'INVALID_OPERATION',
        );
      }

      // Update path by replacing old prefix with new prefix
      descendant.hierarchyPath =
        newPathForDescendants +
        descendant.hierarchyPath.substring(oldPath.length);

      // Adjust level by the same delta
      descendant.hierarchyLevel += levelDelta;
      await descendant.save();
    }

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

  // ============= Override create to handle hierarchy =============

  /**
   * Override create to automatically set hierarchy fields for new tenants.
   * Only calculates them when the caller hasn't already supplied
   * `hierarchyLevel`/`hierarchyPath` in the create input — an explicitly
   * provided value is preserved as-is.
   */
  async create(options: SmrtCreateInput<Tenant>): Promise<Tenant> {
    // If parentTenantId is provided and hierarchy fields not already set
    if (options.parentTenantId) {
      // Only calculate when the caller didn't already supply them
      // (a provided hierarchyLevel/hierarchyPath is preserved as-is)
      const needsHierarchyCalc =
        options.hierarchyLevel === undefined ||
        options.hierarchyPath === undefined;

      if (needsHierarchyCalc) {
        const parent = await this.get({ id: options.parentTenantId });
        if (!parent?.id) {
          throw new TenantHierarchyError(
            `Parent tenant not found: ${options.parentTenantId}`,
            'PARENT_NOT_FOUND',
          );
        }

        const newLevel = parent.hierarchyLevel + 1;
        if (newLevel >= MAX_TENANT_HIERARCHY_DEPTH) {
          throw new TenantHierarchyError(
            `Maximum hierarchy depth (${MAX_TENANT_HIERARCHY_DEPTH}) exceeded`,
            'MAX_DEPTH_EXCEEDED',
          );
        }

        if (options.hierarchyLevel === undefined) {
          options.hierarchyLevel = newLevel;
        }
        if (options.hierarchyPath === undefined) {
          options.hierarchyPath = parent.hierarchyPath
            ? `${parent.hierarchyPath}/${parent.id}`
            : parent.id;
        }
      }
    } else {
      // Root tenant
      options.hierarchyLevel = options.hierarchyLevel ?? 0;
      options.hierarchyPath = options.hierarchyPath ?? '';
    }

    return super.create(options);
  }
}
