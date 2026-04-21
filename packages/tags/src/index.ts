/**
 * @have/tags
 *
 * Reusable tagging system with hierarchies, contexts, and multi-language support
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Export models
export { Tag } from './tag';
export { TagAlias } from './tag-alias';
export { TagAliasCollection } from './tag-aliases';
// Export collections
export { TagCollection } from './tags';

// Export types
export type {
  TagAliasOptions,
  TagHierarchy,
  TagMetadata,
  TagOptions,
} from './types';

// Export utilities
export {
  calculateLevel,
  generateUniqueSlug,
  hasCircularReference,
  sanitizeSlug,
  validateSlug,
} from './utils';
