/**
 * Image model - Asset subclass for image files
 *
 * Represents an image asset with dimensions, accessibility text, and AI embeddings.
 * Uses STI (Single Table Inheritance) - stored in the assets table with _meta_type='Image'.
 */

import { type Meta, smrt } from '@happyvertical/smrt-core';
import { Asset } from './asset';
import type { ImageOptions } from './types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'generateAltText'] },
  cli: true,
})
export class Image extends Asset {
  // Core image dimensions (regular columns for querying)
  width: number = 0;
  height: number = 0;

  // Accessibility text
  alt: string = '';

  // AI embeddings stored in _meta_data JSONB (child-specific fields)
  embedding: Meta<number[]> = [];
  descriptionEmbedding: Meta<number[]> = [];

  constructor(options: ImageOptions = {}) {
    super(options);
    if (options.width !== undefined) this.width = options.width;
    if (options.height !== undefined) this.height = options.height;
    if (options.alt !== undefined) this.alt = options.alt;
    if (options.embedding) this.embedding = options.embedding;
    if (options.descriptionEmbedding)
      this.descriptionEmbedding = options.descriptionEmbedding;
  }

  /**
   * Calculate aspect ratio from dimensions
   */
  get aspectRatio(): number {
    if (this.height === 0) return 0;
    return this.width / this.height;
  }

  /**
   * Check if dimensions indicate landscape orientation
   */
  get isLandscape(): boolean {
    return this.width > this.height;
  }

  /**
   * Check if dimensions indicate portrait orientation
   */
  get isPortrait(): boolean {
    return this.height > this.width;
  }

  /**
   * Check if dimensions indicate square aspect ratio
   */
  get isSquare(): boolean {
    return this.width === this.height && this.width > 0;
  }

  /**
   * Validate that the asset is an image based on MIME type
   */
  isValidImageFormat(): boolean {
    return this.mimeType.startsWith('image/');
  }

  /**
   * Check if this image is high resolution (4K+)
   */
  isHighResolution(): boolean {
    return this.width >= 3840 || this.height >= 2160;
  }

  /**
   * Generate accessibility text using AI
   *
   * @returns AI-generated alt text describing the image
   */
  async generateAltText(): Promise<string> {
    const altText = await this.do(`
      Generate concise accessibility alt text for this image.
      Consider: subject matter, key visual elements, context.
      Keep it under 125 characters for screen reader compatibility.
      Image name: ${this.name}
      Image description: ${this.description}
    `);

    this.alt = altText;
    return altText;
  }
}
