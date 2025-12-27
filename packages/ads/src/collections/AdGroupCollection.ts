/**
 * AdGroupCollection - Collection manager for AdGroup objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AdGroup } from '../models/AdGroup.js';
import { AdGroupStatus } from '../types/index.js';

export class AdGroupCollection extends SmrtCollection<AdGroup> {
  static readonly _itemClass = AdGroup;

  /**
   * Find ad groups by contract
   *
   * @param contractId - Contract ID
   * @returns Array of ad groups
   */
  async findByContract(contractId: string): Promise<AdGroup[]> {
    return await this.list({
      where: { contractId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find ad groups by tier
   *
   * @param tierId - Delivery tier ID
   * @returns Array of ad groups
   */
  async findByTier(tierId: string): Promise<AdGroup[]> {
    return await this.list({
      where: { tierId },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find ad groups by status
   *
   * @param status - Ad group status
   * @returns Array of ad groups
   */
  async findByStatus(status: AdGroupStatus): Promise<AdGroup[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find currently active ad groups
   * (status=active, started, not ended)
   *
   * @returns Array of active ad groups
   */
  async findActive(): Promise<AdGroup[]> {
    const now = new Date().toISOString();
    const results = await this.list({
      where: {
        status: AdGroupStatus.ACTIVE,
      },
      orderBy: 'created_at DESC',
    });
    // Filter by date in memory (complex date logic)
    return results.filter((group) => group.isActive());
  }

  /**
   * Find ad groups by vertical slug
   *
   * @param verticalSlug - Tag slug from smrt-tags
   * @returns Array of ad groups
   */
  async findByVertical(verticalSlug: string): Promise<AdGroup[]> {
    return await this.list({
      where: { verticalSlug },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find ad groups that can serve to a specific zone
   *
   * @param zoneId - Zone ID to check
   * @returns Array of ad groups containing zone
   */
  async findByZone(zoneId: string): Promise<AdGroup[]> {
    // Must filter in memory since zoneIds is JSON
    const all = await this.list({
      where: { status: AdGroupStatus.ACTIVE },
    });
    return all.filter((group) => group.hasZoneId(zoneId));
  }

  /**
   * Find ad groups eligible to serve for a zone
   * (active, has zone, within date range)
   *
   * @param zoneId - Zone ID to check
   * @returns Array of eligible ad groups
   */
  async findEligibleForZone(zoneId: string): Promise<AdGroup[]> {
    const groups = await this.findByZone(zoneId);
    return groups.filter((group) => group.isActive());
  }

  /**
   * Find all draft ad groups
   */
  async findDrafts(): Promise<AdGroup[]> {
    return await this.findByStatus(AdGroupStatus.DRAFT);
  }

  /**
   * Find all paused ad groups
   */
  async findPaused(): Promise<AdGroup[]> {
    return await this.findByStatus(AdGroupStatus.PAUSED);
  }

  /**
   * Find all completed ad groups
   */
  async findCompleted(): Promise<AdGroup[]> {
    return await this.findByStatus(AdGroupStatus.COMPLETED);
  }
}
