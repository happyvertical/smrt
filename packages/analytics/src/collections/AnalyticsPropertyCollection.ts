/**
 * AnalyticsPropertyCollection - Collection manager for AnalyticsProperty objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AnalyticsProperty } from '../models/AnalyticsProperty.js';
import { AnalyticsPropertyStatus, AnalyticsProvider } from '../types/index.js';

export class AnalyticsPropertyCollection extends SmrtCollection<AnalyticsProperty> {
  static readonly _itemClass = AnalyticsProperty;

  /**
   * Find property by external ID
   *
   * @param externalId - External ID from provider
   * @returns Matching property or null
   */
  async findByExternalId(
    externalId: string,
  ): Promise<AnalyticsProperty | null> {
    const results = await this.list({
      where: { externalId },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find property by measurement ID (GA4)
   *
   * @param measurementId - GA4 measurement ID (G-XXXXXXXXXX)
   * @returns Matching property or null
   */
  async findByMeasurementId(
    measurementId: string,
  ): Promise<AnalyticsProperty | null> {
    const results = await this.list({
      where: { measurementId },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find property by site domain (Plausible)
   *
   * @param siteDomain - Plausible site domain
   * @returns Matching property or null
   */
  async findBySiteDomain(
    siteDomain: string,
  ): Promise<AnalyticsProperty | null> {
    const results = await this.list({
      where: { siteDomain },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find properties by provider
   *
   * @param provider - Analytics provider
   * @returns Array of matching properties
   */
  async findByProvider(
    provider: AnalyticsProvider,
  ): Promise<AnalyticsProperty[]> {
    return await this.list({
      where: { provider },
      orderBy: 'displayName ASC',
    });
  }

  /**
   * Find all GA4 properties
   */
  async findGA4Properties(): Promise<AnalyticsProperty[]> {
    return await this.findByProvider(AnalyticsProvider.GA4);
  }

  /**
   * Find all Plausible sites
   */
  async findPlausibleSites(): Promise<AnalyticsProperty[]> {
    return await this.findByProvider(AnalyticsProvider.PLAUSIBLE);
  }

  /**
   * Find properties by status
   *
   * @param status - Property status
   * @returns Array of matching properties
   */
  async findByStatus(
    status: AnalyticsPropertyStatus,
  ): Promise<AnalyticsProperty[]> {
    return await this.list({
      where: { status },
      orderBy: 'displayName ASC',
    });
  }

  /**
   * Find all active properties
   */
  async findActive(): Promise<AnalyticsProperty[]> {
    return await this.findByStatus(AnalyticsPropertyStatus.ACTIVE);
  }

  /**
   * Find properties that need syncing (not synced in last N hours)
   *
   * @param hoursAgo - Hours since last sync
   * @returns Array of properties needing sync
   */
  async findNeedingSync(hoursAgo: number = 24): Promise<AnalyticsProperty[]> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hoursAgo);

    // Get properties where lastSyncAt is null or older than cutoff
    const all = await this.findActive();
    return all.filter((p) => !p.lastSyncAt || p.lastSyncAt < cutoff);
  }
}
