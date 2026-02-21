/**
 * FactSourceCollection - Collection manager for FactSource objects
 *
 * Provides queries for sources by fact, type, and credibility.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
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
    const all = await this.list({});
    return all.filter((s) => s.credibility >= minCredibility);
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
   * Find all global (tenant-less) sources
   */
  async findGlobal(): Promise<FactSource[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find sources for a tenant including global sources
   */
  async findWithGlobals(tenantId: string): Promise<FactSource[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
