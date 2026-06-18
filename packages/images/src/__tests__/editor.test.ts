/**
 * ImageEditor tests
 *
 * Exercises the standard (resize/crop/convert/thumbnail) and AI
 * (edit/generateVariation) operations plus the private createDerivative
 * helper (via its observable effects: a new linked Image record + stored
 * file bytes).
 *
 * Boundaries that are mocked (and ONLY these):
 *  - `@happyvertical/images` — the file-based image processor SDK. Each
 *    stubbed function writes a deterministic output file so the editor's
 *    subsequent `readFile(outputPath)` succeeds. vi.mock is hoisted and
 *    intercepts the dynamic `await import(...)` calls inside editor.ts.
 *  - `@happyvertical/ai` — the AI client (`getAI().generateImage()`).
 *  - The `AssetStore` is a hand-rolled minimal stub (only `read` +
 *    `storeFile` are used by the editor).
 *
 * The `ImageCollection` and its backing DB are REAL (in-memory SQLite) so
 * createDerivative's 3 DB calls (collection.create + storeFile + save)
 * are genuinely exercised end-to-end.
 */

import { writeFile } from 'node:fs/promises';
import type { Asset, AssetStore } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { ImageEditor } from '../editor';
import type { Image } from '../image';
import { ImageCollection } from '../images';

// ---------------------------------------------------------------------------
// Mock the external image-processor SDK. Hoisted by vitest so the dynamic
// `await import('@happyvertical/images')` calls inside editor.ts resolve to
// these stubs. Each stub writes a known buffer to `outPath` so the editor's
// follow-up `readFile(outPath)` finds a real file.
// ---------------------------------------------------------------------------
const RESIZE_BYTES = Buffer.from('resized-image-bytes');
const CROP_BYTES = Buffer.from('cropped-image-bytes');
const CONVERT_BYTES = Buffer.from('converted-image-bytes');
const THUMB_BYTES = Buffer.from('thumbnail-image-bytes');

vi.mock('@happyvertical/images', () => {
  const resizeImage = vi.fn(
    async (_inPath: string, outPath: string, _opts: unknown) => {
      await writeFile(outPath, RESIZE_BYTES);
    },
  );
  const convertFormat = vi.fn(
    async (_inPath: string, outPath: string, _opts: unknown) => {
      await writeFile(outPath, CONVERT_BYTES);
    },
  );
  const generateThumbnail = vi.fn(
    async (_inPath: string, outPath: string, _opts: unknown) => {
      await writeFile(outPath, THUMB_BYTES);
    },
  );
  const processorResize = vi.fn(
    async (_inPath: string, outPath: string, _opts: unknown) => {
      await writeFile(outPath, CROP_BYTES);
    },
  );
  const getImageProcessor = vi.fn(async () => ({ resize: processorResize }));

  return {
    resizeImage,
    convertFormat,
    generateThumbnail,
    getImageProcessor,
    // expose the inner processor.resize mock for assertions
    __processorResize: processorResize,
  };
});

// ---------------------------------------------------------------------------
// Mock the AI SDK. `getAI()` returns a client whose `generateImage()` yields
// a configurable response. Tests reach in via the module mock to tweak it.
// ---------------------------------------------------------------------------
const AI_IMAGE_BYTES = Buffer.from('ai-generated-image-bytes');

vi.mock('@happyvertical/ai', () => {
  const generateImage = vi.fn(async (_prompt: string, _opts: unknown) => ({
    images: [{ data: AI_IMAGE_BYTES }],
  }));
  const getAI = vi.fn(async (_opts: unknown) => ({ generateImage }));
  return { getAI, __generateImage: generateImage };
});

import * as aiSdk from '@happyvertical/ai';
// Typed handles to the mocked module internals for assertions.
import * as imagesSdk from '@happyvertical/images';

const mockedResizeImage = imagesSdk.resizeImage as unknown as Mock;
const mockedConvertFormat = imagesSdk.convertFormat as unknown as Mock;
const mockedGenerateThumbnail = imagesSdk.generateThumbnail as unknown as Mock;
const mockedGetImageProcessor = imagesSdk.getImageProcessor as unknown as Mock;
const mockedProcessorResize = (
  imagesSdk as unknown as { __processorResize: Mock }
).__processorResize;
const mockedGetAI = aiSdk.getAI as unknown as Mock;
const mockedGenerateImage = (aiSdk as unknown as { __generateImage: Mock })
  .__generateImage;

// ---------------------------------------------------------------------------
// Minimal AssetStore stub. The editor only calls `read` and `storeFile`.
// `read` returns canned source bytes; `storeFile` records calls and returns
// a fabricated sourceUri.
// ---------------------------------------------------------------------------
const SOURCE_BYTES = Buffer.from('original-source-image-bytes');

function makeStoreStub() {
  const read = vi.fn(async (_asset: Asset) => SOURCE_BYTES);
  const storeFile = vi.fn(
    async (
      asset: Asset,
      _data: Buffer,
      _opts: { mimeType: string; typeSlug?: string },
    ) => `file:///stored/${asset.id}.bin`,
  );
  return {
    store: { read, storeFile } as unknown as AssetStore,
    read,
    storeFile,
  };
}

describe('ImageEditor', () => {
  let db: DatabaseInterface;
  let images: ImageCollection;
  let store: AssetStore;
  let readMock: Mock;
  let storeFileMock: Mock;
  let source: Image;

  beforeEach(async () => {
    vi.clearAllMocks();

    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    images = await ImageCollection.create({ db });

    const stub = makeStoreStub();
    store = stub.store;
    readMock = stub.read;
    storeFileMock = stub.storeFile;

    source = await images.create({
      name: 'photo',
      sourceUri: 'file:///images/photo.jpg',
      mimeType: 'image/jpeg',
      width: 1600,
      height: 900,
      alt: 'A scenic photo',
      typeSlug: 'image',
      description: 'original',
    });
    await source.save();
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  function makeEditor(options: { ai?: { type: string; apiKey: string } } = {}) {
    return new ImageEditor(store, images, options as never);
  }

  // -------------------------------------------------------------------------
  // resize()
  // -------------------------------------------------------------------------
  describe('resize()', () => {
    it('creates a derivative resized to the target dimensions', async () => {
      const editor = makeEditor();
      const result = await editor.resize(source, 800, 450);

      expect(result.name).toBe('photo-800x450');
      expect(result.width).toBe(800);
      expect(result.height).toBe(450);
      expect(result.sourceAssetId).toBe(source.id);
      expect(result.mimeType).toBe('image/jpeg'); // inherited from source
      expect(result.alt).toBe('A scenic photo'); // inherited from source
      expect(result.description).toBe('Resized from 1600x900 to 800x450');
      expect(result.sourceUri).toBe(`file:///stored/${result.id}.bin`);
    });

    it('reads source bytes and feeds processed bytes to storeFile', async () => {
      const editor = makeEditor();
      const result = await editor.resize(source, 800, 450);

      expect(readMock).toHaveBeenCalledTimes(1);
      expect(readMock).toHaveBeenCalledWith(source);

      // resizeImage invoked with the requested dimensions.
      expect(mockedResizeImage).toHaveBeenCalledTimes(1);
      const [, , opts] = mockedResizeImage.mock.calls[0];
      expect(opts).toEqual({ width: 800, height: 450 });

      // The bytes written back to the store are the ones the processor produced.
      expect(storeFileMock).toHaveBeenCalledTimes(1);
      const [storedAsset, storedData, storedOpts] = storeFileMock.mock.calls[0];
      expect(storedAsset.id).toBe(result.id);
      expect(Buffer.from(storedData).equals(RESIZE_BYTES)).toBe(true);
      expect(storedOpts).toEqual({ mimeType: 'image/jpeg', typeSlug: 'image' });
    });

    it('persists the derivative so it is queryable as a linked Image', async () => {
      const editor = makeEditor();
      const result = await editor.resize(source, 400, 225);

      const loaded = await images.get({ id: result.id });
      expect(loaded).not.toBeNull();
      expect(loaded?.sourceAssetId).toBe(source.id);
      expect(loaded?.width).toBe(400);
      expect(loaded?.height).toBe(225);
    });

    it('cleans up temp files even when the processor throws', async () => {
      mockedResizeImage.mockRejectedValueOnce(new Error('boom'));
      const editor = makeEditor();

      await expect(editor.resize(source, 100, 100)).rejects.toThrow('boom');
      // No derivative should have been written.
      expect(storeFileMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // crop()
  // -------------------------------------------------------------------------
  describe('crop()', () => {
    it('creates a derivative sized to the crop region', async () => {
      const editor = makeEditor();
      const result = await editor.crop(source, 10, 20, 300, 200);

      expect(result.name).toBe('photo-crop');
      expect(result.width).toBe(300);
      expect(result.height).toBe(200);
      expect(result.sourceAssetId).toBe(source.id);
      expect(result.description).toBe('Cropped region 10,20 300x200');
    });

    it('uses the image processor with cover fit and crop dimensions', async () => {
      const editor = makeEditor();
      await editor.crop(source, 10, 20, 300, 200);

      expect(mockedGetImageProcessor).toHaveBeenCalledTimes(1);
      expect(mockedProcessorResize).toHaveBeenCalledTimes(1);
      const [, , opts] = mockedProcessorResize.mock.calls[0];
      expect(opts).toEqual({ width: 300, height: 200, fit: 'cover' });

      // The processor output bytes were stored.
      const [, storedData] = storeFileMock.mock.calls[0];
      expect(Buffer.from(storedData).equals(CROP_BYTES)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // convert()
  // -------------------------------------------------------------------------
  describe('convert()', () => {
    it('creates a derivative with the new format mime type', async () => {
      const editor = makeEditor();
      const result = await editor.convert(source, 'webp');

      expect(result.name).toBe('photo.webp');
      expect(result.mimeType).toBe('image/webp');
      expect(result.sourceAssetId).toBe(source.id);
      expect(result.description).toBe(
        'Converted from image/jpeg to image/webp',
      );
      // Dimensions are inherited from the source (not overridden).
      expect(result.width).toBe(1600);
      expect(result.height).toBe(900);
    });

    it('calls convertFormat with the target format and stores its output', async () => {
      const editor = makeEditor();
      await editor.convert(source, 'png');

      expect(mockedConvertFormat).toHaveBeenCalledTimes(1);
      const [, , opts] = mockedConvertFormat.mock.calls[0];
      expect(opts).toEqual({ format: 'png' });

      const [, storedData, storedOpts] = storeFileMock.mock.calls[0];
      expect(Buffer.from(storedData).equals(CONVERT_BYTES)).toBe(true);
      expect(storedOpts.mimeType).toBe('image/png');
    });
  });

  // -------------------------------------------------------------------------
  // thumbnail()
  // -------------------------------------------------------------------------
  describe('thumbnail()', () => {
    it('creates a square thumbnail derivative', async () => {
      const editor = makeEditor();
      const result = await editor.thumbnail(source, 128);

      expect(result.name).toBe('photo-thumb-128');
      expect(result.width).toBe(128);
      expect(result.height).toBe(128);
      expect(result.sourceAssetId).toBe(source.id);
      expect(result.description).toBe('Thumbnail 128x128');
    });

    it('calls generateThumbnail with max width/height bounds', async () => {
      const editor = makeEditor();
      await editor.thumbnail(source, 256);

      expect(mockedGenerateThumbnail).toHaveBeenCalledTimes(1);
      const [, , opts] = mockedGenerateThumbnail.mock.calls[0];
      expect(opts).toEqual({ maxWidth: 256, maxHeight: 256 });

      const [, storedData] = storeFileMock.mock.calls[0];
      expect(Buffer.from(storedData).equals(THUMB_BYTES)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // edit() — AI path
  // -------------------------------------------------------------------------
  describe('edit()', () => {
    it('throws when no AI options are configured', async () => {
      const editor = makeEditor(); // no ai option
      await expect(editor.edit(source, 'make it sunset')).rejects.toThrow(
        'AI options required for AI-powered editing',
      );
      expect(mockedGetAI).not.toHaveBeenCalled();
    });

    it('generates an AI image and creates a derivative', async () => {
      const editor = makeEditor({ ai: { type: 'openai', apiKey: 'test-key' } });
      const result = await editor.edit(source, 'add a sunset');

      expect(mockedGetAI).toHaveBeenCalledTimes(1);
      expect(mockedGetAI).toHaveBeenCalledWith({
        type: 'openai',
        apiKey: 'test-key',
      });
      expect(mockedGenerateImage).toHaveBeenCalledTimes(1);
      const [prompt, opts] = mockedGenerateImage.mock.calls[0];
      expect(prompt).toBe('add a sunset');
      expect(opts).toEqual({ size: '1600x900' }); // source dimensions

      expect(result.name).toBe('photo-edited');
      expect(result.description).toBe('AI edit: add a sunset');
      expect(result.sourceAssetId).toBe(source.id);
      // Dimensions inherited (no override in createDerivative for edit).
      expect(result.width).toBe(1600);
      expect(result.height).toBe(900);

      const [, storedData] = storeFileMock.mock.calls[0];
      expect(Buffer.from(storedData).equals(AI_IMAGE_BYTES)).toBe(true);
    });

    it('throws when the AI response has no Buffer image data', async () => {
      mockedGenerateImage.mockResolvedValueOnce({ images: [] });
      const editor = makeEditor({ ai: { type: 'openai', apiKey: 'test-key' } });

      await expect(editor.edit(source, 'nope')).rejects.toThrow(
        'AI did not return image data as Buffer',
      );
      expect(storeFileMock).not.toHaveBeenCalled();
    });

    it('throws when the AI returns non-Buffer image data', async () => {
      mockedGenerateImage.mockResolvedValueOnce({
        images: [{ data: 'not-a-buffer' }],
      });
      const editor = makeEditor({ ai: { type: 'openai', apiKey: 'test-key' } });

      await expect(editor.edit(source, 'nope')).rejects.toThrow(
        'AI did not return image data as Buffer',
      );
    });
  });

  // -------------------------------------------------------------------------
  // generateVariation()
  // -------------------------------------------------------------------------
  describe('generateVariation()', () => {
    it('defaults to a single variation', async () => {
      const editor = makeEditor({ ai: { type: 'openai', apiKey: 'test-key' } });
      const results = await editor.generateVariation(source, 'remix');

      expect(results).toHaveLength(1);
      expect(mockedGenerateImage).toHaveBeenCalledTimes(1);
      const [prompt] = mockedGenerateImage.mock.calls[0];
      expect(prompt).toBe('remix (variation 1 of 1)');
      expect(results[0].sourceAssetId).toBe(source.id);
    });

    it('generates the requested number of variations with numbered prompts', async () => {
      const editor = makeEditor({ ai: { type: 'openai', apiKey: 'test-key' } });
      const results = await editor.generateVariation(source, 'remix', {
        count: 3,
      });

      expect(results).toHaveLength(3);
      expect(mockedGenerateImage).toHaveBeenCalledTimes(3);
      expect(mockedGenerateImage.mock.calls[0][0]).toBe(
        'remix (variation 1 of 3)',
      );
      expect(mockedGenerateImage.mock.calls[1][0]).toBe(
        'remix (variation 2 of 3)',
      );
      expect(mockedGenerateImage.mock.calls[2][0]).toBe(
        'remix (variation 3 of 3)',
      );

      // Each variation is a distinct, linked Image with a stored file.
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(3);
      for (const r of results) {
        expect(r.sourceAssetId).toBe(source.id);
        expect(r.name).toBe('photo-edited');
        expect(r.sourceUri).toBe(`file:///stored/${r.id}.bin`);
      }
      // storeFile was invoked once per variation.
      expect(storeFileMock).toHaveBeenCalledTimes(3);
    });

    it('propagates the no-AI-options error from edit()', async () => {
      const editor = makeEditor(); // no ai
      await expect(
        editor.generateVariation(source, 'remix', { count: 2 }),
      ).rejects.toThrow('AI options required for AI-powered editing');
    });
  });

  // -------------------------------------------------------------------------
  // createDerivative behaviour (via the public ops)
  // -------------------------------------------------------------------------
  describe('createDerivative (observed via ops)', () => {
    it('falls back to "image" typeSlug when source has none', async () => {
      const noSlug = await images.create({
        name: 'noslug',
        mimeType: 'image/png',
        width: 200,
        height: 100,
      });
      // Force an empty typeSlug to hit the `|| 'image'` fallback.
      noSlug.typeSlug = '';
      await noSlug.save();

      const editor = makeEditor();
      await editor.resize(noSlug, 50, 25);

      const [, , storedOpts] = storeFileMock.mock.calls[0];
      expect(storedOpts.typeSlug).toBe('image');
    });
  });
});
