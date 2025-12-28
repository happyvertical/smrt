/**
 * PermissionCollection - Collection manager for Permission objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Permission } from '../models/Permission.js';

/**
 * Collection for managing Permission objects
 */
export class PermissionCollection extends SmrtCollection<Permission> {
  static readonly _itemClass = Permission;

  /**
   * Find permissions by category
   */
  async findByCategory(category: string): Promise<Permission[]> {
    return await this.list({
      where: { category },
      orderBy: 'slug ASC',
    });
  }

  /**
   * Find permission by slug
   */
  async findBySlug(slug: string): Promise<Permission | null> {
    const results = await this.list({
      where: { slug },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Batch fetch permissions by IDs
   * Returns a Map of id -> Permission for efficient lookup
   */
  async findByIds(ids: string[]): Promise<Map<string, Permission>> {
    if (ids.length === 0) {
      return new Map();
    }

    // Remove duplicates
    const uniqueIds = [...new Set(ids)];

    // Build placeholders for SQL IN clause
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const results = await this.query(
      `SELECT * FROM ${this.tableName} WHERE id IN (${placeholders})`,
      uniqueIds,
    );

    const map = new Map<string, Permission>();
    for (const perm of results) {
      if (perm.id) {
        map.set(perm.id, perm);
      }
    }
    return map;
  }

  /**
   * Get all unique categories
   */
  async getCategories(): Promise<string[]> {
    const results = await this.query(
      `SELECT DISTINCT category FROM ${this.tableName} WHERE category != '' ORDER BY category ASC`,
    );
    return results.map((r: any) => r.category);
  }

  /**
   * Find or create a permission by slug
   */
  async findOrCreate(
    slug: string,
    defaults: Partial<{
      name: string;
      description: string;
      category: string;
    }> = {},
  ): Promise<Permission> {
    const existing = await this.findBySlug(slug);
    if (existing) {
      return existing;
    }

    const permission = await this.create({
      slug,
      name: defaults.name ?? slug,
      description: defaults.description ?? '',
      category: defaults.category ?? slug.split('.')[0],
    });
    await permission.save();
    return permission;
  }
}
