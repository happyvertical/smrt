/**
 * @happyvertical/smrt-images (Node entry, also `/node`)
 *
 * Node-only image processing: sharp rendering, filesystem scratch files, the
 * `@happyvertical/images` toolkit (resvg native addon) and the AI SDK graph
 * (child_process). Under Node the `node` export condition on `.` resolves here,
 * so `import { ImageEditor } from '@happyvertical/smrt-images'` keeps working;
 * bundler/browser resolution gets the browser-safe `src/index.ts` (#3628).
 * `./node` points here too, for explicit use.
 *
 * @packageDocumentation
 */

export { applyImageAdjustments } from './adjust-render';
export { ImageCategorizer } from './categorizer';
export { ImageDeriver } from './deriver';
export { ImageEditor } from './editor';
export * from './index';
export { ImageMetadataExtractor } from './metadata';
