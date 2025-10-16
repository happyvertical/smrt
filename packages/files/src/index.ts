/**
 * @have/files - Standardized filesystem interface with multi-provider support
 *
 * This package provides a unified interface for file operations across different
 * storage backends including local filesystem, S3-compatible services, Google Drive,
 * WebDAV servers (Nextcloud/ownCloud), and browser storage.
 *
 * The package follows a provider pattern where different storage backends implement
 * the same FilesystemInterface, allowing applications to work with files consistently
 * regardless of the underlying storage system.
 *
 * ## Key Features
 * - Unified API across multiple storage providers
 * - Async/await support for all operations
 * - Comprehensive error handling with typed exceptions
 * - Built-in caching and rate limiting
 * - Legacy compatibility with existing @have/files APIs
 * - TypeScript support with full type definitions
 * - Cross-platform path handling and security
 *
 * ## Supported Providers
 * - **Local**: Node.js filesystem (fs/promises)
 * - **S3**: AWS S3 and S3-compatible services (MinIO, DigitalOcean Spaces)
 * - **Google Drive**: Google Drive API v3
 * - **WebDAV**: Nextcloud, ownCloud, Apache mod_dav
 * - **Browser Storage**: IndexedDB for web applications
 *
 * @example
 * ```typescript
 * import { getFilesystem } from '@have/files';
 *
 * // Create a local filesystem instance
 * const fs = await getFilesystem({ type: 'local', basePath: '/app/data' });
 *
 * // Use the unified API
 * await fs.write('config.json', JSON.stringify({ key: 'value' }));
 * const content = await fs.read('config.json');
 * const files = await fs.list('.', { filter: /\.json$/ });
 * ```
 *
 * @packageDocumentation
 */

// Export provider classes for direct instantiation if needed
export { LocalFilesystemProvider } from './node/local';
// Export main factory function and types
export {
  getAvailableProviders,
  getFilesystem,
  getProviderInfo,
  initializeProviders,
  isProviderAvailable,
  registerProvider,
} from './shared/factory';
export * from './shared/types';

// Note: S3, GoogleDrive, WebDAV providers will be available when external dependencies are added

// Re-export fetch utilities with rate limiting
export {
  addRateLimit,
  fetchBuffer,
  fetchJSON,
  fetchText,
  fetchToFile,
  getRateLimit,
} from './fetch';
// Re-export existing filesystem adapter classes for compatibility
export * from './filesystem';
// Re-export legacy functions for backward compatibility
export {
  download,
  downloadFileWithCache,
  ensureDirectoryExists,
  getCached,
  getMimeType,
  isDirectory,
  isFile,
  listFiles,
  setCached,
  upload,
} from './legacy';

// Initialize providers on module load
// This ensures providers are available immediately after import
import('./shared/factory.js').then(({ initializeProviders }) => {
  initializeProviders().catch(() => {
    // Silently ignore initialization errors - individual providers will fail when used
    // This allows the module to load even if some providers can't be initialized
  });
});

// Default export provides the factory functions for convenience
import * as factory from './shared/factory';

/**
 * Default export containing all factory functions
 * @deprecated Use named imports instead for better tree-shaking
 */
export default factory;
