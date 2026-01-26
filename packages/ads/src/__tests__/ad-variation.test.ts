/**
 * Tests for AdVariation model and collection with weighted selection
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AdDeliveryTier,
  AdDeliveryTierCollection,
  type AdFormat,
  AdFormatCollection,
  AdFormatType,
  type AdGroup,
  AdGroupCollection,
  AdGroupStatus,
  AdVariationCollection,
  AdVariationStatus,
  PricingModel,
} from '../index.js';

describe('AdVariation', () => {
  let dbPath: string;
  let formats: AdFormatCollection;
  let tiers: AdDeliveryTierCollection;
  let groups: AdGroupCollection;
  let variations: AdVariationCollection;

  let format: AdFormat;
  let tier: AdDeliveryTier;
  let group: AdGroup;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-advariation-test-${Date.now()}.db`);
    formats = await AdFormatCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    tiers = await AdDeliveryTierCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    groups = await AdGroupCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    variations = await AdVariationCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    // Create prerequisite objects
    format = await formats.create({
      name: 'Leaderboard',
      width: 728,
      height: 90,
      formatType: AdFormatType.BANNER,
    });
    await format.save();

    tier = await tiers.create({
      name: 'Standard',
      priority: 2,
      pricingModel: PricingModel.CPM,
    });
    await tier.save();

    group = await groups.create({
      contractId: 'contract-123',
      tierId: tier.id,
      name: 'Test Campaign',
      status: AdGroupStatus.ACTIVE,
    });
    await group.save();
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
    it('should create an ad variation', async () => {
      const variation = await variations.create({
        groupId: group.id,
        formatId: format.id,
        assetId: 'asset-123',
        name: 'Version A',
        clickUrl: 'https://example.com',
        altText: 'Test ad',
        weight: 1,
        status: AdVariationStatus.ACTIVE,
      });
      await variation.save();

      expect(variation.id).toBeDefined();
      expect(variation.name).toBe('Version A');
      expect(variation.groupId).toBe(group.id);
      expect(variation.formatId).toBe(format.id);
    });

    it('should track impressions and clicks', async () => {
      const variation = await variations.create({
        groupId: group.id,
        formatId: format.id,
        name: 'Test',
        status: AdVariationStatus.ACTIVE,
      });

      expect(variation.impressions).toBe(0);
      expect(variation.clicks).toBe(0);

      variation.recordImpression();
      variation.recordImpression();
      variation.recordClick();

      expect(variation.impressions).toBe(2);
      expect(variation.clicks).toBe(1);
      expect(variation.getCTR()).toBe(0.5);
    });
  });

  describe('weighted selection', () => {
    beforeEach(async () => {
      // Create variations with different weights
      await (
        await variations.create({
          groupId: group.id,
          formatId: format.id,
          name: 'Weight 1',
          weight: 1,
          status: AdVariationStatus.ACTIVE,
        })
      ).save();

      await (
        await variations.create({
          groupId: group.id,
          formatId: format.id,
          name: 'Weight 2',
          weight: 2,
          status: AdVariationStatus.ACTIVE,
        })
      ).save();

      await (
        await variations.create({
          groupId: group.id,
          formatId: format.id,
          name: 'Inactive',
          weight: 10,
          status: AdVariationStatus.DRAFT, // Not active
        })
      ).save();
    });

    it('should only select active variations', async () => {
      const selected = await variations.selectByWeight(group.id);
      expect(selected).toBeDefined();
      expect(['Weight 1', 'Weight 2']).toContain(selected?.name);
    });

    it('should return null when no active variations', async () => {
      // Create a new group with no variations
      const emptyGroup = await groups.create({
        contractId: 'contract-456',
        tierId: tier.id,
        name: 'Empty Group',
        status: AdGroupStatus.ACTIVE,
      });
      await emptyGroup.save();

      const selected = await variations.selectByWeight(emptyGroup.id);
      expect(selected).toBeNull();
    });

    it('should respect weight distribution over many selections', async () => {
      const counts: Record<string, number> = {
        'Weight 1': 0,
        'Weight 2': 0,
      };

      // Run selections (reduced from 1000 to 100 for CI performance)
      for (let i = 0; i < 100; i++) {
        const selected = await variations.selectByWeight(group.id);
        if (selected) {
          counts[selected.name]++;
        }
      }

      // Weight 2 should be selected roughly 2x as often as Weight 1
      // Allow for wider statistical variance with fewer samples
      const ratio = counts['Weight 2'] / counts['Weight 1'];
      expect(ratio).toBeGreaterThan(1.2);
      expect(ratio).toBeLessThan(3.0);
    });
  });

  describe('collection queries', () => {
    beforeEach(async () => {
      await (
        await variations.create({
          groupId: group.id,
          formatId: format.id,
          name: 'Active 1',
          status: AdVariationStatus.ACTIVE,
          impressions: 100,
          clicks: 5,
        })
      ).save();

      await (
        await variations.create({
          groupId: group.id,
          formatId: format.id,
          name: 'Active 2',
          status: AdVariationStatus.ACTIVE,
          impressions: 100,
          clicks: 10,
        })
      ).save();

      await (
        await variations.create({
          groupId: group.id,
          formatId: format.id,
          name: 'Draft',
          status: AdVariationStatus.DRAFT,
        })
      ).save();
    });

    it('should find by group', async () => {
      const found = await variations.findByGroup(group.id);
      expect(found).toHaveLength(3);
    });

    it('should find active by group', async () => {
      const active = await variations.findActiveByGroup(group.id);
      expect(active).toHaveLength(2);
    });

    it('should find top performers by CTR', async () => {
      const top = await variations.findTopPerformers(10);
      expect(top).toHaveLength(2);
      // Active 2 has 10% CTR, Active 1 has 5% CTR
      expect(top[0].name).toBe('Active 2');
      expect(top[1].name).toBe('Active 1');
    });
  });
});
