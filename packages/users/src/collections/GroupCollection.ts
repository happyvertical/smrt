/**
 * GroupCollection - Collection manager for Group objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Group } from '../models/Group.js';

/**
 * Collection for managing Group objects
 */
export class GroupCollection extends SmrtCollection<Group> {
  static readonly _itemClass = Group;

  /**
   * Find all groups in a tenant
   */
  async findByTenant(tenantId: string): Promise<Group[]> {
    return await this.list({
      where: { tenantId },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find group by slug within a tenant
   */
  async findBySlug(slug: string, tenantId: string): Promise<Group | null> {
    const results = await this.list({
      where: { slug, tenantId },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }
}
