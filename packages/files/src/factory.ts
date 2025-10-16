import {
  FilesystemError,
  type FilesystemInterface,
  type GetFilesystemOptions,
  type GoogleDriveOptions,
  type S3Options,
  type WebDAVOptions,
} from './shared/types';

/**
 * Registry of available filesystem providers
 */
const providers = new Map<string, () => Promise<any>>();

/**
 * Register a filesystem provider
 */
export function registerProvider(
  type: string,
  factory: () => Promise<any>,
): void {
  providers.set(type, factory);
}

/**
 * Get list of available provider types
 */
export function getAvailableProviders(): string[] {
  return Array.from(providers.keys());
}

/**
 * Validate provider options
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

    default:
      throw new FilesystemError(`Unknown provider type: ${type}`, 'EINVAL');
  }
}

/**
 * Detect provider type from options
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

  // Default to local
  return 'local';
}

/**
 * Main factory function to create filesystem instances
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
 * Initialize providers by registering them
 */
export async function initializeProviders(): Promise<void> {
  // Register local provider (always available)
  registerProvider('local', async () => {
    const { LocalFilesystemProvider } = await import('./node/local.js');
    return LocalFilesystemProvider;
  });

  // Note: S3, Google Drive, and WebDAV providers are currently backed up
  // due to external dependency issues during context-aware transformation.
  // They can be restored when dependencies are properly handled.

  // Register S3 provider if dependencies are available
  // try {
  //   registerProvider('s3', async () => {
  //     const { S3FilesystemProvider } = await import('./shared/s3.js');
  //     return S3FilesystemProvider;
  //   });
  // } catch (error) {
  //   // S3 provider not available, skip silently
  // }

  // Register Google Drive provider if dependencies are available
  // try {
  //   registerProvider('gdrive', async () => {
  //     const { GoogleDriveFilesystemProvider } = await import('./shared/gdrive.js');
  //     return GoogleDriveFilesystemProvider;
  //   });
  // } catch (error) {
  //   // Google Drive provider not available, skip silently
  // }

  // Register WebDAV provider if dependencies are available
  // try {
  //   registerProvider('webdav', async () => {
  //     const { WebDAVFilesystemProvider } = await import('./shared/webdav.js');
  //     return WebDAVFilesystemProvider;
  //   });
  // } catch (error) {
  //   // WebDAV provider not available, skip silently
  // }
}

/**
 * Check if a provider is available
 */
export function isProviderAvailable(type: string): boolean {
  return providers.has(type);
}

/**
 * Get provider information
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
  };

  const requiredOptions = {
    local: [],
    s3: ['region', 'bucket'],
    gdrive: ['clientId', 'clientSecret', 'refreshToken'],
    webdav: ['baseUrl', 'username', 'password'],
  };

  return {
    available: isProviderAvailable(type),
    description:
      descriptions[type as keyof typeof descriptions] || 'Unknown provider',
    requiredOptions:
      requiredOptions[type as keyof typeof requiredOptions] || [],
  };
}
