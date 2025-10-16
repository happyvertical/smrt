import { TagCollection } from './tags';
/**
 * Validate slug format (lowercase, alphanumeric + hyphens)
 *
 * @param slug - The slug to validate
 * @returns True if slug is valid
 */
export declare function validateSlug(slug: string): boolean;
/**
 * Sanitize slug input
 *
 * Converts to lowercase, replaces spaces with hyphens,
 * removes invalid characters, and ensures proper format.
 *
 * @param input - The input string to sanitize
 * @returns Sanitized slug
 */
export declare function sanitizeSlug(input: string): string;
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
export declare function hasCircularReference(slug: string, parentSlug: string, tagCollection: TagCollection): Promise<boolean>;
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
export declare function calculateLevel(parentSlug: string | null, tagCollection: TagCollection): Promise<number>;
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
export declare function generateUniqueSlug(name: string, context: string, tagCollection: TagCollection): Promise<string>;
//# sourceMappingURL=utils.d.ts.map