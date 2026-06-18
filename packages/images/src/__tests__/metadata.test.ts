/**
 * ImageMetadataExtractor tests
 *
 * The extractor shells out to the external @happyvertical/images SDK via a
 * dynamic import. Per the testing policy we mock ONLY that external boundary
 * (the SDK) and assert the extractor's mapping/orchestration. The Image model
 * itself is real (constructed directly — no DB needed for field assignment).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDimensions = vi.fn();
const getImageMetadata = vi.fn();

vi.mock('@happyvertical/images', () => ({
  getDimensions: (...args: unknown[]) => getDimensions(...args),
  getImageMetadata: (...args: unknown[]) => getImageMetadata(...args),
}));

import { Image } from '../image';
import { ImageMetadataExtractor } from '../metadata';

describe('ImageMetadataExtractor', () => {
  let extractor: ImageMetadataExtractor;

  beforeEach(() => {
    extractor = new ImageMetadataExtractor();
    getDimensions.mockReset();
    getImageMetadata.mockReset();
  });

  describe('extract()', () => {
    it('maps dimensions, format, mimeType, and exif from the SDK result', async () => {
      getDimensions.mockResolvedValue({ width: 800, height: 600 });
      getImageMetadata.mockResolvedValue({
        format: 'png',
        exif: { Make: 'Canon' },
      });

      const buffer = Buffer.from('img');
      const result = await extractor.extract(buffer);

      // Both SDK fns called with the raw buffer
      expect(getDimensions).toHaveBeenCalledWith(buffer);
      expect(getImageMetadata).toHaveBeenCalledWith(buffer);

      expect(result).toEqual({
        width: 800,
        height: 600,
        format: 'png',
        mimeType: 'image/png',
        exif: { Make: 'Canon' },
      });
    });

    it('falls back to empty format and image/unknown when format is missing', async () => {
      getDimensions.mockResolvedValue({ width: 100, height: 100 });
      getImageMetadata.mockResolvedValue({ format: undefined });

      const result = await extractor.extract(Buffer.from('img'));

      expect(result.format).toBe('');
      expect(result.mimeType).toBe('image/unknown');
      expect(result.exif).toBeUndefined();
    });
  });

  describe('extractAndApply()', () => {
    it('writes width/height/mimeType onto the Image instance', async () => {
      getDimensions.mockResolvedValue({ width: 1920, height: 1080 });
      getImageMetadata.mockResolvedValue({ format: 'jpeg' });

      const image = new Image({ name: 'photo.jpg' });
      await extractor.extractAndApply(image, Buffer.from('img'));

      expect(image.width).toBe(1920);
      expect(image.height).toBe(1080);
      expect(image.mimeType).toBe('image/jpeg');
    });

    it('still applies width/height even when mimeType falls back to unknown', async () => {
      getDimensions.mockResolvedValue({ width: 640, height: 480 });
      getImageMetadata.mockResolvedValue({ format: undefined });

      const image = new Image({ name: 'no-format.bin' });
      await extractor.extractAndApply(image, Buffer.from('img'));

      expect(image.width).toBe(640);
      expect(image.height).toBe(480);
      // mimeType from extract() is always truthy ('image/unknown'), so it is set
      expect(image.mimeType).toBe('image/unknown');
    });
  });
});
