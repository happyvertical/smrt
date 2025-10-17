/**
 * Static manifest module for runtime use
 * Uses pre-generated manifest from build time instead of runtime scanning
 */

// Re-export utility functions that work with static manifest
export { ManifestGenerator } from '../scanner/manifest-generator';
export type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
export {
  staticManifest as manifest,
  staticManifest as default,
} from './static-manifest';

/**
 * Get manifest data (static at runtime)
 * No longer requires TypeScript compiler or file scanning
 */
export function getManifest() {
  // Import static manifest (generated at build time)
  return import('./static-manifest').then((m) => m.staticManifest);
}
