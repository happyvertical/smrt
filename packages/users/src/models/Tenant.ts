/**
 * Tenant model - organizational boundary for multi-tenancy
 * @packageDocumentation
 */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import type { Tenant as TenantContract } from '@happyvertical/smrt-types';
import { TenantStatus } from '../types/index.js';
import {
  applyTenantHierarchyUpdates,
  computeTenantHierarchyFields,
  planDescendantHierarchy,
  type TenantHierarchyDatabase,
} from './tenant-hierarchy.js';

/**
 * Constructor options for {@link Tenant}.
 */
export interface TenantOptions extends SmrtObjectOptions {
  name?: string;
  status?: TenantStatus;
  description?: string;
  parentTenantId?: string | null;
  hierarchyLevel?: number;
  hierarchyPath?: string;
  cascadePermissions?: boolean;
  inheritPermissions?: boolean;
}

export { MAX_TENANT_HIERARCHY_DEPTH } from './tenant-hierarchy.js';

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
  tableStrategy: 'sti',
  // #1400: read-only generated surface — tenant create/update (incl. the
  // cascadePermissions/inheritPermissions flags that drive the permission
  // cascade) goes through TenantService, not auth-only generated CRUD.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class Tenant extends SmrtObject implements TenantContract {
  /**
   * Display name for the tenant
   */
  name: string = '';

  /**
   * Tenant status
   */
  @field({ type: 'text' })
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
   * Derived from `parentTenantId` and maintained by {@link Tenant.save};
   * any value assigned directly is recomputed on save.
   */
  hierarchyLevel: number = 0;

  /**
   * Materialized path for efficient tree traversal.
   * Format: "ancestor-id/parent-id" (path to parent; does not include this tenant's id)
   * Empty string for root tenants.
   * Derived from `parentTenantId` and maintained by {@link Tenant.save};
   * any value assigned directly is recomputed on save. Rows written before
   * the framework maintained it are backfilled with
   * `smrt db:materialize-tenant-hierarchy` (smrt#3036).
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

  constructor(options: TenantOptions = {}) {
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
   * Check if this tenant is configured to cascade permissions to children.
   *
   * Note: This does NOT indicate whether any child tenants actually exist.
   * Use TenantCollection.findChildren() for accurate child lookup.
   */
  canCascadeToChildren(): boolean {
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
   * Persist the tenant, keeping the derived hierarchy fields true (smrt#3036).
   *
   * `hierarchyPath` / `hierarchyLevel` are recomputed from the real
   * `parentTenantId` chain on EVERY save — whichever collection, subclass, or
   * code path produced the object — so a consumer never hand-maintains them.
   * When they change (a reparent, or healing a stale row), every descendant is
   * re-materialized too. Both columns are an authorization source for
   * `inheritsToDescendants` and the declared ancestor-read policy.
   *
   * @throws {TenantHierarchyError} before anything is written, when the new
   *   parent is missing, would create a cycle, or would put this tenant or one
   *   of its descendants at or below `MAX_TENANT_HIERARCHY_DEPTH`.
   */
  override async save(options: SmrtSaveOptions = {}): Promise<this> {
    const db: TenantHierarchyDatabase = this.db;
    const table = this.tableName;
    const fields = await computeTenantHierarchyFields(
      db,
      table,
      this.id,
      this.parentTenantId,
    );
    const changed =
      fields.hierarchyPath !== this.hierarchyPath ||
      fields.hierarchyLevel !== this.hierarchyLevel;
    // Plan (read-only) before writing, so an over-deep or looping subtree is
    // refused without leaving this row moved and its descendants stale. A row
    // not yet persisted cannot have children pointing at it.
    const descendantUpdates =
      changed && this.id && this.isPersisted
        ? await planDescendantHierarchy(db, table, this.id, fields)
        : [];

    this.hierarchyPath = fields.hierarchyPath;
    this.hierarchyLevel = fields.hierarchyLevel;
    await super.save(options);
    if (descendantUpdates.length > 0) {
      await applyTenantHierarchyUpdates(db, table, descendantUpdates);
    }
    return this;
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
