/**
 * FactCollection - Collection manager for Fact objects
 *
 * Provides query methods for facts by status, type, domain, and tenant.
 * Stubs for reconcile(), branch(), evolution, and confidence methods
 * to be implemented in Phase 1b/1d.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Fact } from './fact';
import type {
  EntityBriefing,
  EvolutionType,
  FactOptions,
  FactStatus,
  FactType,
  ReconcileOptions,
  ReconcileResult,
} from './types';

export class FactCollection extends SmrtCollection<Fact> {
  static readonly _itemClass = Fact;

  // =========================================================================
  // Simple Query Methods
  // =========================================================================

  /**
   * Get all active facts
   */
  async getActive(): Promise<Fact[]> {
    return this.list({ where: { status: 'active' } });
  }

  /**
   * Get all pending facts
   */
  async getPending(): Promise<Fact[]> {
    return this.list({ where: { status: 'pending' } });
  }

  /**
   * Get facts by type
   */
  async getByType(type: FactType): Promise<Fact[]> {
    return this.list({ where: { type } });
  }

  /**
   * Get facts by domain
   */
  async getByDomain(domain: string): Promise<Fact[]> {
    return this.list({ where: { domain } });
  }

  /**
   * Get facts by status
   */
  async getByStatus(status: FactStatus): Promise<Fact[]> {
    return this.list({ where: { status } });
  }

  /**
   * Get child facts for a parent
   */
  async getChildren(parentId: string): Promise<Fact[]> {
    return this.list({ where: { parentId } });
  }

  // =========================================================================
  // Tenant Helper Methods
  // =========================================================================

  /**
   * Find all facts belonging to a specific tenant
   */
  async findByTenant(tenantId: string): Promise<Fact[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global (tenant-less) facts
   */
  async findGlobal(): Promise<Fact[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find facts for a tenant including global facts
   */
  async findWithGlobals(tenantId: string): Promise<Fact[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }

  // =========================================================================
  // Reconcile & Evolution Stubs (Phase 1b)
  // =========================================================================

  /**
   * Reconcile raw input against existing facts using semantic search + AI.
   * Determines whether to create, merge, or branch.
   *
   * @stub Implemented in Phase 1b
   */
  async reconcile(_options: ReconcileOptions): Promise<ReconcileResult> {
    throw new Error('Not yet implemented');
  }

  /**
   * Create a branched fact from an existing parent.
   *
   * @stub Implemented in Phase 1b
   */
  async branch(
    _parentId: string,
    _data: Partial<FactOptions>,
    _evolutionType?: EvolutionType,
  ): Promise<Fact> {
    throw new Error('Not yet implemented');
  }

  /**
   * Walk up via parentId to the root fact, returning root→current array.
   *
   * @stub Implemented in Phase 1b
   */
  async getEvolutionChain(_factId: string): Promise<Fact[]> {
    throw new Error('Not yet implemented');
  }

  /**
   * Walk down children to find the latest (highest confidence) leaf.
   *
   * @stub Implemented in Phase 1b
   */
  async getLatestInChain(_factId: string): Promise<Fact> {
    throw new Error('Not yet implemented');
  }

  /**
   * Find root of chain, collect all descendants recursively.
   *
   * @stub Implemented in Phase 1b
   */
  async getEvolutionTree(_factId: string): Promise<Fact[]> {
    throw new Error('Not yet implemented');
  }

  /**
   * Recalculate confidence score for a fact based on its sources.
   *
   * @stub Implemented in Phase 1d
   */
  async recalculateConfidence(_factId: string): Promise<number> {
    throw new Error('Not yet implemented');
  }

  /**
   * Get a briefing of all facts related to a given entity.
   *
   * @stub Implemented in Phase 1b
   */
  async getEntityBriefing(
    _entityType: string,
    _entityId: string,
  ): Promise<EntityBriefing> {
    throw new Error('Not yet implemented');
  }
}
