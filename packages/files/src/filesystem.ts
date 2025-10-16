import { mkdir } from 'node:fs/promises';
import { getTempDirectory } from '@have/utils';
import { getCached, setCached } from './index';

/**
 * Interface defining the required methods for a filesystem adapter
 */
export interface FilesystemAdapterInterface {
  /**
   * Checks if a file or directory exists
   *
   * @param path - Path to check
   * @returns Promise resolving to boolean indicating existence
   */
  exists(path: string): Promise<boolean>;

  /**
   * Reads a file's contents
   *
   * @param path - Path to the file
   * @returns Promise resolving to the file contents as a string
   */
  read(path: string): Promise<string>;

  /**
   * Writes content to a file
   *
   * @param path - Path to the file
   * @param content - Content to write
   * @returns Promise that resolves when the write is complete
   */
  write(path: string, content: string): Promise<void>;

  /**
   * Deletes a file or directory
   *
   * @param path - Path to delete
   * @returns Promise that resolves when the deletion is complete
   */
  delete(path: string): Promise<void>;

  /**
   * Lists files in a directory
   *
   * @param path - Directory path to list
   * @returns Promise resolving to an array of file names
   */
  list(path: string): Promise<string[]>;

  /**
   * Gets the MIME type for a file
   *
   * @param path - Path to the file
   * @returns Promise resolving to the MIME type string
   */
  mimeType(path: string): Promise<string>;
}

/**
 * Configuration options for filesystem adapters
 */
export interface FilesystemAdapterOptions {
  /**
   * Type of filesystem adapter
   */
  type?: string;

  /**
   * Directory to use for caching
   */
  cacheDir?: string;
}

/**
 * Base class for filesystem adapters providing common functionality
 */
export class FilesystemAdapter {
  /**
   * Configuration options
   */
  protected options: FilesystemAdapterOptions;

  /**
   * Cache directory path
   */
  protected cacheDir: string;

  /**
   * Creates a new FilesystemAdapter instance
   *
   * @param options - Configuration options
   */
  constructor(options: FilesystemAdapterOptions) {
    this.options = options;
    this.cacheDir = options.cacheDir || getTempDirectory('cache');
  }

  /**
   * Factory method to create and initialize a FilesystemAdapter
   *
   * @param options - Configuration options
   * @returns Promise resolving to an initialized FilesystemAdapter
   */
  static async create<T extends FilesystemAdapterOptions>(
    options: T,
  ): Promise<FilesystemAdapter> {
    const fs = new FilesystemAdapter(options);
    await fs.initialize();
    return fs;
  }

  /**
   * Initializes the adapter by creating the cache directory
   */
  protected async initialize() {
    await mkdir(this.cacheDir, { recursive: true });
  }

  /**
   * Downloads a file from a URL
   *
   * @param url - URL to download from
   * @param options - Download options
   * @param options.force - Whether to force download even if cached
   * @returns Promise resolving to the path of the downloaded file
   */
  async download(
    _url: string,
    _options: {
      force: boolean;
    } = {
      force: false,
    },
  ): Promise<string> {
    return '';
  }

  /**
   * Checks if a file or directory exists
   *
   * @param path - Path to check
   * @returns Promise resolving to boolean indicating existence
   */
  async exists(_path: string): Promise<boolean> {
    // Dummy implementation
    return false;
  }

  /**
   * Reads a file's contents
   *
   * @param path - Path to the file
   * @returns Promise resolving to the file contents as a string
   */
  async read(_path: string): Promise<string> {
    // Dummy implementation
    return '';
  }

  /**
   * Writes content to a file
   *
   * @param path - Path to the file
   * @param content - Content to write
   * @returns Promise that resolves when the write is complete
   */
  async write(_path: string, _content: string): Promise<void> {
    // Dummy implementation
  }

  /**
   * Deletes a file or directory
   *
   * @param path - Path to delete
   * @returns Promise that resolves when the deletion is complete
   */
  async delete(_path: string): Promise<void> {
    // Dummy implementation
  }

  /**
   * Lists files in a directory
   *
   * @param path - Directory path to list
   * @returns Promise resolving to an array of file names
   */
  async list(_path: string): Promise<string[]> {
    // Dummy implementation
    return [];
  }

  /**
   * Gets data from cache if available and not expired
   *
   * @param file - Cache file identifier
   * @param expiry - Cache expiry time in milliseconds
   * @returns Promise resolving to the cached data or undefined if not found/expired
   */
  async getCached(file: string, expiry = 300000) {
    return getCached(file, expiry);
  }

  /**
   * Sets data in cache
   *
   * @param file - Cache file identifier
   * @param data - Data to cache
   * @returns Promise that resolves when the data is cached
   */
  async setCached(file: string, data: string) {
    return setCached(file, data);
  }
}
