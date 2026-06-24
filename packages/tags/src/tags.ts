/**
 * TagCollection - Collection manager for Tag objects
 *
 * Public methods continue to accept slug strings for ergonomic call sites
 * (declarative tag-tree seeds, CLI tools, etc.), but the underlying FK is
 * now `Tag.parentId` (UUID, inherited from `SmrtHierarchical`). Each public
 * method resolves slugs to ids internally before mutating storage.
 *
 * Slug resolution is context-aware: Tag's natural key is `(slug, context)`,
 * not slug alone. Every slug-resolving method accepts an optional `context`
 * parameter. When omitted, the resolver fails fast if the slug is
 * ambiguous across contexts rather than silently picking one row.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
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
   * Resolve a tag by slug, optionally scoped to a context.
   *
   * Tags are identified by `(slug, context)`. When `context` is omitted
   * and the slug exists in more than one context, this throws a clear
   * ambiguity error rather than silently picking the first matching row.
   * Callers that know their context should pass it; callers that work in
   * a single-context world can leave it off.
   *
   * @returns The matching Tag, or `null` if nothing matches.
   * @throws Error if `context` is omitted and the slug is ambiguous.
   */
  private async resolveBySlug(
    slug: string,
    context?: string,
  ): Promise<Tag | null> {
    const where: { slug: string; context?: string } = { slug };
    if (context !== undefined) where.context = context;
    const matches = await this.list({ where, limit: 2 });
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(
        `Tag slug '${slug}' is ambiguous: resolves to ${matches.length}+ rows across contexts. Pass an explicit \`context\` argument.`,
      );
    }
    return matches[0];
  }

  /**
   * List tags by context with optional parent filtering by slug.
   *
   * @param context - The context to filter by
   * @param parentSlug - Optional parent slug to filter children. Pass an
   *   empty string or `null` to find root tags; pass a slug to find that
   *   tag's immediate children. Typed as `string | null` so TypeScript
   *   callers can pass `null` without a cast — the `null` and `''` paths
   *   are both treated as "roots only".
   * @returns Array of matching tags
   */
  async listByContext(
    context: string,
    parentSlug?: string | null,
  ): Promise<Tag[]> {
    const where: Record<string, unknown> = { context };
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
   * @param context - Optional context for the parent lookup. When omitted,
   *   the parent slug must be unambiguous across contexts (throws if not).
   * @returns Array of child tags, or `[]` if the parent slug doesn't
   *   resolve. Children are filtered to the resolved parent's context so
   *   cross-context children don't leak in.
   */
  async getChildren(parentSlug: string, context?: string): Promise<Tag[]> {
    const parent = await this.resolveBySlug(parentSlug, context);
    if (!parent?.id) return [];
    return await this.list({
      where: { parentId: parent.id, context: parent.context },
    });
  }

  /**
   * Get tag hierarchy (all ancestors and descendants)
   *
   * @param slug - The tag slug
   * @param context - Optional context for the slug lookup. When omitted,
   *   the slug must be unambiguous across contexts.
   * @returns Object with ancestors, current tag, and descendants
   */
  async getHierarchy(slug: string, context?: string): Promise<TagHierarchy> {
    const tag = await this.resolveBySlug(slug, context);
    if (!tag) throw new Error(`Tag '${slug}' not found`);

    const [ancestors, descendants] = await Promise.all([
      tag.getAncestors() as Promise<Tag[]>,
      tag.getDescendants() as Promise<Tag[]>,
    ]);

    return { ancestors, current: tag, descendants };
  }

  /**
   * Move a tag to a new parent. Slug-based API; UUIDs resolved internally.
   *
   * Cycle detection is inlined here (mirroring `SmrtHierarchical.moveTo`'s
   * self-loop + descendant checks) so that both `parentId` and the
   * denormalised `level` field can be persisted in a single `save()`.
   * Delegating to `moveTo` would write `parentId` first and `level` in a
   * second save — if the second save failed, the tag would be left with
   * the new parent but a stale level, breaking the depth cache.
   *
   * After the moved tag persists, descendant levels are recalculated
   * recursively via `updateDescendantLevels`.
   *
   * @param slug - The tag to move
   * @param newParentSlug - The new parent slug (null for root)
   * @param context - Optional context. When provided, both source and new
   *   parent are resolved within it. When omitted, both slugs must be
   *   unambiguous across contexts; the resolver throws otherwise.
   * @throws Error if either slug fails to resolve, if either slug is
   *   ambiguous across contexts (no context provided), if source and new
   *   parent live in different contexts, or if the move would create a
   *   cycle.
   */
  async moveTag(
    slug: string,
    newParentSlug: string | null,
    context?: string,
  ): Promise<void> {
    const tag = await this.resolveBySlug(slug, context);
    if (!tag) throw new Error(`Tag '${slug}' not found`);

    let newParent: Tag | null = null;
    if (newParentSlug) {
      // Resolve the new parent in the SAME context as the tag we're
      // moving. If the caller passed a context, use it; otherwise pin
      // to the source tag's context so we don't drift across contexts
      // on the second lookup.
      newParent = await this.resolveBySlug(
        newParentSlug,
        context ?? tag.context,
      );
      if (!newParent) {
        throw new Error(`Tag '${newParentSlug}' not found`);
      }
      if (newParent.context !== tag.context) {
        throw new Error(
          `Cannot move Tag '${slug}' (context '${tag.context}') under '${newParentSlug}' (context '${newParent.context}') — contexts must match.`,
        );
      }
    }
    const newParentId = newParent?.id ?? null;

    if (newParentId !== null && newParentId === tag.id) {
      throw new Error(`Cannot move Tag ${tag.id} to itself.`);
    }
    if (newParentId !== null) {
      const descendants = (await tag.getDescendants()) as Tag[];
      if (descendants.some((d) => d.id === newParentId)) {
        throw new Error(
          `Cannot move Tag ${tag.id} under one of its own descendants (${newParentId}) — would create a cycle.`,
        );
      }
    }

    tag.parentId = newParentId;
    tag.level = newParent ? newParent.level + 1 : 0;
    await tag.save();
    await this.updateDescendantLevels(tag);
  }

  /**
   * Merge one tag into another (updates all references)
   *
   * Reparents `fromTag`'s direct children onto `toTag` and recalculates
   * their `level` field plus the level of every descendant — without
   * this, children moved from a different depth would carry stale
   * levels relative to their new parent. `TagAlias.tagSlug` references
   * are also rewritten, then `fromTag` is deleted.
   *
   * Note: Consuming packages are responsible for updating their own
   * join tables (e.g. `asset_tags`).
   *
   * @param fromSlug - The tag to merge from
   * @param toSlug - The tag to merge into
   * @param context - Optional context. When provided, both tags are
   *   resolved within it. When omitted, both slugs must be unambiguous
   *   across contexts.
   * @throws Error if either slug fails to resolve, if either slug is
   *   ambiguous, or if the two tags live in different contexts.
   */
  async mergeTag(
    fromSlug: string,
    toSlug: string,
    context?: string,
  ): Promise<void> {
    const fromTag = await this.resolveBySlug(fromSlug, context);
    const toTag = await this.resolveBySlug(toSlug, context ?? fromTag?.context);

    if (!fromTag) throw new Error(`Source tag '${fromSlug}' not found`);
    if (!toTag) throw new Error(`Target tag '${toSlug}' not found`);
    if (!fromTag.id) throw new Error(`Source tag '${fromSlug}' has no id`);
    if (!toTag.id) throw new Error(`Target tag '${toSlug}' has no id`);
    if (fromTag.context !== toTag.context) {
      throw new Error(
        `Cannot merge '${fromSlug}' (context '${fromTag.context}') into '${toSlug}' (context '${toTag.context}') — contexts must match.`,
      );
    }
    if (fromTag.id === toTag.id) {
      throw new Error(`Cannot merge tag '${fromSlug}' into itself.`);
    }

    // Codex round-4 finding: refuse to merge into a descendant. Without
    // this guard the children-reparenting loop below could attach
    // `toTag` (or its ancestor) under itself, producing a cycle; the
    // recursive `updateDescendantLevels` walk has no visited set and
    // would stack-overflow before the corruption is observable.
    const fromDescendants = (await fromTag.getDescendants()) as Tag[];
    if (fromDescendants.some((d) => d.id === toTag.id)) {
      throw new Error(
        `Cannot merge '${fromSlug}' into '${toSlug}' — target is a descendant of source (would create a cycle).`,
      );
    }

    // Move all direct children of fromTag to toTag. Each child needs its
    // own `level` recomputed because toTag's depth may differ from
    // fromTag's depth (the children were positioned relative to fromTag's
    // level; after reparenting they hang off toTag instead). Then walk
    // each child's own subtree to propagate the level shift down.
    const children = await this.list({
      where: { parentId: fromTag.id },
    });
    const newChildLevel = toTag.level + 1;
    for (const child of children) {
      child.parentId = toTag.id;
      child.level = newChildLevel;
      await child.save();
      await this.updateDescendantLevels(child);
    }

    // Copy aliases from fromTag to toTag.
    // R3-B follow-up (codex caught this across multiple rounds): scope
    // the alias rewrite to the merge's resolved context, not the bare
    // slug. Otherwise `mergeTag('foo', 'bar', 'blog')` rewrites
    // `foo`'s aliases in EVERY context (forum, etc.), corrupting tag
    // data outside the requested merge scope.
    //
    // Round-8 codex follow-up: `Tag._context` defaults to `'global'`
    // but `TagAlias._context` defaults to `''` (and `addAlias()`
    // doesn't backfill the default), so a strict equality filter
    // would orphan aliases that were created without an explicit
    // context whenever the merge happens at the default 'global'
    // scope.
    //
    // Round-8 fix (initial): widen to `[fromTag.context, '']` —
    // BUT codex + copilot caught that this overcorrected. For a
    // non-default merge like `mergeTag('foo','bar','blog')`, the
    // unscoped (`''`) aliases for slug `foo` belong to a DIFFERENT
    // tag entirely (the `global/foo` row that the blog merge isn't
    // touching). Widening unconditionally re-introduced the
    // cross-context corruption round-7 was guarding against.
    //
    // Round-8 fix (final): only include `''` when the merge is at
    // the default context — that's the case where the
    // addAlias/Tag default-mismatch would orphan rows. For any
    // other context, the strict equality from round-7 is correct.
    const { TagAliasCollection } = await import('./tag-aliases');
    const aliasCollection = await TagAliasCollection.create(this.options);

    const aliasContexts: string[] = [fromTag.context];
    if (fromTag.context === 'global') {
      aliasContexts.push('');
    }
    const aliases = await aliasCollection.list({
      where: { tagSlug: fromSlug, context: aliasContexts },
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
    const where: Record<string, unknown> = {};
    if (context) where.context = context;

    const tags = await this.list({ where });
    const { TagAliasCollection } = await import('./tag-aliases');
    const aliasCollection = await TagAliasCollection.create(this.options);

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
   * @param context - Optional context for the parent lookup. When
   *   omitted, the parent slug must be unambiguous across contexts.
   * @returns The calculated level (root parent → 1, missing parent → 0)
   */
  async calculateLevel(
    parentSlug: string | null,
    context?: string,
  ): Promise<number> {
    if (!parentSlug) return 0;

    const parent = await this.resolveBySlug(parentSlug, context);
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
   * Find all global (tenant-less) tags.
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global tags with null tenantId
   */
  async findGlobal(): Promise<Tag[]> {
    return queryGlobal<Tag>(this);
  }

  /**
   * Find tags for a tenant including global tags.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - The tenant ID to filter by
   * @returns Array of tags for the tenant plus all global tags
   */
  async findWithGlobals(tenantId: string): Promise<Tag[]> {
    return queryWithGlobals<Tag>(this, tenantId, 'Tag.findWithGlobals');
  }
}
