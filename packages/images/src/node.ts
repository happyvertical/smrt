/**
 * @happyvertical/smrt-images/node
 *
 * Node-only image processing: sharp rendering, filesystem scratch files, the
 * `@happyvertical/images` toolkit (resvg native addon) and the AI SDK graph
 * (child_process). The package root stays browser-safe (#3628); import these
 * services from here. This subpath also re-exports the whole root, so a
 * Node consumer can use it as a single import path.
 *
 * @packageDocumentation
 */

export { applyImageAdjustments } from './adjust-render';
export { ImageCategorizer } from './categorizer';
export { ImageDeriver } from './deriver';
export { ImageEditor } from './editor';
export * from './index';
export { ImageMetadataExtractor } from './metadata';
