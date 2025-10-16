import { SmrtCollection } from '@smrt/core';
import { TagAlias } from './tag-alias';
import { Tag } from './tag';
export declare class TagAliasCollection extends SmrtCollection<TagAlias> {
    static readonly _itemClass: typeof TagAlias;
    /**
     * Add an alias to a tag (get or create)
     *
     * @param tagSlug - The tag slug
     * @param alias - The alias text
     * @param language - Optional language code
     * @param context - Optional context
     * @returns TagAlias instance
     */
    addAlias(tagSlug: string, alias: string, language?: string, context?: string): Promise<TagAlias>;
    /**
     * Search tags by alias
     *
     * @param alias - The alias to search for
     * @param language - Optional language filter
     * @returns Array of matching tags
     */
    searchByAlias(alias: string, language?: string): Promise<Tag[]>;
    /**
     * Get all aliases for a tag
     *
     * @param tagSlug - The tag slug
     * @param language - Optional language filter
     * @returns Array of TagAlias instances
     */
    getAliasesForTag(tagSlug: string, language?: string): Promise<TagAlias[]>;
    /**
     * Remove an alias by ID
     *
     * @param aliasId - The alias UUID
     */
    removeAlias(aliasId: string): Promise<void>;
    /**
     * Bulk add aliases to a tag
     *
     * @param tagSlug - The tag slug
     * @param aliases - Array of alias configurations
     * @returns Array of created TagAlias instances
     */
    bulkAddAliases(tagSlug: string, aliases: Array<{
        alias: string;
        language?: string;
        context?: string;
    }>): Promise<TagAlias[]>;
    /**
     * Get aliases grouped by language
     *
     * @param tagSlug - The tag slug
     * @returns Map of language code to array of aliases
     */
    getAliasesByLanguage(tagSlug: string): Promise<Map<string, string[]>>;
    /**
     * Find similar aliases (case-insensitive partial match)
     *
     * Note: This is a simple implementation. For production use,
     * consider using full-text search or fuzzy matching.
     *
     * @param query - The search query
     * @param language - Optional language filter
     * @returns Array of matching TagAlias instances
     */
    findSimilar(query: string, language?: string): Promise<TagAlias[]>;
}
//# sourceMappingURL=tag-aliases.d.ts.map