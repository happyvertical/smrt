import { FilesystemInterface, GetFilesystemOptions } from './types';
/**
 * Register a filesystem provider factory function
 *
 * This function allows registration of new filesystem providers at runtime.
 * Each provider must implement the FilesystemInterface.
 *
 * @param type - The provider type identifier (e.g., 'local', 's3', 'webdav')
 * @param factory - Async factory function that returns the provider class constructor
 *
 * @example
 * ```typescript
 * registerProvider('custom', async () => {
 *   const { CustomProvider } = await import('./custom-provider.js');
 *   return CustomProvider;
 * });
 * ```
 */
export declare function registerProvider(type: string, factory: () => Promise<any>): void;
/**
 * Get list of available provider types
 *
 * Returns an array of all registered filesystem provider type identifiers.
 * This can be used to check which providers are available in the current environment.
 *
 * @returns Array of provider type strings (e.g., ['local', 's3', 'webdav'])
 *
 * @example
 * ```typescript
 * const availableProviders = getAvailableProviders();
 * console.log('Available providers:', availableProviders);
 * // Output: ['local', 's3', 'webdav']
 * ```
 */
export declare function getAvailableProviders(): string[];
/**
 * Create a filesystem instance with the specified provider and configuration
 *
 * This is the main entry point for creating filesystem instances. It automatically
 * detects the provider type from the options, validates the configuration, and
 * returns a fully configured filesystem interface.
 *
 * @param options - Provider configuration options. Defaults to local filesystem if not specified
 * @returns Promise resolving to a configured filesystem instance
 * @throws {FilesystemError} When provider options are invalid or provider creation fails
 *
 * @example
 * ```typescript
 * // Create local filesystem provider
 * const localFs = await getFilesystem({ type: 'local', basePath: '/app/data' });
 *
 * // Create S3 provider
 * const s3Fs = await getFilesystem({
 *   type: 's3',
 *   region: 'us-east-1',
 *   bucket: 'my-bucket',
 *   accessKeyId: 'AKIA...',
 *   secretAccessKey: 'secret'
 * });
 *
 * // Create WebDAV provider for Nextcloud
 * const webdavFs = await getFilesystem({
 *   type: 'webdav',
 *   baseUrl: 'https://cloud.example.com',
 *   username: 'user',
 *   password: 'password',
 *   davPath: '/remote.php/dav/files/user/'
 * });
 *
 * // Auto-detect provider type from options
 * const autoFs = await getFilesystem({ region: 'us-west-2', bucket: 'data' }); // detects S3
 * ```
 */
export declare function getFilesystem(options?: GetFilesystemOptions): Promise<FilesystemInterface>;
/**
 * Initialize and register all available filesystem providers
 *
 * This function registers the built-in providers that are available in the current
 * environment. It's called automatically when the module is imported, but can be
 * called manually if needed.
 *
 * In Node.js environments, this registers the local filesystem provider.
 * In browser environments, this would register the browser storage provider.
 *
 * @returns Promise that resolves when all providers are registered
 *
 * @example
 * ```typescript
 * // Manually reinitialize providers
 * await initializeProviders();
 * console.log('Providers:', getAvailableProviders());
 * ```
 */
export declare function initializeProviders(): Promise<void>;
/**
 * Check if a specific provider type is available
 *
 * Determines whether a provider has been registered and is available for use.
 * This is useful for feature detection and graceful degradation.
 *
 * @param type - Provider type to check (e.g., 'local', 's3', 'webdav')
 * @returns True if the provider is registered and available, false otherwise
 *
 * @example
 * ```typescript
 * if (isProviderAvailable('s3')) {
 *   // Use S3 provider
 *   const fs = await getFilesystem({ type: 's3', region: 'us-east-1', bucket: 'data' });
 * } else {
 *   // Fallback to local provider
 *   const fs = await getFilesystem({ type: 'local' });
 * }
 * ```
 */
export declare function isProviderAvailable(type: string): boolean;
/**
 * Get detailed information about a specific provider
 *
 * Returns comprehensive information about a provider including availability,
 * description, and required configuration options.
 *
 * @param type - Provider type to get information about
 * @returns Object containing provider availability, description, and required options
 *
 * @example
 * ```typescript
 * const s3Info = getProviderInfo('s3');
 * console.log(s3Info);
 * // {
 * //   available: true,
 * //   description: 'S3-compatible provider supporting AWS S3, MinIO, and other S3-compatible services',
 * //   requiredOptions: ['region', 'bucket']
 * // }
 *
 * // Check requirements before configuration
 * const webdavInfo = getProviderInfo('webdav');
 * if (webdavInfo.available) {
 *   console.log('WebDAV requires:', webdavInfo.requiredOptions);
 *   // ['baseUrl', 'username', 'password']
 * }
 * ```
 */
export declare function getProviderInfo(type: string): {
    available: boolean;
    description: string;
    requiredOptions: string[];
};
//# sourceMappingURL=factory.d.ts.map