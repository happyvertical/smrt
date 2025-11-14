/**
 * Discover base classes from external SMRT packages
 *
 * Loads manifests from external SMRT packages and extracts all class names
 * to use as potential base classes for inheritance detection.
 *
 * This enables the AST scanner to discover classes that extend models from
 * external packages (e.g., CouncilMember extends ProfileRelationship).
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { discoverSmrtPackages } from './discover-smrt-packages.js';

/**
 * Default base classes that are always included
 */
export const DEFAULT_BASE_CLASSES = [
  'SmrtObject',
  'SmrtClass',
  'SmrtCollection',
] as const;

/**
 * Discover all available base classes for AST scanning
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
  const smrtDependencies = discoverSmrtPackages(cwd);

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
 * const scanner = new ASTScanner(files, { baseClasses });
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
  const smrtDependencies = discoverSmrtPackages(cwd);

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
