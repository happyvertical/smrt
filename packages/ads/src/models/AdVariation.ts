/**
 * AdVariation model - Creative asset with A/B testing support
 * @packageDocumentation
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { AdVariationStatus } from '../types/index.js';

/**
 * Options for constructing an {@link AdVariation}.
 */
export interface AdVariationOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  groupId?: string;
  formatId?: string;
  assetId?: string;
  name?: string;
  clickUrl?: string;
  altText?: string;
  weight?: number;
  status?: AdVariationStatus;
  impressions?: number;
  clicks?: number;
}

/**
 * AdVariation represents a creative asset within an ad group.
 * Supports A/B testing via weighted selection.
 *
 * References:
 * - groupId: FK to AdGroup (within package)
 * - formatId: FK to AdFormat (within package)
 * - assetId: String reference to smrt-assets Asset (cross-package)
 *
 * @example
 * ```typescript
 * const variation = await variations.create({
 *   groupId: adGroup.id,
 *   formatId: leaderboard.id,
 *   assetId: 'asset-uuid',
 *   name: 'Version A - Blue CTA',
 *   clickUrl: 'https://example.com/landing',
 *   altText: 'Summer Sale - 50% off',
 *   weight: 2  // 2x more likely than weight=1
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: { skipApiCheck: true },
})
export class AdVariation extends SmrtObject {
  /**
   * Tenant ID for multi-tenancy support
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Ad group ID (FK to AdGroup)
   */
  @foreignKey('AdGroup')
  @field({ description: 'The campaign this ad belongs to.' })
  groupId: string = '';

  /**
   * Ad format ID (FK to AdFormat)
   */
  @foreignKey('AdFormat')
  @field({ description: 'The ad size this ad is made for.' })
  formatId: string = '';

  /**
   * Asset ID (FK to smrt-assets Asset, cross-package)
   */
  @crossPackageRef('@happyvertical/smrt-assets:Asset')
  @field({ description: 'The picture people see.' })
  assetId: string = '';

  /**
   * Display name (e.g., "Version A - Blue CTA")
   */
  @field({
    description: 'What you call this ad, for example Version A, blue button.',
  })
  name: string = '';

  /**
   * Click destination URL
   */
  @field({ description: 'The web address people go to when they tap the ad.' })
  clickUrl: string = '';

  /**
   * Accessibility alt text
   */
  @field({
    description:
      'A few words that describe the picture for people who cannot see it.',
  })
  altText: string = '';

  /**
   * A/B testing weight (higher = more likely to be selected)
   */
  @field({
    description:
      'How often this ad shows compared with the others in its campaign: an ad with weight 2 shows twice as often as one with weight 1.',
  })
  weight: number = 1;

  /**
   * Current status
   */
  @field({
    description:
      'Where the ad stands: draft, active or paused. Only active ads show.',
  })
  status: AdVariationStatus = AdVariationStatus.DRAFT;

  /**
   * Denormalized impression count (updated async)
   */
  @field({
    description:
      'How many times the ad has been shown. The app counts this as it serves ads and refreshes it a little later.',
  })
  impressions: number = 0;

  /**
   * Denormalized click count (updated async)
   */
  @field({
    description:
      'How many times the ad has been tapped. The app counts this as it serves ads and refreshes it a little later.',
  })
  clicks: number = 0;

  constructor(options: AdVariationOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.groupId !== undefined) this.groupId = options.groupId;
    if (options.formatId !== undefined) this.formatId = options.formatId;
    if (options.assetId !== undefined) this.assetId = options.assetId;
    if (options.name !== undefined) this.name = options.name;
    if (options.clickUrl !== undefined) this.clickUrl = options.clickUrl;
    if (options.altText !== undefined) this.altText = options.altText;
    if (options.weight !== undefined) this.weight = options.weight;
    if (options.status !== undefined) this.status = options.status;
    if (options.impressions !== undefined)
      this.impressions = options.impressions;
    if (options.clicks !== undefined) this.clicks = options.clicks;
  }

  /**
   * Check if variation is active
   */
  isActive(): boolean {
    return this.status === AdVariationStatus.ACTIVE;
  }

  /**
   * Check if variation is in draft state
   */
  isDraft(): boolean {
    return this.status === AdVariationStatus.DRAFT;
  }

  /**
   * Check if variation is paused
   */
  isPaused(): boolean {
    return this.status === AdVariationStatus.PAUSED;
  }

  /**
   * Calculate click-through rate (CTR)
   */
  getCTR(): number {
    if (this.impressions === 0) return 0;
    return this.clicks / this.impressions;
  }

  /**
   * Increment impression count
   */
  recordImpression(): void {
    this.impressions += 1;
  }

  /**
   * Increment click count
   */
  recordClick(): void {
    this.clicks += 1;
  }
}

export default AdVariation;
