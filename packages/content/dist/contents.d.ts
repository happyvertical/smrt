import { AIClientOptions } from '../../../core/ai/src';
import { SmrtCollectionOptions, SmrtCollection } from '../../../core/smrt/src';
import { Content } from './content';
/**
 * Configuration options for Contents collection
 */
export interface ContentsOptions extends SmrtCollectionOptions {
    /**
     * AI client configuration options
     */
    ai?: AIClientOptions;
    /**
     * Directory to store content files
     */
    contentDir?: string;
}
/**
 * Collection for managing Content objects
 *
 * The Contents collection provides functionality for managing and manipulating
 * collections of Content objects, including saving to the filesystem and
 * mirroring content from remote URLs.
 */
export declare class Contents extends SmrtCollection<Content> {
    /**
     * Class constructor for collection items
     */
    static _itemClass: typeof Content;
    /**
     * Configuration options
     */
    options: ContentsOptions;
    /**
     * Directory to store content files
     */
    contentDir?: string;
    /**
     * Cache of loaded content by key
     */
    private loaded;
    /**
     * Creates a new Contents collection
     *
     * Use the static `create()` method inherited from SmrtCollection for proper initialization.
     *
     * @param options - Configuration options
     */
    constructor(options: ContentsOptions);
    /**
     * Gets the database interface
     *
     * @returns Database interface
     */
    getDb(): any;
    /**
     * Initializes the collection
     *
     * @returns Promise that resolves to this instance
     */
    initialize(): Promise<this>;
    /**
     * Mirrors content from a remote URL
     *
     * Downloads and stores content from a remote URL, extracting text
     * and saving it as a Content object.
     *
     * @param options - Mirror options
     * @param options.url - URL to mirror
     * @param options.mirrorDir - Directory for caching mirrored files
     * @param options.context - Context for the mirrored content
     * @returns Promise resolving to the mirrored Content object
     * @throws Error if URL is invalid or missing
     */
    mirror(options: {
        url: string;
        mirrorDir?: string;
        context?: string;
    }): Promise<any>;
    /**
     * Writes a Content object to the filesystem as a markdown file
     *
     * @param options - Options for writing the content file
     * @param options.content - Content object to write
     * @param options.contentDir - Directory to write the file to
     * @returns Promise that resolves when the file is written
     * @throws Error if contentDir is not provided
     */
    writeContentFile(options: {
        content: Content;
        contentDir: string;
    }): Promise<void>;
    /**
     * Checks if text appears to be in markdown format
     *
     * @param text - Text to check
     * @returns Boolean indicating if the text contains markdown syntax
     */
    private isMarkdown;
    /**
     * Formats plain text as simple markdown
     *
     * @param text - Plain text to format
     * @returns Text formatted as basic markdown
     */
    private formatAsMarkdown;
    /**
     * Synchronizes content to the filesystem
     *
     * Writes all article-type Content objects to the filesystem
     * as markdown files.
     *
     * @param options - Sync options
     * @param options.contentDir - Directory to write content files to
     * @returns Promise that resolves when synchronization is complete
     */
    syncContentDir(options: {
        contentDir?: string;
    }): Promise<void>;
}
//# sourceMappingURL=contents.d.ts.map