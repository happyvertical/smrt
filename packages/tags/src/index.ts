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

// Export collections
export { TagCollection } from './tags';
export { TagAliasCollection } from './tag-aliases';

// Export types
export type {
  TagOptions,
  TagAliasOptions,
  TagMetadata,
  TagHierarchy,
} from './types';

// Export utilities
export {
  validateSlug,
  sanitizeSlug,
  hasCircularReference,
  calculateLevel,
  generateUniqueSlug,
} from './utils';
