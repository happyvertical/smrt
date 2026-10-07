/**
 * ImageEditor - Standard and AI-powered image editing
 *
 * Creates derivative assets for each edit operation, preserving
 * the original image and linking via sourceAssetId (the derivation
 * pointer; renamed from `parentId` in R3-D).
 *
 * Standard operations use @happyvertical/images (file-based API).
 * AI operations use @happyvertical/ai.
 */

import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AIClientOptions } from '@happyvertical/ai';
import type { ImageFormat } from '@happyvertical/images';
import type { AssetStore } from '@happyvertical/smrt-assets';
import {
  describeImageAdjustments,
  type ImageAdjustments,
  normalizeImageAdjustments,
} from './adjust';
import { applyImageAdjustments } from './adjust-render';
import type { Image } from './image';
import type { ImageCollection } from './images';

/**
 * Output formats `convert()` accepts. Mirrors the `ImageFormat` union from
 * `@happyvertical/images`. Used as a runtime allowlist so a caller-supplied
 * `format` string can never escape this set.
 */
const ALLOWED_CONVERT_FORMATS = new Set<ImageFormat>([
  'jpeg',
  'png',
  'webp',
  'avif',
  'gif',
  'tiff',
]);

export class ImageEditor {
  constructor(
    private readonly store: AssetStore,
    private readonly collection: ImageCollection,
    private readonly options: { ai?: AIClientOptions } = {},
  ) {}

  /**
   * Resize an image to the specified dimensions
   *
   * @param image - Source image
   * @param width - Target width
   * @param height - Target height
   * @returns New derivative Image
   */
  async resize(image: Image, width: number, height: number): Promise<Image> {
    const { resizeImage } = await import('@happyvertical/images');
    const sourceData = await this.store.read(image);

    const inputPath = join(tmpdir(), `smrt-edit-in-${randomUUID()}.bin`);
    const outputPath = join(tmpdir(), `smrt-edit-out-${randomUUID()}.bin`);

    try {
      await writeFile(inputPath, sourceData);
      await resizeImage(inputPath, outputPath, { width, height });
      const resized = await readFile(outputPath);

      return this.createDerivative(image, resized, {
        name: `${image.name}-${width}x${height}`,
        width,
        height,
        description: `Resized from ${image.width}x${image.height} to ${width}x${height}`,
      });
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  }

  /**
   * Crop an image to the specified region (in pixels of the picture as it is
   * seen, after its EXIF orientation). The region is clamped to the picture.
   *
   * @param image - Source image
   * @param x - Left offset
   * @param y - Top offset
   * @param w - Crop width
   * @param h - Crop height
   * @returns New derivative Image
   */
  async crop(
    image: Image,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<Image> {
    const values = [x, y, w, h];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error('Crop needs a left, top, width and height in pixels.');
    }
    if (w < 1 || h < 1) {
      throw new Error('A crop must be at least one pixel wide and tall.');
    }
    const sourceData = await this.store.read(image);
    const { default: sharp } = await import('sharp');
    const oriented = await sharp(sourceData)
      .rotate()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = oriented.info;
    const left = Math.min(Math.max(Math.round(x), 0), width - 1);
    const top = Math.min(Math.max(Math.round(y), 0), height - 1);
    const cropWidth = Math.min(Math.round(w), width - left);
    const cropHeight = Math.min(Math.round(h), height - top);
    const cropped = await sharp(oriented.data)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .toBuffer();

    return this.createDerivative(image, cropped, {
      name: `${image.name}-crop`,
      width: cropWidth,
      height: cropHeight,
      description: `Cropped region ${left},${top} ${cropWidth}x${cropHeight}`,
    });
  }

  /**
   * Brightness, contrast, colour, black-and-white, rotate, flip, region crop
   * or resize, in one pass (see `./adjust.ts`). The source is unchanged; the
   * result is a new derivative linked to it.
   *
   * @param image - Source image
   * @param adjustments - What to change (checked and clamped)
   * @returns New derivative Image
   */
  async adjust(image: Image, adjustments: ImageAdjustments): Promise<Image> {
    const normalized = normalizeImageAdjustments(adjustments);
    if (Object.keys(normalized).length === 0) {
      throw new Error(
        'Nothing to change: the adjustments leave the picture as it is.',
      );
    }
    const sourceData = await this.store.read(image);
    const adjusted = await applyImageAdjustments(sourceData, normalized);
    return this.createDerivative(image, adjusted.data, {
      name: `${image.name}-adjusted`,
      width: adjusted.width,
      height: adjusted.height,
      mimeType: adjusted.mimeType,
      description: `Adjusted: ${describeImageAdjustments(normalized)}`,
    });
  }

  /**
   * Convert an image to a different format
   *
   * @param image - Source image
   * @param format - Target format (e.g., 'webp', 'png', 'jpeg')
   * @returns New derivative Image
   */
  async convert(image: Image, format: string): Promise<Image> {
    // Validate against a fixed allowlist BEFORE the value is interpolated into
    // a filesystem path. `format` is caller-controlled (e.g. an HTTP request
    // body via `ImageConvertRequest`) and is appended as the output temp
    // file's extension; an unchecked value like `../../../etc/cron.d/x` would
    // escape `tmpdir()` and let an attacker write the converted bytes to an
    // arbitrary location (path-traversal write). The static `as ImageFormat`
    // cast below gives zero runtime protection, so guard explicitly here.
    const normalizedFormat = format.trim().toLowerCase();
    if (!ALLOWED_CONVERT_FORMATS.has(normalizedFormat as ImageFormat)) {
      throw new Error(
        `Unsupported image format: ${JSON.stringify(format)}. ` +
          `Allowed formats: ${[...ALLOWED_CONVERT_FORMATS].join(', ')}`,
      );
    }
    const safeFormat = normalizedFormat as ImageFormat;

    const { convertFormat } = await import('@happyvertical/images');
    const sourceData = await this.store.read(image);
    const mimeType = `image/${safeFormat}`;

    const inputPath = join(tmpdir(), `smrt-conv-in-${randomUUID()}.bin`);
    const outputPath = join(
      tmpdir(),
      `smrt-conv-out-${randomUUID()}.${safeFormat}`,
    );

    try {
      await writeFile(inputPath, sourceData);
      await convertFormat(inputPath, outputPath, {
        format: safeFormat,
      });
      const converted = await readFile(outputPath);

      return this.createDerivative(image, converted, {
        name: `${image.name}.${safeFormat}`,
        mimeType,
        description: `Converted from ${image.mimeType} to ${mimeType}`,
      });
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  }

  /**
   * Generate a square thumbnail of the specified size
   *
   * @param image - Source image
   * @param size - Thumbnail dimension (square)
   * @returns New derivative Image
   */
  async thumbnail(image: Image, size: number): Promise<Image> {
    const { generateThumbnail } = await import('@happyvertical/images');
    const sourceData = await this.store.read(image);

    const inputPath = join(tmpdir(), `smrt-thumb-in-${randomUUID()}.bin`);
    const outputPath = join(tmpdir(), `smrt-thumb-out-${randomUUID()}.bin`);

    try {
      await writeFile(inputPath, sourceData);
      await generateThumbnail(inputPath, outputPath, {
        maxWidth: size,
        maxHeight: size,
      });
      const thumbData = await readFile(outputPath);

      return this.createDerivative(image, thumbData, {
        name: `${image.name}-thumb-${size}`,
        width: size,
        height: size,
        description: `Thumbnail ${size}x${size}`,
      });
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  }

  /**
   * AI-powered image generation based on a prompt (creates derivative linked to source)
   *
   * @param image - Source image (used for metadata, linked as parent)
   * @param prompt - Generation instructions (e.g., "similar image with sunset colors")
   * @returns New derivative Image
   */
  async edit(image: Image, prompt: string): Promise<Image> {
    if (!this.options.ai) {
      throw new Error('AI options required for AI-powered editing');
    }

    const { getAI } = await import('@happyvertical/ai');
    const ai = await getAI(this.options.ai);

    const response = await ai.generateImage(prompt, {
      size: `${image.width}x${image.height}`,
    });

    const imageData = response.images[0]?.data;
    if (!imageData || !(imageData instanceof Buffer)) {
      throw new Error('AI did not return image data as Buffer');
    }

    return this.createDerivative(image, imageData, {
      name: `${image.name}-edited`,
      description: `AI edit: ${prompt}`,
    });
  }

  /**
   * Generate variations of an image using AI
   *
   * @param image - Source image
   * @param prompt - Variation instructions
   * @param options - Number of variations to generate
   * @returns Array of new derivative Images
   */
  async generateVariation(
    image: Image,
    prompt: string,
    options: { count?: number } = {},
  ): Promise<Image[]> {
    const count = options.count ?? 1;
    const results: Image[] = [];

    for (let i = 0; i < count; i++) {
      const variation = await this.edit(
        image,
        `${prompt} (variation ${i + 1} of ${count})`,
      );
      results.push(variation);
    }

    return results;
  }

  /**
   * Helper: Create a derivative Image from processed buffer data
   */
  private async createDerivative(
    source: Image,
    data: Buffer,
    overrides: {
      name: string;
      width?: number;
      height?: number;
      mimeType?: string;
      description?: string;
    },
  ): Promise<Image> {
    const mimeType = overrides.mimeType ?? source.mimeType;
    const typeSlug = source.typeSlug || 'image';

    // Create only the Image record (not a plain Asset via store.store())
    const derivative = (await this.collection.create({
      name: overrides.name,
      sourceUri: '',
      mimeType,
      width: overrides.width ?? source.width,
      height: overrides.height ?? source.height,
      alt: source.alt,
      sourceAssetId: source.id,
      typeSlug,
      description: overrides.description ?? '',
    })) as Image;

    // Write file data for the existing record
    const sourceUri = await this.store.storeFile(derivative, data, {
      mimeType,
      typeSlug,
    });
    derivative.sourceUri = sourceUri;
    await derivative.save();

    return derivative;
  }
}
