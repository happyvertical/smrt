/**
 * AssetStore - File I/O + Asset record management
 *
 * Writes buffers to disk via @happyvertical/files and creates
 * corresponding Asset records in the database via AssetCollection.
 *
 * Supports provider-agnostic storage (local, S3, etc.) via @happyvertical/files.
 */

import {
  FileNotFoundError,
  type FilesystemInterface,
  type GetFilesystemOptions,
  getFilesystem,
} from '@happyvertical/files';
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
 * Provider options for configuring the filesystem backend.
 * Accepts any @happyvertical/files options or a simple basePath string for local storage.
 */
export type ProviderOptions = GetFilesystemOptions | string;

/**
 * Asset storage operation currently being resolved.
 */
export type AssetStorageOperation = 'read' | 'write' | 'delete';

/**
 * Context passed to an AssetStore resolver.
 *
 * Downstream apps can use this hook to route a logical Asset to whichever
 * storage backend is appropriate for the current operation.
 */
export interface AssetStorageResolveRequest {
  operation: AssetStorageOperation;
  asset: Asset;
  path: string;
  sourceUri: string;
  mimeType?: string;
  typeSlug?: string;
  defaultProviderOptions: GetFilesystemOptions;
  defaultFilesystem: FilesystemInterface;
}

/**
 * Resolved storage target for an AssetStore operation.
 */
export interface AssetStorageResolution {
  filesystem?: FilesystemInterface;
  providerOptions?: ProviderOptions;
  path?: string;
  sourceUri?: string;
}

export type AssetStorageResolver = (
  request: AssetStorageResolveRequest,
) =>
  | AssetStorageResolution
  | null
  | undefined
  | Promise<AssetStorageResolution | null | undefined>;

export interface AssetStoreOptions {
  resolver?: AssetStorageResolver;
}

interface ResolvedAssetStorageTarget {
  filesystem: FilesystemInterface;
  providerOptions: GetFilesystemOptions;
  path: string;
  sourceUri: string;
}

function normalizeProviderOptions(
  providerOrBasePath: ProviderOptions,
): GetFilesystemOptions {
  if (typeof providerOrBasePath === 'string') {
    return { type: 'local', basePath: providerOrBasePath };
  }
  return providerOrBasePath;
}

/**
 * AssetStore manages file storage and Asset record creation.
 *
 * Files are stored using @happyvertical/files with the convention:
 * `{typeSlug}/{assetId}.{ext}`
 *
 * @example
 * ```typescript
 * import { AssetStore } from '@happyvertical/smrt-assets';
 *
 * // Local storage (backward-compatible)
 * const store = new AssetStore('dev/data/assets', assetCollection);
 * await store.initialize();
 *
 * // Provider-agnostic storage
 * const s3Store = new AssetStore({ type: 's3', bucket: 'my-bucket' }, assetCollection);
 * await s3Store.initialize();
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
  private readonly fsOptions: GetFilesystemOptions;
  private readonly fsCache = new Map<string, FilesystemInterface>();
  private readonly resolver?: AssetStorageResolver;

  constructor(
    providerOrBasePath: ProviderOptions,
    private readonly collection: AssetCollection,
    options: AssetStoreOptions = {},
  ) {
    this.fsOptions = normalizeProviderOptions(providerOrBasePath);
    this.resolver = options.resolver;
  }

  /** The base path for local storage, or empty string for non-local providers */
  get basePath(): string {
    return this.fsOptions.basePath ?? '';
  }

  /**
   * Initialize the filesystem adapter.
   * Must be called before any file operations.
   */
  async initialize(): Promise<this> {
    this.fs = await getFilesystem(this.fsOptions);
    this.fsCache.set(this.providerCacheKey(this.fsOptions), this.fs);
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

  private providerCacheKey(providerOptions: GetFilesystemOptions): string {
    return JSON.stringify(providerOptions);
  }

  private async getFilesystemForOptions(
    providerOptions: GetFilesystemOptions,
  ): Promise<FilesystemInterface> {
    const key = this.providerCacheKey(providerOptions);
    const cached = this.fsCache.get(key);
    if (cached) return cached;

    const filesystem = await getFilesystem(providerOptions);
    this.fsCache.set(key, filesystem);
    return filesystem;
  }

  /**
   * Build a sourceUri for the given file path based on the provider type.
   */
  private buildSourceUri(filePath: string): string {
    return AssetStore.buildSourceUriForProvider(filePath, this.fsOptions);
  }

  private static buildSourceUriForProvider(
    filePath: string,
    providerOptions: GetFilesystemOptions,
  ): string {
    const type = providerOptions.type;
    if (type === 's3') {
      const bucket = providerOptions.bucket ?? '';
      return `s3://${bucket}/${filePath}`;
    }
    // Default to file:// for local and other types
    const base = providerOptions.basePath ?? '';
    return base ? `file://${base}/${filePath}` : `file://${filePath}`;
  }

  private static providerRelativePath(
    filePath: string,
    providerOptions: GetFilesystemOptions,
  ): string {
    const base = providerOptions.basePath ?? '';
    return base && filePath.startsWith(base)
      ? filePath.slice(base.length + 1)
      : filePath;
  }

  private static requireAssetId(asset: Asset): string {
    if (!asset.id) {
      throw new Error('Asset must be saved before storing file data.');
    }
    return asset.id;
  }

  private async resolveStorage(
    request: Omit<
      AssetStorageResolveRequest,
      'defaultProviderOptions' | 'defaultFilesystem'
    >,
  ): Promise<ResolvedAssetStorageTarget> {
    const defaultFilesystem = this.getFs();
    const resolution = this.resolver
      ? await this.resolver({
          ...request,
          defaultProviderOptions: this.fsOptions,
          defaultFilesystem,
        })
      : undefined;
    if (
      request.operation === 'write' &&
      resolution?.filesystem &&
      !resolution.providerOptions &&
      !resolution.sourceUri
    ) {
      throw new Error(
        'Asset storage resolver must return providerOptions or sourceUri when overriding filesystem for write operations.',
      );
    }
    const providerOptions = resolution?.providerOptions
      ? normalizeProviderOptions(resolution.providerOptions)
      : this.fsOptions;
    const path = AssetStore.providerRelativePath(
      resolution?.path ?? request.path,
      providerOptions,
    );
    const sourceUri =
      resolution?.sourceUri ??
      (resolution?.path || resolution?.providerOptions
        ? AssetStore.buildSourceUriForProvider(path, providerOptions)
        : request.sourceUri);
    const filesystem =
      resolution?.filesystem ??
      (providerOptions === this.fsOptions
        ? defaultFilesystem
        : await this.getFilesystemForOptions(providerOptions));

    return {
      filesystem,
      providerOptions,
      path,
      sourceUri,
    };
  }

  private async writeAssetData(
    asset: Asset,
    data: Buffer,
    opts: { mimeType: string; typeSlug?: string },
  ): Promise<string> {
    const ext = MIME_TO_EXT[opts.mimeType] ?? 'bin';
    const typeSlug = opts.typeSlug ?? 'file';
    const assetId = AssetStore.requireAssetId(asset);
    const filePath = `${typeSlug}/${assetId}.${ext}`;
    const sourceUri = this.buildSourceUri(filePath);
    const target = await this.resolveStorage({
      operation: 'write',
      asset,
      path: filePath,
      sourceUri,
      mimeType: opts.mimeType,
      typeSlug,
    });

    await target.filesystem.write(target.path, data, { createParents: true });
    return target.sourceUri;
  }

  /**
   * Write file data for an existing Asset record (no DB record created).
   *
   * Use this when you've already created the record (e.g., via a
   * collection.create()) and only need to persist the file data.
   *
   * @param asset - The existing asset to write data for
   * @param data - File data as a Buffer
   * @param opts - Storage options (mimeType required)
   * @returns The sourceUri for the written file
   */
  async storeFile(
    asset: Asset,
    data: Buffer,
    opts: { mimeType: string; typeSlug?: string },
  ): Promise<string> {
    return this.writeAssetData(asset, data, opts);
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

    try {
      // Write file to storage
      asset.sourceUri = await this.writeAssetData(asset, data, {
        mimeType: opts.mimeType,
        typeSlug,
      });
    } catch (err) {
      // Clean up orphaned Asset record on file write failure
      await asset.delete();
      throw err;
    }

    // Update the Asset with the file URI
    await asset.save();

    return asset;
  }

  /**
   * Store a new version of an existing asset.
   *
   * @param asset - The existing asset to version
   * @param data - File data for the new version
   * @param opts - Optional overrides for store options
   * @returns The newly created version Asset
   */
  async storeVersion(
    asset: Asset,
    data: Buffer,
    opts: Partial<StoreOptions> = {},
  ): Promise<Asset> {
    const primaryVersionId =
      asset.primaryVersionId ?? AssetStore.requireAssetId(asset);
    const newVersion = await this.collection.createNewVersion(
      primaryVersionId,
      '', // sourceUri will be set by store
      { ...opts },
    );

    const mimeType = opts.mimeType ?? asset.mimeType;
    const typeSlug = opts.typeSlug ?? asset.typeSlug ?? 'file';

    try {
      newVersion.sourceUri = await this.writeAssetData(newVersion, data, {
        mimeType,
        typeSlug,
      });
    } catch (err) {
      await newVersion.delete();
      throw err;
    }

    if (opts.mimeType) newVersion.mimeType = opts.mimeType;
    await newVersion.save();

    return newVersion;
  }

  /**
   * Read file data for a specific version of an asset.
   *
   * @param asset - The asset (any version in the chain)
   * @param version - The version number to read
   * @returns File data as a Buffer
   */
  async readVersion(asset: Asset, version: number): Promise<Buffer> {
    const primaryVersionId =
      asset.primaryVersionId ?? AssetStore.requireAssetId(asset);
    const versions = await this.collection.listVersions(primaryVersionId);
    const targetVersion = versions.find((v) => v.version === version);

    if (!targetVersion) {
      throw new Error(
        `Version ${version} not found for asset ${primaryVersionId}`,
      );
    }

    return this.read(targetVersion);
  }

  /**
   * Read file data from an Asset's sourceUri.
   *
   * @param asset - Asset to read data for
   * @returns File data as a Buffer
   */
  async read(asset: Asset): Promise<Buffer> {
    const filePath = AssetStore.pathFromUri(asset.sourceUri);
    const target = await this.resolveStorage({
      operation: 'read',
      asset,
      path: AssetStore.providerRelativePath(filePath, this.fsOptions),
      sourceUri: asset.sourceUri,
    });
    return (await target.filesystem.read(target.path, { raw: true })) as Buffer;
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
    // Delete the file if it exists
    if (asset.sourceUri) {
      const filePath = AssetStore.pathFromUri(asset.sourceUri);
      const target = await this.resolveStorage({
        operation: 'delete',
        asset,
        path: AssetStore.providerRelativePath(filePath, this.fsOptions),
        sourceUri: asset.sourceUri,
      });
      try {
        await target.filesystem.delete(target.path);
      } catch (err) {
        if (!(err instanceof FileNotFoundError)) {
          throw err;
        }
        // File may not exist on disk — still delete the record
      }
    }

    // Delete the asset record
    await asset.delete();
  }

  /**
   * Extract filesystem path from a sourceUri.
   * Handles file://, s3://, and plain paths.
   *
   * @param sourceUri - Asset sourceUri (e.g., 'file:///path/to/file.mp4', 's3://bucket/key')
   * @returns Filesystem path
   */
  static pathFromUri(sourceUri: string): string {
    if (sourceUri.startsWith('file://')) {
      return sourceUri.slice(7);
    }
    if (sourceUri.startsWith('s3://')) {
      // Return everything after s3://bucket/
      const withoutScheme = sourceUri.slice(5);
      const slashIdx = withoutScheme.indexOf('/');
      return slashIdx >= 0 ? withoutScheme.slice(slashIdx + 1) : withoutScheme;
    }
    return sourceUri;
  }
}
