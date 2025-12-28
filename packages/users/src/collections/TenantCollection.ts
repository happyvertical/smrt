/**
 * TenantCollection - Collection manager for Tenant objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Tenant } from '../models/Tenant.js';
import { TenantStatus } from '../types/index.js';

/**
 * Collection for managing Tenant objects
 */
export class TenantCollection extends SmrtCollection<Tenant> {
  static readonly _itemClass = Tenant;

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
}
