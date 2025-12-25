/**
 * Multi-Adapter Parity Tests for Image STI
 *
 * Ensures consistent behavior across SQLite and JSON adapters
 * following the pattern from packages/core/src/__tests__/sti-adapter-parity.test.ts
 *
 * Test Coverage:
 * 1. Basic CRUD operations with Image fields
 * 2. STI inheritance and polymorphic queries
 * 3. Embedding storage/retrieval across adapters
 * 4. Type preservation across save/load cycles
 */

import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Asset } from '../asset';
import { AssetCollection } from '../assets';
import { Image } from '../image';
import { ImageCollection } from '../images';

// ============================================================================
// Test Fixtures
// ============================================================================

const fixtures = {
  image: {
    jpeg: {
      _meta_type: 'Image',
      name: 'photo.jpg',
      sourceUri: 'file:///images/photo.jpg',
      mimeType: 'image/jpeg',
      width: 1920,
      height: 1080,
      alt: 'A scenic photo',
    },
    png: {
      _meta_type: 'Image',
      name: 'icon.png',
      sourceUri: 'file:///images/icon.png',
      mimeType: 'image/png',
      width: 256,
      height: 256,
      alt: 'App icon',
    },
    withEmbedding: {
      _meta_type: 'Image',
      name: 'embedded.jpg',
      sourceUri: 'file:///images/embedded.jpg',
      mimeType: 'image/jpeg',
      width: 512,
      height: 512,
      embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
      descriptionEmbedding: [0.5, 0.4, 0.3, 0.2, 0.1],
    },
  },
  asset: {
    document: {
      name: 'document.pdf',
      sourceUri: 'file:///docs/document.pdf',
      mimeType: 'application/pdf',
    },
  },
};

// ============================================================================
// Adapter Configurations
// ============================================================================

const adapterConfigs = [
  {
    name: 'SQLite (in-memory)',
    getConfig: () => ({ type: 'sqlite' as const, url: ':memory:' }),
    cleanup: async () => {
      /* no cleanup needed */
    },
  },
  {
    name: 'SQLite (file)',
    getConfig: () => ({
      type: 'sqlite' as const,
      url: join(tmpdir(), `test-image-sqlite-${Date.now()}.db`),
    }),
    cleanup: async (config: any) => {
      if (config?.url && config.url !== ':memory:' && existsSync(config.url)) {
        unlinkSync(config.url);
      }
    },
  },
  {
    name: 'JSON (DuckDB)',
    getConfig: () => ({
      type: 'json' as const,
      url: join(tmpdir(), `test-image-json-${Date.now()}`),
    }),
    cleanup: async (config: any) => {
      if (config?.url && existsSync(config.url)) {
        try {
          rmSync(config.url, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  },
];

// ============================================================================
// Reusable Test Suites
// ============================================================================

function runBasicCRUDTests(getContext: () => { images: ImageCollection }) {
  describe('Basic CRUD', () => {
    it('should create image with dimensions', async () => {
      const { images } = getContext();
      const image = await images.create(fixtures.image.jpeg);

      expect(image.width).toBe(1920);
      expect(image.height).toBe(1080);
      expect(image.alt).toBe('A scenic photo');
    });

    it('should preserve dimensions through save/load', async () => {
      const { images } = getContext();
      const image = await images.create(fixtures.image.png);
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(loaded?.width).toBe(256);
      expect(loaded?.height).toBe(256);
    });

    it('should update image fields', async () => {
      const { images } = getContext();
      const image = await images.create(fixtures.image.jpeg);
      await image.save();

      image.width = 3840;
      image.height = 2160;
      image.alt = 'Updated description';
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(loaded?.width).toBe(3840);
      expect(loaded?.height).toBe(2160);
      expect(loaded?.alt).toBe('Updated description');
    });

    it('should delete image', async () => {
      const { images } = getContext();
      const image = await images.create(fixtures.image.jpeg);
      await image.save();

      await image.delete();

      const loaded = await images.get({ id: image.id });
      expect(loaded).toBeNull();
    });
  });
}

function runEmbeddingTests(getContext: () => { images: ImageCollection }) {
  describe('Embedding Storage', () => {
    it('should store and retrieve embedding vectors', async () => {
      const { images } = getContext();
      const image = await images.create(fixtures.image.withEmbedding);
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(loaded?.embedding).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
      expect(loaded?.descriptionEmbedding).toEqual([0.5, 0.4, 0.3, 0.2, 0.1]);
    });

    it('should handle large embedding vectors', async () => {
      const { images } = getContext();
      const largeEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);

      const image = await images.create({
        ...fixtures.image.jpeg,
        embedding: largeEmbedding,
      });
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(loaded?.embedding).toHaveLength(1536);
      expect(loaded?.embedding?.[0]).toBeCloseTo(0);
      expect(loaded?.embedding?.[1535]).toBeCloseTo(1.535);
    });

    it('should handle empty embeddings', async () => {
      const { images } = getContext();
      const image = await images.create({
        ...fixtures.image.jpeg,
        embedding: [],
        descriptionEmbedding: [],
      });
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(loaded?.embedding).toEqual([]);
      expect(loaded?.descriptionEmbedding).toEqual([]);
    });
  });
}

function runPolymorphicTests(
  getContext: () => {
    images: ImageCollection;
    assets: AssetCollection;
  },
) {
  describe('STI Polymorphic Queries', () => {
    it('should return Image instances from AssetCollection', async () => {
      const { images, assets } = getContext();

      await (await images.create(fixtures.image.jpeg)).save();

      const allAssets = await assets.list({});
      const imageAsset = allAssets.find((a) => a.name === 'photo.jpg');

      expect(imageAsset).toBeInstanceOf(Image);
      expect((imageAsset as Image).width).toBe(1920);
    });

    it('should filter by _meta_type', async () => {
      const { images, assets } = getContext();

      await (await images.create(fixtures.image.jpeg)).save();
      await (await assets.create(fixtures.asset.document)).save();

      const onlyImages = await assets.list({
        where: { _meta_type: 'Image' },
      });

      expect(onlyImages).toHaveLength(1);
      expect(onlyImages[0]).toBeInstanceOf(Image);
    });

    it('should preserve Image fields in mixed queries', async () => {
      const { images, assets } = getContext();

      await (await images.create(fixtures.image.withEmbedding)).save();
      await (await assets.create(fixtures.asset.document)).save();

      const allAssets = await assets.list({});
      const imageAsset = allAssets.find(
        (a) => a.name === 'embedded.jpg',
      ) as Image;

      expect(imageAsset).toBeInstanceOf(Image);
      expect(imageAsset.width).toBe(512);
      expect(imageAsset.height).toBe(512);
      expect(imageAsset.embedding).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
    });
  });
}

function runTypePreservationTests(
  getContext: () => { images: ImageCollection },
) {
  describe('Type Preservation', () => {
    it('should preserve integer types for dimensions', async () => {
      const { images } = getContext();
      const image = await images.create({
        ...fixtures.image.jpeg,
        width: 1920,
        height: 1080,
      });
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(typeof loaded?.width).toBe('number');
      expect(typeof loaded?.height).toBe('number');
      expect(Number.isInteger(loaded?.width)).toBe(true);
      expect(Number.isInteger(loaded?.height)).toBe(true);
    });

    it('should preserve string types for alt text', async () => {
      const { images } = getContext();
      const image = await images.create({
        ...fixtures.image.jpeg,
        alt: 'Test alt text',
      });
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(typeof loaded?.alt).toBe('string');
    });

    it('should preserve array types for embeddings', async () => {
      const { images } = getContext();
      const image = await images.create(fixtures.image.withEmbedding);
      await image.save();

      const loaded = await images.get({ id: image.id });
      expect(Array.isArray(loaded?.embedding)).toBe(true);
      expect(Array.isArray(loaded?.descriptionEmbedding)).toBe(true);
    });
  });
}

// ============================================================================
// Run Tests Across All Adapters
// ============================================================================

describe('Image Adapter Parity', () => {
  adapterConfigs.forEach((adapterConfig) => {
    describe(adapterConfig.name, () => {
      let db: DatabaseInterface;
      let dbConfig: any;
      let images: ImageCollection;
      let assets: AssetCollection;

      beforeEach(async () => {
        dbConfig = adapterConfig.getConfig();
        db = await getDatabase(dbConfig);
        images = await ImageCollection.create({ db: dbConfig });
        assets = await AssetCollection.create({ db: dbConfig });
      });

      afterEach(async () => {
        if (db && typeof db.close === 'function') {
          await db.close();
        }
        await adapterConfig.cleanup(dbConfig);
      });

      const getImageContext = () => ({ images });
      const getFullContext = () => ({ images, assets });

      runBasicCRUDTests(getImageContext);
      runEmbeddingTests(getImageContext);
      runPolymorphicTests(getFullContext);
      runTypePreservationTests(getImageContext);
    });
  });
});
