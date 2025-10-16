import { BaseProviderOptions, CacheOptions, CreateDirOptions, DownloadOptions, FileInfo, FileStats, FilesystemCapabilities, FilesystemInterface, ListFilesOptions, ListOptions, ReadOptions, UploadOptions, WriteOptions } from './types';
/**
 * Base class for all filesystem providers
 */
export declare abstract class BaseFilesystemProvider implements FilesystemInterface {
    protected basePath: string;
    protected cacheDir: string;
    protected createMissing: boolean;
    protected providerType: string;
    constructor(options?: BaseProviderOptions);
    /**
     * Get default cache directory for the current context
     */
    private getDefaultCacheDir;
    /**
     * Throw error for unsupported operations
     */
    protected throwUnsupported(operation: string): never;
    /**
     * Normalize path by removing leading/trailing slashes and resolving relative paths
     */
    protected normalizePath(path: string): string;
    /**
     * Universal path joining function that works in both Node.js and browser
     */
    private joinPaths;
    /**
     * Validate that a path is safe (no directory traversal)
     */
    protected validatePath(path: string): void;
    /**
     * Get cache key for a given path
     */
    protected getCacheKey(path: string): string;
    /**
     * Abstract methods that must be implemented by providers
     */
    abstract exists(path: string): Promise<boolean>;
    abstract read(path: string, options?: ReadOptions): Promise<string | Buffer>;
    abstract write(path: string, content: string | Buffer, options?: WriteOptions): Promise<void>;
    abstract delete(path: string): Promise<void>;
    abstract copy(sourcePath: string, destPath: string): Promise<void>;
    abstract move(sourcePath: string, destPath: string): Promise<void>;
    abstract createDirectory(path: string, options?: CreateDirOptions): Promise<void>;
    abstract list(path: string, options?: ListOptions): Promise<FileInfo[]>;
    abstract getStats(path: string): Promise<FileStats>;
    abstract getMimeType(path: string): Promise<string>;
    abstract getCapabilities(): Promise<FilesystemCapabilities>;
    /**
     * Provider methods with default implementations (may be overridden)
     */
    upload(_localPath: string, _remotePath: string, _options?: UploadOptions): Promise<void>;
    download(_remotePath: string, _localPath?: string, _options?: DownloadOptions): Promise<string>;
    downloadWithCache(remotePath: string, options?: CacheOptions): Promise<string>;
    /**
     * Cache implementation - providers can override for their specific storage
     */
    cache: {
        get: (_key: string, _expiry?: number) => Promise<string | undefined>;
        set: (_key: string, _data: string) => Promise<void>;
        clear: (_key?: string) => Promise<void>;
    };
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
    uploadToUrl(_url: string, _data: string | Buffer): Promise<Response>;
    /**
     * Download a file from a URL and save it to a local file (legacy)
     */
    downloadFromUrl(_url: string, _filepath: string): Promise<void>;
    /**
     * Download a file with caching support (legacy)
     */
    downloadFileWithCache(_url: string, _targetPath?: string | null): Promise<string>;
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
//# sourceMappingURL=base.d.ts.map