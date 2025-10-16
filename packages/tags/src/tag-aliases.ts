/**
 * TagAliasCollection - Collection manager for TagAlias objects
 *
 * Provides alias management, multi-language search, and bulk operations.
 */

import { SmrtCollection } from '@have/smrt';
import { TagAlias } from './tag-alias';
import type { Tag } from './tag';

export class TagAliasCollection extends SmrtCollection<TagAlias> {
  static readonly _itemClass = TagAlias;

  /**
   * Add an alias to a tag (get or create)
   *
   * @param tagSlug - The tag slug
   * @param alias - The alias text
   * @param language - Optional language code
   * @param context - Optional context
   * @returns TagAlias instance
   */
  async addAlias(
    tagSlug: string,
    alias: string,
    language?: string,
    context?: string,
  ): Promise<TagAlias> {
    // Check if alias already exists
    const where: any = { tagSlug, alias };
    if (language) where.language = language;
    if (context) where.context = context;

    const existing = await this.list({ where, limit: 1 });
    if (existing.length > 0) {
      return existing[0];
    }

    // Create new alias
    return await this.create({
      tagSlug,
      alias,
      language,
      context,
    });
  }

  /**
   * Search tags by alias
   *
   * @param alias - The alias to search for
   * @param language - Optional language filter
   * @returns Array of matching tags
   */
  async searchByAlias(alias: string, language?: string): Promise<Tag[]> {
    const where: any = { alias };
    if (language) where.language = language;

    const aliases = await this.list({ where });
    const tagSlugs = [...new Set(aliases.map((a) => a.tagSlug))];

    const { TagCollection } = await import('./tags');
    const tagCollection = await TagCollection.create(this.options);

    const tags: Tag[] = [];
    for (const slug of tagSlugs) {
      const tag = await tagCollection.get({ slug });
      if (tag) tags.push(tag);
    }

    return tags;
  }

  /**
   * Get all aliases for a tag
   *
   * @param tagSlug - The tag slug
   * @param language - Optional language filter
   * @returns Array of TagAlias instances
   */
  async getAliasesForTag(
    tagSlug: string,
    language?: string,
  ): Promise<TagAlias[]> {
    const where: any = { tagSlug };
    if (language) where.language = language;

    return await this.list({ where });
  }

  /**
   * Remove an alias by ID
   *
   * @param aliasId - The alias UUID
   */
  async removeAlias(aliasId: string): Promise<void> {
    const alias = await this.get({ id: aliasId });
    if (alias) {
      await alias.delete();
    }
  }

  /**
   * Bulk add aliases to a tag
   *
   * @param tagSlug - The tag slug
   * @param aliases - Array of alias configurations
   * @returns Array of created TagAlias instances
   */
  async bulkAddAliases(
    tagSlug: string,
    aliases: Array<{
      alias: string;
      language?: string;
      context?: string;
    }>,
  ): Promise<TagAlias[]> {
    const created: TagAlias[] = [];

    for (const aliasData of aliases) {
      const tagAlias = await this.addAlias(
        tagSlug,
        aliasData.alias,
        aliasData.language,
        aliasData.context,
      );
      created.push(tagAlias);
    }

    return created;
  }

  /**
   * Get aliases grouped by language
   *
   * @param tagSlug - The tag slug
   * @returns Map of language code to array of aliases
   */
  async getAliasesByLanguage(tagSlug: string): Promise<Map<string, string[]>> {
    const aliases = await this.getAliasesForTag(tagSlug);
    const grouped = new Map<string, string[]>();

    for (const alias of aliases) {
      const lang = alias.language || 'default';
      if (!grouped.has(lang)) {
        grouped.set(lang, []);
      }
      grouped.get(lang)?.push(alias.alias);
    }

    return grouped;
  }

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
  async findSimilar(query: string, language?: string): Promise<TagAlias[]> {
    const where: any = {};
    if (language) where.language = language;

    const all = await this.list({ where });
    const queryLower = query.toLowerCase();

    return all.filter((alias) =>
      alias.alias.toLowerCase().includes(queryLower),
    );
  }
}
