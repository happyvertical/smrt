import { constants, createWriteStream, existsSync, statSync } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { URL } from 'node:url';
import { getTempDirectory } from '@have/utils';
import { BaseFilesystemProvider } from '../shared/base';
import {
  type CreateDirOptions,
  DirectoryNotEmptyError,
  type FileInfo,
  FileNotFoundError,
  type FileStats,
  type FilesystemCapabilities,
  FilesystemError,
  type ListOptions,
  type LocalOptions,
  PermissionError,
  type ReadOptions,
  type WriteOptions,
} from '../shared/types';

/**
 * Local filesystem provider using Node.js fs module with full feature support
 *
 * This provider implements all filesystem operations using the Node.js built-in
 * fs/promises module. It supports all standard file operations including reading,
 * writing, directory management, and caching. The provider operates within a
 * configurable root path for security and organization.
 *
 * @example
 * ```typescript
 * // Create provider with default settings (current working directory)
 * const fs = new LocalFilesystemProvider();
 *
 * // Create provider with custom base path
 * const fs = new LocalFilesystemProvider({ basePath: '/app/data' });
 *
 * // Use the provider
 * await fs.write('config.json', JSON.stringify({ key: 'value' }));
 * const content = await fs.read('config.json');
 * ```
 */
export class LocalFilesystemProvider extends BaseFilesystemProvider {
  private readonly rootPath: string;

  constructor(options: LocalOptions = {}) {
    super(options);
    this.rootPath = options.basePath
      ? resolve(options.basePath)
      : process.cwd();
  }

  /**
   * Resolve a relative path to an absolute path within the root directory
   *
   * This method validates the path, normalizes it, and resolves it relative to
   * the configured root path. It ensures path safety by preventing directory
   * traversal attacks.
   *
   * @param path - Relative path to resolve
   * @returns Absolute path within the root directory
   * @throws {FilesystemError} When path is invalid or contains directory traversal
   *
   * @internal
   */
  private resolvePath(path: string): string {
    this.validatePath(path);
    const normalized = this.normalizePath(path);
    return join(this.rootPath, normalized);
  }

  /**
   * Check if a file or directory exists at the specified path
   *
   * Uses Node.js fs.access() to check for file existence without reading
   * the file contents. This is more efficient than trying to read or stat
   * the file when only existence needs to be verified.
   *
   * @param path - Path to check for existence
   * @returns Promise resolving to true if the path exists, false otherwise
   *
   * @example
   * ```typescript
   * const exists = await fs.exists('config.json');
   * if (exists) {
   *   console.log('Config file found');
   * }
   * ```
   */
  async exists(path: string): Promise<boolean> {
    try {
      const resolvedPath = this.resolvePath(path);
      await access(resolvedPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read file contents as string or Buffer
   *
   * Reads the entire contents of a file into memory. For large files, consider
   * using streaming approaches to avoid memory issues.
   *
   * @param path - Path to the file to read
   * @param options - Read options including encoding and raw mode
   * @param options.encoding - Text encoding for string output (default: 'utf8')
   * @param options.raw - If true, returns Buffer instead of string
   * @returns Promise resolving to file contents as string or Buffer
   * @throws {FileNotFoundError} When the file doesn't exist
   * @throws {PermissionError} When read access is denied
   * @throws {FilesystemError} For other filesystem errors
   *
   * @example
   * ```typescript
   * // Read as UTF-8 string (default)
   * const text = await fs.read('document.txt');
   *
   * // Read as Buffer for binary data
   * const buffer = await fs.read('image.png', { raw: true });
   *
   * // Read with specific encoding
   * const latin1Text = await fs.read('legacy.txt', { encoding: 'latin1' });
   * ```
   */
  async read(
    path: string,
    options: ReadOptions = {},
  ): Promise<string | Buffer> {
    try {
      const resolvedPath = this.resolvePath(path);

      if (options.raw) {
        // Return raw buffer
        return await readFile(resolvedPath);
      }
      // Return string with specified encoding (default utf8)
      return await readFile(resolvedPath, options.encoding || 'utf8');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new FileNotFoundError(path, 'local');
      }
      if (error.code === 'EACCES') {
        throw new PermissionError(path, 'local');
      }
      throw new FilesystemError(
        `Failed to read file: ${error.message}`,
        error.code || 'UNKNOWN',
        path,
        'local',
      );
    }
  }

  /**
   * Write content to a file
   *
   * Creates or overwrites a file with the provided content. Can automatically
   * create parent directories if they don't exist. Supports both string and
   * binary data.
   *
   * @param path - Path where the file should be written
   * @param content - Content to write (string or Buffer)
   * @param options - Write options
   * @param options.encoding - Text encoding for string content
   * @param options.mode - File permissions (e.g., 0o644)
   * @param options.createParents - Whether to create parent directories (default: true)
   * @returns Promise that resolves when the file is written
   * @throws {FileNotFoundError} When parent directory doesn't exist and createParents is false
   * @throws {PermissionError} When write access is denied
   * @throws {FilesystemError} For other filesystem errors
   *
   * @example
   * ```typescript
   * // Write text file
   * await fs.write('config.json', JSON.stringify({ key: 'value' }));
   *
   * // Write binary data
   * const imageBuffer = await someImageProcessing();
   * await fs.write('output.png', imageBuffer);
   *
   * // Write with specific permissions
   * await fs.write('secret.txt', 'sensitive data', { mode: 0o600 });
   *
   * // Write without creating parent directories
   * await fs.write('existing/dir/file.txt', 'content', { createParents: false });
   * ```
   */
  async write(
    path: string,
    content: string | Buffer,
    options: WriteOptions = {},
  ): Promise<void> {
    try {
      const resolvedPath = this.resolvePath(path);

      // Create parent directories if needed
      if (options.createParents ?? this.createMissing) {
        await mkdir(dirname(resolvedPath), { recursive: true });
      }

      await writeFile(resolvedPath, content, {
        encoding: options.encoding,
        mode: options.mode,
      });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new FileNotFoundError(dirname(path), 'local');
      }
      if (error.code === 'EACCES') {
        throw new PermissionError(path, 'local');
      }
      throw new FilesystemError(
        `Failed to write file: ${error.message}`,
        error.code || 'UNKNOWN',
        path,
        'local',
      );
    }
  }

  /**
   * Delete a file or empty directory
   *
   * Removes a file or directory from the filesystem. For directories, they must
   * be empty. Use recursive deletion utilities for non-empty directories.
   *
   * @param path - Path to the file or directory to delete
   * @returns Promise that resolves when the item is deleted
   * @throws {FileNotFoundError} When the file or directory doesn't exist
   * @throws {PermissionError} When delete access is denied
   * @throws {DirectoryNotEmptyError} When trying to delete a non-empty directory
   * @throws {FilesystemError} For other filesystem errors
   *
   * @example
   * ```typescript
   * // Delete a file
   * await fs.delete('temp.txt');
   *
   * // Delete an empty directory
   * await fs.delete('empty-dir/');
   * ```
   */
  async delete(path: string): Promise<void> {
    try {
      const resolvedPath = this.resolvePath(path);
      const stats = await stat(resolvedPath);

      if (stats.isDirectory()) {
        await rmdir(resolvedPath);
      } else {
        await unlink(resolvedPath);
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new FileNotFoundError(path, 'local');
      }
      if (error.code === 'EACCES') {
        throw new PermissionError(path, 'local');
      }
      if (error.code === 'ENOTEMPTY') {
        throw new DirectoryNotEmptyError(path, 'local');
      }
      throw new FilesystemError(
        `Failed to delete: ${error.message}`,
        error.code || 'UNKNOWN',
        path,
        'local',
      );
    }
  }

  /**
   * Copy a file from source to destination
   *
   * Creates an exact copy of a file at the destination path. Will create
   * parent directories if they don't exist and createMissing is enabled.
   * The operation preserves file contents but not necessarily all metadata.
   *
   * @param sourcePath - Path to the source file
   * @param destPath - Path where the copy should be created
   * @returns Promise that resolves when the file is copied
   * @throws {FileNotFoundError} When the source file doesn't exist
   * @throws {PermissionError} When read/write access is denied
   * @throws {FilesystemError} For other filesystem errors
   *
   * @example
   * ```typescript
   * // Copy a file
   * await fs.copy('original.txt', 'backup.txt');
   *
   * // Copy to a different directory
   * await fs.copy('data.json', 'backup/data-copy.json');
   * ```
   */
  async copy(sourcePath: string, destPath: string): Promise<void> {
    try {
      const resolvedSource = this.resolvePath(sourcePath);
      const resolvedDest = this.resolvePath(destPath);

      // Create parent directories if needed
      if (this.createMissing) {
        await mkdir(dirname(resolvedDest), { recursive: true });
      }

      await copyFile(resolvedSource, resolvedDest);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new FileNotFoundError(sourcePath, 'local');
      }
      if (error.code === 'EACCES') {
        throw new PermissionError(sourcePath, 'local');
      }
      throw new FilesystemError(
        `Failed to copy: ${error.message}`,
        error.code || 'UNKNOWN',
        sourcePath,
        'local',
      );
    }
  }

  /**
   * Move/rename a file from source to destination
   *
   * Moves a file to a new location, effectively combining copy and delete
   * operations. This is atomic on most filesystems when moving within the
   * same filesystem. Will create parent directories if they don't exist.
   *
   * @param sourcePath - Path to the source file
   * @param destPath - Path where the file should be moved
   * @returns Promise that resolves when the file is moved
   * @throws {FileNotFoundError} When the source file doesn't exist
   * @throws {PermissionError} When move access is denied
   * @throws {FilesystemError} For other filesystem errors
   *
   * @example
   * ```typescript
   * // Rename a file
   * await fs.move('old-name.txt', 'new-name.txt');
   *
   * // Move to a different directory
   * await fs.move('temp.txt', 'archive/temp.txt');
   * ```
   */
  async move(sourcePath: string, destPath: string): Promise<void> {
    try {
      const resolvedSource = this.resolvePath(sourcePath);
      const resolvedDest = this.resolvePath(destPath);

      // Create parent directories if needed
      if (this.createMissing) {
        await mkdir(dirname(resolvedDest), { recursive: true });
      }

      await rename(resolvedSource, resolvedDest);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new FileNotFoundError(sourcePath, 'local');
      }
      if (error.code === 'EACCES') {
        throw new PermissionError(sourcePath, 'local');
      }
      throw new FilesystemError(
        `Failed to move: ${error.message}`,
        error.code || 'UNKNOWN',
        sourcePath,
        'local',
      );
    }
  }

  /**
   * Create a directory at the specified path
   *
   * Creates a new directory with optional recursive creation of parent
   * directories. Supports setting directory permissions.
   *
   * @param path - Path where the directory should be created
   * @param options - Directory creation options
   * @param options.recursive - Whether to create parent directories (default: true)
   * @param options.mode - Directory permissions (e.g., 0o755)
   * @returns Promise that resolves when the directory is created
   * @throws {PermissionError} When create access is denied
   * @throws {FilesystemError} For other filesystem errors
   *
   * @example
   * ```typescript
   * // Create directory with parents
   * await fs.createDirectory('path/to/new/dir');
   *
   * // Create directory with specific permissions
   * await fs.createDirectory('private-dir', { mode: 0o700 });
   *
   * // Create directory without parent creation
   * await fs.createDirectory('existing-parent/new-dir', { recursive: false });
   * ```
   */
  async createDirectory(
    path: string,
    options: CreateDirOptions = {},
  ): Promise<void> {
    try {
      const resolvedPath = this.resolvePath(path);
      await mkdir(resolvedPath, {
        recursive: options.recursive ?? true,
        mode: options.mode,
      });
    } catch (error: any) {
      if (error.code === 'EACCES') {
        throw new PermissionError(path, 'local');
      }
      throw new FilesystemError(
        `Failed to create directory: ${error.message}`,
        error.code || 'UNKNOWN',
        path,
        'local',
      );
    }
  }

  /**
   * List the contents of a directory
   *
   * Returns an array of FileInfo objects describing each item in the directory.
   * Supports filtering, recursive listing, and detailed metadata retrieval.
   *
   * @param path - Path to the directory to list
   * @param options - Listing options
   * @param options.recursive - Whether to include subdirectories recursively
   * @param options.filter - RegExp or string pattern to filter file names
   * @param options.detailed - Whether to include MIME types and extended metadata
   * @returns Promise resolving to array of FileInfo objects
   * @throws {FileNotFoundError} When the directory doesn't exist
   * @throws {PermissionError} When read access is denied
   * @throws {FilesystemError} For other filesystem errors
   *
   * @example
   * ```typescript
   * // List all files and directories
   * const items = await fs.list('/path/to/dir');
   * items.forEach(item => {
   *   console.log(`${item.name} (${item.isDirectory ? 'dir' : 'file'})`);
   * });
   *
   * // List only text files
   * const textFiles = await fs.list('/documents', { filter: /\.txt$/ });
   *
   * // Recursive listing with detailed info
   * const allFiles = await fs.list('/project', {
   *   recursive: true,
   *   detailed: true
   * });
   * ```
   */
  async list(path: string, options: ListOptions = {}): Promise<FileInfo[]> {
    try {
      const resolvedPath = this.resolvePath(path);
      const entries = await readdir(resolvedPath, { withFileTypes: true });

      const results: FileInfo[] = [];

      for (const entry of entries) {
        const fullPath = join(resolvedPath, entry.name);
        const relativePath = join(path, entry.name);

        // Apply filter if provided
        if (options.filter) {
          const filterPattern =
            typeof options.filter === 'string'
              ? new RegExp(options.filter)
              : options.filter;

          if (!filterPattern.test(entry.name)) {
            continue;
          }
        }

        const stats = await stat(fullPath);
        const fileInfo: FileInfo = {
          name: entry.name,
          path: relativePath,
          size: stats.size,
          isDirectory: entry.isDirectory(),
          lastModified: stats.mtime,
          extension: entry.isFile() ? extname(entry.name).slice(1) : undefined,
        };

        if (options.detailed) {
          fileInfo.mimeType = await this.getMimeType(relativePath);
        }

        results.push(fileInfo);

        // Recursively list subdirectories if requested
        if (options.recursive && entry.isDirectory()) {
          const subResults = await this.list(relativePath, options);
          results.push(...subResults);
        }
      }

      return results;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new FileNotFoundError(path, 'local');
      }
      if (error.code === 'EACCES') {
        throw new PermissionError(path, 'local');
      }
      throw new FilesystemError(
        `Failed to list directory: ${error.message}`,
        error.code || 'UNKNOWN',
        path,
        'local',
      );
    }
  }

  /**
   * Get detailed file or directory statistics
   *
   * Returns comprehensive metadata about a file or directory including size,
   * timestamps, permissions, and ownership information.
   *
   * @param path - Path to the file or directory
   * @returns Promise resolving to FileStats object with detailed metadata
   * @throws {FileNotFoundError} When the path doesn't exist
   * @throws {PermissionError} When stat access is denied
   * @throws {FilesystemError} For other filesystem errors
   *
   * @example
   * ```typescript
   * const stats = await fs.getStats('document.pdf');
   * console.log(`Size: ${stats.size} bytes`);
   * console.log(`Modified: ${stats.mtime}`);
   * console.log(`Is file: ${stats.isFile}`);
   * console.log(`Permissions: ${stats.mode.toString(8)}`);
   * ```
   */
  async getStats(path: string): Promise<FileStats> {
    try {
      const resolvedPath = this.resolvePath(path);
      const stats = await stat(resolvedPath);

      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        birthtime: stats.birthtime,
        atime: stats.atime,
        mtime: stats.mtime,
        ctime: stats.ctime,
        mode: stats.mode,
        uid: stats.uid,
        gid: stats.gid,
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new FileNotFoundError(path, 'local');
      }
      if (error.code === 'EACCES') {
        throw new PermissionError(path, 'local');
      }
      throw new FilesystemError(
        `Failed to get stats: ${error.message}`,
        error.code || 'UNKNOWN',
        path,
        'local',
      );
    }
  }

  /**
   * Get the MIME type for a file based on its extension
   *
   * Determines the MIME type by examining the file extension. Returns a
   * standard MIME type string that can be used for content-type headers
   * or file type detection.
   *
   * @param path - Path to the file
   * @returns Promise resolving to MIME type string (e.g., 'text/plain', 'image/png')
   *
   * @example
   * ```typescript
   * const mimeType = await fs.getMimeType('document.pdf');
   * console.log(mimeType); // 'application/pdf'
   *
   * const imageMime = await fs.getMimeType('photo.jpg');
   * console.log(imageMime); // 'image/jpeg'
   * ```
   */
  async getMimeType(path: string): Promise<string> {
    const mimeTypes: { [key: string]: string } = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.css': 'text/css',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.txt': 'text/plain',
      '.doc': 'application/msword',
      '.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pdf': 'application/pdf',
      '.xml': 'application/xml',
      '.zip': 'application/zip',
      '.rar': 'application/x-rar-compressed',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
    };

    const extension = extname(path).toLowerCase();
    return mimeTypes[extension] || 'application/octet-stream';
  }

  /**
   * Upload data to a URL using PUT method (legacy)
   */
  async uploadToUrl(url: string, data: string | Buffer): Promise<Response> {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        body: Buffer.isBuffer(data) ? new Uint8Array(data) : data,
        headers: { 'Content-Type': 'application/octet-stream' },
      });

      if (!response.ok) {
        throw new Error(`unexpected response ${response.statusText}`);
      }
      return response;
    } catch (error) {
      const err = error as Error;
      console.error(`Error uploading data to ${url}\nError: ${err.message}`);
      throw error;
    }
  }

  /**
   * Download a file from a URL and save it to a local file (legacy)
   */
  async downloadFromUrl(url: string, filepath: string): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Unexpected response ${response.statusText}`);
      }

      const fileStream = createWriteStream(this.resolvePath(filepath));

      return new Promise<void>((resolve, reject) => {
        fileStream.on('error', reject);
        fileStream.on('finish', resolve);

        response.body
          ?.pipeTo(
            new WritableStream({
              write(chunk) {
                fileStream.write(Buffer.from(chunk));
              },
              close() {
                fileStream.end();
              },
              abort(reason) {
                fileStream.destroy();
                reject(reason);
              },
            }),
          )
          .catch(reject);
      });
    } catch (error) {
      const err = error as Error;
      console.error('Error downloading file:', err);
      throw error;
    }
  }

  /**
   * Download a file with caching support (legacy)
   */
  async downloadFileWithCache(
    url: string,
    targetPath: string | null = null,
  ): Promise<string> {
    const parsedUrl = new URL(url);
    const downloadPath =
      targetPath ||
      join(
        getTempDirectory('downloads'),
        parsedUrl.hostname + parsedUrl.pathname,
      );

    if (!existsSync(downloadPath)) {
      await mkdir(dirname(downloadPath), { recursive: true });
      await this.downloadFromUrl(url, downloadPath);
    }
    return downloadPath;
  }

  /**
   * Get data from cache if available and not expired (legacy)
   */
  async getCached(file: string, expiry = 300000): Promise<string | undefined> {
    const cacheFile = resolve(getTempDirectory('cache'), file);
    const cached = existsSync(cacheFile);
    if (cached) {
      const stats = statSync(cacheFile);
      const modTime = new Date(stats.mtime);
      const now = new Date();
      const isExpired = expiry && now.getTime() - modTime.getTime() > expiry;
      if (!isExpired) {
        return await readFile(cacheFile, 'utf8');
      }
    }
    return undefined;
  }

  /**
   * Set data in cache (legacy)
   */
  async setCached(file: string, data: string): Promise<void> {
    const cacheFile = resolve(getTempDirectory('cache'), file);
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, data);
  }

  /**
   * Cache implementation using file system
   */
  cache = {
    get: async (key: string, expiry?: number): Promise<string | undefined> => {
      return await this.getCached(key, expiry);
    },

    set: async (key: string, data: string): Promise<void> => {
      await this.setCached(key, data);
    },

    clear: async (key?: string): Promise<void> => {
      if (key) {
        const cacheFile = resolve(getTempDirectory('cache'), key);
        try {
          await unlink(cacheFile);
        } catch {
          // Ignore errors if file doesn't exist
        }
      } else {
        // Clear entire cache directory
        try {
          const cacheDir = resolve(getTempDirectory('cache'));
          await rmdir(cacheDir, { recursive: true });
        } catch {
          // Ignore errors if directory doesn't exist
        }
      }
    },
  };

  /**
   * Get provider capabilities
   */
  async getCapabilities(): Promise<FilesystemCapabilities> {
    return {
      streaming: true,
      atomicOperations: true,
      versioning: false,
      sharing: false,
      realTimeSync: false,
      offlineCapable: true,
      supportedOperations: [
        'exists',
        'read',
        'write',
        'delete',
        'copy',
        'move',
        'createDirectory',
        'list',
        'getStats',
        'getMimeType',
        'upload',
        'download',
        'downloadWithCache',
        'isFile',
        'isDirectory',
        'ensureDirectoryExists',
        'uploadToUrl',
        'downloadFromUrl',
        'downloadFileWithCache',
        'listFiles',
        'getCached',
        'setCached',
      ],
    };
  }
}
