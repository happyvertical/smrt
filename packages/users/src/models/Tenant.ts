/**
 * Tenant model - organizational boundary for multi-tenancy
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantStatus } from '../types/index.js';

/**
 * Maximum allowed depth for tenant hierarchy.
 * Prevents excessively deep trees that could cause performance issues.
 */
export const MAX_TENANT_HIERARCHY_DEPTH = 10;

/**
 * Tenant represents an organizational boundary in the multi-tenant system.
 *
 * Supports hierarchical organization with parent-child relationships.
 * Users can belong to multiple tenants through Memberships.
 * Each tenant can have custom roles in addition to system defaults.
 *
 * ## Hierarchical Tenants
 *
 * Tenants can be organized in a tree structure where child tenants
 * can optionally inherit permissions from their parent tenants.
 *
 * ### Cascade Control
 *
 * Two flags control permission inheritance:
 * - `cascadePermissions`: If true, this tenant pushes its permissions to children
 * - `inheritPermissions`: If true, this tenant accepts permissions from parent
 *
 * Both must be true for inheritance to flow from parent to child.
 *
 * @example
 * ```typescript
 * // Create root tenant
 * const corp = await tenants.create({
 *   name: 'Acme Corporation',
 *   slug: 'acme-corp',
 *   cascadePermissions: true,  // Push permissions to children
 * });
 * await corp.save();
 *
 * // Create child tenant that inherits
 * const division = await tenants.create({
 *   name: 'Acme West Division',
 *   slug: 'acme-west',
 *   parentTenantId: corp.id,
 *   inheritPermissions: true,  // Accept parent permissions
 * });
 * await division.save();
 *
 * // Create independent child (breaks inheritance chain)
 * const independent = await tenants.create({
 *   name: 'Acme Labs',
 *   slug: 'acme-labs',
 *   parentTenantId: corp.id,
 *   inheritPermissions: false,  // Does NOT inherit from parent
 * });
 * await independent.save();
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Tenant extends SmrtObject {
  /**
   * Display name for the tenant
   */
  name: string = '';

  /**
   * Tenant status
   */
  status: TenantStatus = TenantStatus.ACTIVE;

  /**
   * Optional description
   */
  description: string = '';

  // ============= Hierarchy Fields =============

  /**
   * Parent tenant ID for hierarchical organization.
   * Null for root-level tenants.
   */
  @foreignKey('Tenant', { nullable: true })
  parentTenantId?: string | null;

  /**
   * Depth in the hierarchy tree (0 = root, 1 = first level child, etc.)
   * Automatically managed by TenantCollection methods.
   */
  hierarchyLevel: number = 0;

  /**
   * Materialized path for efficient tree traversal.
   * Format: "ancestor-id/parent-id/self-id"
   * Empty string for root tenants.
   * Automatically managed by TenantCollection methods.
   */
  hierarchyPath: string = '';

  // ============= Permission Cascade Control =============

  /**
   * If true, this tenant's permissions cascade DOWN to child tenants.
   * Children can still opt-out by setting inheritPermissions: false.
   * Default: true
   */
  cascadePermissions: boolean = true;

  /**
   * If true, this tenant ACCEPTS permissions from its parent tenant.
   * Parent must also have cascadePermissions: true for inheritance to work.
   * Default: true
   */
  inheritPermissions: boolean = true;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.status !== undefined) this.status = options.status;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.parentTenantId !== undefined)
      this.parentTenantId = options.parentTenantId;
    if (options.hierarchyLevel !== undefined)
      this.hierarchyLevel = options.hierarchyLevel;
    if (options.hierarchyPath !== undefined)
      this.hierarchyPath = options.hierarchyPath;
    if (options.cascadePermissions !== undefined)
      this.cascadePermissions = options.cascadePermissions;
    if (options.inheritPermissions !== undefined)
      this.inheritPermissions = options.inheritPermissions;
  }

  /**
   * Check if tenant is active
   */
  isActive(): boolean {
    return this.status === TenantStatus.ACTIVE;
  }

  /**
   * Check if tenant is suspended
   */
  isSuspended(): boolean {
    return this.status === TenantStatus.SUSPENDED;
  }

  /**
   * Check if this is a root-level tenant (no parent)
   */
  isRoot(): boolean {
    return !this.parentTenantId;
  }

  /**
   * Check if this tenant has children
   * Note: This is a hint based on cascadePermissions being true.
   * Use TenantCollection.getChildren() for accurate child lookup.
   */
  hasChildren(): boolean {
    // This is set by the collection when children exist
    return this.cascadePermissions;
  }

  /**
   * Check if permission inheritance is active for this tenant.
   * Inheritance is active if:
   * - This tenant has a parent AND
   * - This tenant has inheritPermissions: true
   *
   * Note: The parent must also have cascadePermissions: true
   * for actual inheritance to occur. Use PermissionResolver
   * for accurate permission calculation.
   */
  acceptsInheritance(): boolean {
    return !!this.parentTenantId && this.inheritPermissions;
  }

  /**
   * Get ancestor IDs from the hierarchy path.
   * Returns an array of tenant IDs from root to immediate parent.
   * Empty array for root tenants.
   */
  getAncestorIds(): string[] {
    if (!this.hierarchyPath) return [];
    return this.hierarchyPath.split('/').filter((id) => id.length > 0);
  }
}
