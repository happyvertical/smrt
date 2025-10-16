/**
 * Static manifest module for runtime use
 * Uses pre-generated manifest from build time instead of runtime scanning
 */

export {
  staticManifest as manifest,
  staticManifest as default,
} from './static-manifest';
export type {
  SmartObjectManifest,
  SmartObjectDefinition,
} from '../scanner/types';

// Re-export utility functions that work with static manifest
export { ManifestGenerator } from '../scanner/manifest-generator';

/**
 * Get manifest data (static at runtime)
 * No longer requires TypeScript compiler or file scanning
 */
export function getManifest() {
  // Import static manifest (generated at build time)
  return import('./static-manifest').then((m) => m.staticManifest);
}
