/**
 * FactContentCollection - Collection manager for FactContent objects
 *
 * Provides queries for fact-content links, including
 * link/unlink operations and content-centric lookups.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { FactContent } from './fact-content';
import type { FactContentRelationship } from './types';

export class FactContentCollection extends SmrtCollection<FactContent> {
  static readonly _itemClass = FactContent;

  /**
   * Get all content links for a fact
   */
  async getForFact(factId: string): Promise<FactContent[]> {
    return this.list({ where: { factId } });
  }

  /**
   * Get all fact links for a content item
   */
  async getForContent(contentId: string): Promise<FactContent[]> {
    return this.list({ where: { contentId } });
  }

  /**
   * Link a content item to a fact with a relationship type
   */
  async link(
    factId: string,
    contentId: string,
    relationship: FactContentRelationship = 'extracted_from',
  ): Promise<FactContent> {
    return this.create({
      factId,
      contentId,
      relationship,
    });
  }

  /**
   * Unlink a content item from a fact (removes all relationships)
   */
  async unlink(factId: string, contentId: string): Promise<void> {
    const links = await this.list({
      where: { factId, contentId },
    });
    for (const link of links) {
      await link.delete();
    }
  }

  // =========================================================================
  // Tenant Helper Methods
  // =========================================================================

  /**
   * Find all fact-content links belonging to a specific tenant
   */
  async findByTenant(tenantId: string): Promise<FactContent[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global (tenant-less) fact-content links
   */
  async findGlobal(): Promise<FactContent[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find fact-content links for a tenant including global links
   */
  async findWithGlobals(tenantId: string): Promise<FactContent[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
