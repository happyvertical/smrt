/**
 * @have/tags
 *
 * Reusable tagging system with hierarchies, contexts, and multi-language support
 *
 * @packageDocumentation
 */
export { Tag } from './tag';
export { TagAlias } from './tag-alias';
export { TagCollection } from './tags';
export { TagAliasCollection } from './tag-aliases';
export type { TagOptions, TagAliasOptions, TagMetadata, TagHierarchy, } from './types';
export { validateSlug, sanitizeSlug, hasCircularReference, calculateLevel, generateUniqueSlug, } from './utils';
//# sourceMappingURL=index.d.ts.map