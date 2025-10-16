import { SmrtObjectOptions, SmrtObject } from '@smrt/core';
/**
 * Options for Content initialization
 */
export interface ContentOptions extends SmrtObjectOptions {
    /**
     * Content type classification
     */
    type?: string | null;
    /**
     * Content variant for namespaced classification within types
     * Format: generator:domain:specific-type
     * Example: "praeco:meeting:upcoming"
     */
    variant?: string | null;
    /**
     * Reference to file storage key
     */
    fileKey?: string | null;
    /**
     * Author of the content
     */
    author?: string | null;
    /**
     * Content title
     */
    title?: string | null;
    /**
     * Short description or summary
     */
    description?: string | null;
    /**
     * Main content body text
     */
    body?: string | null;
    /**
     * Date when content was published
     */
    publish_date?: Date | null;
    /**
     * URL source of the content
     */
    url?: string | null;
    /**
     * Original source identifier
     */
    source?: string | null;
    /**
     * Publication status
     */
    status?: 'published' | 'draft' | 'archived' | 'deleted' | null;
    /**
     * Content state flag
     */
    state?: 'deprecated' | 'active' | 'highlighted' | null;
    /**
     * Original URL of the content
     */
    original_url?: string | null;
    /**
     * Content language
     */
    language?: string | null;
    /**
     * Content tags
     */
    tags?: string[];
    /**
     * Additional metadata
     */
    metadata?: Record<string, any>;
}
/**
 * Structured content object with metadata and body text
 *
 * Content represents any text-based content with metadata such as
 * title, author, description, and publishing information. It supports
 * referencing related content objects.
 */
export declare class Content extends SmrtObject {
    /**
     * Array of referenced content objects
     */
    protected references: Content[];
    /**
     * Content type classification
     */
    type: string | null;
    /**
     * Content variant for namespaced classification within types
     * Format: generator:domain:specific-type
     * Example: "praeco:meeting:upcoming"
     */
    variant: string | null;
    /**
     * Reference to file storage key
     */
    fileKey: string | null;
    /**
     * Author of the content
     */
    author: string | null;
    /**
     * Content title
     */
    title: string;
    /**
     * Short description or summary
     */
    description: string | null;
    /**
     * Main content body text
     */
    body: string;
    /**
     * Date when content was published
     */
    publish_date: Date | null;
    /**
     * URL source of the content
     */
    url: string | null;
    /**
     * Original source identifier
     */
    source: string | null;
    /**
     * Original URL of the content
     */
    original_url: string | null;
    /**
     * Content language
     */
    language: string | null;
    /**
     * Content tags
     */
    tags: string[];
    /**
     * Publication status
     */
    status: 'published' | 'draft' | 'archived' | 'deleted';
    /**
     * Content state flag
     */
    state: 'deprecated' | 'active' | 'highlighted';
    /**
     * Additional JSON metadata for flexible schema extension
     */
    metadata: Record<string, any>;
    /**
     * Creates a new Content instance
     */
    constructor(options?: ContentOptions);
    /**
     * Initializes this content object
     *
     * @returns Promise that resolves to this instance
     */
    initialize(): Promise<this>;
    /**
     * Loads referenced content objects
     *
     * @returns Promise that resolves when references are loaded
     */
    loadReferences(): Promise<void>;
    /**
     * Adds a reference to another content object
     *
     * @param content - Content object or URL to reference
     * @returns Promise that resolves when the reference is added
     */
    addReference(content: Content | string): Promise<void>;
    /**
     * Gets all referenced content objects
     *
     * @returns Promise resolving to an array of referenced Content objects
     */
    getReferences(): Promise<Content[]>;
    /**
     * Converts this content object to a plain JSON object
     *
     * @returns JSON representation of this content
     */
    toJSON(): {
        id: string;
        slug: string;
        context: string;
        type: string | null;
        variant: string;
        fileKey: string;
        author: string;
        title: string;
        description: string;
        body: string;
        publish_date: string | Date;
        url: string;
        source: string;
        status: "published" | "draft" | "archived" | "deleted";
        state: "deprecated" | "active" | "highlighted";
    };
}
//# sourceMappingURL=content.d.ts.map