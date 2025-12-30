/**
 * Tests for AnalyticsProperty model and collection
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsPropertyCollection } from '../collections/AnalyticsPropertyCollection.js';
import { AnalyticsProperty } from '../models/AnalyticsProperty.js';
import { AnalyticsPropertyStatus, AnalyticsProvider } from '../types/index.js';

describe('AnalyticsProperty', () => {
  describe('constructor', () => {
    it('should create a property with default values', () => {
      const property = new AnalyticsProperty();

      expect(property.name).toBe('');
      expect(property.displayName).toBe('');
      expect(property.provider).toBe(AnalyticsProvider.GA4);
      expect(property.status).toBe(AnalyticsPropertyStatus.ACTIVE);
      expect(property.timeZone).toBe('America/Los_Angeles');
      expect(property.currencyCode).toBe('USD');
    });

    it('should create a GA4 property with options', () => {
      const property = new AnalyticsProperty({
        name: 'properties/123456789',
        displayName: 'My Website',
        provider: AnalyticsProvider.GA4,
        externalId: 'properties/123456789',
        measurementId: 'G-ABCD1234',
        apiSecret: 'test-secret',
      });

      expect(property.name).toBe('properties/123456789');
      expect(property.displayName).toBe('My Website');
      expect(property.provider).toBe(AnalyticsProvider.GA4);
      expect(property.measurementId).toBe('G-ABCD1234');
      expect(property.apiSecret).toBe('test-secret');
    });

    it('should create a Plausible property with options', () => {
      const property = new AnalyticsProperty({
        name: 'example.com',
        displayName: 'Example Site',
        provider: AnalyticsProvider.PLAUSIBLE,
        siteDomain: 'example.com',
      });

      expect(property.name).toBe('example.com');
      expect(property.provider).toBe(AnalyticsProvider.PLAUSIBLE);
      expect(property.siteDomain).toBe('example.com');
    });
  });

  describe('provider checks', () => {
    it('should correctly identify GA4 properties', () => {
      const property = new AnalyticsProperty({
        provider: AnalyticsProvider.GA4,
      });

      expect(property.isGA4()).toBe(true);
      expect(property.isPlausible()).toBe(false);
    });

    it('should correctly identify Plausible sites', () => {
      const property = new AnalyticsProperty({
        provider: AnalyticsProvider.PLAUSIBLE,
      });

      expect(property.isGA4()).toBe(false);
      expect(property.isPlausible()).toBe(true);
    });
  });

  describe('metadata handling', () => {
    it('should get and set provider metadata', () => {
      const property = new AnalyticsProperty();

      property.setProviderMetadata({
        serviceLevel: 'PREMIUM',
        industryCategory: 'TECHNOLOGY',
      });

      const metadata = property.getProviderMetadata();
      expect(metadata.serviceLevel).toBe('PREMIUM');
      expect(metadata.industryCategory).toBe('TECHNOLOGY');
    });

    it('should return empty object for invalid JSON', () => {
      const property = new AnalyticsProperty();
      property.providerMetadata = 'invalid json';

      expect(property.getProviderMetadata()).toEqual({});
    });
  });

  describe('sync tracking', () => {
    it('should mark as synced with current timestamp', () => {
      const property = new AnalyticsProperty();
      expect(property.lastSyncAt).toBeNull();

      property.markSynced();

      expect(property.lastSyncAt).toBeInstanceOf(Date);
      expect(property.lastSyncAt?.getTime()).toBeCloseTo(Date.now(), -2);
    });
  });
});

describe('AnalyticsPropertyCollection', () => {
  let collection: AnalyticsPropertyCollection;

  beforeEach(async () => {
    // Use unique temp file for each test to ensure isolation
    const tempDbPath = `/tmp/test-analytics-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    collection = await AnalyticsPropertyCollection.create({
      persistence: { type: 'sqlite', url: tempDbPath },
    });
  });

  it('should create and list properties', async () => {
    const property = await collection.create({
      name: 'Test Property',
      displayName: 'Test Analytics',
      provider: AnalyticsProvider.GA4,
      measurementId: 'G-TEST123',
    });
    await property.save();

    const properties = await collection.list({});
    expect(properties).toHaveLength(1);
    expect(properties[0].measurementId).toBe('G-TEST123');
  });

  it('should find property by measurement ID', async () => {
    const property = await collection.create({
      name: 'GA4 Property',
      displayName: 'GA4 Test',
      provider: AnalyticsProvider.GA4,
      measurementId: 'G-UNIQUE123',
    });
    await property.save();

    const found = await collection.findByMeasurementId('G-UNIQUE123');
    expect(found).not.toBeNull();
    expect(found?.displayName).toBe('GA4 Test');
  });

  it('should find properties by provider', async () => {
    const ga4 = await collection.create({
      name: 'GA4',
      displayName: 'GA4 Property',
      provider: AnalyticsProvider.GA4,
    });
    await ga4.save();

    const plausible = await collection.create({
      name: 'Plausible',
      displayName: 'Plausible Site',
      provider: AnalyticsProvider.PLAUSIBLE,
    });
    await plausible.save();

    const ga4Properties = await collection.findGA4Properties();
    expect(ga4Properties).toHaveLength(1);
    expect(ga4Properties[0].provider).toBe(AnalyticsProvider.GA4);

    const plausibleSites = await collection.findPlausibleSites();
    expect(plausibleSites).toHaveLength(1);
    expect(plausibleSites[0].provider).toBe(AnalyticsProvider.PLAUSIBLE);
  });

  it('should find active properties', async () => {
    const active = await collection.create({
      name: 'Active',
      displayName: 'Active Property',
      status: AnalyticsPropertyStatus.ACTIVE,
    });
    await active.save();

    const inactive = await collection.create({
      name: 'Inactive',
      displayName: 'Inactive Property',
      status: AnalyticsPropertyStatus.INACTIVE,
    });
    await inactive.save();

    const activeProperties = await collection.findActive();
    expect(activeProperties).toHaveLength(1);
    expect(activeProperties[0].displayName).toBe('Active Property');
  });
});
