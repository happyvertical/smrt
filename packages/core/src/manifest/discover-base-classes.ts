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
import { resolve } from 'node:path';
import { discoverSmrtPackages } from './discover-smrt-packages.js';

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

  // Load external base classes from SMRT package manifests
  for (const pkgName of smrtDependencies) {
    try {
      const manifestPath = resolve(
        cwd,
        'node_modules',
        pkgName,
        'dist',
        'manifest.json',
      );

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
    } catch (error) {}
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

  // Load external base classes from SMRT package manifests
  for (const pkgName of smrtDependencies) {
    try {
      const manifestPath = resolve(
        cwd,
        'node_modules',
        pkgName,
        'dist',
        'manifest.json',
      );

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
    } catch (error) {}
  }

  return baseClasses;
}
