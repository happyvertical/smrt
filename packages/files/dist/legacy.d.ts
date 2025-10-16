import { statSync } from 'node:fs';
/**
 * Checks if a path is a file (legacy compatibility function)
 *
 * This function provides backward compatibility with the existing @have/files API.
 * It synchronously checks if the given path exists and is a file (not a directory).
 *
 * @param file - Path to check
 * @returns File stats object if the path is a file, false otherwise
 *
 * @example
 * ```typescript
 * const stats = isFile('/path/to/document.txt');
 * if (stats) {
 *   console.log(`File size: ${stats.size} bytes`);
 *   console.log(`Modified: ${stats.mtime}`);
 * }
 * ```
 *
 * @deprecated Use the async filesystem interface methods instead
 */
export declare const isFile: (file: string) => false | ReturnType<typeof statSync>;
/**
 * Checks if a path is a directory (legacy compatibility function)
 *
 * This function provides backward compatibility with the existing @have/files API.
 * It synchronously checks if the given path exists and is a directory.
 *
 * @param dir - Path to check
 * @returns True if the path is a directory, false if it doesn't exist
 * @throws {Error} If the path exists but is not a directory
 *
 * @example
 * ```typescript
 * try {
 *   const isDir = isDirectory('/path/to/folder');
 *   if (isDir) {
 *     console.log('Path is a directory');
 *   } else {
 *     console.log('Directory does not exist');
 *   }
 * } catch (error) {
 *   console.error('Path exists but is not a directory');
 * }
 * ```
 *
 * @deprecated Use the async filesystem interface methods instead
 */
export declare const isDirectory: (dir: string) => boolean;
/**
 * Creates a directory if it doesn't exist (legacy compatibility function)
 *
 * This function provides backward compatibility with the existing @have/files API.
 * It ensures a directory exists by creating it (and any parent directories) if needed.
 *
 * @param dir - Directory path to create
 * @returns Promise that resolves when the directory exists or has been created
 *
 * @example
 * ```typescript
 * await ensureDirectoryExists('/path/to/nested/directory');
 * console.log('Directory is ready for use');
 * ```
 *
 * @deprecated Use the async filesystem interface createDirectory method instead
 */
export declare const ensureDirectoryExists: (dir: string) => Promise<void>;
/**
 * Uploads data to a URL using PUT method (legacy compatibility function)
 *
 * This function provides backward compatibility with the existing @have/files API.
 * It performs an HTTP PUT request to upload data to a remote URL.
 *
 * @param url - URL to upload data to
 * @param data - String or Buffer data to upload
 * @returns Promise that resolves with the Response object
 * @throws {Error} If the upload fails (network error or non-2xx response)
 *
 * @example
 * ```typescript
 * const response = await upload('https://api.example.com/files/document.txt', 'file content');
 * console.log('Upload successful:', response.status);
 *
 * // Upload binary data
 * const imageBuffer = await fs.readFile('image.png');
 * await upload('https://api.example.com/files/image.png', imageBuffer);
 * ```
 *
 * @deprecated Use the async filesystem interface upload method instead
 */
export declare const upload: (url: string, data: string | Buffer) => Promise<Response>;
/**
 * Downloads a file from a URL and saves it to a local file (legacy compatibility function)
 *
 * This function provides backward compatibility with the existing @have/files API.
 * It downloads content from a URL and writes it to a local file using streaming
 * to handle large files efficiently.
 *
 * @param url - URL to download from
 * @param filepath - Local file path to save to
 * @returns Promise that resolves when the download is complete
 * @throws {Error} If the download fails (network error, file write error, etc.)
 *
 * @example
 * ```typescript
 * await download('https://example.com/document.pdf', './downloads/document.pdf');
 * console.log('Download complete');
 *
 * // Download with error handling
 * try {
 *   await download('https://example.com/large-file.zip', './temp/file.zip');
 * } catch (error) {
 *   console.error('Download failed:', error.message);
 * }
 * ```
 *
 * @deprecated Use the async filesystem interface download method instead
 */
export declare function download(url: string, filepath: string): Promise<void>;
/**
 * Downloads a file with caching support (legacy compatibility function)
 *
 * This function provides backward compatibility with the existing @have/files API.
 * It downloads a file only if it doesn't already exist locally, implementing
 * a simple caching mechanism to avoid redundant downloads.
 *
 * @param url - URL to download from
 * @param targetPath - Optional custom target path. If null, uses a generated path in temp directory
 * @returns Promise that resolves with the path to the downloaded file (either cached or newly downloaded)
 *
 * @example
 * ```typescript
 * // Download with auto-generated cache path
 * const filePath = await downloadFileWithCache('https://example.com/data.json');
 * console.log('File available at:', filePath);
 *
 * // Download to specific path
 * const customPath = await downloadFileWithCache(
 *   'https://example.com/document.pdf',
 *   './cache/document.pdf'
 * );
 * ```
 *
 * @deprecated Use the async filesystem interface downloadWithCache method instead
 */
export declare const downloadFileWithCache: (url: string, targetPath?: string | null) => Promise<string>;
/**
 * Options for listing files in a directory
 */
interface ListFilesOptions {
    /**
     * Optional regular expression to filter files by name
     */
    match?: RegExp;
}
/**
 * Lists files in a directory with optional filtering (legacy compatibility function)
 *
 * This function provides backward compatibility with the existing @have/files API.
 * It returns only files (not directories) from the specified directory, with
 * optional regular expression filtering.
 *
 * @param dirPath - Directory path to list files from
 * @param options - Filtering options
 * @param options.match - Optional regular expression to filter files by name
 * @returns Promise that resolves with an array of file names (not full paths)
 *
 * @example
 * ```typescript
 * // List all files
 * const allFiles = await listFiles('/path/to/directory');
 * console.log('Files:', allFiles);
 *
 * // List only JavaScript files
 * const jsFiles = await listFiles('/project/src', { match: /\.js$/ });
 * console.log('JS files:', jsFiles);
 *
 * // List image files
 * const images = await listFiles('/photos', { match: /\.(jpg|png|gif)$/i });
 * ```
 *
 * @deprecated Use the async filesystem interface list method instead
 */
export declare const listFiles: (dirPath: string, options?: ListFilesOptions) => Promise<string[]>;
/**
 * Gets data from cache if available and not expired
 *
 * @param file - Cache file identifier
 * @param expiry - Cache expiry time in milliseconds
 * @returns Promise that resolves with the cached data or undefined if not found/expired
 */
export declare function getCached(file: string, expiry?: number): Promise<string | undefined>;
/**
 * Sets data in cache
 *
 * @param file - Cache file identifier
 * @param data - Data to cache
 * @returns Promise that resolves when the data is cached
 */
export declare function setCached(file: string, data: string): Promise<void>;
/**
 * Gets the MIME type for a file or URL based on its extension
 *
 * @param fileOrUrl - File path or URL to get MIME type for
 * @returns MIME type string, defaults to 'application/octet-stream' if not found
 */
export declare function getMimeType(fileOrUrl: string): string;
export {};
//# sourceMappingURL=legacy.d.ts.map