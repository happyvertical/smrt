/**
 * RoleCollection - Collection manager for Role objects
 * @packageDocumentation
 */

import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  SmrtCollection,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { Role } from '../models/Role.js';
import { DEFAULT_ROLES } from '../types/index.js';
import type {
  RolePermissionPatternMatrix,
  SeedRolePermissionsOptions,
} from './RolePermissionCollection.js';

export interface SeedSystemRolesOptions
  extends Omit<SeedRolePermissionsOptions, 'catalog'> {
  permissionMatrix?: RolePermissionPatternMatrix;
  seedPermissions?: boolean;
  /**
   * System role slugs to flag `inheritsToDescendants: true` (opt-in
   * hierarchical membership inheritance, e.g. `['owner', 'admin']` for
   * organizational hierarchies). Additive and idempotent: listed slugs are
   * flagged on create and on already-seeded roles, but omitting a slug never
   * unsets a previously flagged role — unflag explicitly via a role update.
   * Unknown slugs throw (a typo here would silently withhold intended
   * authority). Default: no role inherits.
   */
  inheritsToDescendants?: string[];
}

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

  /** Find a built-in system role only; tenant slug collisions never match. */
  async findSystemRoleBySlug(slug: string): Promise<Role | null> {
    const builtIn = DEFAULT_ROLES.find((role) => role.slug === slug);
    const systemRoles = await this.list({
      where: {
        slug,
        tenantId: null,
        isSystem: true,
        ...(builtIn && { id: builtIn.id }),
      },
      limit: 1,
    });
    return systemRoles[0] ?? null;
  }

  /**
   * Seed default system roles
   */
  async seedSystemRoles(options: SeedSystemRolesOptions = {}): Promise<Role[]> {
    const roles: Role[] = [];

    const inheritableSlugs = new Set(options.inheritsToDescendants ?? []);
    const knownSlugs = new Set<string>(DEFAULT_ROLES.map((def) => def.slug));
    for (const slug of inheritableSlugs) {
      if (!knownSlugs.has(slug)) {
        throw new Error(
          `Unknown system role slug '${slug}' in inheritsToDescendants. ` +
            `Valid slugs: ${[...knownSlugs].join(', ')}.`,
        );
      }
    }

    const seed = async (writer: RoleCollection) => {
      // A joined DuckDB transaction has no savepoint. Check all application
      // identity refusals before any writes so callers can catch them safely.
      const existingRoles = new Map<string, Role>();
      const globalRoles = await writer.findSystemRoles();
      for (const roleDef of DEFAULT_ROLES) {
        const matches = globalRoles.filter(({ slug }) => slug === roleDef.slug);
        const [existing] = matches;
        if (
          matches.length > 1 ||
          (existing && (!existing.isSystem || existing.id !== roleDef.id)) ||
          (!existing && (await writer.count({ where: { id: roleDef.id } })) > 0)
        ) {
          throw new Error(
            `System role identity collision for '${roleDef.slug}'`,
          );
        }
        if (existing) existingRoles.set(roleDef.slug, existing);
      }

      for (const roleDef of DEFAULT_ROLES) {
        const inheritable = inheritableSlugs.has(roleDef.slug);
        const existing = existingRoles.get(roleDef.slug);
        if (existing) {
          // Additive-only convergence: flag a listed slug, never unset one.
          if (inheritable && !existing.inheritsToDescendants) {
            existing.inheritsToDescendants = true;
            await existing.save();
          }
          roles.push(existing);
          continue;
        }

        // Create new system role. `create()` already persists, so the second
        // `save()` was a redundant UPDATE plus an extra change-feed append
        // (#3022). Strict INSERT also protects against a concurrent collision.
        const role = await writer.create({
          id: roleDef.id,
          _insertOnly: true,
          slug: roleDef.slug,
          name: roleDef.name,
          description: roleDef.description,
          tenantId: null,
          isSystem: true,
          inheritsToDescendants: inheritable,
        });
        roles.push(role);
      }
    };
    const postgres = isPostgresDatabase(this.db);
    const embedded = isEmbeddedDatabase(this.db);
    if (postgres || embedded) {
      await withEmbeddedWriteTransaction(
        this.db as DatabaseInterface,
        embedded,
        async (db) => {
          // Serialize global identity checks with other PostgreSQL seeders.
          if (postgres) await db.query('SELECT pg_advisory_xact_lock(3329, 1)');
          await seed(await RoleCollection.create({ ...this.options, db }));
        },
        true,
      );
      // Return objects bound to the caller, not the completed batch handle.
      roles.length = 0;
      for (const roleDef of DEFAULT_ROLES) {
        const role = await this.findSystemRoleBySlug(roleDef.slug);
        if (role) roles.push(role);
      }
    } else {
      await seed(this);
    }

    if (options.seedPermissions) {
      const { RolePermissionCollection } = await import(
        './RolePermissionCollection.js'
      );
      const rolePermissions = await RolePermissionCollection.create(
        this.options,
      );
      await rolePermissions.seedRolePermissions(options.permissionMatrix, {
        prune: options.prune,
        syncCatalog: options.syncCatalog,
        tenantId: options.tenantId,
      });
    }

    return roles;
  }
}
