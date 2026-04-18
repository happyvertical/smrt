/**
 * Static manifest module for runtime use
 * Uses pre-generated manifest from build time instead of runtime scanning
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SmartObjectManifest } from '../scanner/types';

// Re-export utility functions that work with static manifest
export { ManifestGenerator } from '../scanner/manifest-generator';
export type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
export type { ManifestBuilderOptions } from './generator';
export { ManifestBuilder } from './generator';
export { ManifestManager } from './manager';
export {
  discoverManifestEntry,
  findManifestEntryByQualifiedName,
  loadExternalManifest,
  loadExternalManifestSync,
  loadLocalTestManifestSync,
  loadManifestFromPathSync,
} from './manifest-loader';

const EMPTY_STATIC_MANIFEST: SmartObjectManifest = {
  version: '1.0.0',
  timestamp: 0,
  objects: {},
  packageName: '@happyvertical/smrt-core',
};

function loadStaticManifest(): SmartObjectManifest {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const manifestCandidates = [
    join(currentDir, 'static-manifest.json'),
    join(currentDir, '..', 'manifest.json'),
    join(currentDir, '..', '..', 'dist', 'manifest.json'),
  ];

  for (const manifestPath of manifestCandidates) {
    if (!existsSync(manifestPath)) {
      continue;
    }

    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      // Fall through to the next candidate or the empty manifest.
    }
  }

  return EMPTY_STATIC_MANIFEST;
}

export const manifest = loadStaticManifest();
export const staticManifest = manifest;
export default manifest;

/**
 * Get manifest data (static at runtime)
 * No longer requires TypeScript compiler or file scanning.
 */
export function getManifest() {
  return Promise.resolve(manifest);
}
