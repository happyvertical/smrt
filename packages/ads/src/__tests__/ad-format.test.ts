/**
 * Tests for AdFormat model and collection
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdFormat, AdFormatCollection, AdFormatType } from '../index.js';

describe('AdFormat', () => {
  let dbPath: string;
  let formats: AdFormatCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-adformat-test-${Date.now()}.db`);
    formats = await AdFormatCollection.create({
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
    it('should create an ad format', async () => {
      const format = await formats.create({
        name: 'Leaderboard',
        width: 728,
        height: 90,
        formatType: AdFormatType.BANNER,
        description: 'Standard IAB leaderboard',
      });
      await format.save();

      expect(format.id).toBeDefined();
      expect(format.name).toBe('Leaderboard');
      expect(format.width).toBe(728);
      expect(format.height).toBe(90);
      expect(format.formatType).toBe(AdFormatType.BANNER);
    });

    it('should retrieve an ad format by id', async () => {
      const format = await formats.create({
        name: 'Medium Rectangle',
        width: 300,
        height: 250,
        formatType: AdFormatType.BANNER,
      });
      await format.save();

      const retrieved = await formats.get(format.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Medium Rectangle');
      expect(retrieved?.width).toBe(300);
      expect(retrieved?.height).toBe(250);
    });

    it('should update an ad format', async () => {
      const format = await formats.create({
        name: 'Test Format',
        width: 100,
        height: 100,
        formatType: AdFormatType.BANNER,
      });
      await format.save();

      format.name = 'Updated Format';
      format.description = 'Updated description';
      await format.save();

      const retrieved = await formats.get(format.id);
      expect(retrieved?.name).toBe('Updated Format');
      expect(retrieved?.description).toBe('Updated description');
    });
  });

  describe('helper methods', () => {
    it('should return dimensions as string', async () => {
      const format = await formats.create({
        name: 'Leaderboard',
        width: 728,
        height: 90,
        formatType: AdFormatType.BANNER,
      });

      expect(format.getDimensions()).toBe('728x90');
    });

    it('should match dimensions', async () => {
      const format = await formats.create({
        name: 'Leaderboard',
        width: 728,
        height: 90,
        formatType: AdFormatType.BANNER,
      });

      expect(format.matchesDimensions(728, 90)).toBe(true);
      expect(format.matchesDimensions(300, 250)).toBe(false);
    });
  });

  describe('collection queries', () => {
    beforeEach(async () => {
      await (
        await formats.create({
          name: 'Leaderboard',
          width: 728,
          height: 90,
          formatType: AdFormatType.BANNER,
        })
      ).save();

      await (
        await formats.create({
          name: 'Medium Rectangle',
          width: 300,
          height: 250,
          formatType: AdFormatType.BANNER,
        })
      ).save();

      await (
        await formats.create({
          name: 'Native Card',
          width: 0,
          height: 0,
          formatType: AdFormatType.NATIVE,
        })
      ).save();

      await (
        await formats.create({
          name: 'Pre-roll',
          width: 640,
          height: 360,
          formatType: AdFormatType.VIDEO,
        })
      ).save();
    });

    it('should find by dimensions', async () => {
      const found = await formats.findByDimensions(728, 90);
      expect(found).toBeDefined();
      expect(found?.name).toBe('Leaderboard');
    });

    it('should return null for non-existent dimensions', async () => {
      const found = await formats.findByDimensions(999, 999);
      expect(found).toBeNull();
    });

    it('should find by type', async () => {
      const banners = await formats.findByType(AdFormatType.BANNER);
      expect(banners).toHaveLength(2);

      const native = await formats.findByType(AdFormatType.NATIVE);
      expect(native).toHaveLength(1);
      expect(native[0].name).toBe('Native Card');
    });

    it('should find banners', async () => {
      const banners = await formats.findBanners();
      expect(banners).toHaveLength(2);
    });

    it('should find native formats', async () => {
      const native = await formats.findNative();
      expect(native).toHaveLength(1);
    });

    it('should find video formats', async () => {
      const video = await formats.findVideo();
      expect(video).toHaveLength(1);
      expect(video[0].name).toBe('Pre-roll');
    });
  });
});
