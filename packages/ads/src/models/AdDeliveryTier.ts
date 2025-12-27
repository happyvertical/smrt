/**
 * AdDeliveryTier model - Priority waterfall for ad selection
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { PricingModel } from '../types/index.js';

/**
 * AdDeliveryTier defines priority levels for ad serving.
 *
 * Ads are selected by priority (lower = higher priority):
 * 1. Sponsorship - Guaranteed, premium placements
 * 2. Standard - Regular programmatic ads
 * 3. House - Self-promotional/fallback ads
 *
 * @example
 * ```typescript
 * const sponsorship = await tiers.create({
 *   name: 'Sponsorship',
 *   priority: 1,
 *   pricingModel: PricingModel.FIXED,
 *   description: 'Premium guaranteed placements'
 * });
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class AdDeliveryTier extends SmrtObject {
  /**
   * Display name (e.g., "Sponsorship", "Standard", "House")
   */
  name: string = '';

  /**
   * Priority level (lower = higher priority: 1, 2, 3...)
   */
  priority: number = 0;

  /**
   * Pricing model for this tier
   */
  pricingModel: PricingModel = PricingModel.CPM;

  /**
   * Optional description
   */
  description: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.priority !== undefined) this.priority = options.priority;
    if (options.pricingModel !== undefined)
      this.pricingModel = options.pricingModel;
    if (options.description !== undefined)
      this.description = options.description;
  }

  /**
   * Check if this tier is higher priority than another
   */
  isHigherPriorityThan(other: AdDeliveryTier): boolean {
    return this.priority < other.priority;
  }

  /**
   * Check if this is a fixed pricing tier
   */
  isFixedPricing(): boolean {
    return this.pricingModel === PricingModel.FIXED;
  }

  /**
   * Check if this is a performance-based tier (CPC, CPA)
   */
  isPerformanceBased(): boolean {
    return (
      this.pricingModel === PricingModel.CPC ||
      this.pricingModel === PricingModel.CPA
    );
  }
}

export default AdDeliveryTier;
