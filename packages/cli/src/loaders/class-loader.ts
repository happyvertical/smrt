/**
 * Dynamic Class Loader for SMRT CLI
 *
 * Loads SMRT object classes from external packages at runtime,
 * enabling CLI commands to work with objects from installed packages.
 */

import { createLogger } from '@happyvertical/logger';
import type { SmartObjectDefinition } from '@happyvertical/smrt-core/scanner';

export interface LoadedClasses {
  ObjectClass: any;
  CollectionClass?: any;
}

/**
 * Dynamically load SMRT classes from external packages
 */
export class DynamicClassLoader {
  private loadedModules = new Map<string, any>();
  private classCache = new Map<string, LoadedClasses>();
  private verbose: boolean;
  // verbose traces are debug-level; the logger level follows the flag so they
  // actually emit when verbose is on (a fixed 'info' would filter them).
  private logger: ReturnType<typeof createLogger>;

  constructor(options: { verbose?: boolean } = {}) {
    this.verbose = options.verbose || false;
    this.logger = createLogger({ level: this.verbose ? 'debug' : 'info' });
  }

  /**
   * Load a class from package using manifest metadata
   */
  async loadClass(objectDef: SmartObjectDefinition): Promise<LoadedClasses> {
    const cacheKey = `${objectDef.packageName}:${objectDef.className}`;

    // Return cached if available
    if (this.classCache.has(cacheKey)) {
      if (this.verbose) {
        this.logger.debug(`[ClassLoader] Using cached ${cacheKey}`);
      }
      return this.classCache.get(cacheKey)!;
    }

    try {
      // Determine import path
      const importPath = this.resolveImportPath(objectDef);

      if (this.verbose) {
        this.logger.debug(
          `[ClassLoader] Loading ${cacheKey} from ${importPath}`,
        );
      }

      // Dynamic import
      let module = this.loadedModules.get(importPath);
      if (!module) {
        module = await import(importPath);
        this.loadedModules.set(importPath, module);

        if (this.verbose) {
          this.logger.debug(`[ClassLoader] Imported module ${importPath}`);
        }
      }

      // Extract classes
      const ObjectClass =
        module[objectDef.exportName || objectDef.className] || module.default;
      const CollectionClass = objectDef.collectionExportName
        ? module[objectDef.collectionExportName]
        : undefined;

      if (!ObjectClass) {
        throw new Error(
          `Failed to find export '${objectDef.exportName || objectDef.className}' in ${importPath}`,
        );
      }

      const result = { ObjectClass, CollectionClass };
      this.classCache.set(cacheKey, result);

      if (this.verbose) {
        this.logger.debug(
          `[ClassLoader] Loaded ${cacheKey} (Collection: ${CollectionClass ? 'yes' : 'no'})`,
        );
      }

      return result;
    } catch (error) {
      throw new Error(
        `Failed to load class ${objectDef.className} from ${objectDef.packageName}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  /**
   * Resolve import path with fallbacks
   */
  private resolveImportPath(objectDef: SmartObjectDefinition): string {
    // Try explicit import path first
    if (objectDef.importPath) {
      return objectDef.importPath;
    }

    // Fallback: Try package main export
    if (objectDef.packageName) {
      return objectDef.packageName;
    }

    throw new Error(
      `Cannot determine import path for ${objectDef.className} - no importPath or packageName`,
    );
  }

  /**
   * Load all classes from manifest
   */
  async loadAllFromManifest(
    manifest: any,
  ): Promise<Map<string, LoadedClasses>> {
    const loaded = new Map<string, LoadedClasses>();

    for (const [objectName, objectDef] of Object.entries(manifest.objects)) {
      try {
        const classes = await this.loadClass(
          objectDef as SmartObjectDefinition,
        );
        loaded.set(objectName, classes);
      } catch (error) {
        if (this.verbose) {
          this.logger.warn(`[ClassLoader] Skipping ${objectName}`, {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    return loaded;
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.loadedModules.clear();
    this.classCache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    modulesLoaded: number;
    classesCached: number;
  } {
    return {
      modulesLoaded: this.loadedModules.size,
      classesCached: this.classCache.size,
    };
  }
}
