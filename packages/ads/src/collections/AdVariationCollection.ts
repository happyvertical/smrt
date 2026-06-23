/**
 * AdVariationCollection - Collection manager for AdVariation objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { AdVariation } from '../models/AdVariation.js';
import { AdVariationStatus } from '../types/index.js';

export class AdVariationCollection extends SmrtCollection<AdVariation> {
  static readonly _itemClass = AdVariation;

  /**
   * Find variations by ad group
   *
   * @param groupId - Ad group ID
   * @returns Array of variations
   */
  async findByGroup(groupId: string): Promise<AdVariation[]> {
    return await this.list({
      where: { groupId },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find variations by format
   *
   * @param formatId - Ad format ID
   * @returns Array of variations
   */
  async findByFormat(formatId: string): Promise<AdVariation[]> {
    return await this.list({
      where: { formatId },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find active variations for a group
   *
   * @param groupId - Ad group ID
   * @returns Array of active variations
   */
  async findActiveByGroup(groupId: string): Promise<AdVariation[]> {
    return await this.list({
      where: {
        groupId,
        status: AdVariationStatus.ACTIVE,
      },
      orderBy: 'name ASC',
    });
  }

  /**
   * Select a variation using weighted random selection
   * Higher weight = more likely to be selected
   *
   * @param groupId - Ad group ID
   * @returns Selected variation or null if none available
   */
  async selectByWeight(groupId: string): Promise<AdVariation | null> {
    const active = await this.findActiveByGroup(groupId);
    if (active.length === 0) return null;
    if (active.length === 1) return active[0];

    // Calculate total weight
    const totalWeight = active.reduce((sum, v) => sum + v.weight, 0);
    if (totalWeight <= 0) return active[0];

    // Random selection weighted by weight
    let random = Math.random() * totalWeight;
    for (const variation of active) {
      random -= variation.weight;
      if (random <= 0) {
        return variation;
      }
    }

    // Fallback to last variation
    return active[active.length - 1];
  }

  /**
   * Find variations by status
   *
   * @param status - Variation status
   * @returns Array of variations
   */
  async findByStatus(status: AdVariationStatus): Promise<AdVariation[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all active variations
   */
  async findActive(): Promise<AdVariation[]> {
    return await this.findByStatus(AdVariationStatus.ACTIVE);
  }

  /**
   * Find all draft variations
   */
  async findDrafts(): Promise<AdVariation[]> {
    return await this.findByStatus(AdVariationStatus.DRAFT);
  }

  /**
   * Find all paused variations
   */
  async findPaused(): Promise<AdVariation[]> {
    return await this.findByStatus(AdVariationStatus.PAUSED);
  }

  /**
   * Find top performing variations by CTR
   *
   * @param limit - Maximum number to return
   * @returns Array of variations sorted by CTR descending
   */
  async findTopPerformers(limit: number = 10): Promise<AdVariation[]> {
    const all = await this.list({
      where: { status: AdVariationStatus.ACTIVE },
    });
    // Sort by CTR descending
    return all
      .filter((v) => v.impressions > 0)
      .sort((a, b) => b.getCTR() - a.getCTR())
      .slice(0, limit);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenancy Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find ad variations belonging to a specific tenant
   *
   * @param tenantId - Tenant ID to filter by
   * @returns Array of ad variations for the tenant
   */
  async findByTenant(tenantId: string): Promise<AdVariation[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find global ad variations (no tenant association).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global ad variations
   */
  async findGlobal(): Promise<AdVariation[]> {
    return queryGlobal<AdVariation>(this);
  }

  /**
   * Find ad variations for a tenant including global (shared) variations.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID to include
   * @returns Array of tenant-specific and global ad variations
   */
  async findWithGlobals(tenantId: string): Promise<AdVariation[]> {
    return queryWithGlobals<AdVariation>(
      this,
      tenantId,
      'AdVariation.findWithGlobals',
    );
  }
}
