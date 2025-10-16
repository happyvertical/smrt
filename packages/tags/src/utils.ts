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
 * (e.g., making a tag its own ancestor).
 *
 * @param slug - The tag being moved
 * @param parentSlug - The proposed new parent
 * @param tagCollection - TagCollection instance for queries
 * @returns True if circular reference detected
 */
export async function hasCircularReference(
  slug: string,
  parentSlug: string,
  tagCollection: TagCollection,
): Promise<boolean> {
  let current = parentSlug;

  while (current) {
    if (current === slug) return true; // Circular reference found

    const parent = await tagCollection.get({ slug: current });
    if (!parent || !parent.parentSlug) break;

    current = parent.parentSlug;
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
