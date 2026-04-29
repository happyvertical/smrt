/**
 * Tests for AnalyticsProperty model and collection
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsPropertyCollection } from '../collections/AnalyticsPropertyCollection.js';
import { AnalyticsProperty } from '../models/AnalyticsProperty.js';
import { AnalyticsPropertyStatus, AnalyticsProvider } from '../types/index.js';
import {
  createTestDb,
  getAdapterDisplayName,
  getTestAdapter,
  isPostgresAvailable,
} from './helpers/index.js';

// Check postgres availability at module load (top-level await)
const pgAvailable = await isPostgresAvailable();
const skipTests = getTestAdapter() === 'postgres' && !pgAvailable;

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

    it('should create a Matomo property with options', () => {
      const property = new AnalyticsProperty({
        name: 'sites/7',
        displayName: 'Example Matomo Site',
        provider: AnalyticsProvider.MATOMO,
        externalId: '7',
        siteDomain: 'example.com',
      });

      expect(property.name).toBe('sites/7');
      expect(property.provider).toBe(AnalyticsProvider.MATOMO);
      expect(property.externalId).toBe('7');
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
      expect(property.isMatomo()).toBe(false);
    });

    it('should correctly identify Plausible sites', () => {
      const property = new AnalyticsProperty({
        provider: AnalyticsProvider.PLAUSIBLE,
      });

      expect(property.isGA4()).toBe(false);
      expect(property.isPlausible()).toBe(true);
      expect(property.isMatomo()).toBe(false);
    });

    it('should correctly identify Matomo sites', () => {
      const property = new AnalyticsProperty({
        provider: AnalyticsProvider.MATOMO,
      });

      expect(property.isGA4()).toBe(false);
      expect(property.isPlausible()).toBe(false);
      expect(property.isMatomo()).toBe(true);
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

describe.skipIf(skipTests)(
  `AnalyticsPropertyCollection [${getAdapterDisplayName()}]`,
  () => {
    let collection: AnalyticsPropertyCollection;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const testDb = await createTestDb();
      cleanup = testDb.cleanup;
      collection = await AnalyticsPropertyCollection.create({
        persistence: testDb.config,
      });
    });

    afterEach(async () => {
      await cleanup();
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

      const matomo = await collection.create({
        name: 'Matomo',
        displayName: 'Matomo Site',
        provider: AnalyticsProvider.MATOMO,
      });
      await matomo.save();

      const ga4Properties = await collection.findGA4Properties();
      expect(ga4Properties).toHaveLength(1);
      expect(ga4Properties[0].provider).toBe(AnalyticsProvider.GA4);

      const plausibleSites = await collection.findPlausibleSites();
      expect(plausibleSites).toHaveLength(1);
      expect(plausibleSites[0].provider).toBe(AnalyticsProvider.PLAUSIBLE);

      const matomoSites = await collection.findMatomoSites();
      expect(matomoSites).toHaveLength(1);
      expect(matomoSites[0].provider).toBe(AnalyticsProvider.MATOMO);
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
  },
);
