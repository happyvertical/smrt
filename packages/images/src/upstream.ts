/**
 * UpstreamManager - Manages importing images from upstream sources
 *
 * Searches across configured upstream source adapters and imports
 * assets into the local store with provenance tracking.
 */

import type { AssetStore } from '@happyvertical/smrt-assets';
import type { Image } from './image';
import type { ImageCollection } from './images';

/**
 * Minimal adapter interface for upstream asset sources.
 * Full implementation lives in @happyvertical/assets (SDK package).
 */
export interface AssetSourceAdapter {
  readonly name: string;
  readonly capabilities: {
    search: boolean;
    download: boolean;
    browse: boolean;
  };
  search(
    query: string,
    options?: { limit?: number; offset?: number },
  ): Promise<SourceAsset[]>;
  get(externalId: string): Promise<SourceAsset | null>;
  download(
    externalId: string,
  ): Promise<{ data: Buffer; metadata: SourceAssetMetadata }>;
}

export interface SourceAsset {
  externalId: string;
  sourceName: string;
  name: string;
  mimeType: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  metadata: SourceAssetMetadata;
}

export interface SourceAssetMetadata {
  width?: number;
  height?: number;
  description?: string;
  tags?: string[];
  license?: string;
  attribution?: string;
}

export class UpstreamManager {
  constructor(
    private readonly sources: AssetSourceAdapter[],
    private readonly store: AssetStore,
    private readonly collection: ImageCollection,
  ) {}

  /**
   * Search across all configured upstream sources
   *
   * @param query - Search query
   * @param options - Search options
   * @returns Merged and ranked results from all sources
   */
  async search(
    query: string,
    options: { limit?: number } = {},
  ): Promise<SourceAsset[]> {
    const limit = options.limit ?? 20;
    const allResults: SourceAsset[] = [];

    const searches = this.sources
      .filter((s) => s.capabilities.search)
      .map((source) =>
        source.search(query, { limit }).catch(() => [] as SourceAsset[]),
      );

    const results = await Promise.all(searches);
    for (const sourceResults of results) {
      allResults.push(...sourceResults);
    }

    return allResults.slice(0, limit);
  }

  /**
   * Import an asset from an upstream source into the local store
   *
   * @param sourceAsset - The upstream asset to import
   * @returns Locally stored Image with provenance
   */
  async import(sourceAsset: SourceAsset): Promise<Image> {
    // Find the source adapter
    const adapter = this.sources.find((s) => s.name === sourceAsset.sourceName);
    if (!adapter) {
      throw new Error(`No adapter found for source: ${sourceAsset.sourceName}`);
    }

    // Download from upstream
    const { data, metadata } = await adapter.download(sourceAsset.externalId);

    // Store locally
    const stored = await this.store.store(sourceAsset.name, data, {
      mimeType: sourceAsset.mimeType,
      typeSlug: 'image',
    });

    // Create the Image with provenance
    const image = (await this.collection.create({
      name: sourceAsset.name,
      sourceUri: stored.sourceUri,
      mimeType: sourceAsset.mimeType,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      alt: metadata.description ?? '',
      description: metadata.attribution
        ? `${metadata.description ?? ''} (${metadata.attribution})`
        : (metadata.description ?? ''),
      sourceType: sourceAsset.sourceName,
      externalId: sourceAsset.externalId,
      typeSlug: 'image',
    })) as Image;

    return image;
  }
}
