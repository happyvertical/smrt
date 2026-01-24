/**
 * AdEventCollection - Collection manager for AdEvent objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AdEvent } from '../models/AdEvent.js';
import { AdEventType } from '../types/index.js';

export class AdEventCollection extends SmrtCollection<AdEvent> {
  static readonly _itemClass = AdEvent;

  /**
   * Find events by variation
   *
   * @param variationId - Variation ID
   * @returns Array of events
   */
  async findByVariation(variationId: string): Promise<AdEvent[]> {
    return await this.list({
      where: { variationId },
      orderBy: 'timestamp DESC',
    });
  }

  /**
   * Find events by zone
   *
   * @param zoneId - Zone ID
   * @returns Array of events
   */
  async findByZone(zoneId: string): Promise<AdEvent[]> {
    return await this.list({
      where: { zoneId },
      orderBy: 'timestamp DESC',
    });
  }

  /**
   * Find events by site
   *
   * @param siteId - Site ID
   * @returns Array of events
   */
  async findBySite(siteId: string): Promise<AdEvent[]> {
    return await this.list({
      where: { siteId },
      orderBy: 'timestamp DESC',
    });
  }

  /**
   * Find events in date range
   *
   * @param start - Start date
   * @param end - End date
   * @returns Array of events
   */
  async findByDateRange(start: Date, end: Date): Promise<AdEvent[]> {
    return await this.list({
      where: {
        'timestamp >=': start.toISOString(),
        'timestamp <=': end.toISOString(),
      },
      orderBy: 'timestamp DESC',
    });
  }

  /**
   * Find events by type
   *
   * @param eventType - Event type
   * @returns Array of events
   */
  async findByType(eventType: AdEventType): Promise<AdEvent[]> {
    return await this.list({
      where: { eventType },
      orderBy: 'timestamp DESC',
    });
  }

  /**
   * Count events by type for a variation
   *
   * @param variationId - Variation ID
   * @param eventType - Event type
   * @returns Count of events
   */
  async countByType(
    variationId: string,
    eventType: AdEventType,
  ): Promise<number> {
    const events = await this.list({
      where: { variationId, eventType },
    });
    return events.length;
  }

  /**
   * Count impressions for a variation
   */
  async countImpressions(variationId: string): Promise<number> {
    return await this.countByType(variationId, AdEventType.IMPRESSION);
  }

  /**
   * Count clicks for a variation
   */
  async countClicks(variationId: string): Promise<number> {
    return await this.countByType(variationId, AdEventType.CLICK);
  }

  /**
   * Count conversions for a variation
   */
  async countConversions(variationId: string): Promise<number> {
    return await this.countByType(variationId, AdEventType.CONVERSION);
  }

  /**
   * Find all impressions
   */
  async findImpressions(): Promise<AdEvent[]> {
    return await this.findByType(AdEventType.IMPRESSION);
  }

  /**
   * Find all clicks
   */
  async findClicks(): Promise<AdEvent[]> {
    return await this.findByType(AdEventType.CLICK);
  }

  /**
   * Find all conversions
   */
  async findConversions(): Promise<AdEvent[]> {
    return await this.findByType(AdEventType.CONVERSION);
  }

  /**
   * Get aggregate stats for a variation
   *
   * @param variationId - Variation ID
   * @returns Stats object with impressions, clicks, conversions, CTR
   */
  async getVariationStats(variationId: string): Promise<{
    impressions: number;
    clicks: number;
    conversions: number;
    ctr: number;
    conversionRate: number;
  }> {
    const impressions = await this.countImpressions(variationId);
    const clicks = await this.countClicks(variationId);
    const conversions = await this.countConversions(variationId);

    return {
      impressions,
      clicks,
      conversions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      conversionRate: clicks > 0 ? conversions / clicks : 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenancy Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find ad events belonging to a specific tenant
   *
   * @param tenantId - Tenant ID to filter by
   * @returns Array of ad events for the tenant
   */
  async findByTenant(tenantId: string): Promise<AdEvent[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find global ad events (no tenant association)
   *
   * @returns Array of global ad events
   */
  async findGlobal(): Promise<AdEvent[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find ad events for a tenant including global (shared) events
   *
   * @param tenantId - Tenant ID to include
   * @returns Array of tenant-specific and global ad events
   */
  async findWithGlobals(tenantId: string): Promise<AdEvent[]> {
    return this.query(
      `SELECT * FROM ad_events WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
