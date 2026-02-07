/**
 * AssetStore - File I/O + Asset record management
 *
 * Writes buffers to disk via @happyvertical/files and creates
 * corresponding Asset records in the database via AssetCollection.
 */

import { type FilesystemInterface, getFilesystem } from '@happyvertical/files';
import type { Asset } from './asset';
import type { AssetCollection } from './assets';

/**
 * MIME type to file extension mapping
 */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'text/plain': 'txt',
};

/**
 * Options for storing an asset
 */
export interface StoreOptions {
  /** MIME type of the data */
  mimeType: string;

  /** Asset type slug (e.g., 'video', 'audio', 'image', 'reference-image') */
  typeSlug?: string;

  /** Parent asset ID (for derivatives like thumbnails) */
  parentId?: string;

  /** Asset status slug */
  statusSlug?: string;

  /** Description */
  description?: string;
}

/**
 * AssetStore manages file storage and Asset record creation.
 *
 * Files are stored on disk using @happyvertical/files with the convention:
 * `{basePath}/{typeSlug}/{assetId}.{ext}`
 *
 * @example
 * ```typescript
 * import { AssetStore } from '@happyvertical/smrt-assets';
 *
 * const store = new AssetStore('dev/data/assets', assetCollection);
 * await store.initialize();
 *
 * // Store a video buffer
 * const asset = await store.store('my-video', videoBuffer, {
 *   mimeType: 'video/mp4',
 *   typeSlug: 'video',
 * });
 *
 * // Read it back
 * const data = await store.read(asset);
 *
 * // Delete it
 * await store.remove(asset);
 * ```
 */
export class AssetStore {
  private fs: FilesystemInterface | null = null;

  constructor(
    private readonly basePath: string,
    private readonly collection: AssetCollection,
  ) {}

  /**
   * Initialize the filesystem adapter.
   * Must be called before any file operations.
   */
  async initialize(): Promise<this> {
    this.fs = await getFilesystem({
      type: 'local',
      basePath: this.basePath,
    });
    return this;
  }

  /**
   * Get the initialized filesystem (throws if not initialized)
   */
  private getFs(): FilesystemInterface {
    if (!this.fs) {
      throw new Error('AssetStore not initialized. Call initialize() first.');
    }
    return this.fs;
  }

  /**
   * Write buffer to disk and create an Asset record.
   *
   * @param name - Human-readable name for the asset
   * @param data - File data as a Buffer
   * @param opts - Storage options (mimeType required)
   * @returns Created Asset instance
   */
  async store(name: string, data: Buffer, opts: StoreOptions): Promise<Asset> {
    const fs = this.getFs();
    const ext = MIME_TO_EXT[opts.mimeType] ?? 'bin';
    const typeSlug = opts.typeSlug ?? 'file';

    // Create the Asset record first to get an ID
    const asset = (await this.collection.create({
      name,
      mimeType: opts.mimeType,
      typeSlug,
      statusSlug: opts.statusSlug ?? 'active',
      parentId: opts.parentId ?? null,
      description: opts.description ?? '',
      sourceUri: '', // Will be updated after file write
    })) as Asset;

    // Build file path: {typeSlug}/{assetId}.{ext}
    const filePath = `${typeSlug}/${asset.id}.${ext}`;
    const sourceUri = `file://${this.basePath}/${filePath}`;

    // Write file to disk
    await fs.write(filePath, data, { createParents: true });

    // Update the Asset with the file URI
    asset.sourceUri = sourceUri;
    await asset.save();

    return asset;
  }

  /**
   * Read file data from an Asset's sourceUri.
   *
   * @param asset - Asset to read data for
   * @returns File data as a Buffer
   */
  async read(asset: Asset): Promise<Buffer> {
    const fs = this.getFs();
    const filePath = AssetStore.pathFromUri(asset.sourceUri);
    const relativePath = filePath.startsWith(this.basePath)
      ? filePath.slice(this.basePath.length + 1)
      : filePath;
    return (await fs.read(relativePath, { raw: true })) as Buffer;
  }

  /**
   * Read file by asset ID.
   *
   * @param id - Asset ID to look up
   * @returns Object with data Buffer and Asset, or null if not found
   */
  async readById(id: string): Promise<{ data: Buffer; asset: Asset } | null> {
    const asset = (await this.collection.get({ id })) as Asset | null;
    if (!asset) return null;

    try {
      const data = await this.read(asset);
      return { data, asset };
    } catch {
      return null;
    }
  }

  /**
   * Delete file from disk and remove the Asset record.
   *
   * @param asset - Asset to remove
   */
  async remove(asset: Asset): Promise<void> {
    const fs = this.getFs();

    // Delete the file if it exists
    if (asset.sourceUri) {
      const filePath = AssetStore.pathFromUri(asset.sourceUri);
      const relativePath = filePath.startsWith(this.basePath)
        ? filePath.slice(this.basePath.length + 1)
        : filePath;
      try {
        await fs.delete(relativePath);
      } catch {
        // File may not exist on disk — still delete the record
      }
    }

    // Delete the asset record
    await asset.delete();
  }

  /**
   * Extract filesystem path from a file:// sourceUri.
   *
   * @param sourceUri - Asset sourceUri (e.g., 'file:///path/to/file.mp4')
   * @returns Filesystem path
   */
  static pathFromUri(sourceUri: string): string {
    if (sourceUri.startsWith('file://')) {
      return sourceUri.slice(7);
    }
    return sourceUri;
  }
}
