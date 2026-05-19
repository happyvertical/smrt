/**
 * TagCollection - Collection manager for Tag objects
 *
 * Public methods continue to accept slug strings for ergonomic call sites
 * (declarative tag-tree seeds, CLI tools, etc.), but the underlying FK is
 * now `Tag.parentId` (UUID, inherited from `SmrtHierarchical`). Each public
 * method resolves slugs to ids internally before mutating storage.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Tag } from './tag';
import type { TagHierarchy } from './types';

export class TagCollection extends SmrtCollection<Tag> {
  static readonly _itemClass = Tag;

  /**
   * Get or create a tag with context
   *
   * @param slug - Tag slug
   * @param context - Tag context (default: 'global')
   * @returns Tag instance
   */
  async getOrCreate(slug: string, context: string = 'global'): Promise<Tag> {
    // First try to find existing tag with this slug and context
    const existing = await this.list({
      where: { slug, context },
      limit: 1,
    });

    if (existing.length > 0) {
      return existing[0];
    }

    // Create new tag
    return await this.create({
      slug,
      name: slug.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
      context,
      level: 0,
    });
  }

  /**
   * List tags by context with optional parent filtering by slug.
   *
   * @param context - The context to filter by
   * @param parentSlug - Optional parent slug to filter children. Pass an
   *   empty string or `null` to find root tags; pass a slug to find that
   *   tag's immediate children.
   * @returns Array of matching tags
   */
  async listByContext(context: string, parentSlug?: string): Promise<Tag[]> {
    const where: any = { context };
    if (parentSlug === '' || parentSlug === null) {
      where.parentId = null;
    } else if (parentSlug !== undefined) {
      const parent = await this.get({ slug: parentSlug, context });
      if (!parent?.id) return [];
      where.parentId = parent.id;
    }
    return await this.list({ where });
  }

  /**
   * Get root tags (no parent) for a context
   *
   * @param context - The context to filter by (default: 'global')
   * @returns Array of root tags
   */
  async getRootTags(context: string = 'global'): Promise<Tag[]> {
    return await this.list({
      where: { context, parentId: null },
    });
  }

  /**
   * Get immediate children of a parent tag, looked up by slug.
   *
   * @param parentSlug - The parent tag slug
   * @returns Array of child tags, or `[]` if the parent slug doesn't resolve
   */
  async getChildren(parentSlug: string): Promise<Tag[]> {
    const parent = await this.get({ slug: parentSlug });
    if (!parent?.id) return [];
    return await this.list({ where: { parentId: parent.id } });
  }

  /**
   * Get tag hierarchy (all ancestors and descendants)
   *
   * @param slug - The tag slug
   * @returns Object with ancestors, current tag, and descendants
   */
  async getHierarchy(slug: string): Promise<TagHierarchy> {
    const tag = await this.get({ slug });
    if (!tag) throw new Error(`Tag '${slug}' not found`);

    const [ancestors, descendants] = await Promise.all([
      tag.getAncestors() as Promise<Tag[]>,
      tag.getDescendants() as Promise<Tag[]>,
    ]);

    return { ancestors, current: tag, descendants };
  }

  /**
   * Move a tag to a new parent. Slug-based API; UUIDs resolved internally.
   * Cycle detection is delegated to `SmrtHierarchical.moveTo`. Updates the
   * denormalised `level` field on the moved tag and recursively on all of
   * its descendants.
   *
   * @param slug - The tag to move
   * @param newParentSlug - The new parent slug (null for root)
   * @throws Error if the source slug doesn't resolve, the new parent slug
   *   doesn't resolve, or the move would create a cycle.
   */
  async moveTag(slug: string, newParentSlug: string | null): Promise<void> {
    const tag = await this.get({ slug });
    if (!tag) throw new Error(`Tag '${slug}' not found`);

    let newParent: Tag | null = null;
    if (newParentSlug) {
      newParent = await this.get({ slug: newParentSlug });
      if (!newParent) {
        throw new Error(`Tag '${newParentSlug}' not found`);
      }
    }

    await tag.moveTo(newParent ?? null);

    // Recalculate level for the moved tag + every descendant. moveTo already
    // saved tag.parentId; we just need to update level (denormalised depth).
    tag.level = newParent ? newParent.level + 1 : 0;
    await tag.save();
    await this.updateDescendantLevels(tag);
  }

  /**
   * Merge one tag into another (updates all references)
   *
   * Note: This method updates the tag itself but consuming packages
   * are responsible for updating their join tables (e.g., asset_tags).
   * `TagAlias.tagSlug` is rewritten here because aliases live inside the
   * tags package.
   *
   * @param fromSlug - The tag to merge from
   * @param toSlug - The tag to merge into
   */
  async mergeTag(fromSlug: string, toSlug: string): Promise<void> {
    const fromTag = await this.get({ slug: fromSlug });
    const toTag = await this.get({ slug: toSlug });

    if (!fromTag) throw new Error(`Source tag '${fromSlug}' not found`);
    if (!toTag) throw new Error(`Target tag '${toSlug}' not found`);
    if (!fromTag.id) throw new Error(`Source tag '${fromSlug}' has no id`);
    if (!toTag.id) throw new Error(`Target tag '${toSlug}' has no id`);

    // Move all children of fromTag to toTag
    const children = await this.list({
      where: { parentId: fromTag.id },
    });
    for (const child of children) {
      child.parentId = toTag.id;
      await child.save();
    }

    // Copy aliases from fromTag to toTag
    const { TagAliasCollection } = await import('./tag-aliases');
    const aliasCollection = await (TagAliasCollection as any).create(
      this.options,
    );

    const aliases = await aliasCollection.list({
      where: { tagSlug: fromSlug },
    });
    for (const alias of aliases) {
      alias.tagSlug = toSlug;
      await alias.save();
    }

    // Delete the fromTag
    await fromTag.delete();
  }

  /**
   * Remove tags with no references (cleanup unused tags)
   *
   * Note: This requires consuming packages to provide usage information.
   * By default, only removes tags with no children and no aliases.
   *
   * @param context - Optional context to filter cleanup
   */
  async cleanupUnused(context?: string): Promise<number> {
    const where: any = {};
    if (context) where.context = context;

    const tags = await this.list({ where });
    const { TagAliasCollection } = await import('./tag-aliases');
    const aliasCollection = await (TagAliasCollection as any).create(
      this.options,
    );

    let deletedCount = 0;

    for (const tag of tags) {
      if (!tag.id) continue;

      // Check if tag has children (by parentId — UUID).
      const children = await this.list({
        where: { parentId: tag.id },
        limit: 1,
      });
      if (children.length > 0) continue;

      // Check if tag has aliases (still slug-keyed on TagAlias.tagSlug).
      const aliases = await aliasCollection.list({
        where: { tagSlug: tag.slug },
        limit: 1,
      });
      if (aliases.length > 0) continue;

      // No children, no aliases - safe to delete
      await tag.delete();
      deletedCount++;
    }

    return deletedCount;
  }

  /**
   * Calculate hierarchy level for a tag, looking the parent up by slug.
   *
   * @param parentSlug - The parent tag slug (null/empty for root)
   * @returns The calculated level (root parent → 1, missing parent → 0)
   */
  async calculateLevel(parentSlug: string | null): Promise<number> {
    if (!parentSlug) return 0;

    const parent = await this.get({ slug: parentSlug });
    if (!parent) return 0;

    return parent.level + 1;
  }

  /**
   * Update levels for all descendants after moving a tag
   *
   * @param tag - The tag that was moved
   */
  private async updateDescendantLevels(tag: Tag): Promise<void> {
    if (!tag.id) return;
    const children = await this.list({
      where: { parentId: tag.id },
    });

    for (const child of children) {
      child.level = tag.level + 1;
      await child.save();
      await this.updateDescendantLevels(child); // Recursive
    }
  }

  // =========================================================================
  // Tenant Helper Methods
  // =========================================================================

  /**
   * Find all tags belonging to a specific tenant
   *
   * @param tenantId - The tenant ID to filter by
   * @returns Array of tags for the specified tenant
   */
  async findByTenant(tenantId: string): Promise<Tag[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global (tenant-less) tags
   *
   * @returns Array of global tags with null tenantId
   */
  async findGlobal(): Promise<Tag[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find tags for a tenant including global tags
   *
   * @param tenantId - The tenant ID to filter by
   * @returns Array of tags for the tenant plus all global tags
   */
  async findWithGlobals(tenantId: string): Promise<Tag[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
