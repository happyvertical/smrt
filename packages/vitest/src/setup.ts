/**
 * Vitest setup file for globalThis state isolation
 *
 * Import this file in your vitest.config.ts to prevent
 * manifest cache and registry state from bleeding across test files.
 *
 * @example
 * ```typescript
 * // vitest.config.ts
 * import { defineConfig } from 'vitest/config';
 *
 * export default defineConfig({
 *   test: {
 *     setupFiles: ['@happyvertical/smrt-vitest/setup'],
 *   },
 * });
 * ```
 *
 * @packageDocumentation
 */

import { afterAll, beforeAll } from 'vitest';

// Type alias for any to avoid conflicts with smrt-core's globalThis declarations
type CacheState = unknown;

// Snapshot original state before tests
let originalManifestCache: CacheState;
let originalLocalTest: CacheState;

beforeAll(() => {
  // Capture original state using type-safe accessors
  const g = globalThis as Record<string, CacheState>;
  originalManifestCache = g.__smrtManifestCache;
  originalLocalTest = g.__smrtManifestLocalTest;
});

afterAll(async () => {
  // Restore original state to prevent cross-file pollution
  const g = globalThis as Record<string, CacheState>;
  g.__smrtManifestCache = originalManifestCache;
  g.__smrtManifestLocalTest = originalLocalTest;

  // Reset table existence cache to prevent cross-file contamination (issue #970)
  // Dynamic import to avoid hard dependency on smrt-core from vitest package
  try {
    const { resetVerifiedTables } = await import('@happyvertical/smrt-core');
    resetVerifiedTables();
  } catch {
    // smrt-core may not be available in all test environments
  }
});
