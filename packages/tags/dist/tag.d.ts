import { SmrtObject } from '../../../core/smrt/src';
import { TagOptions, TagMetadata } from './types';
export declare class Tag extends SmrtObject {
    protected _slug: string;
    protected _context: string;
    get slug(): string;
    set slug(value: string);
    get context(): string;
    set context(value: string);
    name: string;
    parentSlug: string;
    level: number;
    description: string;
    metadata: string;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: TagOptions);
    /**
     * Get metadata as parsed object
     *
     * @returns Parsed metadata object or empty object if no metadata
     */
    getMetadata(): TagMetadata;
    /**
     * Set metadata from object
     *
     * @param data - Metadata object to store
     */
    setMetadata(data: TagMetadata): void;
    /**
     * Update metadata by merging with existing values
     *
     * @param updates - Partial metadata to merge
     */
    updateMetadata(updates: Partial<TagMetadata>): void;
    /**
     * Get the parent tag
     *
     * @returns Parent Tag instance or null if no parent
     */
    getParent(): Promise<Tag | null>;
    /**
     * Get immediate child tags
     *
     * @returns Array of child Tag instances
     */
    getChildren(): Promise<Tag[]>;
    /**
     * Get all ancestor tags (recursive)
     *
     * @returns Array of ancestor tags from root to immediate parent
     */
    getAncestors(): Promise<Tag[]>;
    /**
     * Get all descendant tags (recursive)
     *
     * @returns Array of all descendant tags
     */
    getDescendants(): Promise<Tag[]>;
    /**
     * Convenience method for slug-based lookup
     *
     * @param slug - The slug to search for
     * @param context - Optional context filter
     * @returns Tag instance or null if not found
     */
    static getBySlug(slug: string, context?: string): Promise<Tag | null>;
    /**
     * Get root tags (no parent) for a context
     *
     * @param context - The context to filter by
     * @returns Array of root tags
     */
    static getRootTags(context?: string): Promise<Tag[]>;
}
//# sourceMappingURL=tag.d.ts.map