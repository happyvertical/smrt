/**
 * Types and enums for smrt-ads package
 */

/**
 * Ad format types for different creative types
 */
export enum AdFormatType {
  BANNER = 'banner',
  NATIVE = 'native',
  VIDEO = 'video',
}

/**
 * Pricing models for ad delivery tiers
 */
export enum PricingModel {
  FIXED = 'fixed',
  CPM = 'cpm',
  CPC = 'cpc',
  CPA = 'cpa',
}

/**
 * Status for ad groups
 */
export enum AdGroupStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
}

/**
 * Status for ad variations
 */
export enum AdVariationStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  PAUSED = 'paused',
}

/**
 * Event types for ad tracking
 */
export enum AdEventType {
  IMPRESSION = 'impression',
  CLICK = 'click',
  CONVERSION = 'conversion',
}
