/**
 * Discover SMRT classes from external packages for inheritance detection
 *
 * Loads manifests from external SMRT packages and extracts all class names.
 * These are used by the scanner for inheritance detection - to determine
 * if a class extends a valid SMRT class from an external package.
 *
 * IMPORTANT: Despite the name, this function returns ALL SMRT classes from
 * external packages, not just "base classes". The two have different uses:
 *
 * 1. DEFAULT_BASE_CLASSES (SmrtObject, SmrtClass, SmrtCollection):
 *    Used by the scanner to SKIP these framework classes from the manifest.
 *    These are the only classes that should be filtered out.
 *
 * 2. All discovered classes (return value of this function):
 *    Used by the scanner for INHERITANCE DETECTION - to recognize when a
 *    local class extends an external SMRT class.
 *
 * Issue #847 Fix: The scanner now uses DEFAULT_BASE_CLASSES for skipping,
 * not the full return value of this function. This prevents local classes
 * with names matching external classes from being incorrectly skipped.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createLogger } from '@happyvertical/logger';
import {
  discoverSmrtPackages,
  resolveManifestPath,
} from './discover-smrt-packages.js';

const logger = createLogger({ level: 'info' });

/**
 * Log a manifest-load failure during base-class discovery without aborting the
 * whole scan. ENOENT (a package that simply hasn't built/published a manifest)
 * is benign and logged at debug; malformed JSON or other read errors are
 * surfaced at warn so a stale/corrupt manifest is not silently ignored.
 */
function logBaseClassLoadError(
  pkgName: string,
  manifestPath: string,
  error: unknown,
): void {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'ENOENT') {
    logger.debug(
      `[discoverBaseClasses] No manifest for ${pkgName} at ${manifestPath}; skipping.`,
    );
  } else {
    logger.warn(
      `[discoverBaseClasses] Failed to load manifest for ${pkgName} at ${manifestPath}: ${message}`,
    );
  }
}

/**
 * Framework base classes that should be skipped during manifest generation
 *
 * These are the ONLY classes that the scanner should skip - they are
 * framework base classes that should not appear in the manifest themselves.
 *
 * Note: This is separate from inheritance detection. A local class named
 * "Council" should NOT be skipped just because an external package has a
 * class named "Council" - only these framework classes should be skipped.
 */
export const DEFAULT_BASE_CLASSES = [
  'SmrtObject',
  'SmrtClass',
  'SmrtCollection',
] as const;

/**
 * Discover all available base classes for scanning
 *
 * Combines the default SMRT framework base classes with classes discovered
 * from external SMRT package manifests.
 *
 * @param options - Discovery options
 * @param options.includeDefaults - Include default base classes (default: true)
 * @param options.cwd - Current working directory (default: process.cwd())
 * @returns Array of base class names
 *
 * @example
 * ```typescript
 * // Discover all base classes
 * const baseClasses = await discoverBaseClasses();
 * // ['SmrtObject', 'SmrtClass', 'SmrtCollection', 'ProfileRelationship', ...]
 *
 * // Only external classes
 * const external = await discoverBaseClasses({ includeDefaults: false });
 * // ['ProfileRelationship', 'Event', 'Organization', ...]
 * ```
 */
export async function discoverBaseClasses(
  options: { includeDefaults?: boolean; cwd?: string } = {},
): Promise<string[]> {
  const { includeDefaults = true, cwd = process.cwd() } = options;

  // Start with default base classes
  const baseClasses: string[] = includeDefaults
    ? [...DEFAULT_BASE_CLASSES]
    : [];

  // Discover external SMRT packages
  const smrtDependencies = discoverSmrtPackages();

  // Load external base classes from SMRT package manifests.
  // Resolve each manifest the same way discovery does (honoring `.smrt/` and
  // `src/manifest/` in addition to `dist/`), so a workspace package not yet
  // built to dist/ still contributes its base classes (#1378). A hardcoded
  // `node_modules/{pkg}/dist/manifest.json` path silently degraded inheritance
  // detection for source-only packages.
  for (const pkgName of smrtDependencies) {
    const manifestPath = resolveManifestPath(pkgName, cwd);
    if (!manifestPath) {
      logger.debug(
        `[discoverBaseClasses] No SMRT manifest resolved for ${pkgName}; skipping.`,
      );
      continue;
    }

    try {
      const manifestContent = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);

      // Extract all class names from this package
      if (manifest.objects && typeof manifest.objects === 'object') {
        for (const objDef of Object.values(manifest.objects)) {
          if (
            objDef &&
            typeof objDef === 'object' &&
            'className' in objDef &&
            typeof objDef.className === 'string'
          ) {
            baseClasses.push(objDef.className);
          }
        }
      }
    } catch (error) {
      logBaseClassLoadError(pkgName, manifestPath, error);
    }
  }

  return baseClasses;
}

/**
 * Synchronous version of discoverBaseClasses
 *
 * Uses readFileSync to load manifests synchronously. Works in both ESM and CJS.
 *
 * @param options - Discovery options
 * @returns Array of base class names
 *
 * @example
 * ```typescript
 * const baseClasses = discoverBaseClassesSync();
 * const scanner = new OxcScanner({ baseClasses });
 * ```
 */
export function discoverBaseClassesSync(
  options: { includeDefaults?: boolean; cwd?: string } = {},
): string[] {
  const { includeDefaults = true, cwd = process.cwd() } = options;

  // Start with default base classes
  const baseClasses: string[] = includeDefaults
    ? [...DEFAULT_BASE_CLASSES]
    : [];

  // Discover external SMRT packages
  const smrtDependencies = discoverSmrtPackages();

  // Load external base classes from SMRT package manifests. Same resolution as
  // the async variant (honors `.smrt/` and `src/manifest/`, not just `dist/`),
  // so source-only workspace packages still contribute base classes (#1378).
  for (const pkgName of smrtDependencies) {
    const manifestPath = resolveManifestPath(pkgName, cwd);
    if (!manifestPath) {
      logger.debug(
        `[discoverBaseClassesSync] No SMRT manifest resolved for ${pkgName}; skipping.`,
      );
      continue;
    }

    try {
      // Use fs.readFileSync for synchronous loading (works in ESM)
      const manifestContent = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);

      // Extract all class names from this package
      if (manifest.objects && typeof manifest.objects === 'object') {
        for (const objDef of Object.values(manifest.objects)) {
          if (
            objDef &&
            typeof objDef === 'object' &&
            'className' in objDef &&
            typeof objDef.className === 'string'
          ) {
            baseClasses.push(objDef.className);
          }
        }
      }
    } catch (error) {
      logBaseClassLoadError(pkgName, manifestPath, error);
    }
  }

  return baseClasses;
}
