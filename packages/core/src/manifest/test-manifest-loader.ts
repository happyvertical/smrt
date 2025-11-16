/**
 * Test manifest loader with fallback
 * Synchronously loads test manifest if available, otherwise returns empty manifest
 */

import type { SmartObjectManifest } from '../scanner/types';

// Try to import test manifest, fall back to empty manifest
let loadedTestManifest: SmartObjectManifest | null = null;

try {
  // This will be replaced by the actual manifest after pretest script runs
  // @ts-expect-error - test-manifest.js is generated during test setup and may not exist during build
  const { testManifest } = await import('./test-manifest.js');
  loadedTestManifest = testManifest;
} catch {
  // Test manifest not generated yet - use empty manifest
  loadedTestManifest = null;
}

export const testManifest = loadedTestManifest;
