/**
 * @packageDocumentation
 * STI content types (Article, ContentDocument, Mirror) with thumbnail generation
 * strategies, asset associations, and markdown serialization utilities.
 */

export type { ContentOptions } from './content';
export { Content } from './content';
export type { ContentReferenceOptions } from './content-reference';
export { ContentReference } from './content-reference';
export type { ContentReferencesOptions } from './content-references';
export { ContentReferences } from './content-references';
// Content subclasses (STI)
export { Article, ContentDocument, Mirror } from './content-types';
export type { ContentsOptions } from './contents';
export { Contents } from './contents';
// Thumbnail generation
export {
  type AIGenerateThumbnailOptions,
  type HeadlineCardThumbnailOptions,
  type StaticMapThumbnailOptions,
  ThumbnailGenerator,
  type ThumbnailOptions,
  type ThumbnailStrategy,
} from './thumbnail-generator';
export { contentToString, stringToContent } from './utils';
