/**
 * AdEvent model - Immutable event tracking (impressions, clicks)
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { AdEventType } from '../types/index.js';
import { AdVariation } from './AdVariation.js';

/**
 * AdEvent tracks ad impressions, clicks, and conversions.
 * Events are immutable (append-only, no update/delete).
 *
 * References:
 * - variationId: FK to AdVariation (within package)
 * - zoneId: String reference to smrt-properties Zone (cross-package)
 * - siteId: Denormalized for query efficiency (cross-package)
 *
 * @example
 * ```typescript
 * // Track an impression
 * const impression = await events.create({
 *   variationId: variation.id,
 *   zoneId: 'zone-uuid',
 *   siteId: 'site-uuid',
 *   eventType: AdEventType.IMPRESSION,
 *   metadata: JSON.stringify({
 *     ip: '192.168.1.1',
 *     userAgent: 'Mozilla/5.0...',
 *     referrer: 'https://example.com'
 *   })
 * });
 *
 * // Track a click
 * const click = await events.create({
 *   variationId: variation.id,
 *   zoneId: 'zone-uuid',
 *   siteId: 'site-uuid',
 *   eventType: AdEventType.CLICK
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['create', 'list'] }, // No update/delete (immutable)
  mcp: { include: ['create'] },
  cli: false, // High volume, not useful in CLI
})
export class AdEvent extends SmrtObject {
  /**
   * Tenant ID for multi-tenancy support
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Variation ID (FK to AdVariation)
   */
  variationId = foreignKey(AdVariation);

  /**
   * Zone ID (FK to smrt-properties Zone, cross-package)
   */
  zoneId: string = '';

  /**
   * Site ID (denormalized from Zone for query efficiency)
   */
  siteId: string = '';

  /**
   * Event type (impression, click, conversion)
   */
  eventType: AdEventType = AdEventType.IMPRESSION;

  /**
   * Event timestamp
   */
  timestamp: Date = new Date();

  /**
   * Analytics metadata as JSON string
   * (IP, user agent, referrer, etc.)
   */
  metadata: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.variationId !== undefined)
      this.variationId = options.variationId;
    if (options.zoneId !== undefined) this.zoneId = options.zoneId;
    if (options.siteId !== undefined) this.siteId = options.siteId;
    if (options.eventType !== undefined) this.eventType = options.eventType;
    if (options.timestamp !== undefined) this.timestamp = options.timestamp;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Get metadata as object
   */
  getMetadata(): Record<string, any> {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  /**
   * Set metadata from object
   */
  setMetadata(data: Record<string, any>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Check if this is an impression event
   */
  isImpression(): boolean {
    return this.eventType === AdEventType.IMPRESSION;
  }

  /**
   * Check if this is a click event
   */
  isClick(): boolean {
    return this.eventType === AdEventType.CLICK;
  }

  /**
   * Check if this is a conversion event
   */
  isConversion(): boolean {
    return this.eventType === AdEventType.CONVERSION;
  }
}

export default AdEvent;
