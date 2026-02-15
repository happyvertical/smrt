/**
 * ImageMetadataExtractor - Extracts metadata from image buffers
 *
 * Uses @happyvertical/images for dimension and format extraction.
 */

import type { Image } from './image';
import type { ImageMetadataResult } from './types';

export class ImageMetadataExtractor {
  /**
   * Extract metadata from an image buffer
   *
   * @param buffer - Raw image data
   * @returns Extracted metadata including dimensions and format
   */
  async extract(buffer: Buffer): Promise<ImageMetadataResult> {
    const { getDimensions, getImageMetadata } = await import(
      '@happyvertical/images'
    );

    const dimensions = await getDimensions(buffer);
    const metadata = await getImageMetadata(buffer);

    return {
      width: dimensions.width,
      height: dimensions.height,
      format: metadata.format ?? '',
      mimeType: metadata.format ? `image/${metadata.format}` : 'image/unknown',
      exif: metadata.exif as Record<string, unknown> | undefined,
    };
  }

  /**
   * Extract metadata and apply it to an Image instance
   *
   * @param image - The Image instance to update
   * @param buffer - Raw image data
   */
  async extractAndApply(image: Image, buffer: Buffer): Promise<void> {
    const result = await this.extract(buffer);
    image.width = result.width;
    image.height = result.height;
    if (result.mimeType) image.mimeType = result.mimeType;
  }
}
