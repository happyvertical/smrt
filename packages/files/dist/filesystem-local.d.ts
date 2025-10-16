import { FilesystemAdapter, FilesystemAdapterOptions } from './filesystem';
/**
 * Adapter for interacting with the local filesystem
 */
export declare class LocalFilesystemAdapter extends FilesystemAdapter {
    /**
     * Cache directory path
     */
    protected cacheDir: string;
    /**
     * Type identifier for this adapter
     */
    type: string;
    /**
     * Configuration options
     */
    protected options: FilesystemAdapterOptions;
    /**
     * Creates a new LocalFilesystemAdapter instance
     *
     * @param options - Configuration options
     */
    constructor(options: FilesystemAdapterOptions);
    /**
     * Creates a LocalFilesystemAdapter from a URL
     *
     * @param url - URL to create adapter from
     * @returns Promise resolving to a LocalFilesystemAdapter
     */
    static createFromUrl(_url: string): Promise<void>;
    /**
     * Factory method to create a LocalFilesystemAdapter
     *
     * @param options - Configuration options
     * @returns Promise resolving to an initialized LocalFilesystemAdapter
     */
    static create(options: FilesystemAdapterOptions): Promise<LocalFilesystemAdapter>;
    /**
     * Checks if a file or directory exists in the local filesystem
     *
     * @param path - Path to check
     * @returns Promise resolving to boolean indicating existence
     */
    exists(_path: string): Promise<boolean>;
    /**
     * Reads a file's contents from the local filesystem
     *
     * @param path - Path to the file
     * @returns Promise resolving to the file contents as a string
     */
    read(_path: string): Promise<string>;
    /**
     * Writes content to a file in the local filesystem
     *
     * @param path - Path to the file
     * @param content - Content to write
     * @returns Promise that resolves when the write is complete
     */
    write(_path: string, _content: string): Promise<void>;
    /**
     * Deletes a file or directory from the local filesystem
     *
     * @param path - Path to delete
     * @returns Promise that resolves when the deletion is complete
     */
    delete(_path: string): Promise<void>;
    /**
     * Lists files in a directory in the local filesystem
     *
     * @param path - Directory path to list
     * @returns Promise resolving to an array of file names
     */
    list(_path: string): Promise<never[]>;
    /**
     * Gets the MIME type for a file based on its extension
     *
     * @param path - Path to the file
     * @returns Promise resolving to the MIME type string
     */
    mimeType(path: string): Promise<string>;
}
//# sourceMappingURL=filesystem-local.d.ts.map