/**
 * Image class tests
 *
 * Tests for:
 * 1. Image CRUD operations
 * 2. STI polymorphic queries (Asset collection returning Image instances)
 * 3. Existing Asset functionality (inheritance of tag management, versioning)
 * 4. Image-specific computed properties
 *
 * Note: For semantic search on images, use the centralized embedding system
 * in @happyvertical/smrt-core via @smrt({ embeddings: { fields: ['alt', 'description'] } })
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Asset } from '../asset';
import { AssetCollection } from '../assets';
import { Image } from '../image';
import { ImageCollection } from '../images';

describe('Image', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `smrt-image-test-${Date.now()}.db`);
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

  describe('Basic CRUD Operations', () => {
    it('should create an image with dimensions', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const image = await images.create({
        name: 'hero-image.jpg',
        sourceUri: 'file:///images/hero-image.jpg',
        mimeType: 'image/jpeg',
        width: 1920,
        height: 1080,
        alt: 'Hero banner image',
      });

      expect(image.id).toBeDefined();
      expect(image.width).toBe(1920);
      expect(image.height).toBe(1080);
      expect(image.alt).toBe('Hero banner image');
    });

    it('should preserve dimensions through save/load cycle', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const image = await images.create({
        name: 'test-image.png',
        sourceUri: 'file:///images/test.png',
        mimeType: 'image/png',
        width: 800,
        height: 600,
      });
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(loaded).toBeDefined();
      expect(loaded?.width).toBe(800);
      expect(loaded?.height).toBe(600);
    });

    it('should update image properties', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const image = await images.create({
        name: 'updatable.jpg',
        width: 640,
        height: 480,
      });
      await image.save();

      image.width = 1280;
      image.height = 720;
      image.alt = 'Updated alt text';
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(loaded?.width).toBe(1280);
      expect(loaded?.height).toBe(720);
      expect(loaded?.alt).toBe('Updated alt text');
    });

    it('should delete an image', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const image = await images.create({
        name: 'deletable.jpg',
        width: 100,
        height: 100,
      });
      await image.save();

      await image.delete();

      const loaded = await images.get({ id: image.id });
      expect(loaded).toBeNull();
    });
  });

  describe('STI Polymorphic Queries', () => {
    it('should return Image instances from AssetCollection', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const image = await images.create({
        name: 'poly-test.jpg',
        sourceUri: 'file:///images/poly.jpg',
        mimeType: 'image/jpeg',
        width: 1024,
        height: 768,
      });
      await image.save();

      // Query via base AssetCollection
      const assets = await AssetCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const allAssets = await assets.list({});
      expect(allAssets.length).toBeGreaterThanOrEqual(1);

      const imageAsset = allAssets.find((a) => a.name === 'poly-test.jpg');
      expect(imageAsset).toBeInstanceOf(Image);
      expect((imageAsset as Image).width).toBe(1024);
    });

    it('should filter by _meta_type for Images only', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });
      const assets = await AssetCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      // Create an Image
      await (
        await images.create({
          name: 'image-asset.jpg',
          sourceUri: 'file:///images/asset.jpg',
          mimeType: 'image/jpeg',
          width: 640,
          height: 480,
        })
      ).save();

      // Create a regular Asset
      await (
        await assets.create({
          name: 'document.pdf',
          sourceUri: 'file:///docs/document.pdf',
          mimeType: 'application/pdf',
        })
      ).save();

      // Filter by type
      const onlyImages = await assets.list({
        where: { _meta_type: 'Image' },
      });

      expect(onlyImages).toHaveLength(1);
      expect(onlyImages[0]).toBeInstanceOf(Image);
    });

    it('should handle mixed asset types in single query', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });
      const assets = await AssetCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      // Create mixed assets
      await (
        await images.create({
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          width: 800,
          height: 600,
        })
      ).save();

      await (
        await assets.create({
          name: 'report.pdf',
          mimeType: 'application/pdf',
        })
      ).save();

      await (
        await images.create({
          name: 'icon.png',
          mimeType: 'image/png',
          width: 64,
          height: 64,
        })
      ).save();

      const allAssets = await assets.list({});
      expect(allAssets).toHaveLength(3);

      const imageCount = allAssets.filter((a) => a instanceof Image).length;
      const assetCount = allAssets.filter(
        (a) => !(a instanceof Image) && a instanceof Asset,
      ).length;

      expect(imageCount).toBe(2);
      expect(assetCount).toBe(1);
    });
  });

  describe('Computed Properties', () => {
    it('should calculate aspect ratio correctly', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const image = await images.create({
        name: 'widescreen.jpg',
        width: 1920,
        height: 1080,
      });

      expect(image.aspectRatio).toBeCloseTo(16 / 9, 2);
    });

    it('should handle zero height for aspect ratio', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const image = await images.create({
        name: 'zero-height.jpg',
        width: 100,
        height: 0,
      });

      expect(image.aspectRatio).toBe(0);
    });

    it('should identify landscape/portrait/square correctly', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const landscape = await images.create({
        name: 'land.jpg',
        width: 1920,
        height: 1080,
      });
      const portrait = await images.create({
        name: 'port.jpg',
        width: 1080,
        height: 1920,
      });
      const square = await images.create({
        name: 'sq.jpg',
        width: 1000,
        height: 1000,
      });

      expect(landscape.isLandscape).toBe(true);
      expect(landscape.isPortrait).toBe(false);
      expect(landscape.isSquare).toBe(false);

      expect(portrait.isPortrait).toBe(true);
      expect(portrait.isLandscape).toBe(false);
      expect(portrait.isSquare).toBe(false);

      expect(square.isSquare).toBe(true);
      expect(square.isLandscape).toBe(false);
      expect(square.isPortrait).toBe(false);
    });

    it('should validate image MIME types', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const jpeg = await images.create({
        name: 'test.jpg',
        mimeType: 'image/jpeg',
      });
      const png = await images.create({
        name: 'test.png',
        mimeType: 'image/png',
      });
      const webp = await images.create({
        name: 'test.webp',
        mimeType: 'image/webp',
      });
      const pdf = await images.create({
        name: 'test.pdf',
        mimeType: 'application/pdf',
      });

      expect(jpeg.isValidImageFormat()).toBe(true);
      expect(png.isValidImageFormat()).toBe(true);
      expect(webp.isValidImageFormat()).toBe(true);
      expect(pdf.isValidImageFormat()).toBe(false);
    });

    it('should detect high resolution images', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const uhd = await images.create({
        name: '4k.jpg',
        width: 3840,
        height: 2160,
      });
      const hd = await images.create({
        name: 'hd.jpg',
        width: 1920,
        height: 1080,
      });
      const sd = await images.create({
        name: 'sd.jpg',
        width: 640,
        height: 480,
      });

      expect(uhd.isHighResolution()).toBe(true);
      expect(hd.isHighResolution()).toBe(false);
      expect(sd.isHighResolution()).toBe(false);
    });
  });

  describe('ImageCollection Query Methods', () => {
    it('should get images by minimum dimensions', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      await (
        await images.create({ name: 'small.jpg', width: 640, height: 480 })
      ).save();
      await (
        await images.create({ name: 'medium.jpg', width: 1280, height: 720 })
      ).save();
      await (
        await images.create({ name: 'large.jpg', width: 1920, height: 1080 })
      ).save();

      const hdImages = await images.getByMinDimensions(1280, 720);
      expect(hdImages).toHaveLength(2);
      expect(hdImages.map((i) => i.name).sort()).toEqual([
        'large.jpg',
        'medium.jpg',
      ]);
    });

    it('should get images by maximum dimensions', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      await (
        await images.create({ name: 'small.jpg', width: 640, height: 480 })
      ).save();
      await (
        await images.create({ name: 'medium.jpg', width: 1280, height: 720 })
      ).save();
      await (
        await images.create({ name: 'large.jpg', width: 1920, height: 1080 })
      ).save();

      const smallImages = await images.getByMaxDimensions(800, 600);
      expect(smallImages).toHaveLength(1);
      expect(smallImages[0].name).toBe('small.jpg');
    });

    it('should get landscape images', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      await (
        await images.create({ name: 'land.jpg', width: 1920, height: 1080 })
      ).save();
      await (
        await images.create({ name: 'port.jpg', width: 1080, height: 1920 })
      ).save();
      await (
        await images.create({ name: 'sq.jpg', width: 1000, height: 1000 })
      ).save();

      const landscape = await images.getLandscape();
      expect(landscape).toHaveLength(1);
      expect(landscape[0].name).toBe('land.jpg');
    });

    it('should get portrait images', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      await (
        await images.create({ name: 'land.jpg', width: 1920, height: 1080 })
      ).save();
      await (
        await images.create({ name: 'port.jpg', width: 1080, height: 1920 })
      ).save();

      const portrait = await images.getPortrait();
      expect(portrait).toHaveLength(1);
      expect(portrait[0].name).toBe('port.jpg');
    });

    it('should get images missing alt text', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      await (
        await images.create({ name: 'with-alt.jpg', alt: 'Description' })
      ).save();
      await (await images.create({ name: 'no-alt.jpg' })).save();

      const missing = await images.getMissingAltText();
      expect(missing).toHaveLength(1);
      expect(missing[0].name).toBe('no-alt.jpg');
    });

    it('should get high resolution images', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      await (
        await images.create({ name: '4k.jpg', width: 3840, height: 2160 })
      ).save();
      await (
        await images.create({ name: 'hd.jpg', width: 1920, height: 1080 })
      ).save();

      const hiRes = await images.getHighResolution();
      expect(hiRes).toHaveLength(1);
      expect(hiRes[0].name).toBe('4k.jpg');
    });

    it('should get images by aspect ratio range', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      // 16:9 = 1.78
      await (
        await images.create({ name: 'wide.jpg', width: 1920, height: 1080 })
      ).save();
      // 4:3 = 1.33
      await (
        await images.create({ name: 'standard.jpg', width: 1600, height: 1200 })
      ).save();
      // 1:1 = 1.0
      await (
        await images.create({ name: 'square.jpg', width: 1000, height: 1000 })
      ).save();

      const widescreen = await images.getByAspectRatio(1.7, 1.9);
      expect(widescreen).toHaveLength(1);
      expect(widescreen[0].name).toBe('wide.jpg');

      const standardAndWide = await images.getByAspectRatio(1.3, 1.9);
      expect(standardAndWide).toHaveLength(2);
    });
  });

  describe('Inherited Asset Functionality', () => {
    it('should inherit name and sourceUri from Asset', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const image = await images.create({
        name: 'inherited-test.jpg',
        sourceUri: 's3://bucket/inherited-test.jpg',
        mimeType: 'image/jpeg',
        description: 'Test description',
        width: 800,
        height: 600,
      });
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(loaded?.name).toBe('inherited-test.jpg');
      expect(loaded?.sourceUri).toBe('s3://bucket/inherited-test.jpg');
      expect(loaded?.mimeType).toBe('image/jpeg');
      expect(loaded?.description).toBe('Test description');
    });

    it('should inherit version tracking from Asset', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const image = await images.create({
        name: 'versioned.jpg',
        width: 800,
        height: 600,
        version: 1,
      });
      await image.save();

      expect(image.version).toBe(1);

      // Simulate version update
      image.version = 2;
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(loaded?.version).toBe(2);
    });

    it('should inherit slug generation from SmrtObject', async () => {
      const images = await ImageCollection.create({
        db: { type: 'sqlite', url: dbPath },
      });

      const image = await images.create({
        name: 'My Test Image',
        width: 800,
        height: 600,
      });
      await image.save();

      expect(image.slug).toBeDefined();
      expect(image.slug.length).toBeGreaterThan(0);
    });
  });
});
