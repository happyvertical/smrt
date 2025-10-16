import {
  FilesystemError,
  type FilesystemInterface,
  type GetFilesystemOptions,
  type GoogleDriveOptions,
  type S3Options,
  type WebDAVOptions,
} from './types';

/**
 * Registry of available filesystem providers
 * Maps provider type strings to factory functions that create provider instances
 */
const providers = new Map<string, () => Promise<any>>();

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
export function registerProvider(
  type: string,
  factory: () => Promise<any>,
): void {
  providers.set(type, factory);
}

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
export function getAvailableProviders(): string[] {
  return Array.from(providers.keys());
}

/**
 * Validate provider configuration options
 *
 * Performs comprehensive validation of provider options to ensure all required
 * parameters are present and valid for the specified provider type.
 *
 * @param options - Provider configuration options to validate
 * @throws {FilesystemError} When required options are missing or invalid
 *
 * @internal
 */
function validateOptions(options: GetFilesystemOptions): void {
  if (!options) {
    throw new FilesystemError('Provider options are required', 'EINVAL');
  }

  const type = options.type || 'local';

  switch (type) {
    case 'local':
      // Local provider has no required options
      break;

    case 's3': {
      const s3Opts = options as S3Options;
      if (!s3Opts.region) {
        throw new FilesystemError('S3 provider requires region', 'EINVAL');
      }
      if (!s3Opts.bucket) {
        throw new FilesystemError('S3 provider requires bucket', 'EINVAL');
      }
      break;
    }

    case 'gdrive': {
      const gdriveOpts = options as GoogleDriveOptions;
      if (!gdriveOpts.clientId) {
        throw new FilesystemError(
          'Google Drive provider requires clientId',
          'EINVAL',
        );
      }
      if (!gdriveOpts.clientSecret) {
        throw new FilesystemError(
          'Google Drive provider requires clientSecret',
          'EINVAL',
        );
      }
      if (!gdriveOpts.refreshToken) {
        throw new FilesystemError(
          'Google Drive provider requires refreshToken',
          'EINVAL',
        );
      }
      break;
    }

    case 'webdav': {
      const webdavOpts = options as WebDAVOptions;
      if (!webdavOpts.baseUrl) {
        throw new FilesystemError('WebDAV provider requires baseUrl', 'EINVAL');
      }
      if (!webdavOpts.username) {
        throw new FilesystemError(
          'WebDAV provider requires username',
          'EINVAL',
        );
      }
      if (!webdavOpts.password) {
        throw new FilesystemError(
          'WebDAV provider requires password',
          'EINVAL',
        );
      }
      break;
    }

    case 'browser-storage':
      // Browser storage provider has no required options
      break;

    default:
      throw new FilesystemError(`Unknown provider type: ${type}`, 'EINVAL');
  }
}

/**
 * Automatically detect provider type from configuration options
 *
 * Analyzes the provided options to determine the most appropriate provider type.
 * Uses heuristics based on the presence of specific required fields and the
 * current runtime environment (Node.js vs browser).
 *
 * @param options - Provider configuration options to analyze
 * @returns Detected provider type string (e.g., 'local', 's3', 'webdav')
 *
 * @example
 * ```typescript
 * // Detects 's3' provider
 * const type = detectProviderType({ region: 'us-east-1', bucket: 'my-bucket' });
 *
 * // Detects 'webdav' provider
 * const type = detectProviderType({ baseUrl: 'https://cloud.example.com', username: 'user' });
 * ```
 *
 * @internal
 */
function detectProviderType(options: GetFilesystemOptions): string {
  if (options.type) {
    return options.type;
  }

  // Auto-detect based on required fields
  if ('region' in options && 'bucket' in options) {
    return 's3';
  }

  if ('clientId' in options && 'clientSecret' in options) {
    return 'gdrive';
  }

  if ('baseUrl' in options && 'username' in options) {
    return 'webdav';
  }

  if ('databaseName' in options || 'storageQuota' in options) {
    return 'browser-storage';
  }

  // Default depends on environment
  if (typeof globalThis !== 'undefined') {
    // Check for browser environment indicators
    if (
      typeof (globalThis as any).window !== 'undefined' &&
      typeof (globalThis as any).indexedDB !== 'undefined'
    ) {
      return 'browser-storage';
    }
    if ((globalThis as any).process?.versions?.node) {
      return 'local';
    }
  }

  // Fallback detection
  return 'local';
}

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
export async function getFilesystem(
  options: GetFilesystemOptions = {},
): Promise<FilesystemInterface> {
  // Validate options
  validateOptions(options);

  // Detect provider type
  const type = detectProviderType(options);

  // Get provider factory
  const providerFactory = providers.get(type);
  if (!providerFactory) {
    throw new FilesystemError(
      `Provider '${type}' is not registered. Available providers: ${getAvailableProviders().join(', ')}`,
      'ENOTFOUND',
    );
  }

  try {
    // Create provider instance
    const ProviderClass = await providerFactory();
    return new ProviderClass(options);
  } catch (error) {
    throw new FilesystemError(
      `Failed to create '${type}' provider: ${error instanceof Error ? error.message : String(error)}`,
      'ENOENT',
      undefined,
      type,
    );
  }
}

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
export async function initializeProviders(): Promise<void> {
  // Register local provider (always available in Node.js environment)
  registerProvider('local', async () => {
    const { LocalFilesystemProvider } = await import('../node/local.js');
    return LocalFilesystemProvider;
  });

  // In browser context, the browser entry point will register the browser-storage provider
  // For tests running in Node.js, we only register the local provider
}

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
export function isProviderAvailable(type: string): boolean {
  return providers.has(type);
}

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
export function getProviderInfo(type: string): {
  available: boolean;
  description: string;
  requiredOptions: string[];
} {
  const descriptions = {
    local: 'Local filesystem provider using Node.js fs module',
    s3: 'S3-compatible provider supporting AWS S3, MinIO, and other S3-compatible services',
    gdrive: 'Google Drive provider using Google Drive API v3',
    webdav:
      'WebDAV provider supporting Nextcloud, ownCloud, Apache mod_dav, and other WebDAV servers',
    'browser-storage':
      'Browser storage provider using IndexedDB for app file management',
  };

  const requiredOptions = {
    local: [],
    s3: ['region', 'bucket'],
    gdrive: ['clientId', 'clientSecret', 'refreshToken'],
    webdav: ['baseUrl', 'username', 'password'],
    'browser-storage': [],
  };

  return {
    available: isProviderAvailable(type),
    description:
      descriptions[type as keyof typeof descriptions] || 'Unknown provider',
    requiredOptions:
      requiredOptions[type as keyof typeof requiredOptions] || [],
  };
}
