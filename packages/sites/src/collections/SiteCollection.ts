/**
 * SiteCollection - Collection manager for Site objects
 *
 * Provides domain lookup, tenant filtering, and status queries.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Site } from '../models/Site';
import type { SiteStatus } from '../types';

export class SiteCollection extends SmrtCollection<Site> {
  static readonly _itemClass = Site;

  /**
   * Find a site by its primary domain
   */
  async findByDomain(domain: string): Promise<Site | null> {
    const results = await this.list({ where: { domain } });
    return results[0] ?? null;
  }

  /**
   * Find all sites belonging to a tenant
   */
  async findByTenant(tenantId: string): Promise<Site[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find sites by lifecycle status
   */
  async findByStatus(status: SiteStatus): Promise<Site[]> {
    return this.list({ where: { status } });
  }

  /**
   * Find all active sites
   */
  async findActive(): Promise<Site[]> {
    return this.findByStatus('active');
  }
}
