import { SmrtCollection } from '../../../core/smrt/src';
import { Tag } from './tag';
import { TagHierarchy } from './types';
export declare class TagCollection extends SmrtCollection<Tag> {
    static readonly _itemClass: typeof Tag;
    /**
     * Get or create a tag with context
     *
     * @param slug - Tag slug
     * @param context - Tag context (default: 'global')
     * @returns Tag instance
     */
    getOrCreate(slug: string, context?: string): Promise<Tag>;
    /**
     * List tags by context with optional parent filtering
     *
     * @param context - The context to filter by
     * @param parentSlug - Optional parent slug to filter children
     * @returns Array of matching tags
     */
    listByContext(context: string, parentSlug?: string): Promise<Tag[]>;
    /**
     * Get root tags (no parent) for a context
     *
     * @param context - The context to filter by (default: 'global')
     * @returns Array of root tags
     */
    getRootTags(context?: string): Promise<Tag[]>;
    /**
     * Get immediate children of a parent tag
     *
     * @param parentSlug - The parent tag slug
     * @returns Array of child tags
     */
    getChildren(parentSlug: string): Promise<Tag[]>;
    /**
     * Get tag hierarchy (all ancestors and descendants)
     *
     * @param slug - The tag slug
     * @returns Object with ancestors, current tag, and descendants
     */
    getHierarchy(slug: string): Promise<TagHierarchy>;
    /**
     * Move a tag to a new parent (updates level automatically)
     *
     * @param slug - The tag to move
     * @param newParentSlug - The new parent slug (null for root)
     * @throws Error if circular reference detected
     */
    moveTag(slug: string, newParentSlug: string | null): Promise<void>;
    /**
     * Merge one tag into another (updates all references)
     *
     * Note: This method updates the tag itself but consuming packages
     * are responsible for updating their join tables (e.g., asset_tags)
     *
     * @param fromSlug - The tag to merge from
     * @param toSlug - The tag to merge into
     */
    mergeTag(fromSlug: string, toSlug: string): Promise<void>;
    /**
     * Remove tags with no references (cleanup unused tags)
     *
     * Note: This requires consuming packages to provide usage information.
     * By default, only removes tags with no children and no aliases.
     *
     * @param context - Optional context to filter cleanup
     */
    cleanupUnused(context?: string): Promise<number>;
    /**
     * Calculate hierarchy level for a tag
     *
     * @param parentSlug - The parent tag slug (null for root)
     * @returns The calculated level
     */
    calculateLevel(parentSlug: string | null): Promise<number>;
    /**
     * Check if moving a tag would create a circular reference
     *
     * @param slug - The tag being moved
     * @param newParentSlug - The proposed new parent
     * @returns True if circular reference detected
     */
    private hasCircularReference;
    /**
     * Get all ancestor tags (recursive)
     *
     * @param tag - The tag to get ancestors for
     * @returns Array of ancestor tags from root to immediate parent
     */
    private getAncestors;
    /**
     * Get all descendant tags (recursive)
     *
     * @param tag - The tag to get descendants for
     * @returns Array of all descendant tags
     */
    private getDescendants;
    /**
     * Update levels for all descendants after moving a tag
     *
     * @param tag - The tag that was moved
     */
    private updateDescendantLevels;
}
//# sourceMappingURL=tags.d.ts.map