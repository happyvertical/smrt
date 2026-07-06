/**
 * Role model - permission template
 * @packageDocumentation
 */

import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import type { Role as RoleContract } from '@happyvertical/smrt-types';

/**
 * Constructor options for {@link Role}.
 */
export interface RoleOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  name?: string;
  description?: string;
  isSystem?: boolean;
  inheritsToDescendants?: boolean;
}

/**
 * Role represents a permission template that can be assigned to users.
 *
 * Roles can be:
 * - System roles (tenantId = null): Available to all tenants, cannot be modified
 * - Custom roles (tenantId set): Specific to a tenant, can be customized
 *
 * @example
 * ```typescript
 * // System role (tenantId = null)
 * const adminRole = await roles.create({
 *   slug: 'admin',
 *   name: 'Administrator',
 *   isSystem: true
 * });
 *
 * // Custom tenant role
 * const editorRole = await roles.create({
 *   tenantId: tenant.id,
 *   slug: 'editor',
 *   name: 'Editor',
 *   description: 'Can edit content'
 * });
 * ```
 */
@smrt({
  // #1400: read-only generated surface — RBAC/identity writes go through
  // permission-gated services, not auth-only generated CRUD.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Role extends SmrtObject implements RoleContract {
  /**
   * Foreign key to Tenant
   * null = system role available to all tenants
   */
  @foreignKey('Tenant', { nullable: true })
  tenantId?: string | null;

  /**
   * Display name for the role
   */
  name: string = '';

  /**
   * Description of the role
   */
  description: string = '';

  /**
   * Whether this is a system role (cannot be deleted)
   */
  isSystem: boolean = false;

  /**
   * Opt-in hierarchical inheritance: when true, an ACTIVE membership holding
   * this role also resolves permissions in descendant tenants where the user
   * has no direct membership (nearest flagged ancestor membership wins).
   *
   * Default false: the role's authority is exact-tenant only, which is the
   * pre-existing resolver behavior. Flag structural roles like a network-level
   * owner/admin; leave per-tenant roles like member/viewer unflagged.
   */
  inheritsToDescendants: boolean = false;

  constructor(options: RoleOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.isSystem !== undefined) this.isSystem = options.isSystem;
    if (options.inheritsToDescendants !== undefined)
      this.inheritsToDescendants = options.inheritsToDescendants;
  }

  /**
   * Check if this is a system-wide role
   */
  isSystemRole(): boolean {
    return this.tenantId === null || this.tenantId === undefined;
  }

  /**
   * Check if this is a tenant-specific role
   */
  isTenantRole(): boolean {
    return this.tenantId !== null && this.tenantId !== undefined;
  }

  /**
   * Check if this role can be deleted.
   * System roles (isSystem = true) cannot be deleted.
   * @returns true if the role can be deleted
   */
  canDelete(): boolean {
    return !this.isSystem;
  }

  /**
   * Delete guard - prevents deletion of system roles.
   * Override the delete method to check isSystem flag first.
   */
  async delete(): Promise<void> {
    if (this.isSystem) {
      throw new Error(
        `Cannot delete system role '${this.slug}'. System roles are protected.`,
      );
    }
    return super.delete();
  }
}
