/**
 * AnalyticsProperty model - Represents an analytics property/site
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { AnalyticsPropertyStatus, AnalyticsProvider } from '../types/index.js';

/**
 * AnalyticsProperty represents an analytics property (GA4 property or Plausible site).
 *
 * @example
 * ```typescript
 * const property = await properties.create({
 *   name: 'My Website',
 *   displayName: 'My Website Analytics',
 *   provider: AnalyticsProvider.GA4,
 *   externalId: 'properties/123456789',
 *   measurementId: 'G-XXXXXXXXXX'
 * });
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'sync', 'runReport'] },
  cli: true,
})
export class AnalyticsProperty extends SmrtObject {
  /**
   * Internal name/identifier
   */
  name: string = '';

  /**
   * Human-readable display name
   */
  displayName: string = '';

  /**
   * Analytics provider (ga4, plausible)
   */
  provider: AnalyticsProvider = AnalyticsProvider.GA4;

  /**
   * External ID from the provider (e.g., "properties/123456789" for GA4)
   */
  externalId: string = '';

  /**
   * Measurement ID for GA4 (G-XXXXXXXXXX)
   */
  measurementId: string = '';

  /**
   * API secret for server-side tracking (GA4)
   */
  apiSecret: string = '';

  /**
   * Site domain for Plausible
   */
  siteDomain: string = '';

  /**
   * Property timezone
   */
  timeZone: string = 'America/Los_Angeles';

  /**
   * Currency code (e.g., 'USD', 'EUR')
   */
  currencyCode: string = 'USD';

  /**
   * Industry category
   */
  industryCategory: string = '';

  /**
   * Service level (STANDARD, PREMIUM)
   */
  serviceLevel: string = 'STANDARD';

  /**
   * Property status
   */
  status: AnalyticsPropertyStatus = AnalyticsPropertyStatus.ACTIVE;

  /**
   * Last sync timestamp with provider
   */
  lastSyncAt: Date | null = null;

  /**
   * Metadata from provider (JSON)
   */
  providerMetadata: string = '{}';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.displayName !== undefined)
      this.displayName = options.displayName;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.externalId !== undefined) this.externalId = options.externalId;
    if (options.measurementId !== undefined)
      this.measurementId = options.measurementId;
    if (options.apiSecret !== undefined) this.apiSecret = options.apiSecret;
    if (options.siteDomain !== undefined) this.siteDomain = options.siteDomain;
    if (options.timeZone !== undefined) this.timeZone = options.timeZone;
    if (options.currencyCode !== undefined)
      this.currencyCode = options.currencyCode;
    if (options.industryCategory !== undefined)
      this.industryCategory = options.industryCategory;
    if (options.serviceLevel !== undefined)
      this.serviceLevel = options.serviceLevel;
    if (options.status !== undefined) this.status = options.status;
    if (options.lastSyncAt !== undefined) this.lastSyncAt = options.lastSyncAt;
    if (options.providerMetadata !== undefined)
      this.providerMetadata = options.providerMetadata;
  }

  /**
   * Check if this is a GA4 property
   */
  isGA4(): boolean {
    return this.provider === AnalyticsProvider.GA4;
  }

  /**
   * Check if this is a Plausible site
   */
  isPlausible(): boolean {
    return this.provider === AnalyticsProvider.PLAUSIBLE;
  }

  /**
   * Get parsed provider metadata
   */
  getProviderMetadata(): Record<string, unknown> {
    try {
      return JSON.parse(this.providerMetadata);
    } catch {
      return {};
    }
  }

  /**
   * Set provider metadata
   */
  setProviderMetadata(metadata: Record<string, unknown>): void {
    this.providerMetadata = JSON.stringify(metadata);
  }

  /**
   * Mark as synced with provider
   */
  markSynced(): void {
    this.lastSyncAt = new Date();
  }

  /**
   * AI-powered: Analyze property performance
   */
  async analyzePerformance(options: { period?: string } = {}): Promise<{
    action: string;
    period: string;
    analysis: string;
  }> {
    const period = options.period || '30 days';
    const analysis = await this.do(`
      Analyze the analytics performance for this property over the last ${period}.
      Consider: traffic trends, user engagement, conversion patterns.
      Property: ${this.displayName} (${this.provider})
    `);
    return {
      action: 'analyzePerformance',
      period,
      analysis,
    };
  }

  /**
   * AI-powered: Check if property is performing well
   */
  async isPerformingWell(): Promise<boolean> {
    return await this.is(`
      Based on the property configuration and metadata:
      - Property: ${this.displayName}
      - Provider: ${this.provider}
      - Status: ${this.status}
      - Last sync: ${this.lastSyncAt}

      Is this property properly configured and likely performing well?
    `);
  }
}

export default AnalyticsProperty;
