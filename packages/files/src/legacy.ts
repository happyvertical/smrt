/**
 * Legacy compatibility functions
 *
 * These functions maintain backward compatibility with the existing @have/files API
 * while internally using the new standardized interface.
 */

import { createWriteStream, type Dirent, existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { dirname } from 'node:path';
import { URL } from 'node:url';
import { getTempDirectory } from '@have/utils';

/**
 * Default temporary directory for caching and intermediate files
 */
const TMP_DIR = path.resolve(getTempDirectory('kissd'));

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
export const isFile = (file: string): false | ReturnType<typeof statSync> => {
  try {
    const fileStat = statSync(file);
    return fileStat.isDirectory() ? false : fileStat;
  } catch {
    return false;
  }
};

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
export const isDirectory = (dir: string): boolean => {
  try {
    const dirStat = statSync(dir);
    if (dirStat.isDirectory()) return true;
    throw new Error(`${dir} exists but isn't a directory`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOENT')) {
      return false;
    }
    throw error;
  }
};

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
export const ensureDirectoryExists = async (dir: string): Promise<void> => {
  if (!isDirectory(dir)) {
    console.log(`Creating directory: ${dir}`);
    await mkdir(dir, { recursive: true });
  }
};

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
export const upload = async (
  url: string,
  data: string | Buffer,
): Promise<Response> => {
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
    throw error; // Re-throw to allow proper error handling
  }
};

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
export async function download(url: string, filepath: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Unexpected response ${response.statusText}`);
    }

    const fileStream = createWriteStream(filepath);

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
export const downloadFileWithCache = async (
  url: string,
  targetPath: string | null = null,
): Promise<string> => {
  const parsedUrl = new URL(url);

  console.log(targetPath);
  const downloadPath =
    targetPath ||
    `${TMP_DIR}/downloads/${parsedUrl.hostname}${parsedUrl.pathname}`;

  console.log('downloadPath', downloadPath);
  if (!isFile(downloadPath)) {
    await ensureDirectoryExists(dirname(downloadPath));
    await download(url, downloadPath);
  }
  return downloadPath;
};

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
export const listFiles = async (
  dirPath: string,
  options: ListFilesOptions = { match: /.*/ },
): Promise<string[]> => {
  const entries: Dirent[] = await readdir(dirPath, { withFileTypes: true });
  const files = entries
    .filter((entry: Dirent) => entry.isFile())
    .map((entry: Dirent) => entry.name);

  return options.match
    ? files.filter((item) => options.match?.test(item))
    : files;
};

/**
 * Gets data from cache if available and not expired
 *
 * @param file - Cache file identifier
 * @param expiry - Cache expiry time in milliseconds
 * @returns Promise that resolves with the cached data or undefined if not found/expired
 */
export async function getCached(file: string, expiry = 300000) {
  const cacheFile = path.resolve(TMP_DIR, file);
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
}

/**
 * Sets data in cache
 *
 * @param file - Cache file identifier
 * @param data - Data to cache
 * @returns Promise that resolves when the data is cached
 */
export async function setCached(file: string, data: string) {
  const cacheFile = path.resolve(TMP_DIR, file);
  await ensureDirectoryExists(path.dirname(cacheFile));
  await writeFile(cacheFile, data);
}

/**
 * Map of file extensions to MIME types
 */
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
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  // Add more mappings as needed
};

/**
 * Gets the MIME type for a file or URL based on its extension
 *
 * @param fileOrUrl - File path or URL to get MIME type for
 * @returns MIME type string, defaults to 'application/octet-stream' if not found
 */
export function getMimeType(fileOrUrl: string): string {
  const urlPattern = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//; // Matches any valid URL scheme
  let extension: string;

  if (urlPattern.test(fileOrUrl)) {
    // It's a URL, extract the pathname
    const url = new URL(fileOrUrl);
    extension = path.extname(url.pathname);
  } else {
    // It's a file path
    extension = path.extname(fileOrUrl);
  }

  return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
}
