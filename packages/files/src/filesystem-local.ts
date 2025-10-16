import { FilesystemAdapter, type FilesystemAdapterOptions } from './filesystem';
import { getMimeType } from './index';

/**
 * Adapter for interacting with the local filesystem
 */
export class LocalFilesystemAdapter extends FilesystemAdapter {
  /**
   * Cache directory path
   */
  protected cacheDir: string;

  /**
   * Type identifier for this adapter
   */
  public type: string;

  /**
   * Configuration options
   */
  protected options: FilesystemAdapterOptions;

  /**
   * Creates a new LocalFilesystemAdapter instance
   *
   * @param options - Configuration options
   */
  constructor(options: FilesystemAdapterOptions) {
    super(options);
    this.options = options;
    this.type = options.type || 'local';
    this.cacheDir = options.cacheDir || '.cache';
  }

  /**
   * Creates a LocalFilesystemAdapter from a URL
   *
   * @param url - URL to create adapter from
   * @returns Promise resolving to a LocalFilesystemAdapter
   */
  static async createFromUrl(_url: string) {}

  /**
   * Factory method to create a LocalFilesystemAdapter
   *
   * @param options - Configuration options
   * @returns Promise resolving to an initialized LocalFilesystemAdapter
   */
  static async create(options: FilesystemAdapterOptions) {
    const fs = new LocalFilesystemAdapter(options);
    return fs;
  }

  /**
   * Checks if a file or directory exists in the local filesystem
   *
   * @param path - Path to check
   * @returns Promise resolving to boolean indicating existence
   */
  async exists(_path: string) {
    return false;
  }

  /**
   * Reads a file's contents from the local filesystem
   *
   * @param path - Path to the file
   * @returns Promise resolving to the file contents as a string
   */
  async read(_path: string) {
    return '';
  }

  /**
   * Writes content to a file in the local filesystem
   *
   * @param path - Path to the file
   * @param content - Content to write
   * @returns Promise that resolves when the write is complete
   */
  async write(_path: string, _content: string) {
    return;
  }

  /**
   * Deletes a file or directory from the local filesystem
   *
   * @param path - Path to delete
   * @returns Promise that resolves when the deletion is complete
   */
  async delete(_path: string) {
    return;
  }

  /**
   * Lists files in a directory in the local filesystem
   *
   * @param path - Directory path to list
   * @returns Promise resolving to an array of file names
   */
  async list(_path: string) {
    return [];
  }

  /**
   * Gets the MIME type for a file based on its extension
   *
   * @param path - Path to the file
   * @returns Promise resolving to the MIME type string
   */
  async mimeType(path: string) {
    const extension = path.slice(((path.lastIndexOf('.') - 1) >>> 0) + 2);
    return getMimeType(`.${extension}`);
  }
}
