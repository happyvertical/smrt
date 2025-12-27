/**
 * AdVariationCollection - Collection manager for AdVariation objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
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
}
