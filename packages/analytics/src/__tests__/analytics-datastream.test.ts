/**
 * Tests for AnalyticsDataStream model and collection
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsDataStreamCollection } from '../collections/AnalyticsDataStreamCollection.js';
import { AnalyticsDataStream } from '../models/AnalyticsDataStream.js';
import { DataStreamStatus, DataStreamType } from '../types/index.js';

describe('AnalyticsDataStream', () => {
  describe('constructor', () => {
    it('should create a stream with default values', () => {
      const stream = new AnalyticsDataStream();

      expect(stream.propertyId).toBe('');
      expect(stream.displayName).toBe('');
      expect(stream.streamType).toBe(DataStreamType.WEB);
      expect(stream.status).toBe(DataStreamStatus.ACTIVE);
      expect(stream.enhancedMeasurement).toBe(true);
    });

    it('should create a web stream with options', () => {
      const stream = new AnalyticsDataStream({
        propertyId: 'prop-123',
        displayName: 'Main Website',
        streamType: DataStreamType.WEB,
        measurementId: 'G-ABCD1234',
        defaultUri: 'https://example.com',
      });

      expect(stream.propertyId).toBe('prop-123');
      expect(stream.displayName).toBe('Main Website');
      expect(stream.streamType).toBe(DataStreamType.WEB);
      expect(stream.measurementId).toBe('G-ABCD1234');
      expect(stream.defaultUri).toBe('https://example.com');
    });

    it('should create an iOS stream with options', () => {
      const stream = new AnalyticsDataStream({
        propertyId: 'prop-123',
        displayName: 'iOS App',
        streamType: DataStreamType.IOS,
        firebaseAppId: '1:123456789:ios:abc123',
        bundleId: 'com.example.app',
      });

      expect(stream.streamType).toBe(DataStreamType.IOS);
      expect(stream.firebaseAppId).toBe('1:123456789:ios:abc123');
      expect(stream.bundleId).toBe('com.example.app');
    });

    it('should create an Android stream with options', () => {
      const stream = new AnalyticsDataStream({
        propertyId: 'prop-123',
        displayName: 'Android App',
        streamType: DataStreamType.ANDROID,
        firebaseAppId: '1:123456789:android:def456',
        packageName: 'com.example.app',
      });

      expect(stream.streamType).toBe(DataStreamType.ANDROID);
      expect(stream.firebaseAppId).toBe('1:123456789:android:def456');
      expect(stream.packageName).toBe('com.example.app');
    });
  });

  describe('stream type checks', () => {
    it('should correctly identify web streams', () => {
      const stream = new AnalyticsDataStream({
        streamType: DataStreamType.WEB,
      });

      expect(stream.isWeb()).toBe(true);
      expect(stream.isIOS()).toBe(false);
      expect(stream.isAndroid()).toBe(false);
      expect(stream.isMobileApp()).toBe(false);
    });

    it('should correctly identify iOS streams', () => {
      const stream = new AnalyticsDataStream({
        streamType: DataStreamType.IOS,
      });

      expect(stream.isWeb()).toBe(false);
      expect(stream.isIOS()).toBe(true);
      expect(stream.isAndroid()).toBe(false);
      expect(stream.isMobileApp()).toBe(true);
    });

    it('should correctly identify Android streams', () => {
      const stream = new AnalyticsDataStream({
        streamType: DataStreamType.ANDROID,
      });

      expect(stream.isWeb()).toBe(false);
      expect(stream.isIOS()).toBe(false);
      expect(stream.isAndroid()).toBe(true);
      expect(stream.isMobileApp()).toBe(true);
    });
  });

  describe('getPlatformId', () => {
    it('should return measurementId for web streams', () => {
      const stream = new AnalyticsDataStream({
        streamType: DataStreamType.WEB,
        measurementId: 'G-ABCD1234',
        firebaseAppId: '1:123:ios:abc',
      });

      expect(stream.getPlatformId()).toBe('G-ABCD1234');
    });

    it('should return firebaseAppId for iOS streams', () => {
      const stream = new AnalyticsDataStream({
        streamType: DataStreamType.IOS,
        measurementId: 'G-ABCD1234',
        firebaseAppId: '1:123:ios:abc',
      });

      expect(stream.getPlatformId()).toBe('1:123:ios:abc');
    });

    it('should return firebaseAppId for Android streams', () => {
      const stream = new AnalyticsDataStream({
        streamType: DataStreamType.ANDROID,
        measurementId: 'G-ABCD1234',
        firebaseAppId: '1:123:android:def',
      });

      expect(stream.getPlatformId()).toBe('1:123:android:def');
    });
  });
});

describe('AnalyticsDataStreamCollection', () => {
  let collection: AnalyticsDataStreamCollection;

  beforeEach(async () => {
    const tempDbPath = `/tmp/test-analytics-datastream-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    collection = await AnalyticsDataStreamCollection.create({
      persistence: { type: 'sqlite', url: tempDbPath },
    });
  });

  it('should create and list streams', async () => {
    const stream = await collection.create({
      propertyId: 'prop-123',
      displayName: 'Web Stream',
      streamType: DataStreamType.WEB,
      measurementId: 'G-TEST123',
    });
    await stream.save();

    const streams = await collection.list({});
    expect(streams).toHaveLength(1);
    expect(streams[0].measurementId).toBe('G-TEST123');
  });

  it('should find stream by measurement ID', async () => {
    const stream = await collection.create({
      displayName: 'Web Stream',
      streamType: DataStreamType.WEB,
      measurementId: 'G-UNIQUE123',
    });
    await stream.save();

    const found = await collection.findByMeasurementId('G-UNIQUE123');
    expect(found).not.toBeNull();
    expect(found?.displayName).toBe('Web Stream');
  });

  it('should find streams by type', async () => {
    const web = await collection.create({
      displayName: 'Web',
      streamType: DataStreamType.WEB,
    });
    await web.save();

    const ios = await collection.create({
      displayName: 'iOS',
      streamType: DataStreamType.IOS,
    });
    await ios.save();

    const android = await collection.create({
      displayName: 'Android',
      streamType: DataStreamType.ANDROID,
    });
    await android.save();

    const webStreams = await collection.findWebStreams();
    expect(webStreams).toHaveLength(1);
    expect(webStreams[0].streamType).toBe(DataStreamType.WEB);

    const iosStreams = await collection.findIOSStreams();
    expect(iosStreams).toHaveLength(1);
    expect(iosStreams[0].streamType).toBe(DataStreamType.IOS);

    const androidStreams = await collection.findAndroidStreams();
    expect(androidStreams).toHaveLength(1);
    expect(androidStreams[0].streamType).toBe(DataStreamType.ANDROID);
  });

  it('should find mobile streams (iOS + Android)', async () => {
    const web = await collection.create({
      displayName: 'Web',
      streamType: DataStreamType.WEB,
    });
    await web.save();

    const ios = await collection.create({
      displayName: 'iOS App',
      streamType: DataStreamType.IOS,
    });
    await ios.save();

    const android = await collection.create({
      displayName: 'Android App',
      streamType: DataStreamType.ANDROID,
    });
    await android.save();

    const mobileStreams = await collection.findMobileStreams();
    expect(mobileStreams).toHaveLength(2);
    expect(mobileStreams.map((s) => s.streamType).sort()).toEqual([
      DataStreamType.ANDROID,
      DataStreamType.IOS,
    ]);
  });

  it('should find active streams', async () => {
    const active = await collection.create({
      displayName: 'Active Stream',
      status: DataStreamStatus.ACTIVE,
    });
    await active.save();

    const inactive = await collection.create({
      displayName: 'Inactive Stream',
      status: DataStreamStatus.INACTIVE,
    });
    await inactive.save();

    const activeStreams = await collection.findActive();
    expect(activeStreams).toHaveLength(1);
    expect(activeStreams[0].displayName).toBe('Active Stream');
  });

  it('should find streams by property', async () => {
    const stream1 = await collection.create({
      propertyId: 'prop-1',
      displayName: 'Stream 1',
    });
    await stream1.save();

    const stream2 = await collection.create({
      propertyId: 'prop-1',
      displayName: 'Stream 2',
    });
    await stream2.save();

    const stream3 = await collection.create({
      propertyId: 'prop-2',
      displayName: 'Stream 3',
    });
    await stream3.save();

    const prop1Streams = await collection.findByProperty('prop-1');
    expect(prop1Streams).toHaveLength(2);
  });

  it('should find active streams by property', async () => {
    const propertyId = 'prop-test';

    const active = await collection.create({
      propertyId,
      displayName: 'Active',
      status: DataStreamStatus.ACTIVE,
    });
    await active.save();

    const inactive = await collection.create({
      propertyId,
      displayName: 'Inactive',
      status: DataStreamStatus.INACTIVE,
    });
    await inactive.save();

    const activeStreams = await collection.findActiveByProperty(propertyId);
    expect(activeStreams).toHaveLength(1);
    expect(activeStreams[0].displayName).toBe('Active');
  });

  it('should find stream by external ID', async () => {
    const stream = await collection.create({
      displayName: 'External Stream',
      externalId: 'dataStreams/123456789',
    });
    await stream.save();

    const found = await collection.findByExternalId('dataStreams/123456789');
    expect(found).not.toBeNull();
    expect(found?.displayName).toBe('External Stream');
  });
});
