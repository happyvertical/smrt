/**
 * @have/tags
 *
 * Reusable tagging system with hierarchies, contexts, and multi-language support
 *
 * @packageDocumentation
 */

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
