import { constants, createWriteStream, existsSync, statSync } from "node:fs";
import { access, readFile, mkdir, writeFile, stat, rmdir, unlink, copyFile, rename, readdir } from "node:fs/promises";
import * as path from "node:path";
import { resolve, join, dirname, extname } from "node:path";
import { URL as URL$1 } from "node:url";
import { getTempDirectory } from "@have/utils";
class FilesystemError extends Error {
  constructor(message, code, path2, provider) {
    super(message);
    this.code = code;
    this.path = path2;
    this.provider = provider;
    this.name = "FilesystemError";
  }
}
class FileNotFoundError extends FilesystemError {
  constructor(path2, provider) {
    super(`File not found: ${path2}`, "ENOENT", path2, provider);
    this.name = "FileNotFoundError";
  }
}
class PermissionError extends FilesystemError {
  constructor(path2, provider) {
    super(`Permission denied: ${path2}`, "EACCES", path2, provider);
    this.name = "PermissionError";
  }
}
class DirectoryNotEmptyError extends FilesystemError {
  constructor(path2, provider) {
    super(`Directory not empty: ${path2}`, "ENOTEMPTY", path2, provider);
    this.name = "DirectoryNotEmptyError";
  }
}
class InvalidPathError extends FilesystemError {
  constructor(path2, provider) {
    super(`Invalid path: ${path2}`, "EINVAL", path2, provider);
    this.name = "InvalidPathError";
  }
}
class BaseFilesystemProvider {
  basePath;
  cacheDir;
  createMissing;
  providerType;
  constructor(options = {}) {
    this.basePath = options.basePath || "";
    this.cacheDir = options.cacheDir || this.getDefaultCacheDir();
    this.createMissing = options.createMissing ?? true;
    this.providerType = this.constructor.name.toLowerCase().replace("filesystemprovider", "");
  }
  /**
   * Get default cache directory for the current context
   */
  getDefaultCacheDir() {
    try {
      const { getTempDirectory: getTempDirectory2 } = require("@have/utils");
      return getTempDirectory2("files-cache");
    } catch {
      if (process?.versions?.node) {
        try {
          const { tmpdir } = require("node:os");
          const { join: join2 } = require("node:path");
          return join2(tmpdir(), "have-sdk", "files-cache");
        } catch {
          return "./tmp/have-sdk/files-cache";
        }
      }
      return "./tmp/have-sdk/files-cache";
    }
  }
  /**
   * Throw error for unsupported operations
   */
  throwUnsupported(operation) {
    throw new FilesystemError(
      `Operation '${operation}' not supported by ${this.providerType} provider`,
      "ENOTSUP",
      void 0,
      this.providerType
    );
  }
  /**
   * Normalize path by removing leading/trailing slashes and resolving relative paths
   */
  normalizePath(path2) {
    if (!path2) return "";
    let normalized = path2.startsWith("/") ? path2.slice(1) : path2;
    if (this.basePath) {
      normalized = this.joinPaths(this.basePath, normalized);
    }
    return normalized;
  }
  /**
   * Universal path joining function that works in both Node.js and browser
   */
  joinPaths(...paths) {
    return paths.filter((p) => p && p.length > 0).map((p) => p.replace(/^\/+|\/+$/g, "")).join("/");
  }
  /**
   * Validate that a path is safe (no directory traversal)
   */
  validatePath(path2) {
    if (!path2) {
      throw new FilesystemError("Path cannot be empty", "EINVAL", path2);
    }
    if (path2.includes("..") || path2.includes("~")) {
      throw new FilesystemError(
        "Path contains invalid characters (directory traversal)",
        "EINVAL",
        path2
      );
    }
  }
  /**
   * Get cache key for a given path
   */
  getCacheKey(path2) {
    return `${this.constructor.name}-${path2}`;
  }
  /**
   * Provider methods with default implementations (may be overridden)
   */
  async upload(_localPath, _remotePath, _options = {}) {
    this.throwUnsupported("upload");
  }
  async download(_remotePath, _localPath, _options = {}) {
    this.throwUnsupported("download");
  }
  async downloadWithCache(remotePath, options = {}) {
    const cacheKey = this.getCacheKey(remotePath);
    if (!options.force) {
      const cached = await this.cache.get(cacheKey, options.expiry);
      if (cached) {
        return cached;
      }
    }
    const localPath = await this.download(remotePath, void 0, options);
    await this.cache.set(cacheKey, localPath);
    return localPath;
  }
  /**
   * Cache implementation - providers can override for their specific storage
   */
  cache = {
    get: async (_key, _expiry) => {
      this.throwUnsupported("cache.get");
    },
    set: async (_key, _data) => {
      this.throwUnsupported("cache.set");
    },
    clear: async (_key) => {
      this.throwUnsupported("cache.clear");
    }
  };
  // Legacy method implementations - providers can override or use default ENOTSUP errors
  /**
   * Check if a path is a file (legacy)
   */
  async isFile(file) {
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
  async isDirectory(dir) {
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
  async ensureDirectoryExists(dir) {
    if (!await this.isDirectory(dir)) {
      await this.createDirectory(dir, { recursive: true });
    }
  }
  /**
   * Upload data to a URL using PUT method (legacy)
   */
  async uploadToUrl(_url, _data) {
    this.throwUnsupported("uploadToUrl");
  }
  /**
   * Download a file from a URL and save it to a local file (legacy)
   */
  async downloadFromUrl(_url, _filepath) {
    this.throwUnsupported("downloadFromUrl");
  }
  /**
   * Download a file with caching support (legacy)
   */
  async downloadFileWithCache(_url, _targetPath) {
    this.throwUnsupported("downloadFileWithCache");
  }
  /**
   * List files in a directory with optional filtering (legacy)
   */
  async listFiles(dirPath, options = { match: /.*/ }) {
    const files = await this.list(dirPath);
    const fileNames = files.filter((file) => !file.isDirectory).map((file) => file.name);
    return options.match ? fileNames.filter((name) => options.match?.test(name)) : fileNames;
  }
  /**
   * Get data from cache if available and not expired (legacy)
   */
  async getCached(file, expiry = 3e5) {
    return await this.cache.get(file, expiry);
  }
  /**
   * Set data in cache (legacy)
   */
  async setCached(file, data) {
    await this.cache.set(file, data);
  }
}
class LocalFilesystemProvider extends BaseFilesystemProvider {
  rootPath;
  constructor(options = {}) {
    super(options);
    this.rootPath = options.basePath ? resolve(options.basePath) : process.cwd();
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
  resolvePath(path2) {
    this.validatePath(path2);
    const normalized = this.normalizePath(path2);
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
  async exists(path2) {
    try {
      const resolvedPath = this.resolvePath(path2);
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
  async read(path2, options = {}) {
    try {
      const resolvedPath = this.resolvePath(path2);
      if (options.raw) {
        return await readFile(resolvedPath);
      }
      return await readFile(resolvedPath, options.encoding || "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new FileNotFoundError(path2, "local");
      }
      if (error.code === "EACCES") {
        throw new PermissionError(path2, "local");
      }
      throw new FilesystemError(
        `Failed to read file: ${error.message}`,
        error.code || "UNKNOWN",
        path2,
        "local"
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
  async write(path2, content, options = {}) {
    try {
      const resolvedPath = this.resolvePath(path2);
      if (options.createParents ?? this.createMissing) {
        await mkdir(dirname(resolvedPath), { recursive: true });
      }
      await writeFile(resolvedPath, content, {
        encoding: options.encoding,
        mode: options.mode
      });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new FileNotFoundError(dirname(path2), "local");
      }
      if (error.code === "EACCES") {
        throw new PermissionError(path2, "local");
      }
      throw new FilesystemError(
        `Failed to write file: ${error.message}`,
        error.code || "UNKNOWN",
        path2,
        "local"
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
  async delete(path2) {
    try {
      const resolvedPath = this.resolvePath(path2);
      const stats = await stat(resolvedPath);
      if (stats.isDirectory()) {
        await rmdir(resolvedPath);
      } else {
        await unlink(resolvedPath);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new FileNotFoundError(path2, "local");
      }
      if (error.code === "EACCES") {
        throw new PermissionError(path2, "local");
      }
      if (error.code === "ENOTEMPTY") {
        throw new DirectoryNotEmptyError(path2, "local");
      }
      throw new FilesystemError(
        `Failed to delete: ${error.message}`,
        error.code || "UNKNOWN",
        path2,
        "local"
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
  async copy(sourcePath, destPath) {
    try {
      const resolvedSource = this.resolvePath(sourcePath);
      const resolvedDest = this.resolvePath(destPath);
      if (this.createMissing) {
        await mkdir(dirname(resolvedDest), { recursive: true });
      }
      await copyFile(resolvedSource, resolvedDest);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new FileNotFoundError(sourcePath, "local");
      }
      if (error.code === "EACCES") {
        throw new PermissionError(sourcePath, "local");
      }
      throw new FilesystemError(
        `Failed to copy: ${error.message}`,
        error.code || "UNKNOWN",
        sourcePath,
        "local"
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
  async move(sourcePath, destPath) {
    try {
      const resolvedSource = this.resolvePath(sourcePath);
      const resolvedDest = this.resolvePath(destPath);
      if (this.createMissing) {
        await mkdir(dirname(resolvedDest), { recursive: true });
      }
      await rename(resolvedSource, resolvedDest);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new FileNotFoundError(sourcePath, "local");
      }
      if (error.code === "EACCES") {
        throw new PermissionError(sourcePath, "local");
      }
      throw new FilesystemError(
        `Failed to move: ${error.message}`,
        error.code || "UNKNOWN",
        sourcePath,
        "local"
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
  async createDirectory(path2, options = {}) {
    try {
      const resolvedPath = this.resolvePath(path2);
      await mkdir(resolvedPath, {
        recursive: options.recursive ?? true,
        mode: options.mode
      });
    } catch (error) {
      if (error.code === "EACCES") {
        throw new PermissionError(path2, "local");
      }
      throw new FilesystemError(
        `Failed to create directory: ${error.message}`,
        error.code || "UNKNOWN",
        path2,
        "local"
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
  async list(path2, options = {}) {
    try {
      const resolvedPath = this.resolvePath(path2);
      const entries = await readdir(resolvedPath, { withFileTypes: true });
      const results = [];
      for (const entry of entries) {
        const fullPath = join(resolvedPath, entry.name);
        const relativePath = join(path2, entry.name);
        if (options.filter) {
          const filterPattern = typeof options.filter === "string" ? new RegExp(options.filter) : options.filter;
          if (!filterPattern.test(entry.name)) {
            continue;
          }
        }
        const stats = await stat(fullPath);
        const fileInfo = {
          name: entry.name,
          path: relativePath,
          size: stats.size,
          isDirectory: entry.isDirectory(),
          lastModified: stats.mtime,
          extension: entry.isFile() ? extname(entry.name).slice(1) : void 0
        };
        if (options.detailed) {
          fileInfo.mimeType = await this.getMimeType(relativePath);
        }
        results.push(fileInfo);
        if (options.recursive && entry.isDirectory()) {
          const subResults = await this.list(relativePath, options);
          results.push(...subResults);
        }
      }
      return results;
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new FileNotFoundError(path2, "local");
      }
      if (error.code === "EACCES") {
        throw new PermissionError(path2, "local");
      }
      throw new FilesystemError(
        `Failed to list directory: ${error.message}`,
        error.code || "UNKNOWN",
        path2,
        "local"
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
  async getStats(path2) {
    try {
      const resolvedPath = this.resolvePath(path2);
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
        gid: stats.gid
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new FileNotFoundError(path2, "local");
      }
      if (error.code === "EACCES") {
        throw new PermissionError(path2, "local");
      }
      throw new FilesystemError(
        `Failed to get stats: ${error.message}`,
        error.code || "UNKNOWN",
        path2,
        "local"
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
  async getMimeType(path2) {
    const mimeTypes2 = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".json": "application/json",
      ".css": "text/css",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".txt": "text/plain",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pdf": "application/pdf",
      ".xml": "application/xml",
      ".zip": "application/zip",
      ".rar": "application/x-rar-compressed",
      ".mp3": "audio/mpeg",
      ".mp4": "video/mp4",
      ".avi": "video/x-msvideo",
      ".mov": "video/quicktime"
    };
    const extension = extname(path2).toLowerCase();
    return mimeTypes2[extension] || "application/octet-stream";
  }
  /**
   * Upload data to a URL using PUT method (legacy)
   */
  async uploadToUrl(url, data) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        body: Buffer.isBuffer(data) ? new Uint8Array(data) : data,
        headers: { "Content-Type": "application/octet-stream" }
      });
      if (!response.ok) {
        throw new Error(`unexpected response ${response.statusText}`);
      }
      return response;
    } catch (error) {
      const err = error;
      console.error(`Error uploading data to ${url}
Error: ${err.message}`);
      throw error;
    }
  }
  /**
   * Download a file from a URL and save it to a local file (legacy)
   */
  async downloadFromUrl(url, filepath) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Unexpected response ${response.statusText}`);
      }
      const fileStream = createWriteStream(this.resolvePath(filepath));
      return new Promise((resolve2, reject) => {
        fileStream.on("error", reject);
        fileStream.on("finish", resolve2);
        response.body?.pipeTo(
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
            }
          })
        ).catch(reject);
      });
    } catch (error) {
      const err = error;
      console.error("Error downloading file:", err);
      throw error;
    }
  }
  /**
   * Download a file with caching support (legacy)
   */
  async downloadFileWithCache(url, targetPath = null) {
    const parsedUrl = new URL$1(url);
    const downloadPath = targetPath || join(
      getTempDirectory("downloads"),
      parsedUrl.hostname + parsedUrl.pathname
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
  async getCached(file, expiry = 3e5) {
    const cacheFile = resolve(getTempDirectory("cache"), file);
    const cached = existsSync(cacheFile);
    if (cached) {
      const stats = statSync(cacheFile);
      const modTime = new Date(stats.mtime);
      const now = /* @__PURE__ */ new Date();
      const isExpired = expiry && now.getTime() - modTime.getTime() > expiry;
      if (!isExpired) {
        return await readFile(cacheFile, "utf8");
      }
    }
    return void 0;
  }
  /**
   * Set data in cache (legacy)
   */
  async setCached(file, data) {
    const cacheFile = resolve(getTempDirectory("cache"), file);
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, data);
  }
  /**
   * Cache implementation using file system
   */
  cache = {
    get: async (key, expiry) => {
      return await this.getCached(key, expiry);
    },
    set: async (key, data) => {
      await this.setCached(key, data);
    },
    clear: async (key) => {
      if (key) {
        const cacheFile = resolve(getTempDirectory("cache"), key);
        try {
          await unlink(cacheFile);
        } catch {
        }
      } else {
        try {
          const cacheDir = resolve(getTempDirectory("cache"));
          await rmdir(cacheDir, { recursive: true });
        } catch {
        }
      }
    }
  };
  /**
   * Get provider capabilities
   */
  async getCapabilities() {
    return {
      streaming: true,
      atomicOperations: true,
      versioning: false,
      sharing: false,
      realTimeSync: false,
      offlineCapable: true,
      supportedOperations: [
        "exists",
        "read",
        "write",
        "delete",
        "copy",
        "move",
        "createDirectory",
        "list",
        "getStats",
        "getMimeType",
        "upload",
        "download",
        "downloadWithCache",
        "isFile",
        "isDirectory",
        "ensureDirectoryExists",
        "uploadToUrl",
        "downloadFromUrl",
        "downloadFileWithCache",
        "listFiles",
        "getCached",
        "setCached"
      ]
    };
  }
}
const local = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  LocalFilesystemProvider
}, Symbol.toStringTag, { value: "Module" }));
const providers = /* @__PURE__ */ new Map();
function registerProvider(type, factory2) {
  providers.set(type, factory2);
}
function getAvailableProviders() {
  return Array.from(providers.keys());
}
function validateOptions(options) {
  if (!options) {
    throw new FilesystemError("Provider options are required", "EINVAL");
  }
  const type = options.type || "local";
  switch (type) {
    case "local":
      break;
    case "s3": {
      const s3Opts = options;
      if (!s3Opts.region) {
        throw new FilesystemError("S3 provider requires region", "EINVAL");
      }
      if (!s3Opts.bucket) {
        throw new FilesystemError("S3 provider requires bucket", "EINVAL");
      }
      break;
    }
    case "gdrive": {
      const gdriveOpts = options;
      if (!gdriveOpts.clientId) {
        throw new FilesystemError(
          "Google Drive provider requires clientId",
          "EINVAL"
        );
      }
      if (!gdriveOpts.clientSecret) {
        throw new FilesystemError(
          "Google Drive provider requires clientSecret",
          "EINVAL"
        );
      }
      if (!gdriveOpts.refreshToken) {
        throw new FilesystemError(
          "Google Drive provider requires refreshToken",
          "EINVAL"
        );
      }
      break;
    }
    case "webdav": {
      const webdavOpts = options;
      if (!webdavOpts.baseUrl) {
        throw new FilesystemError("WebDAV provider requires baseUrl", "EINVAL");
      }
      if (!webdavOpts.username) {
        throw new FilesystemError(
          "WebDAV provider requires username",
          "EINVAL"
        );
      }
      if (!webdavOpts.password) {
        throw new FilesystemError(
          "WebDAV provider requires password",
          "EINVAL"
        );
      }
      break;
    }
    case "browser-storage":
      break;
    default:
      throw new FilesystemError(`Unknown provider type: ${type}`, "EINVAL");
  }
}
function detectProviderType(options) {
  if (options.type) {
    return options.type;
  }
  if ("region" in options && "bucket" in options) {
    return "s3";
  }
  if ("clientId" in options && "clientSecret" in options) {
    return "gdrive";
  }
  if ("baseUrl" in options && "username" in options) {
    return "webdav";
  }
  if ("databaseName" in options || "storageQuota" in options) {
    return "browser-storage";
  }
  if (typeof globalThis !== "undefined") {
    if (typeof globalThis.window !== "undefined" && typeof globalThis.indexedDB !== "undefined") {
      return "browser-storage";
    }
    if (globalThis.process?.versions?.node) {
      return "local";
    }
  }
  return "local";
}
async function getFilesystem(options = {}) {
  validateOptions(options);
  const type = detectProviderType(options);
  const providerFactory = providers.get(type);
  if (!providerFactory) {
    throw new FilesystemError(
      `Provider '${type}' is not registered. Available providers: ${getAvailableProviders().join(", ")}`,
      "ENOTFOUND"
    );
  }
  try {
    const ProviderClass = await providerFactory();
    return new ProviderClass(options);
  } catch (error) {
    throw new FilesystemError(
      `Failed to create '${type}' provider: ${error instanceof Error ? error.message : String(error)}`,
      "ENOENT",
      void 0,
      type
    );
  }
}
async function initializeProviders() {
  registerProvider("local", async () => {
    const { LocalFilesystemProvider: LocalFilesystemProvider2 } = await Promise.resolve().then(() => local);
    return LocalFilesystemProvider2;
  });
}
function isProviderAvailable(type) {
  return providers.has(type);
}
function getProviderInfo(type) {
  const descriptions = {
    local: "Local filesystem provider using Node.js fs module",
    s3: "S3-compatible provider supporting AWS S3, MinIO, and other S3-compatible services",
    gdrive: "Google Drive provider using Google Drive API v3",
    webdav: "WebDAV provider supporting Nextcloud, ownCloud, Apache mod_dav, and other WebDAV servers",
    "browser-storage": "Browser storage provider using IndexedDB for app file management"
  };
  const requiredOptions = {
    local: [],
    s3: ["region", "bucket"],
    gdrive: ["clientId", "clientSecret", "refreshToken"],
    webdav: ["baseUrl", "username", "password"],
    "browser-storage": []
  };
  return {
    available: isProviderAvailable(type),
    description: descriptions[type] || "Unknown provider",
    requiredOptions: requiredOptions[type] || []
  };
}
const factory = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  getAvailableProviders,
  getFilesystem,
  getProviderInfo,
  initializeProviders,
  isProviderAvailable,
  registerProvider
}, Symbol.toStringTag, { value: "Module" }));
class RateLimiter {
  /**
   * Map of domains to their rate limit configurations
   * Each domain tracks: lastRequest time, request limit, interval, and current queue size
   */
  domains = /* @__PURE__ */ new Map();
  /**
   * Default maximum number of requests per interval
   * Applied to domains that don't have specific limits configured
   */
  defaultLimit = 6;
  /**
   * Default interval in milliseconds (500ms)
   * Time window for the request limit enforcement
   */
  defaultInterval = 500;
  /**
   * Creates a new RateLimiter with default settings
   * Initializes with a 'default' domain configuration used as fallback
   */
  constructor() {
    this.domains.set("default", {
      lastRequest: 0,
      limit: this.defaultLimit,
      interval: this.defaultInterval,
      queue: 0
    });
  }
  /**
   * Extracts the domain from a URL for rate limiting purposes
   *
   * @param url - URL to extract domain from
   * @returns Domain string (hostname) or 'default' if the URL is invalid
   *
   * @internal
   */
  getDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "default";
    }
  }
  /**
   * Waits until the next request can be made according to rate limits
   *
   * This method implements the core rate limiting logic. It checks if the
   * current request would exceed the domain's rate limit and delays if necessary.
   *
   * @param url - URL to check rate limits for (domain extracted automatically)
   * @returns Promise that resolves when the request can proceed safely
   *
   * @internal
   */
  async waitForNext(url) {
    const domain = this.getDomain(url);
    const now = Date.now();
    const domainConfig = this.domains.get(domain) || this.domains.get("default");
    if (domainConfig.queue >= domainConfig.limit) {
      const timeToWait = Math.max(
        0,
        domainConfig.lastRequest + domainConfig.interval - now
      );
      if (timeToWait > 0) {
        await new Promise((resolve2) => setTimeout(resolve2, timeToWait));
      }
      domainConfig.queue = 0;
    }
    domainConfig.lastRequest = now;
    domainConfig.queue++;
  }
  /**
   * Sets rate limit for a specific domain
   *
   * @param domain - Domain to set limits for
   * @param limit - Maximum number of requests per interval
   * @param interval - Interval in milliseconds
   */
  setDomainLimit(domain, limit, interval) {
    this.domains.set(domain, {
      lastRequest: 0,
      limit,
      interval,
      queue: 0
    });
  }
  /**
   * Gets rate limit configuration for a domain
   *
   * @param domain - Domain to get limits for
   * @returns Rate limit configuration
   */
  getDomainLimit(domain) {
    return this.domains.get(domain) || this.domains.get("default");
  }
}
const rateLimiter = new RateLimiter();
async function addRateLimit(domain, limit, interval) {
  rateLimiter.setDomainLimit(domain, limit, interval);
}
async function getRateLimit(domain) {
  const config = rateLimiter.getDomainLimit(domain);
  return {
    limit: config.limit,
    interval: config.interval
  };
}
async function rateLimitedFetch(url, options) {
  await rateLimiter.waitForNext(url);
  return fetch(url, options);
}
async function fetchText(url) {
  const response = await rateLimitedFetch(url);
  return response.text();
}
async function fetchJSON(url) {
  const response = await rateLimitedFetch(url);
  return response.json();
}
async function fetchBuffer(url) {
  const response = await rateLimitedFetch(url);
  return Buffer.from(await response.arrayBuffer());
}
async function fetchToFile(url, filepath) {
  const response = await rateLimitedFetch(url);
  const buffer = await response.arrayBuffer();
  await writeFile(filepath, Buffer.from(buffer));
}
class FilesystemAdapter {
  /**
   * Configuration options
   */
  options;
  /**
   * Cache directory path
   */
  cacheDir;
  /**
   * Creates a new FilesystemAdapter instance
   *
   * @param options - Configuration options
   */
  constructor(options) {
    this.options = options;
    this.cacheDir = options.cacheDir || getTempDirectory("cache");
  }
  /**
   * Factory method to create and initialize a FilesystemAdapter
   *
   * @param options - Configuration options
   * @returns Promise resolving to an initialized FilesystemAdapter
   */
  static async create(options) {
    const fs = new FilesystemAdapter(options);
    await fs.initialize();
    return fs;
  }
  /**
   * Initializes the adapter by creating the cache directory
   */
  async initialize() {
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
  async download(_url, _options = {
    force: false
  }) {
    return "";
  }
  /**
   * Checks if a file or directory exists
   *
   * @param path - Path to check
   * @returns Promise resolving to boolean indicating existence
   */
  async exists(_path) {
    return false;
  }
  /**
   * Reads a file's contents
   *
   * @param path - Path to the file
   * @returns Promise resolving to the file contents as a string
   */
  async read(_path) {
    return "";
  }
  /**
   * Writes content to a file
   *
   * @param path - Path to the file
   * @param content - Content to write
   * @returns Promise that resolves when the write is complete
   */
  async write(_path, _content) {
  }
  /**
   * Deletes a file or directory
   *
   * @param path - Path to delete
   * @returns Promise that resolves when the deletion is complete
   */
  async delete(_path) {
  }
  /**
   * Lists files in a directory
   *
   * @param path - Directory path to list
   * @returns Promise resolving to an array of file names
   */
  async list(_path) {
    return [];
  }
  /**
   * Gets data from cache if available and not expired
   *
   * @param file - Cache file identifier
   * @param expiry - Cache expiry time in milliseconds
   * @returns Promise resolving to the cached data or undefined if not found/expired
   */
  async getCached(file, expiry = 3e5) {
    return getCached(file, expiry);
  }
  /**
   * Sets data in cache
   *
   * @param file - Cache file identifier
   * @param data - Data to cache
   * @returns Promise that resolves when the data is cached
   */
  async setCached(file, data) {
    return setCached(file, data);
  }
}
const TMP_DIR = path.resolve(getTempDirectory("kissd"));
const isFile = (file) => {
  try {
    const fileStat = statSync(file);
    return fileStat.isDirectory() ? false : fileStat;
  } catch {
    return false;
  }
};
const isDirectory = (dir) => {
  try {
    const dirStat = statSync(dir);
    if (dirStat.isDirectory()) return true;
    throw new Error(`${dir} exists but isn't a directory`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      return false;
    }
    throw error;
  }
};
const ensureDirectoryExists = async (dir) => {
  if (!isDirectory(dir)) {
    console.log(`Creating directory: ${dir}`);
    await mkdir(dir, { recursive: true });
  }
};
const upload = async (url, data) => {
  try {
    const response = await fetch(url, {
      method: "PUT",
      body: Buffer.isBuffer(data) ? new Uint8Array(data) : data,
      headers: { "Content-Type": "application/octet-stream" }
    });
    if (!response.ok) {
      throw new Error(`unexpected response ${response.statusText}`);
    }
    return response;
  } catch (error) {
    const err = error;
    console.error(`Error uploading data to ${url}
Error: ${err.message}`);
    throw error;
  }
};
async function download(url, filepath) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Unexpected response ${response.statusText}`);
    }
    const fileStream = createWriteStream(filepath);
    return new Promise((resolve2, reject) => {
      fileStream.on("error", reject);
      fileStream.on("finish", resolve2);
      response.body?.pipeTo(
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
          }
        })
      ).catch(reject);
    });
  } catch (error) {
    const err = error;
    console.error("Error downloading file:", err);
    throw error;
  }
}
const downloadFileWithCache = async (url, targetPath = null) => {
  const parsedUrl = new URL$1(url);
  console.log(targetPath);
  const downloadPath = targetPath || `${TMP_DIR}/downloads/${parsedUrl.hostname}${parsedUrl.pathname}`;
  console.log("downloadPath", downloadPath);
  if (!isFile(downloadPath)) {
    await ensureDirectoryExists(dirname(downloadPath));
    await download(url, downloadPath);
  }
  return downloadPath;
};
const listFiles = async (dirPath, options = { match: /.*/ }) => {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  return options.match ? files.filter((item) => options.match?.test(item)) : files;
};
async function getCached(file, expiry = 3e5) {
  const cacheFile = path.resolve(TMP_DIR, file);
  const cached = existsSync(cacheFile);
  if (cached) {
    const stats = statSync(cacheFile);
    const modTime = new Date(stats.mtime);
    const now = /* @__PURE__ */ new Date();
    const isExpired = expiry && now.getTime() - modTime.getTime() > expiry;
    if (!isExpired) {
      return await readFile(cacheFile, "utf8");
    }
  }
}
async function setCached(file, data) {
  const cacheFile = path.resolve(TMP_DIR, file);
  await ensureDirectoryExists(path.dirname(cacheFile));
  await writeFile(cacheFile, data);
}
const mimeTypes = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".rar": "application/x-rar-compressed",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime"
  // Add more mappings as needed
};
function getMimeType(fileOrUrl) {
  const urlPattern = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;
  let extension;
  if (urlPattern.test(fileOrUrl)) {
    const url = new URL$1(fileOrUrl);
    extension = path.extname(url.pathname);
  } else {
    extension = path.extname(fileOrUrl);
  }
  return mimeTypes[extension.toLowerCase()] || "application/octet-stream";
}
Promise.resolve().then(() => factory).then(({ initializeProviders: initializeProviders2 }) => {
  initializeProviders2().catch(() => {
  });
});
export {
  DirectoryNotEmptyError,
  FileNotFoundError,
  FilesystemAdapter,
  FilesystemError,
  InvalidPathError,
  LocalFilesystemProvider,
  PermissionError,
  addRateLimit,
  factory as default,
  download,
  downloadFileWithCache,
  ensureDirectoryExists,
  fetchBuffer,
  fetchJSON,
  fetchText,
  fetchToFile,
  getAvailableProviders,
  getCached,
  getFilesystem,
  getMimeType,
  getProviderInfo,
  getRateLimit,
  initializeProviders,
  isDirectory,
  isFile,
  isProviderAvailable,
  listFiles,
  registerProvider,
  setCached,
  upload
};
//# sourceMappingURL=index.js.map
