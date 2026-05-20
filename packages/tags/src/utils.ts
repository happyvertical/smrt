/**
 * Utility functions for tag management
 */

import type { TagCollection } from './tags';

/**
 * Validate slug format (lowercase, alphanumeric + hyphens)
 *
 * @param slug - The slug to validate
 * @returns True if slug is valid
 */
export function validateSlug(slug: string): boolean {
  // Slug must be lowercase alphanumeric with hyphens
  const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  return slugPattern.test(slug);
}

/**
 * Sanitize slug input
 *
 * Converts to lowercase, replaces spaces with hyphens,
 * removes invalid characters, and ensures proper format.
 *
 * @param input - The input string to sanitize
 * @returns Sanitized slug
 */
export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase() // Convert to lowercase
    .trim() // Remove leading/trailing whitespace
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/[^a-z0-9-]/g, '') // Remove invalid characters
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Validate hierarchy for circular references
 *
 * Checks if setting a parent would create a circular reference
 * (e.g., making a tag its own ancestor). The actual move call in
 * `TagCollection.moveTag` also runs `SmrtHierarchical.moveTo`'s
 * descendant-cycle check; this helper remains exported for callers that
 * want to pre-validate a candidate parent without attempting the move.
 *
 * Tags are identified by `(slug, context)`. If `context` is omitted,
 * slug-only lookups are used — fine when slugs are unique across all
 * contexts, but the walk can traverse the wrong chain when the same
 * slug exists in multiple contexts. Pass the candidate parent's
 * `context` for accurate cross-context-safe validation.
 *
 * @param slug - The tag being moved
 * @param parentSlug - The proposed new parent
 * @param tagCollection - TagCollection instance for queries
 * @param context - Optional context to scope every slug lookup to
 * @returns True if circular reference detected
 */
export async function hasCircularReference(
  slug: string,
  parentSlug: string,
  tagCollection: TagCollection,
  context?: string,
): Promise<boolean> {
  // Walk up the proposed parent's chain by slug. Resolve each step to its
  // UUID parent so the iteration matches the new `parentId` FK storage.
  let current: string | null = parentSlug;
  const slugWhere = (slugValue: string): Record<string, string> => {
    const w: Record<string, string> = { slug: slugValue };
    if (context !== undefined) w.context = context;
    return w;
  };

  while (current) {
    if (current === slug) return true; // Circular reference found

    const parent = await tagCollection.get(slugWhere(current));
    if (!parent?.parentId) break;

    // Step to the grandparent by UUID. UUIDs are globally unique, so no
    // context filter is needed here.
    const grand = await tagCollection.get({ id: parent.parentId });
    current = grand?.slug ?? null;
  }

  return false;
}

/**
 * Calculate hierarchy level
 *
 * Determines the level (depth) of a tag based on its parent.
 * Root tags have level 0, their children have level 1, etc.
 *
 * @param parentSlug - The parent tag slug (null for root)
 * @param tagCollection - TagCollection instance for queries
 * @returns The calculated level
 */
export async function calculateLevel(
  parentSlug: string | null,
  tagCollection: TagCollection,
): Promise<number> {
  if (!parentSlug) return 0;

  const parent = await tagCollection.get({ slug: parentSlug });
  if (!parent) return 0;

  return parent.level + 1;
}

/**
 * Generate a unique slug from a name
 *
 * Creates a slug and ensures uniqueness by appending a number if needed.
 *
 * @param name - The name to convert to slug
 * @param context - The context for uniqueness checking
 * @param tagCollection - TagCollection instance for queries
 * @returns Unique slug
 */
export async function generateUniqueSlug(
  name: string,
  context: string,
  tagCollection: TagCollection,
): Promise<string> {
  const baseSlug = sanitizeSlug(name);
  let slug = baseSlug;
  let counter = 1;

  // Check if slug exists, append number if needed
  while (true) {
    const existing = await tagCollection.list({
      where: { slug, context },
      limit: 1,
    });

    if (existing.length === 0) break;

    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  return slug;
}
