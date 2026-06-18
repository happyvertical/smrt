/**
 * Extended tests for `ImageDeriver` — covers `derive()` directly and the
 * `deriveWithAssociations()` end-to-end path (without stubbing `derive`).
 *
 * The existing `deriver.test.ts` only verifies provenance linking with `derive`
 * mocked out, so it never exercises the AI image-generation loop, the prompt
 * assembly, the count loop, or the error branches. These tests fill that gap.
 *
 * External boundary: `@happyvertical/ai` (dynamic `import` inside `derive()`)
 * is mocked. The `ImageCollection` runs against a real in-memory SQLite DB; the
 * `AssetStore` is a lightweight stub since it is provider-agnostic file I/O.
 */

import type {
  AssetAssociationCollection,
  AssetStore,
} from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageDeriver } from '../deriver';
import type { Image } from '../image';
import { ImageCollection } from '../images';

// `derive()` calls `ai.generateImage(prompt, { size })` and reads
// `response.images[0].data`. `generateImageMock` is reassignable per-test.
let generateImageMock: ReturnType<typeof vi.fn>;

vi.mock('@happyvertical/ai', () => ({
  getAI: vi.fn(async () => ({
    generateImage: (...args: unknown[]) => generateImageMock(...args),
  })),
}));

const aiOptions = { ai: { type: 'openai' as const, apiKey: 'test-key' } };

describe('ImageDeriver (extended)', () => {
  let db: DatabaseInterface;
  let images: ImageCollection;
  let storeFileMock: ReturnType<typeof vi.fn>;
  let store: AssetStore;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    images = await ImageCollection.create({ db });

    // Stub AssetStore: just records the call and returns a deterministic URI.
    storeFileMock = vi
      .fn()
      .mockImplementation(async (asset: Image) => `stored://${asset.name}.png`);
    store = { storeFile: storeFileMock } as unknown as AssetStore;

    generateImageMock = vi.fn();
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
    vi.clearAllMocks();
  });

  async function makeSource(name: string): Promise<Image> {
    const img = await images.create({
      name,
      mimeType: 'image/jpeg',
      width: 800,
      height: 600,
    });
    await img.save();
    return img;
  }

  function aiReturnsBuffer() {
    generateImageMock.mockResolvedValue({
      images: [{ data: Buffer.from('generated-png-bytes') }],
    });
  }

  describe('derive()', () => {
    it('throws when no source images are provided', async () => {
      const deriver = new ImageDeriver(store, images, aiOptions);
      await expect(deriver.derive([], 'a prompt')).rejects.toThrow(
        'At least one source image is required',
      );
      expect(generateImageMock).not.toHaveBeenCalled();
    });

    it('generates a single derived image by default and persists it', async () => {
      aiReturnsBuffer();
      const source = await makeSource('cat');

      const deriver = new ImageDeriver(store, images, aiOptions);
      const results = await deriver.derive([source], 'Make it painterly');

      expect(results).toHaveLength(1);
      expect(generateImageMock).toHaveBeenCalledTimes(1);

      const derived = results[0];
      expect(derived.name).toBe('derived-cat-1');
      expect(derived.mimeType).toBe('image/png');
      expect(derived.description).toBe('Derived: Make it painterly');
      expect(derived.sourceAssetId).toBe(source.id);
      // sourceUri is set from the stubbed store return value.
      expect(derived.sourceUri).toBe('stored://derived-cat-1.png');

      // The bytes from the AI were handed to the store.
      expect(storeFileMock).toHaveBeenCalledTimes(1);
      const [, data, opts] = storeFileMock.mock.calls[0];
      expect(Buffer.isBuffer(data)).toBe(true);
      expect((data as Buffer).toString()).toBe('generated-png-bytes');
      expect(opts).toMatchObject({ mimeType: 'image/png', typeSlug: 'image' });

      // The derived record was actually saved (sourceUri persisted).
      const reloaded = await images.get({ id: derived.id });
      expect(reloaded?.sourceUri).toBe('stored://derived-cat-1.png');
    });

    it('generates `count` images, numbering each result', async () => {
      aiReturnsBuffer();
      const source = await makeSource('dog');

      const deriver = new ImageDeriver(store, images, aiOptions);
      const results = await deriver.derive([source], 'Variations', {
        count: 3,
      });

      expect(results).toHaveLength(3);
      expect(generateImageMock).toHaveBeenCalledTimes(3);
      expect(results.map((r) => r.name)).toEqual([
        'derived-dog-1',
        'derived-dog-2',
        'derived-dog-3',
      ]);
    });

    it('assembles the prompt with style, size, and source names', async () => {
      aiReturnsBuffer();
      const a = await makeSource('alpha');
      const b = await makeSource('beta');

      const deriver = new ImageDeriver(store, images, aiOptions);
      await deriver.derive([a, b], 'Blend these', {
        style: 'watercolor',
        size: '1024x1024',
      });

      const [fullPrompt, genOpts] = generateImageMock.mock.calls[0];
      expect(fullPrompt).toContain('Blend these');
      expect(fullPrompt).toContain('Style: watercolor');
      expect(fullPrompt).toContain('Output size: 1024x1024');
      expect(fullPrompt).toContain('Source images: alpha, beta');
      // The size is forwarded to generateImage options.
      expect(genOpts).toEqual({ size: '1024x1024' });
    });

    it('omits style and size lines from the prompt when not provided', async () => {
      aiReturnsBuffer();
      const source = await makeSource('plain');

      const deriver = new ImageDeriver(store, images, aiOptions);
      await deriver.derive([source], 'Just the prompt');

      const [fullPrompt, genOpts] = generateImageMock.mock.calls[0];
      expect(fullPrompt).not.toContain('Style:');
      expect(fullPrompt).not.toContain('Output size:');
      expect(fullPrompt).toContain('Source images: plain');
      expect(genOpts).toEqual({ size: undefined });
    });

    it('throws when the AI returns no image data', async () => {
      generateImageMock.mockResolvedValue({ images: [] });
      const source = await makeSource('empty');

      const deriver = new ImageDeriver(store, images, aiOptions);
      await expect(deriver.derive([source], 'prompt')).rejects.toThrow(
        'AI did not return image data as Buffer',
      );
    });

    it('throws when the AI returns image data that is not a Buffer', async () => {
      generateImageMock.mockResolvedValue({
        images: [{ data: 'a-base64-string-not-a-buffer' }],
      });
      const source = await makeSource('string-data');

      const deriver = new ImageDeriver(store, images, aiOptions);
      await expect(deriver.derive([source], 'prompt')).rejects.toThrow(
        'AI did not return image data as Buffer',
      );
    });
  });

  describe('deriveWithAssociations() end-to-end', () => {
    it('derives images and links every source to each derived image', async () => {
      aiReturnsBuffer();
      const s1 = await makeSource('src-one');
      const s2 = await makeSource('src-two');

      const attach = vi.fn().mockResolvedValue(undefined);
      const associations = {
        attach,
      } as unknown as AssetAssociationCollection;

      const deriver = new ImageDeriver(store, images, aiOptions);
      const results = await deriver.deriveWithAssociations(
        [s1, s2],
        'Combine references',
        associations,
        { count: 2 },
      );

      expect(results).toHaveLength(2);
      // 2 derived images × 2 sources = 4 association links.
      expect(attach).toHaveBeenCalledTimes(4);
      for (const call of attach.mock.calls) {
        const [metaType, derivedId, sourceId, opts] = call;
        expect(metaType).toBe('Image');
        expect(results.some((r) => r.id === derivedId)).toBe(true);
        expect([s1.id, s2.id]).toContain(sourceId);
        expect(opts).toEqual({ role: 'derivation-source' });
      }
    });
  });
});
