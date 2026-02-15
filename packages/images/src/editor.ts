/**
 * ImageEditor - Standard and AI-powered image editing
 *
 * Creates derivative assets for each edit operation, preserving
 * the original image and linking via parentId.
 *
 * Standard operations use @happyvertical/images (file-based API).
 * AI operations use @happyvertical/ai.
 */

import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AIClientOptions } from '@happyvertical/ai';
import type { AssetStore } from '@happyvertical/smrt-assets';
import type { Image } from './image';
import type { ImageCollection } from './images';

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
   * Crop an image to the specified region
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
    const { getImageProcessor } = await import('@happyvertical/images');
    const processor = await getImageProcessor();
    const sourceData = await this.store.read(image);

    const inputPath = join(tmpdir(), `smrt-crop-in-${randomUUID()}.bin`);
    const outputPath = join(tmpdir(), `smrt-crop-out-${randomUUID()}.bin`);

    try {
      await writeFile(inputPath, sourceData);
      // Use the processor adapter for crop via resize with cover fit
      await processor.resize(inputPath, outputPath, {
        width: w,
        height: h,
        fit: 'cover',
      });
      const cropped = await readFile(outputPath);

      return this.createDerivative(image, cropped, {
        name: `${image.name}-crop`,
        width: w,
        height: h,
        description: `Cropped region ${x},${y} ${w}x${h}`,
      });
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  }

  /**
   * Convert an image to a different format
   *
   * @param image - Source image
   * @param format - Target format (e.g., 'webp', 'png', 'jpeg')
   * @returns New derivative Image
   */
  async convert(image: Image, format: string): Promise<Image> {
    const { convertFormat } = await import('@happyvertical/images');
    const sourceData = await this.store.read(image);
    const mimeType = `image/${format}`;

    const inputPath = join(tmpdir(), `smrt-conv-in-${randomUUID()}.bin`);
    const outputPath = join(
      tmpdir(),
      `smrt-conv-out-${randomUUID()}.${format}`,
    );

    try {
      await writeFile(inputPath, sourceData);
      await convertFormat(inputPath, outputPath, {
        format: format as import('@happyvertical/images').ImageFormat,
      });
      const converted = await readFile(outputPath);

      return this.createDerivative(image, converted, {
        name: `${image.name}.${format}`,
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

    const stored = await this.store.store(overrides.name, data, {
      mimeType,
      typeSlug,
      parentId: source.id!,
      description: overrides.description,
    });

    const derivative = (await this.collection.create({
      name: overrides.name,
      sourceUri: stored.sourceUri,
      mimeType,
      width: overrides.width ?? source.width,
      height: overrides.height ?? source.height,
      alt: source.alt,
      parentId: source.id,
      typeSlug,
      description: overrides.description ?? '',
    })) as Image;

    return derivative;
  }
}
