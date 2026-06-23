/**
 * FactSourceCollection - Collection manager for FactSource objects
 *
 * Provides queries for sources by fact, type, and credibility.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { FactSource } from './fact-source';

export class FactSourceCollection extends SmrtCollection<FactSource> {
  static readonly _itemClass = FactSource;

  /**
   * Get all sources for a given fact
   */
  async getForFact(factId: string): Promise<FactSource[]> {
    return this.list({ where: { factId } });
  }

  /**
   * Count sources for a given fact
   */
  async countForFact(factId: string): Promise<number> {
    const sources = await this.getForFact(factId);
    return sources.length;
  }

  /**
   * Get sources by type
   */
  async getByType(sourceType: string): Promise<FactSource[]> {
    return this.list({ where: { sourceType } });
  }

  /**
   * Get sources with credibility above a threshold
   */
  async getHighCredibility(
    minCredibility: number = 0.7,
  ): Promise<FactSource[]> {
    return this.list({ where: { 'credibility >=': minCredibility } });
  }

  /**
   * Get average credibility for a fact's sources
   */
  async getAverageCredibility(factId: string): Promise<number> {
    const sources = await this.getForFact(factId);
    if (sources.length === 0) return 0;
    const total = sources.reduce((sum, s) => sum + s.credibility, 0);
    return total / sources.length;
  }

  // =========================================================================
  // Tenant Helper Methods
  // =========================================================================

  /**
   * Find all sources belonging to a specific tenant
   */
  async findByTenant(tenantId: string): Promise<FactSource[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global (tenant-less) sources.
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   */
  async findGlobal(): Promise<FactSource[]> {
    return queryGlobal<FactSource>(this);
  }

  /**
   * Find sources for a tenant including global sources.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   */
  async findWithGlobals(tenantId: string): Promise<FactSource[]> {
    return queryWithGlobals<FactSource>(
      this,
      tenantId,
      'FactSource.findWithGlobals',
    );
  }
}
