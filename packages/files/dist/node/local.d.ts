import { BaseFilesystemProvider } from '../shared/base';
import { CreateDirOptions, FileInfo, FileStats, FilesystemCapabilities, ListOptions, LocalOptions, ReadOptions, WriteOptions } from '../shared/types';
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
export declare class LocalFilesystemProvider extends BaseFilesystemProvider {
    private readonly rootPath;
    constructor(options?: LocalOptions);
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
    private resolvePath;
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
    exists(path: string): Promise<boolean>;
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
    read(path: string, options?: ReadOptions): Promise<string | Buffer>;
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
    write(path: string, content: string | Buffer, options?: WriteOptions): Promise<void>;
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
    delete(path: string): Promise<void>;
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
    copy(sourcePath: string, destPath: string): Promise<void>;
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
    move(sourcePath: string, destPath: string): Promise<void>;
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
    createDirectory(path: string, options?: CreateDirOptions): Promise<void>;
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
    list(path: string, options?: ListOptions): Promise<FileInfo[]>;
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
    getStats(path: string): Promise<FileStats>;
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
    getMimeType(path: string): Promise<string>;
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
    downloadFileWithCache(url: string, targetPath?: string | null): Promise<string>;
    /**
     * Get data from cache if available and not expired (legacy)
     */
    getCached(file: string, expiry?: number): Promise<string | undefined>;
    /**
     * Set data in cache (legacy)
     */
    setCached(file: string, data: string): Promise<void>;
    /**
     * Cache implementation using file system
     */
    cache: {
        get: (key: string, expiry?: number) => Promise<string | undefined>;
        set: (key: string, data: string) => Promise<void>;
        clear: (key?: string) => Promise<void>;
    };
    /**
     * Get provider capabilities
     */
    getCapabilities(): Promise<FilesystemCapabilities>;
}
//# sourceMappingURL=local.d.ts.map