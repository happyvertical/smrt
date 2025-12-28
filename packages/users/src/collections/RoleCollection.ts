/**
 * RoleCollection - Collection manager for Role objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Role } from '../models/Role.js';
import { DEFAULT_ROLES } from '../types/index.js';

/**
 * Collection for managing Role objects
 */
export class RoleCollection extends SmrtCollection<Role> {
  static readonly _itemClass = Role;

  /**
   * Find all system roles (tenantId is null)
   */
  async findSystemRoles(): Promise<Role[]> {
    // Query for roles where tenantId is null
    return await this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id IS NULL ORDER BY name ASC`,
    );
  }

  /**
   * Find roles available for a tenant (system + tenant-specific)
   */
  async findByTenant(tenantId: string): Promise<Role[]> {
    return await this.query(
      `SELECT * FROM ${this.tableName}
       WHERE tenant_id IS NULL OR tenant_id = ?
       ORDER BY is_system DESC, name ASC`,
      [tenantId],
    );
  }

  /**
   * Find tenant-specific roles only
   */
  async findTenantRoles(tenantId: string): Promise<Role[]> {
    return await this.list({
      where: { tenantId },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find role by slug within a tenant context
   */
  async findBySlug(slug: string, tenantId?: string): Promise<Role | null> {
    // First check tenant-specific role
    if (tenantId) {
      const tenantRoles = await this.list({
        where: { slug, tenantId },
        limit: 1,
      });
      if (tenantRoles.length > 0) {
        return tenantRoles[0];
      }
    }

    // Fall back to system role
    const systemRoles = await this.query(
      `SELECT * FROM ${this.tableName} WHERE slug = ? AND tenant_id IS NULL LIMIT 1`,
      [slug],
    );
    return systemRoles.length > 0 ? systemRoles[0] : null;
  }

  /**
   * Seed default system roles
   */
  async seedSystemRoles(): Promise<Role[]> {
    const roles: Role[] = [];

    for (const roleDef of DEFAULT_ROLES) {
      // Check if role already exists
      const existing = await this.findBySlug(roleDef.slug);
      if (existing) {
        roles.push(existing);
        continue;
      }

      // Create new system role
      const role = await this.create({
        slug: roleDef.slug,
        name: roleDef.name,
        description: roleDef.description,
        tenantId: null,
        isSystem: true,
      });
      await role.save();
      roles.push(role);
    }

    return roles;
  }
}
