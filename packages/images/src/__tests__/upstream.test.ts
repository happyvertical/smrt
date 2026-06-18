/**
 * UpstreamManager tests
 *
 * Exercises the orchestration of UpstreamManager.search() and .import()
 * using a STUB AssetSourceAdapter (the interface is injectable) and a STUB
 * AssetStore. The ImageCollection is REAL (backed by in-memory SQLite) so
 * import() actually persists records — no DB/model/collection mocking.
 *
 * Mocked boundaries: only the source adapter (external provider) and the
 * AssetStore.storeFile() (external blob storage). Everything else is real.
 */

import type { AssetStore } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Image } from '../image';
import { ImageCollection } from '../images';
import {
  type AssetSourceAdapter,
  type SourceAsset,
  UpstreamManager,
} from '../upstream';

/**
 * Build a stub AssetSourceAdapter with overridable behavior.
 */
function makeAdapter(
  name: string,
  overrides: Partial<AssetSourceAdapter> = {},
): AssetSourceAdapter {
  return {
    name,
    capabilities: { search: true, download: true, browse: true },
    search: vi.fn(async () => [] as SourceAsset[]),
    get: vi.fn(async () => null),
    download: vi.fn(async () => ({
      data: Buffer.from('fake-image-bytes'),
      metadata: {},
    })),
    ...overrides,
  };
}

function makeSourceAsset(
  sourceName: string,
  externalId: string,
  extra: Partial<SourceAsset> = {},
): SourceAsset {
  return {
    externalId,
    sourceName,
    name: `${externalId}.jpg`,
    mimeType: 'image/jpeg',
    metadata: {},
    ...extra,
  };
}

describe('UpstreamManager', () => {
  let db: DatabaseInterface;
  let collection: ImageCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    collection = await ImageCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('search()', () => {
    it('merges results from all search-capable sources', async () => {
      const a = makeAdapter('unsplash', {
        search: vi.fn(async () => [
          makeSourceAsset('unsplash', 'u1'),
          makeSourceAsset('unsplash', 'u2'),
        ]),
      });
      const b = makeAdapter('pexels', {
        search: vi.fn(async () => [makeSourceAsset('pexels', 'p1')]),
      });

      const manager = new UpstreamManager([a, b], {} as AssetStore, collection);
      const results = await manager.search('mountains');

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.externalId).sort()).toEqual([
        'p1',
        'u1',
        'u2',
      ]);
    });

    it('skips adapters that lack the search capability', async () => {
      const searchable = makeAdapter('searchable', {
        search: vi.fn(async () => [makeSourceAsset('searchable', 's1')]),
      });
      const nonSearchable = makeAdapter('nosearch', {
        capabilities: { search: false, download: true, browse: false },
        search: vi.fn(async () => [makeSourceAsset('nosearch', 'x1')]),
      });

      const manager = new UpstreamManager(
        [searchable, nonSearchable],
        {} as AssetStore,
        collection,
      );
      const results = await manager.search('anything');

      expect(results).toHaveLength(1);
      expect(results[0].externalId).toBe('s1');
      expect(nonSearchable.search).not.toHaveBeenCalled();
    });

    it('passes the resolved limit through to adapters', async () => {
      const a = makeAdapter('lim');
      const manager = new UpstreamManager([a], {} as AssetStore, collection);

      await manager.search('q', { limit: 5 });
      expect(a.search).toHaveBeenCalledWith('q', { limit: 5 });

      await manager.search('q');
      expect(a.search).toHaveBeenLastCalledWith('q', { limit: 20 });
    });

    it('caps the merged results to the requested limit', async () => {
      const many = makeAdapter('many', {
        search: vi.fn(async () =>
          Array.from({ length: 10 }, (_, i) =>
            makeSourceAsset('many', `m${i}`),
          ),
        ),
      });
      const manager = new UpstreamManager([many], {} as AssetStore, collection);

      const results = await manager.search('q', { limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('treats a failing source as empty and still returns others', async () => {
      const failing = makeAdapter('failing', {
        search: vi.fn(async () => {
          throw new Error('network down');
        }),
      });
      const ok = makeAdapter('ok', {
        search: vi.fn(async () => [makeSourceAsset('ok', 'ok1')]),
      });

      const manager = new UpstreamManager(
        [failing, ok],
        {} as AssetStore,
        collection,
      );
      const results = await manager.search('q');

      expect(results).toHaveLength(1);
      expect(results[0].externalId).toBe('ok1');
    });
  });

  describe('import()', () => {
    it('downloads, persists an Image, stores the file, and saves sourceUri', async () => {
      const downloadedBytes = Buffer.from('the-real-bytes');
      const adapter = makeAdapter('unsplash', {
        download: vi.fn(async () => ({
          data: downloadedBytes,
          metadata: {
            width: 1920,
            height: 1080,
            description: 'A mountain',
            attribution: 'Jane Doe',
          },
        })),
      });

      const storeFile = vi.fn(async () => 'file:///stored/path.jpg');
      const store = { storeFile } as unknown as AssetStore;

      const manager = new UpstreamManager([adapter], store, collection);

      const sourceAsset = makeSourceAsset('unsplash', 'abc123', {
        name: 'mountain.jpg',
        mimeType: 'image/jpeg',
      });

      const image = (await manager.import(sourceAsset)) as Image;

      // Downloaded from the matching adapter
      expect(adapter.download).toHaveBeenCalledWith('abc123');

      // Mapped metadata onto the Image
      expect(image.id).toBeDefined();
      expect(image.name).toBe('mountain.jpg');
      expect(image.width).toBe(1920);
      expect(image.height).toBe(1080);
      expect(image.alt).toBe('A mountain');
      // attribution folded into description
      expect(image.description).toBe('A mountain (Jane Doe)');

      // storeFile was called with the persisted image + downloaded bytes
      expect(storeFile).toHaveBeenCalledTimes(1);
      const [storedImage, storedData, storeOpts] = storeFile.mock.calls[0];
      expect(storedImage).toBe(image);
      expect(storedData).toBe(downloadedBytes);
      expect(storeOpts).toMatchObject({
        mimeType: 'image/jpeg',
        typeSlug: 'image',
      });

      // sourceUri from the store was applied and saved
      expect(image.sourceUri).toBe('file:///stored/path.jpg');

      // Reloading proves it was persisted with the final sourceUri
      const loaded = await collection.get({ id: image.id });
      expect(loaded?.sourceUri).toBe('file:///stored/path.jpg');
      expect(loaded?.width).toBe(1920);
    });

    it('defaults missing dimensions/description to safe values', async () => {
      const adapter = makeAdapter('pexels', {
        download: vi.fn(async () => ({
          data: Buffer.from('x'),
          metadata: {}, // no width/height/description/attribution
        })),
      });
      const store = {
        storeFile: vi.fn(async () => 'file:///s.jpg'),
      } as unknown as AssetStore;

      const manager = new UpstreamManager([adapter], store, collection);
      const image = (await manager.import(
        makeSourceAsset('pexels', 'p9'),
      )) as Image;

      expect(image.width).toBe(0);
      expect(image.height).toBe(0);
      expect(image.alt).toBe('');
      expect(image.description).toBe('');
    });

    it('throws when no adapter matches the asset source name', async () => {
      const adapter = makeAdapter('unsplash');
      const manager = new UpstreamManager(
        [adapter],
        {} as AssetStore,
        collection,
      );

      await expect(
        manager.import(makeSourceAsset('unknown-source', 'z1')),
      ).rejects.toThrow(/No adapter found for source: unknown-source/);
      expect(adapter.download).not.toHaveBeenCalled();
    });
  });
});
