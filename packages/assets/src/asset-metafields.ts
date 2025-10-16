/**
 * AssetMetafieldCollection - Collection manager for AssetMetafield instances
 *
 * Manages asset metafield definitions with validation rules
 */

import { SmrtCollection } from '@smrt/core';
import { AssetMetafield } from './asset-metafield';

export class AssetMetafieldCollection extends SmrtCollection<AssetMetafield> {
  static readonly _itemClass = AssetMetafield;

  /**
   * Get or create an asset metafield by slug
   *
   * @param slug - The metafield slug
   * @param name - The display name (defaults to slug)
   * @param validation - Optional validation rules (JSON string or object)
   * @returns The existing or newly created AssetMetafield
   */
  async getOrCreate(
    slug: string,
    name?: string,
    validation?: string | Record<string, unknown>,
  ): Promise<AssetMetafield> {
    const existing = await this.list({ where: { slug }, limit: 1 });
    if (existing.length > 0) {
      return existing[0];
    }

    const validationString =
      typeof validation === 'string'
        ? validation
        : validation
          ? JSON.stringify(validation)
          : '';

    return await this.create({
      slug,
      name: name || slug,
      validation: validationString,
    });
  }

  /**
   * Initialize common asset metafields
   *
   * Creates standard metafields with validation rules:
   * - width (integer, min: 0)
   * - height (integer, min: 0)
   * - duration (number, min: 0)
   * - size (integer, min: 0)
   * - author (string)
   * - copyright (string)
   */
  async initializeCommonMetafields(): Promise<void> {
    await this.getOrCreate('width', 'Width', {
      type: 'integer',
      min: 0,
      description: 'Width in pixels',
    });
    await this.getOrCreate('height', 'Height', {
      type: 'integer',
      min: 0,
      description: 'Height in pixels',
    });
    await this.getOrCreate('duration', 'Duration', {
      type: 'number',
      min: 0,
      description: 'Duration in seconds',
    });
    await this.getOrCreate('size', 'File Size', {
      type: 'integer',
      min: 0,
      description: 'File size in bytes',
    });
    await this.getOrCreate('author', 'Author', {
      type: 'string',
      description: 'Content creator',
    });
    await this.getOrCreate('copyright', 'Copyright', {
      type: 'string',
      description: 'Copyright notice',
    });
  }
}
