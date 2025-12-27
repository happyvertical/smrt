/**
 * AdDeliveryTierCollection - Collection manager for AdDeliveryTier objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AdDeliveryTier } from '../models/AdDeliveryTier.js';
import { PricingModel } from '../types/index.js';

export class AdDeliveryTierCollection extends SmrtCollection<AdDeliveryTier> {
  static readonly _itemClass = AdDeliveryTier;

  /**
   * Find tiers ordered by priority (ascending, lower = higher priority)
   *
   * @returns Array of tiers ordered by priority
   */
  async findByPriority(): Promise<AdDeliveryTier[]> {
    return await this.list({
      orderBy: 'priority ASC',
    });
  }

  /**
   * Find tiers by pricing model
   *
   * @param pricingModel - Pricing model to filter by
   * @returns Array of matching tiers
   */
  async findByPricingModel(
    pricingModel: PricingModel,
  ): Promise<AdDeliveryTier[]> {
    return await this.list({
      where: { pricingModel },
      orderBy: 'priority ASC',
    });
  }

  /**
   * Get the highest priority tier
   *
   * @returns Highest priority tier or null
   */
  async getHighestPriority(): Promise<AdDeliveryTier | null> {
    const results = await this.list({
      orderBy: 'priority ASC',
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find fixed pricing tiers
   */
  async findFixedPricing(): Promise<AdDeliveryTier[]> {
    return await this.findByPricingModel(PricingModel.FIXED);
  }

  /**
   * Find CPM-based tiers
   */
  async findCPM(): Promise<AdDeliveryTier[]> {
    return await this.findByPricingModel(PricingModel.CPM);
  }

  /**
   * Find performance-based tiers (CPC, CPA)
   */
  async findPerformanceBased(): Promise<AdDeliveryTier[]> {
    const cpc = await this.findByPricingModel(PricingModel.CPC);
    const cpa = await this.findByPricingModel(PricingModel.CPA);
    return [...cpc, ...cpa].sort((a, b) => a.priority - b.priority);
  }
}
