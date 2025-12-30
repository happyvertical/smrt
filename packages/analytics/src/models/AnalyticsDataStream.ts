/**
 * AnalyticsDataStream model - Represents a data stream for a property
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { DataStreamStatus, DataStreamType } from '../types/index.js';

/**
 * AnalyticsDataStream represents a data stream (web, iOS, Android) for an analytics property.
 *
 * @example
 * ```typescript
 * const stream = await streams.create({
 *   propertyId: property.id,
 *   displayName: 'Web Stream',
 *   streamType: DataStreamType.WEB,
 *   measurementId: 'G-XXXXXXXXXX',
 *   defaultUri: 'https://example.com'
 * });
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class AnalyticsDataStream extends SmrtObject {
  /**
   * Parent property ID (references AnalyticsProperty)
   */
  propertyId: string = '';

  /**
   * Human-readable display name
   */
  displayName: string = '';

  /**
   * Stream type (WEB, ANDROID, IOS)
   */
  streamType: DataStreamType = DataStreamType.WEB;

  /**
   * External stream ID from provider
   */
  externalId: string = '';

  /**
   * Measurement ID for web streams (G-XXXXXXX)
   */
  measurementId: string = '';

  /**
   * Firebase App ID for app streams
   */
  firebaseAppId: string = '';

  /**
   * Default URI for web streams
   */
  defaultUri: string = '';

  /**
   * Bundle ID for iOS apps
   */
  bundleId: string = '';

  /**
   * Package name for Android apps
   */
  packageName: string = '';

  /**
   * Stream status
   */
  status: DataStreamStatus = DataStreamStatus.ACTIVE;

  /**
   * Enhanced measurement enabled
   */
  enhancedMeasurement: boolean = true;

  constructor(options: any = {}) {
    super(options);
    if (options.propertyId !== undefined) this.propertyId = options.propertyId;
    if (options.displayName !== undefined)
      this.displayName = options.displayName;
    if (options.streamType !== undefined) this.streamType = options.streamType;
    if (options.externalId !== undefined) this.externalId = options.externalId;
    if (options.measurementId !== undefined)
      this.measurementId = options.measurementId;
    if (options.firebaseAppId !== undefined)
      this.firebaseAppId = options.firebaseAppId;
    if (options.defaultUri !== undefined) this.defaultUri = options.defaultUri;
    if (options.bundleId !== undefined) this.bundleId = options.bundleId;
    if (options.packageName !== undefined)
      this.packageName = options.packageName;
    if (options.status !== undefined) this.status = options.status;
    if (options.enhancedMeasurement !== undefined)
      this.enhancedMeasurement = options.enhancedMeasurement;
  }

  /**
   * Check if this is a web stream
   */
  isWeb(): boolean {
    return this.streamType === DataStreamType.WEB;
  }

  /**
   * Check if this is an iOS app stream
   */
  isIOS(): boolean {
    return this.streamType === DataStreamType.IOS;
  }

  /**
   * Check if this is an Android app stream
   */
  isAndroid(): boolean {
    return this.streamType === DataStreamType.ANDROID;
  }

  /**
   * Check if this is a mobile app stream (iOS or Android)
   */
  isMobileApp(): boolean {
    return this.isIOS() || this.isAndroid();
  }

  /**
   * Get the platform identifier (measurementId for web, firebaseAppId for apps)
   */
  getPlatformId(): string {
    if (this.isWeb()) {
      return this.measurementId;
    }
    return this.firebaseAppId;
  }
}

export default AnalyticsDataStream;
