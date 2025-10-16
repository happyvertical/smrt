/**
 * Core types and interfaces for the Files library
 */

/**
 * Options for reading files
 */
export interface ReadOptions {
  /**
   * Text encoding for reading the file
   */
  encoding?: BufferEncoding;

  /**
   * Whether to return raw buffer data instead of string
   */
  raw?: boolean;
}

/**
 * Options for writing files
 */
export interface WriteOptions {
  /**
   * Text encoding for writing the file
   */
  encoding?: BufferEncoding;

  /**
   * File mode (permissions)
   */
  mode?: number;

  /**
   * Whether to create parent directories if they don't exist
   */
  createParents?: boolean;
}

/**
 * Options for creating directories
 */
export interface CreateDirOptions {
  /**
   * Whether to create parent directories recursively
   */
  recursive?: boolean;

  /**
   * Directory mode (permissions)
   */
  mode?: number;
}

/**
 * Options for listing directory contents
 */
export interface ListOptions {
  /**
   * Whether to include subdirectories
   */
  recursive?: boolean;

  /**
   * Filter pattern for file names
   */
  filter?: RegExp | string;

  /**
   * Whether to return full file information
   */
  detailed?: boolean;
}

/**
 * Options for file upload operations
 */
export interface UploadOptions {
  /**
   * Content type for the upload
   */
  contentType?: string;

  /**
   * Whether to overwrite existing files
   */
  overwrite?: boolean;

  /**
   * Custom metadata to attach to the file
   */
  metadata?: Record<string, string>;

  /**
   * Progress callback function
   */
  onProgress?: (progress: { loaded: number; total: number }) => void;
}

/**
 * Options for file download operations
 */
export interface DownloadOptions {
  /**
   * Whether to force download even if local copy exists
   */
  force?: boolean;

  /**
   * Progress callback function
   */
  onProgress?: (progress: { loaded: number; total: number }) => void;
}

/**
 * Options for caching operations
 */
export interface CacheOptions {
  /**
   * Cache expiry time in milliseconds
   */
  expiry?: number;

  /**
   * Whether to force download even if cached
   */
  force?: boolean;
}

/**
 * Options for listing files (legacy compatibility)
 */
export interface ListFilesOptions {
  /**
   * Optional regular expression to filter files by name
   */
  match?: RegExp;
}

/**
 * File information structure
 */
export interface FileInfo {
  /**
   * File name
   */
  name: string;

  /**
   * Full path to the file
   */
  path: string;

  /**
   * File size in bytes
   */
  size: number;

  /**
   * Whether this is a directory
   */
  isDirectory: boolean;

  /**
   * Last modified date
   */
  lastModified: Date;

  /**
   * MIME type of the file
   */
  mimeType?: string;

  /**
   * File extension
   */
  extension?: string;
}

/**
 * File statistics structure
 */
export interface FileStats {
  /**
   * File size in bytes
   */
  size: number;

  /**
   * Whether this is a directory
   */
  isDirectory: boolean;

  /**
   * Whether this is a regular file
   */
  isFile: boolean;

  /**
   * Creation time
   */
  birthtime: Date;

  /**
   * Last access time
   */
  atime: Date;

  /**
   * Last modification time
   */
  mtime: Date;

  /**
   * Last status change time
   */
  ctime: Date;

  /**
   * File mode (permissions)
   */
  mode: number;

  /**
   * User ID of file owner
   */
  uid: number;

  /**
   * Group ID of file owner
   */
  gid: number;
}

/**
 * Filesystem capabilities structure
 */
export interface FilesystemCapabilities {
  /**
   * Whether the filesystem supports streaming
   */
  streaming: boolean;

  /**
   * Whether the filesystem supports atomic operations
   */
  atomicOperations: boolean;

  /**
   * Whether the filesystem supports file versioning
   */
  versioning: boolean;

  /**
   * Whether the filesystem supports sharing/permissions
   */
  sharing: boolean;

  /**
   * Whether the filesystem supports real-time synchronization
   */
  realTimeSync: boolean;

  /**
   * Whether the filesystem can work offline
   */
  offlineCapable: boolean;

  /**
   * Maximum file size supported (in bytes)
   */
  maxFileSize?: number;

  /**
   * Supported file operations
   */
  supportedOperations: string[];
}

/**
 * Core filesystem interface that all providers must implement
 */
export interface FilesystemInterface {
  /**
   * Check if a file or directory exists
   */
  exists(path: string): Promise<boolean>;

  /**
   * Read file contents
   */
  read(path: string, options?: ReadOptions): Promise<string | Buffer>;

  /**
   * Write content to a file
   */
  write(
    path: string,
    content: string | Buffer,
    options?: WriteOptions,
  ): Promise<void>;

  /**
   * Delete a file or directory
   */
  delete(path: string): Promise<void>;

  /**
   * Copy a file from source to destination
   */
  copy(sourcePath: string, destPath: string): Promise<void>;

  /**
   * Move a file from source to destination
   */
  move(sourcePath: string, destPath: string): Promise<void>;

  /**
   * Create a directory
   */
  createDirectory(path: string, options?: CreateDirOptions): Promise<void>;

  /**
   * List directory contents
   */
  list(path: string, options?: ListOptions): Promise<FileInfo[]>;

  /**
   * Get file statistics
   */
  getStats(path: string): Promise<FileStats>;

  /**
   * Get MIME type for a file
   */
  getMimeType(path: string): Promise<string>;

  /**
   * Upload a file (for remote providers)
   */
  upload(
    localPath: string,
    remotePath: string,
    options?: UploadOptions,
  ): Promise<void>;

  /**
   * Download a file (for remote providers)
   */
  download(
    remotePath: string,
    localPath?: string,
    options?: DownloadOptions,
  ): Promise<string>;

  /**
   * Download file with caching
   */
  downloadWithCache(
    remotePath: string,
    options?: CacheOptions,
  ): Promise<string>;

  /**
   * Caching operations
   */
  cache: {
    get(key: string, expiry?: number): Promise<string | undefined>;
    set(key: string, data: string): Promise<void>;
    clear(key?: string): Promise<void>;
  };

  /**
   * Get provider capabilities
   */
  getCapabilities(): Promise<FilesystemCapabilities>;

  // Legacy method compatibility - all providers must implement these

  /**
   * Check if a path is a file (legacy)
   */
  isFile(file: string): Promise<false | FileStats>;

  /**
   * Check if a path is a directory (legacy)
   */
  isDirectory(dir: string): Promise<boolean>;

  /**
   * Create a directory if it doesn't exist (legacy)
   */
  ensureDirectoryExists(dir: string): Promise<void>;

  /**
   * Upload data to a URL using PUT method (legacy)
   */
  uploadToUrl(url: string, data: string | Buffer): Promise<Response>;

  /**
   * Download a file from a URL and save it to a local file (legacy)
   */
  downloadFromUrl(url: string, filepath: string): Promise<void>;

  /**
   * Download a file with caching support (legacy)
   */
  downloadFileWithCache(
    url: string,
    targetPath?: string | null,
  ): Promise<string>;

  /**
   * List files in a directory with optional filtering (legacy)
   */
  listFiles(dirPath: string, options?: ListFilesOptions): Promise<string[]>;

  /**
   * Get data from cache if available and not expired (legacy)
   */
  getCached(file: string, expiry?: number): Promise<string | undefined>;

  /**
   * Set data in cache (legacy)
   */
  setCached(file: string, data: string): Promise<void>;
}

/**
 * Base configuration options for all providers
 */
export interface BaseProviderOptions {
  /**
   * Base path for operations
   */
  basePath?: string;

  /**
   * Cache directory location
   */
  cacheDir?: string;

  /**
   * Whether to create missing directories
   */
  createMissing?: boolean;
}

/**
 * Local filesystem provider options
 */
export interface LocalOptions extends BaseProviderOptions {
  type?: 'local';
}

/**
 * S3-compatible provider options
 */
export interface S3Options extends BaseProviderOptions {
  type: 's3';
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

/**
 * Google Drive provider options
 */
export interface GoogleDriveOptions extends BaseProviderOptions {
  type: 'gdrive';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId?: string;
  scopes?: string[];
}

/**
 * WebDAV provider options (supports Nextcloud, ownCloud, Apache, etc.)
 */
export interface WebDAVOptions extends BaseProviderOptions {
  type: 'webdav';
  baseUrl: string;
  username: string;
  password: string;
  davPath?: string;
}

/**
 * Browser storage provider options (uses IndexedDB for app storage)
 */
export interface BrowserStorageOptions extends BaseProviderOptions {
  type: 'browser-storage';
  /**
   * Database name for IndexedDB
   */
  databaseName?: string;
  /**
   * Maximum storage quota to request (in bytes)
   */
  storageQuota?: number;
}

/**
 * Union type for all provider options
 */
export type GetFilesystemOptions =
  | LocalOptions
  | S3Options
  | GoogleDriveOptions
  | WebDAVOptions
  | BrowserStorageOptions;

/**
 * Error types for filesystem operations
 */
export class FilesystemError extends Error {
  constructor(
    message: string,
    public code: string,
    public path?: string,
    public provider?: string,
  ) {
    super(message);
    this.name = 'FilesystemError';
  }
}

export class FileNotFoundError extends FilesystemError {
  constructor(path: string, provider?: string) {
    super(`File not found: ${path}`, 'ENOENT', path, provider);
    this.name = 'FileNotFoundError';
  }
}

export class PermissionError extends FilesystemError {
  constructor(path: string, provider?: string) {
    super(`Permission denied: ${path}`, 'EACCES', path, provider);
    this.name = 'PermissionError';
  }
}

export class DirectoryNotEmptyError extends FilesystemError {
  constructor(path: string, provider?: string) {
    super(`Directory not empty: ${path}`, 'ENOTEMPTY', path, provider);
    this.name = 'DirectoryNotEmptyError';
  }
}

export class InvalidPathError extends FilesystemError {
  constructor(path: string, provider?: string) {
    super(`Invalid path: ${path}`, 'EINVAL', path, provider);
    this.name = 'InvalidPathError';
  }
}
