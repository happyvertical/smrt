import { SmrtObject } from '@smrt/core';
import { Tag } from './tag';
import { TagAliasOptions } from './types';
export declare class TagAlias extends SmrtObject {
    tagSlug: string;
    alias: string;
    language: string;
    protected _context: string;
    get context(): string;
    set context(value: string);
    createdAt: Date;
    constructor(options?: TagAliasOptions);
    /**
     * Get the tag this alias belongs to
     *
     * @returns Tag instance or null if not found
     */
    getTag(): Promise<Tag | null>;
    /**
     * Search tags by alias
     *
     * @param alias - The alias to search for
     * @param language - Optional language filter
     * @returns Array of matching tags
     */
    static searchByAlias(_alias: string, _language?: string): Promise<Tag[]>;
    /**
     * Get all aliases for a tag
     *
     * @param tagSlug - The tag slug to get aliases for
     * @returns Array of TagAlias instances
     */
    static getAliasesForTag(_tagSlug: string): Promise<TagAlias[]>;
}
//# sourceMappingURL=tag-alias.d.ts.map