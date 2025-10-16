import {
  type BaseProviderOptions,
  type CacheOptions,
  type CreateDirOptions,
  type DownloadOptions,
  type FileInfo,
  type FileStats,
  type FilesystemCapabilities,
  FilesystemError,
  type FilesystemInterface,
  type ListFilesOptions,
  type ListOptions,
  type ReadOptions,
  type UploadOptions,
  type WriteOptions,
} from './types';

/**
 * Base class for all filesystem providers
 */
export abstract class BaseFilesystemProvider implements FilesystemInterface {
  protected basePath: string;
  protected cacheDir: string;
  protected createMissing: boolean;
  protected providerType: string;

  constructor(options: BaseProviderOptions = {}) {
    this.basePath = options.basePath || '';
    // Use a universal cache directory approach - will be context-specific
    this.cacheDir = options.cacheDir || this.getDefaultCacheDir();
    this.createMissing = options.createMissing ?? true;
    this.providerType = this.constructor.name
      .toLowerCase()
      .replace('filesystemprovider', '');
  }

  /**
   * Get default cache directory for the current context
   */
  private getDefaultCacheDir(): string {
    // Use context-aware temp directory from utils
    try {
      const { getTempDirectory } = require('@have/utils');
      return getTempDirectory('files-cache');
    } catch {
      // Fallback if utils not available
      if (process?.versions?.node) {
        try {
          const { tmpdir } = require('node:os');
          const { join } = require('node:path');
          return join(tmpdir(), 'have-sdk', 'files-cache');
        } catch {
          return './tmp/have-sdk/files-cache';
        }
      }
      return './tmp/have-sdk/files-cache';
    }
  }

  /**
   * Throw error for unsupported operations
   */
  protected throwUnsupported(operation: string): never {
    throw new FilesystemError(
      `Operation '${operation}' not supported by ${this.providerType} provider`,
      'ENOTSUP',
      undefined,
      this.providerType,
    );
  }

  /**
   * Normalize path by removing leading/trailing slashes and resolving relative paths
   */
  protected normalizePath(path: string): string {
    if (!path) return '';

    // Remove leading slash for consistency
    let normalized = path.startsWith('/') ? path.slice(1) : path;

    // Combine with base path if configured
    if (this.basePath) {
      normalized = this.joinPaths(this.basePath, normalized);
    }

    return normalized;
  }

  /**
   * Universal path joining function that works in both Node.js and browser
   */
  private joinPaths(...paths: string[]): string {
    return paths
      .filter((p) => p && p.length > 0)
      .map((p) => p.replace(/^\/+|\/+$/g, ''))
      .join('/');
  }

  /**
   * Validate that a path is safe (no directory traversal)
   */
  protected validatePath(path: string): void {
    if (!path) {
      throw new FilesystemError('Path cannot be empty', 'EINVAL', path);
    }

    // Check for directory traversal attempts
    if (path.includes('..') || path.includes('~')) {
      throw new FilesystemError(
        'Path contains invalid characters (directory traversal)',
        'EINVAL',
        path,
      );
    }
  }

  /**
   * Get cache key for a given path
   */
  protected getCacheKey(path: string): string {
    return `${this.constructor.name}-${path}`;
  }

  /**
   * Abstract methods that must be implemented by providers
   */
  abstract exists(path: string): Promise<boolean>;
  abstract read(path: string, options?: ReadOptions): Promise<string | Buffer>;
  abstract write(
    path: string,
    content: string | Buffer,
    options?: WriteOptions,
  ): Promise<void>;
  abstract delete(path: string): Promise<void>;
  abstract copy(sourcePath: string, destPath: string): Promise<void>;
  abstract move(sourcePath: string, destPath: string): Promise<void>;
  abstract createDirectory(
    path: string,
    options?: CreateDirOptions,
  ): Promise<void>;
  abstract list(path: string, options?: ListOptions): Promise<FileInfo[]>;
  abstract getStats(path: string): Promise<FileStats>;
  abstract getMimeType(path: string): Promise<string>;
  abstract getCapabilities(): Promise<FilesystemCapabilities>;

  /**
   * Provider methods with default implementations (may be overridden)
   */
  async upload(
    _localPath: string,
    _remotePath: string,
    _options: UploadOptions = {},
  ): Promise<void> {
    this.throwUnsupported('upload');
  }

  async download(
    _remotePath: string,
    _localPath?: string,
    _options: DownloadOptions = {},
  ): Promise<string> {
    this.throwUnsupported('download');
  }

  async downloadWithCache(
    remotePath: string,
    options: CacheOptions = {},
  ): Promise<string> {
    const cacheKey = this.getCacheKey(remotePath);

    // Check cache first
    if (!options.force) {
      const cached = await this.cache.get(cacheKey, options.expiry);
      if (cached) {
        return cached;
      }
    }

    // Download and cache
    const localPath = await this.download(remotePath, undefined, options);
    await this.cache.set(cacheKey, localPath);

    return localPath;
  }

  /**
   * Cache implementation - providers can override for their specific storage
   */
  cache = {
    get: async (
      _key: string,
      _expiry?: number,
    ): Promise<string | undefined> => {
      // Default implementation - providers should override this
      this.throwUnsupported('cache.get');
    },

    set: async (_key: string, _data: string): Promise<void> => {
      // Default implementation - providers should override this
      this.throwUnsupported('cache.set');
    },

    clear: async (_key?: string): Promise<void> => {
      // Default implementation - providers should override this
      this.throwUnsupported('cache.clear');
    },
  };

  // Legacy method implementations - providers can override or use default ENOTSUP errors

  /**
   * Check if a path is a file (legacy)
   */
  async isFile(file: string): Promise<false | FileStats> {
    try {
      const stats = await this.getStats(file);
      return stats.isFile ? stats : false;
    } catch {
      return false;
    }
  }

  /**
   * Check if a path is a directory (legacy)
   */
  async isDirectory(dir: string): Promise<boolean> {
    try {
      const stats = await this.getStats(dir);
      return stats.isDirectory;
    } catch {
      return false;
    }
  }

  /**
   * Create a directory if it doesn't exist (legacy)
   */
  async ensureDirectoryExists(dir: string): Promise<void> {
    if (!(await this.isDirectory(dir))) {
      await this.createDirectory(dir, { recursive: true });
    }
  }

  /**
   * Upload data to a URL using PUT method (legacy)
   */
  async uploadToUrl(_url: string, _data: string | Buffer): Promise<Response> {
    this.throwUnsupported('uploadToUrl');
  }

  /**
   * Download a file from a URL and save it to a local file (legacy)
   */
  async downloadFromUrl(_url: string, _filepath: string): Promise<void> {
    this.throwUnsupported('downloadFromUrl');
  }

  /**
   * Download a file with caching support (legacy)
   */
  async downloadFileWithCache(
    _url: string,
    _targetPath?: string | null,
  ): Promise<string> {
    this.throwUnsupported('downloadFileWithCache');
  }

  /**
   * List files in a directory with optional filtering (legacy)
   */
  async listFiles(
    dirPath: string,
    options: ListFilesOptions = { match: /.*/ },
  ): Promise<string[]> {
    const files = await this.list(dirPath);
    const fileNames = files
      .filter((file) => !file.isDirectory)
      .map((file) => file.name);

    return options.match
      ? fileNames.filter((name) => options.match?.test(name))
      : fileNames;
  }

  /**
   * Get data from cache if available and not expired (legacy)
   */
  async getCached(file: string, expiry = 300000): Promise<string | undefined> {
    return await this.cache.get(file, expiry);
  }

  /**
   * Set data in cache (legacy)
   */
  async setCached(file: string, data: string): Promise<void> {
    await this.cache.set(file, data);
  }
}
