/**
 * ImageCollection - Collection manager for Image instances
 *
 * Provides image-specific query operations, tenant-aware queries, and bulk operations
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Image } from './image';

export class ImageCollection extends SmrtCollection<Image> {
  static readonly _itemClass = Image;

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenant-Aware Query Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find all images belonging to a specific tenant
   *
   * @param tenantId - The tenant ID to filter by
   * @returns Array of images belonging to this tenant
   */
  async findByTenant(tenantId: string): Promise<Image[]> {
    return (await this.list({ where: { tenantId } })) as Image[];
  }

  /**
   * Find all global images (images without a tenant)
   *
   * @returns Array of global images
   */
  async findGlobal(): Promise<Image[]> {
    return (await this.list({ where: { tenantId: null } })) as Image[];
  }

  /**
   * Find images belonging to a tenant plus all global images
   *
   * @param tenantId - The tenant ID to include
   * @returns Array of tenant-specific and global images
   */
  async findWithGlobals(tenantId: string): Promise<Image[]> {
    return (await this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    )) as Image[];
  }

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
    return (await this.query(
      `SELECT * FROM ${this.tableName} WHERE width > height`,
    )) as Image[];
  }

  /**
   * Get portrait images (height > width)
   *
   * @returns Array of portrait-oriented images
   */
  async getPortrait(): Promise<Image[]> {
    return (await this.query(
      `SELECT * FROM ${this.tableName} WHERE height > width`,
    )) as Image[];
  }

  /**
   * Get square images (width === height)
   *
   * @returns Array of square images
   */
  async getSquare(): Promise<Image[]> {
    return (await this.query(
      `SELECT * FROM ${this.tableName} WHERE width = height AND width > 0`,
    )) as Image[];
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
    return (await this.query(
      `SELECT * FROM ${this.tableName} WHERE width >= 3840 OR height >= 2160`,
    )) as Image[];
  }

  /**
   * Get images by aspect ratio range
   *
   * @param minRatio - Minimum aspect ratio (width/height)
   * @param maxRatio - Maximum aspect ratio (width/height)
   * @returns Array of images within the aspect ratio range
   */
  async getByAspectRatio(minRatio: number, maxRatio: number): Promise<Image[]> {
    // Use computed ratio in SQL: (CAST(width AS REAL) / NULLIF(height, 0))
    return (await this.query(
      `SELECT * FROM ${this.tableName}
       WHERE height > 0
         AND (CAST(width AS REAL) / height) >= ?
         AND (CAST(width AS REAL) / height) <= ?`,
      [minRatio, maxRatio],
    )) as Image[];
  }
}
