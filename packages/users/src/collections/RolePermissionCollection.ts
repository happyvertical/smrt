/**
 * RolePermissionCollection - Collection manager for RolePermission objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { RolePermission } from '../models/RolePermission.js';
import {
  normalizeOperationPermissionAction,
  type PermissionCatalog,
  PermissionCatalogService,
} from '../services/PermissionCatalogService.js';
import { DEFAULT_ROLE_SLUGS, type DefaultRoleSlug } from '../types/index.js';
import { PermissionCollection } from './PermissionCollection.js';
import { RoleCollection } from './RoleCollection.js';

export type RolePermissionPatternMatrix = Partial<
  Record<string, readonly string[]>
>;

export interface SeedRolePermissionsOptions {
  catalog?: PermissionCatalog;
  /**
   * Remove existing role mappings not selected by the role's current patterns.
   * Defaults false to keep seeding additive and low-risk.
   */
  prune?: boolean;
  /**
   * Sync catalog definitions into the Permission table before assigning role
   * permissions. Defaults true.
   */
  syncCatalog?: boolean;
  tenantId?: string;
}

export interface SeedRolePermissionsResult {
  added: Record<string, string[]>;
  matched: Record<string, string[]>;
  missingPermissions: Record<string, string[]>;
  missingRoles: string[];
  removed: Record<string, string[]>;
  unchanged: Record<string, string[]>;
  unmatchedPatterns: Record<string, string[]>;
}

export const DEFAULT_ROLE_PERMISSION_PATTERNS: Record<
  DefaultRoleSlug,
  readonly string[]
> = {
  [DEFAULT_ROLE_SLUGS.OWNER]: ['*'],
  [DEFAULT_ROLE_SLUGS.ADMIN]: ['*'],
  [DEFAULT_ROLE_SLUGS.MEMBER]: ['*.read', '*.list', '*.get', '*.create'],
  [DEFAULT_ROLE_SLUGS.VIEWER]: ['*.read', '*.list', '*.get'],
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed === '*' || !trimmed.includes('.')) {
    return trimmed;
  }

  const [resource, action, ...rest] = trimmed.split('.');
  if (!resource || !action || rest.length > 0) {
    return trimmed;
  }

  return `${resource}.${normalizeOperationPermissionAction(action)}`;
}

function matchesPattern(slug: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }

  const regex = new RegExp(
    `^${escapeRegExp(pattern).replaceAll('\\*', '.*')}$`,
  );
  return regex.test(slug);
}

function emptyResult(): SeedRolePermissionsResult {
  return {
    added: {},
    matched: {},
    missingPermissions: {},
    missingRoles: [],
    removed: {},
    unchanged: {},
    unmatchedPatterns: {},
  };
}

function ensureResultSlot(
  result: SeedRolePermissionsResult,
  roleSlug: string,
): void {
  result.added[roleSlug] ??= [];
  result.matched[roleSlug] ??= [];
  result.missingPermissions[roleSlug] ??= [];
  result.removed[roleSlug] ??= [];
  result.unchanged[roleSlug] ??= [];
  result.unmatchedPatterns[roleSlug] ??= [];
}

/**
 * Collection for managing RolePermission objects
 */
export class RolePermissionCollection extends SmrtCollection<RolePermission> {
  static readonly _itemClass = RolePermission;

  /**
   * Find all permissions for a role
   */
  async findByRole(roleId: string): Promise<RolePermission[]> {
    return await this.list({
      where: { roleId },
    });
  }

  /**
   * Find all roles that have a permission
   */
  async findByPermission(permissionId: string): Promise<RolePermission[]> {
    return await this.list({
      where: { permissionId },
    });
  }

  /**
   * Check if a role has a specific permission
   */
  async hasPermission(roleId: string, permissionId: string): Promise<boolean> {
    const results = await this.list({
      where: { roleId, permissionId },
      limit: 1,
    });
    return results.length > 0;
  }

  /**
   * Add a permission to a role
   */
  async addPermission(
    roleId: string,
    permissionId: string,
  ): Promise<RolePermission> {
    // Check if already exists
    const existing = await this.list({
      where: { roleId, permissionId },
      limit: 1,
    });
    if (existing.length > 0) {
      return existing[0];
    }

    const rolePermission = await this.create({ roleId, permissionId });
    await rolePermission.save();
    return rolePermission;
  }

  /**
   * Remove a permission from a role
   */
  async removePermission(
    roleId: string,
    permissionId: string,
  ): Promise<boolean> {
    const existing = await this.list({
      where: { roleId, permissionId },
      limit: 1,
    });
    if (existing.length === 0) {
      return false;
    }

    await existing[0].delete();
    return true;
  }

  /**
   * Get permission IDs for a role
   */
  async getPermissionIds(roleId: string): Promise<string[]> {
    const rolePermissions = await this.findByRole(roleId);
    return rolePermissions.map((rp) => rp.permissionId as string);
  }

  /**
   * Seed role-to-permission mappings from catalog-aware glob patterns.
   *
   * Defaults to the system owner/admin/member/viewer matrix. Re-running is
   * idempotent: existing mappings are reported as `unchanged`, new catalog
   * slugs are added, and stale mappings are only removed when `prune` is true.
   */
  async seedRolePermissions(
    matrix: RolePermissionPatternMatrix = DEFAULT_ROLE_PERMISSION_PATTERNS,
    options: SeedRolePermissionsOptions = {},
  ): Promise<SeedRolePermissionsResult> {
    const result = emptyResult();
    const catalogService = PermissionCatalogService.create(this.options);
    const syncResult =
      options.syncCatalog === false
        ? undefined
        : await catalogService.syncPermissionCatalog();
    const catalog =
      options.catalog ?? syncResult?.catalog ?? catalogService.getCatalog();
    const permissions = await PermissionCollection.create(this.options);
    const roles = await RoleCollection.create(this.options);
    const catalogSlugs = catalog.permissions.map(
      (permission) => permission.slug,
    );

    for (const [roleSlug, rawPatterns] of Object.entries(matrix)) {
      ensureResultSlot(result, roleSlug);

      const role = await roles.findBySlug(roleSlug, options.tenantId);
      if (!role?.id) {
        result.missingRoles.push(roleSlug);
        continue;
      }

      const patterns = (rawPatterns ?? []).map(normalizePattern);
      const matchedSlugs = new Set<string>();
      for (const pattern of patterns) {
        const matches = catalogSlugs.filter((slug) =>
          matchesPattern(slug, pattern),
        );
        if (matches.length === 0) {
          result.unmatchedPatterns[roleSlug].push(pattern);
        }
        for (const slug of matches) {
          matchedSlugs.add(slug);
        }
      }

      const sortedMatchedSlugs = Array.from(matchedSlugs).sort();
      result.matched[roleSlug].push(...sortedMatchedSlugs);

      const existingPermissionIds = new Set(
        await this.getPermissionIds(role.id),
      );
      const targetPermissionIds = new Set<string>();

      for (const slug of sortedMatchedSlugs) {
        const permission = await permissions.findBySlug(slug);
        if (!permission?.id) {
          result.missingPermissions[roleSlug].push(slug);
          continue;
        }

        targetPermissionIds.add(permission.id);
        if (existingPermissionIds.has(permission.id)) {
          result.unchanged[roleSlug].push(slug);
          continue;
        }

        await this.addPermission(role.id, permission.id);
        result.added[roleSlug].push(slug);
      }

      if (!options.prune) {
        continue;
      }

      const existingPermissions = await permissions.findByIds(
        Array.from(existingPermissionIds),
      );
      for (const permissionId of existingPermissionIds) {
        if (targetPermissionIds.has(permissionId)) {
          continue;
        }

        await this.removePermission(role.id, permissionId);
        result.removed[roleSlug].push(
          existingPermissions.get(permissionId)?.slug ?? permissionId,
        );
      }
    }

    return result;
  }
}
