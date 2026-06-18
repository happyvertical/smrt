/**
 * Tests for `ImageSearch` — text and heuristic image search.
 *
 * `search.ts` imports the `@happyvertical/ai` types but does NOT currently
 * invoke the AI client (the constructor accepts an optional `ai` option that is
 * unused so far). All search logic runs against the real `ImageCollection`, so
 * these tests use a real in-memory SQLite database rather than mocks.
 */

import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Image } from '../image';
import { ImageCollection } from '../images';
import { ImageSearch } from '../search';

describe('ImageSearch', () => {
  let db: DatabaseInterface;
  let images: ImageCollection;
  let search: ImageSearch;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    images = await ImageCollection.create({ db });
    search = new ImageSearch(images);
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  async function seed() {
    await (
      await images.create({
        name: 'sunset-beach.jpg',
        description: 'A golden sunset over the ocean',
        alt: 'Beach at dusk',
        mimeType: 'image/jpeg',
        width: 1920,
        height: 1080,
      })
    ).save();
    await (
      await images.create({
        name: 'mountain-peak.jpg',
        description: 'Snowy mountain at sunrise',
        alt: 'Alpine vista',
        mimeType: 'image/jpeg',
        width: 1080,
        height: 1920,
      })
    ).save();
    await (
      await images.create({
        name: 'portrait-of-cat.png',
        description: 'A fluffy cat',
        alt: 'Cat looking at camera',
        mimeType: 'image/png',
        width: 1000,
        height: 1000,
      })
    ).save();
  }

  describe('search()', () => {
    it('matches a query against the name', async () => {
      await seed();
      const results = await search.search('mountain');
      expect(results.map((r) => r.name)).toEqual(['mountain-peak.jpg']);
    });

    it('matches a query against the description (case-insensitive)', async () => {
      await seed();
      const results = await search.search('SUNSET');
      // 'sunset' appears in name + description of sunset-beach; only one image
      // matches.
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('sunset-beach.jpg');
    });

    it('matches a query against the alt text', async () => {
      await seed();
      const results = await search.search('vista');
      expect(results.map((r) => r.name)).toEqual(['mountain-peak.jpg']);
    });

    it('returns no matches when nothing matches the query', async () => {
      await seed();
      const results = await search.search('spaceship');
      expect(results).toEqual([]);
    });

    it('returns all images (up to limit) for an empty query', async () => {
      await seed();
      const results = await search.search('');
      expect(results).toHaveLength(3);
    });

    it('filters by minimum dimensions via the where clause', async () => {
      await seed();
      // minWidth filters out the portrait (1080w) and square (1000w) images;
      // only the 1920w landscape remains.
      const results = await search.search('', { minWidth: 1500 });
      expect(results.map((r) => r.name)).toEqual(['sunset-beach.jpg']);
    });

    it('filters by minHeight via the where clause', async () => {
      await seed();
      // Only the portrait image (1920h) clears the 1500 minimum; the
      // landscape (1080h) and square (1000h) are excluded.
      const results = await search.search('', { minHeight: 1500 });
      expect(results.map((r) => r.name)).toEqual(['mountain-peak.jpg']);
    });

    it('filters by landscape orientation', async () => {
      await seed();
      const results = await search.search('', { orientation: 'landscape' });
      expect(results.map((r) => r.name)).toEqual(['sunset-beach.jpg']);
    });

    it('filters by portrait orientation', async () => {
      await seed();
      const results = await search.search('', { orientation: 'portrait' });
      expect(results.map((r) => r.name)).toEqual(['mountain-peak.jpg']);
    });

    it('filters by square orientation', async () => {
      await seed();
      const results = await search.search('', { orientation: 'square' });
      expect(results.map((r) => r.name)).toEqual(['portrait-of-cat.png']);
    });

    it('applies the final limit to results', async () => {
      await seed();
      const results = await search.search('', { limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('combines a text query with an orientation filter', async () => {
      // Two landscape images that both match the word "city" by description,
      // but only one is landscape.
      await (
        await images.create({
          name: 'city-wide.jpg',
          description: 'A bustling city skyline',
          mimeType: 'image/jpeg',
          width: 1920,
          height: 1080,
        })
      ).save();
      await (
        await images.create({
          name: 'city-tall.jpg',
          description: 'A bustling city street',
          mimeType: 'image/jpeg',
          width: 1080,
          height: 1920,
        })
      ).save();

      const results = await search.search('city', {
        orientation: 'landscape',
      });
      expect(results.map((r) => r.name)).toEqual(['city-wide.jpg']);
    });
  });

  describe('findSimilar()', () => {
    it('returns images within ±20% aspect ratio, excluding the source', async () => {
      await seed();
      // Two more ~16:9 landscape images so the source has neighbours.
      const a = await images.create({
        name: 'wide-a.jpg',
        mimeType: 'image/jpeg',
        width: 1600,
        height: 900,
      });
      await a.save();
      const b = await images.create({
        name: 'wide-b.jpg',
        mimeType: 'image/jpeg',
        width: 1280,
        height: 720,
      });
      await b.save();

      const source = (await images.get({
        name: 'sunset-beach.jpg',
      })) as Image;
      const similar = await search.findSimilar(source);

      const names = similar.map((s) => s.name);
      // The square (1:1) and portrait (9:16) images are outside ±20%.
      expect(names).toContain('wide-a.jpg');
      expect(names).toContain('wide-b.jpg');
      // The source itself is excluded.
      expect(names).not.toContain('sunset-beach.jpg');
    });

    it('respects the limit option', async () => {
      const ratios = [
        [1600, 900],
        [1280, 720],
        [1920, 1080],
        [1366, 768],
      ];
      for (const [w, h] of ratios) {
        await (
          await images.create({
            name: `img-${w}x${h}.jpg`,
            mimeType: 'image/jpeg',
            width: w,
            height: h,
          })
        ).save();
      }

      const source = (await images.get({
        name: 'img-1600x900.jpg',
      })) as Image;
      const similar = await search.findSimilar(source, { limit: 2 });
      expect(similar).toHaveLength(2);
    });
  });

  describe('findByPrompt()', () => {
    it('delegates to text search', async () => {
      await seed();
      const results = await search.findByPrompt('cat');
      expect(results.map((r) => r.name)).toEqual(['portrait-of-cat.png']);
    });

    it('passes the limit option through to search', async () => {
      await seed();
      const results = await search.findByPrompt('', { limit: 1 });
      expect(results).toHaveLength(1);
    });
  });
});
