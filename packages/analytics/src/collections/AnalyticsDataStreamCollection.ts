/**
 * AnalyticsDataStreamCollection - Collection manager for AnalyticsDataStream objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AnalyticsDataStream } from '../models/AnalyticsDataStream.js';
import { DataStreamStatus, DataStreamType } from '../types/index.js';

export class AnalyticsDataStreamCollection extends SmrtCollection<AnalyticsDataStream> {
  static readonly _itemClass = AnalyticsDataStream;

  /**
   * Find streams by property
   *
   * @param propertyId - Parent property ID
   * @returns Array of data streams
   */
  async findByProperty(propertyId: string): Promise<AnalyticsDataStream[]> {
    return await this.list({
      where: { propertyId },
      orderBy: 'displayName ASC',
    });
  }

  /**
   * Find stream by external ID
   *
   * @param externalId - External stream ID from provider
   * @returns Matching stream or null
   */
  async findByExternalId(
    externalId: string,
  ): Promise<AnalyticsDataStream | null> {
    const results = await this.list({
      where: { externalId },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find stream by measurement ID (web streams)
   *
   * @param measurementId - GA4 measurement ID (G-XXXXXXX)
   * @returns Matching stream or null
   */
  async findByMeasurementId(
    measurementId: string,
  ): Promise<AnalyticsDataStream | null> {
    const results = await this.list({
      where: { measurementId },
      limit: 1,
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find streams by type
   *
   * @param streamType - Stream type (WEB, ANDROID, IOS)
   * @returns Array of matching streams
   */
  async findByType(streamType: DataStreamType): Promise<AnalyticsDataStream[]> {
    return await this.list({
      where: { streamType },
      orderBy: 'displayName ASC',
    });
  }

  /**
   * Find all web streams
   */
  async findWebStreams(): Promise<AnalyticsDataStream[]> {
    return await this.findByType(DataStreamType.WEB);
  }

  /**
   * Find all iOS app streams
   */
  async findIOSStreams(): Promise<AnalyticsDataStream[]> {
    return await this.findByType(DataStreamType.IOS);
  }

  /**
   * Find all Android app streams
   */
  async findAndroidStreams(): Promise<AnalyticsDataStream[]> {
    return await this.findByType(DataStreamType.ANDROID);
  }

  /**
   * Find all mobile app streams (iOS + Android)
   */
  async findMobileStreams(): Promise<AnalyticsDataStream[]> {
    const ios = await this.findIOSStreams();
    const android = await this.findAndroidStreams();
    return [...ios, ...android].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }

  /**
   * Find streams by status
   *
   * @param status - Stream status
   * @returns Array of matching streams
   */
  async findByStatus(status: DataStreamStatus): Promise<AnalyticsDataStream[]> {
    return await this.list({
      where: { status },
      orderBy: 'displayName ASC',
    });
  }

  /**
   * Find all active streams
   */
  async findActive(): Promise<AnalyticsDataStream[]> {
    return await this.findByStatus(DataStreamStatus.ACTIVE);
  }

  /**
   * Find active streams for a property
   *
   * @param propertyId - Parent property ID
   * @returns Array of active streams
   */
  async findActiveByProperty(
    propertyId: string,
  ): Promise<AnalyticsDataStream[]> {
    return await this.list({
      where: {
        propertyId,
        status: DataStreamStatus.ACTIVE,
      },
      orderBy: 'displayName ASC',
    });
  }
}
