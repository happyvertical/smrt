/**
 * ImageCollection - Collection manager for Image instances
 *
 * Provides image-specific query operations and bulk operations
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Image } from './image';

export class ImageCollection extends SmrtCollection<Image> {
  static readonly _itemClass = Image;

  /**
   * Get images by minimum dimensions
   *
   * @param minWidth - Minimum width in pixels
   * @param minHeight - Minimum height in pixels
   * @returns Array of images meeting minimum dimension requirements
   */
  async getByMinDimensions(
    minWidth: number,
    minHeight: number,
  ): Promise<Image[]> {
    return (await this.list({
      where: {
        'width >=': minWidth,
        'height >=': minHeight,
      },
    })) as Image[];
  }

  /**
   * Get images by maximum dimensions
   *
   * @param maxWidth - Maximum width in pixels
   * @param maxHeight - Maximum height in pixels
   * @returns Array of images within maximum dimension limits
   */
  async getByMaxDimensions(
    maxWidth: number,
    maxHeight: number,
  ): Promise<Image[]> {
    return (await this.list({
      where: {
        'width <=': maxWidth,
        'height <=': maxHeight,
      },
    })) as Image[];
  }

  /**
   * Get landscape images (width > height)
   *
   * @returns Array of landscape-oriented images
   */
  async getLandscape(): Promise<Image[]> {
    const images = (await this.list({})) as Image[];
    return images.filter((img) => img.isLandscape);
  }

  /**
   * Get portrait images (height > width)
   *
   * @returns Array of portrait-oriented images
   */
  async getPortrait(): Promise<Image[]> {
    const images = (await this.list({})) as Image[];
    return images.filter((img) => img.isPortrait);
  }

  /**
   * Get square images (width === height)
   *
   * @returns Array of square images
   */
  async getSquare(): Promise<Image[]> {
    const images = (await this.list({})) as Image[];
    return images.filter((img) => img.isSquare);
  }

  /**
   * Get images missing alt text
   *
   * @returns Array of images without accessibility text
   */
  async getMissingAltText(): Promise<Image[]> {
    return (await this.list({
      where: { alt: '' },
    })) as Image[];
  }

  /**
   * Get high resolution images (4K+)
   *
   * @returns Array of high resolution images
   */
  async getHighResolution(): Promise<Image[]> {
    const images = (await this.list({})) as Image[];
    return images.filter((img) => img.isHighResolution());
  }

  /**
   * Get images by aspect ratio range
   *
   * @param minRatio - Minimum aspect ratio (width/height)
   * @param maxRatio - Maximum aspect ratio (width/height)
   * @returns Array of images within the aspect ratio range
   */
  async getByAspectRatio(minRatio: number, maxRatio: number): Promise<Image[]> {
    const images = (await this.list({})) as Image[];
    return images.filter((img) => {
      const ratio = img.aspectRatio;
      return ratio >= minRatio && ratio <= maxRatio;
    });
  }
}
