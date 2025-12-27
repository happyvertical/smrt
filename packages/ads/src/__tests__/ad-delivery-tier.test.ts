/**
 * Tests for AdDeliveryTier model and collection
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdDeliveryTier,
  AdDeliveryTierCollection,
  PricingModel,
} from '../index.js';

describe('AdDeliveryTier', () => {
  let dbPath: string;
  let tiers: AdDeliveryTierCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-adtier-test-${Date.now()}.db`);
    tiers = await AdDeliveryTierCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('CRUD operations', () => {
    it('should create a delivery tier', async () => {
      const tier = await tiers.create({
        name: 'Sponsorship',
        priority: 1,
        pricingModel: PricingModel.FIXED,
        description: 'Premium guaranteed placements',
      });
      await tier.save();

      expect(tier.id).toBeDefined();
      expect(tier.name).toBe('Sponsorship');
      expect(tier.priority).toBe(1);
      expect(tier.pricingModel).toBe(PricingModel.FIXED);
    });

    it('should retrieve a tier by id', async () => {
      const tier = await tiers.create({
        name: 'Standard',
        priority: 2,
        pricingModel: PricingModel.CPM,
      });
      await tier.save();

      const retrieved = await tiers.get(tier.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Standard');
    });
  });

  describe('helper methods', () => {
    it('should compare priority correctly', async () => {
      const sponsorship = await tiers.create({
        name: 'Sponsorship',
        priority: 1,
        pricingModel: PricingModel.FIXED,
      });

      const standard = await tiers.create({
        name: 'Standard',
        priority: 2,
        pricingModel: PricingModel.CPM,
      });

      expect(sponsorship.isHigherPriorityThan(standard)).toBe(true);
      expect(standard.isHigherPriorityThan(sponsorship)).toBe(false);
    });

    it('should identify fixed pricing', async () => {
      const fixed = await tiers.create({
        name: 'Sponsorship',
        priority: 1,
        pricingModel: PricingModel.FIXED,
      });

      const cpm = await tiers.create({
        name: 'Standard',
        priority: 2,
        pricingModel: PricingModel.CPM,
      });

      expect(fixed.isFixedPricing()).toBe(true);
      expect(cpm.isFixedPricing()).toBe(false);
    });

    it('should identify performance-based pricing', async () => {
      const cpc = await tiers.create({
        name: 'CPC',
        priority: 2,
        pricingModel: PricingModel.CPC,
      });

      const cpa = await tiers.create({
        name: 'CPA',
        priority: 3,
        pricingModel: PricingModel.CPA,
      });

      const cpm = await tiers.create({
        name: 'CPM',
        priority: 2,
        pricingModel: PricingModel.CPM,
      });

      expect(cpc.isPerformanceBased()).toBe(true);
      expect(cpa.isPerformanceBased()).toBe(true);
      expect(cpm.isPerformanceBased()).toBe(false);
    });
  });

  describe('collection queries', () => {
    beforeEach(async () => {
      await (
        await tiers.create({
          name: 'Sponsorship',
          priority: 1,
          pricingModel: PricingModel.FIXED,
        })
      ).save();

      await (
        await tiers.create({
          name: 'Standard',
          priority: 2,
          pricingModel: PricingModel.CPM,
        })
      ).save();

      await (
        await tiers.create({
          name: 'House',
          priority: 3,
          pricingModel: PricingModel.FIXED,
        })
      ).save();
    });

    it('should find by priority order', async () => {
      const ordered = await tiers.findByPriority();
      expect(ordered).toHaveLength(3);
      expect(ordered[0].name).toBe('Sponsorship');
      expect(ordered[1].name).toBe('Standard');
      expect(ordered[2].name).toBe('House');
    });

    it('should get highest priority', async () => {
      const highest = await tiers.getHighestPriority();
      expect(highest).toBeDefined();
      expect(highest?.name).toBe('Sponsorship');
      expect(highest?.priority).toBe(1);
    });

    it('should find by pricing model', async () => {
      const fixed = await tiers.findByPricingModel(PricingModel.FIXED);
      expect(fixed).toHaveLength(2);

      const cpm = await tiers.findByPricingModel(PricingModel.CPM);
      expect(cpm).toHaveLength(1);
      expect(cpm[0].name).toBe('Standard');
    });

    it('should find fixed pricing tiers', async () => {
      const fixed = await tiers.findFixedPricing();
      expect(fixed).toHaveLength(2);
    });

    it('should find CPM tiers', async () => {
      const cpm = await tiers.findCPM();
      expect(cpm).toHaveLength(1);
    });
  });
});
