/**
 * FactTagCollection - Collection manager for FactTag objects
 *
 * Provides queries for fact-tag links, including
 * add/remove operations and tag-centric lookups.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { FactTag } from './fact-tag';

export class FactTagCollection extends SmrtCollection<FactTag> {
  static readonly _itemClass = FactTag;

  /**
   * Get all tag links for a fact
   */
  async getForFact(factId: string): Promise<FactTag[]> {
    return this.list({ where: { factId } });
  }

  /**
   * Get all fact links for a tag slug
   */
  async getForTag(tagSlug: string): Promise<FactTag[]> {
    return this.list({ where: { tagSlug } });
  }

  /**
   * Add a tag to a fact
   */
  async addTag(factId: string, tagSlug: string): Promise<FactTag> {
    return this.create({
      factId,
      tagSlug,
    });
  }

  /**
   * Remove a tag from a fact
   */
  async removeTag(factId: string, tagSlug: string): Promise<void> {
    const links = await this.list({
      where: { factId, tagSlug },
    });
    for (const link of links) {
      await link.delete();
    }
  }

  /**
   * Get all tag slugs for a fact
   */
  async getTagSlugs(factId: string): Promise<string[]> {
    const tags = await this.getForFact(factId);
    return tags.map((t) => t.tagSlug);
  }

  // =========================================================================
  // Tenant Helper Methods
  // =========================================================================

  /**
   * Find all fact-tag links belonging to a specific tenant
   */
  async findByTenant(tenantId: string): Promise<FactTag[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global (tenant-less) fact-tag links.
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   */
  async findGlobal(): Promise<FactTag[]> {
    return queryGlobal<FactTag>(this);
  }

  /**
   * Find fact-tag links for a tenant including global links.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   */
  async findWithGlobals(tenantId: string): Promise<FactTag[]> {
    return queryWithGlobals<FactTag>(this, tenantId, 'FactTag.findWithGlobals');
  }
}
