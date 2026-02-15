/**
 * ImageSearch - AI-powered image search
 *
 * Provides text-based and semantic search across image collections
 * with optional AI-powered similarity matching.
 */

import type { AIClientOptions } from '@happyvertical/ai';
import type { Image } from './image';
import type { ImageCollection } from './images';
import type { ImageSearchOptions } from './types';

export class ImageSearch {
  constructor(
    private readonly collection: ImageCollection,
    readonly _options: { ai?: AIClientOptions } = {},
  ) {}

  /**
   * Search images by text query with optional dimension/orientation filters
   *
   * @param query - Text search query
   * @param searchOptions - Optional filters for dimensions, orientation, etc.
   * @returns Matching images
   */
  async search(
    query: string,
    searchOptions: ImageSearchOptions = {},
  ): Promise<Image[]> {
    // Build where clause from filters
    const where: Record<string, unknown> = {};

    if (searchOptions.minWidth) where['width >='] = searchOptions.minWidth;
    if (searchOptions.minHeight) where['height >='] = searchOptions.minHeight;

    // Text search on name, description, alt
    if (query) {
      where['name like'] = `%${query}%`;
    }

    let results = (await this.collection.list({
      where,
      limit: searchOptions.limit,
      offset: searchOptions.offset,
    })) as Image[];

    // Also search description and alt if query didn't match name
    if (query) {
      const descResults = (await this.collection.list({
        where: {
          ...where,
          'name like': undefined,
          'description like': `%${query}%`,
        },
        limit: searchOptions.limit,
      })) as Image[];

      const altResults = (await this.collection.list({
        where: { ...where, 'name like': undefined, 'alt like': `%${query}%` },
        limit: searchOptions.limit,
      })) as Image[];

      // Merge and deduplicate
      const seen = new Set(results.map((r) => r.id));
      for (const img of [...descResults, ...altResults]) {
        if (!seen.has(img.id)) {
          seen.add(img.id);
          results.push(img);
        }
      }
    }

    // Apply orientation filter in-memory
    if (searchOptions.orientation) {
      results = results.filter((img) => {
        switch (searchOptions.orientation) {
          case 'landscape':
            return img.isLandscape;
          case 'portrait':
            return img.isPortrait;
          case 'square':
            return img.isSquare;
          default:
            return true;
        }
      });
    }

    // Apply limit after merging
    if (searchOptions.limit && results.length > searchOptions.limit) {
      results = results.slice(0, searchOptions.limit);
    }

    return results;
  }

  /**
   * Find images similar to a given image
   *
   * @param image - The reference image
   * @param options - Search options
   * @returns Similar images
   */
  async findSimilar(
    image: Image,
    options: { limit?: number } = {},
  ): Promise<Image[]> {
    const limit = options.limit ?? 10;

    // Use basic heuristic: same aspect ratio range + similar dimensions
    const ratio = image.aspectRatio;
    const minRatio = ratio * 0.8;
    const maxRatio = ratio * 1.2;

    const candidates = await this.collection.getByAspectRatio(
      minRatio,
      maxRatio,
    );

    // Exclude the source image and limit results
    return candidates.filter((c) => c.id !== image.id).slice(0, limit);
  }

  /**
   * Find images matching a natural language prompt
   *
   * @param prompt - Natural language description of desired images
   * @param options - Search options
   * @returns Matching images
   */
  async findByPrompt(
    prompt: string,
    options: { limit?: number } = {},
  ): Promise<Image[]> {
    // Default to text search; AI enhancement can be added later
    return this.search(prompt, { limit: options.limit });
  }
}
