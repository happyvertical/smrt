/**
 * Role model - permission template
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

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
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Role extends SmrtObject {
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

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.isSystem !== undefined) this.isSystem = options.isSystem;
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
}
