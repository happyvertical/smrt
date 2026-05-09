# Issue #215: Dynamic Class Loading Architecture

**Issue**: [#215 - SMRT CLI should discover objects from consumer plugin's aggregated manifest](https://github.com/happyvertical/smrt/issues/215)

**Status**: In Development
**Branch**: `feat/issue-215-dynamic-class-loading`
**Started**: 2025-11-05

---

## Problem Statement

### Current Behavior
The SMRT CLI only discovers objects from the local project, ignoring objects from external packages consumed via `smrtConsumer` plugin.

**Example**:
```bash
# Install external SMRT package
npm install @happyvertical/praeco

# CLI should show external objects but doesn't
npx smrt objects
# Output: Only shows local objects ❌
```

### Root Cause
The CLI needs actual class constructors to:
1. Instantiate collection classes
2. Execute CRUD operations
3. Call custom methods on objects

**Current state**:
- ✅ Consumer plugin aggregates manifests to `.smrt/manifest.json`
- ✅ CLI discovers the aggregated manifest
- ❌ CLI cannot execute commands without class code

---

## Architecture Analysis

### What Works ✅

#### 1. Consumer Plugin Aggregation
**File**: `packages/core/src/consumer-plugin/index.ts`

```typescript
async function aggregateTypeManifests(packages, projectRoot) {
  const aggregatedManifest = {
    version: '1.0.0',
    timestamp: Date.now(),
    objects: {}
  };

  // Scans node_modules for SMRT packages
  // Loads manifests from each package
  // Aggregates into single manifest

  return aggregatedManifest;
}

// Saves to .smrt/manifest.json (lines 415-437)
await saveAggregatedManifest(typeManifest, projectRoot);
```

#### 2. CLI Manifest Discovery
**File**: `packages/cli/src/discovery/manifest-discovery.ts`

```typescript
async function findProjectManifests(projectRoot) {
  const candidates = [
    '.smrt/manifest.json',  // ← Consumer plugin output
    'dist/manifest.json',
    // ... other locations
  ];

  // Finds and loads .smrt/manifest.json
  // Returns manifest metadata
}
```

#### 3. CLI Metadata Registration
**File**: `packages/cli/src/cli-generator.ts` (lines 264-278)

```typescript
if (manifest?.objects) {
  for (const [name, objectDef] of Object.entries(manifest.objects)) {
    // Registers metadata in ObjectRegistry
    ObjectRegistry.registerFromManifest(name, objectDef, manifest.packageName);
  }
}
```

### What's Missing ❌

#### 1. Package Metadata in Manifest
Current manifest doesn't include:
- `packageName` - Which package the object comes from
- `importPath` - Where to dynamically import the class from
- `exportName` - Named export to use
- `collectionExportName` - Collection class export

Without this, CLI can't determine **where to load classes from**.

#### 2. Dynamic Class Loading
**File**: `packages/cli/src/cli-generator.ts` (lines 113-228)

```typescript
private async tryLoadUserClasses() {
  // Only loads LOCAL entry point
  const entryPoint = './dist/index.js';
  await import(entryPoint);

  // ❌ No mechanism to import from external packages
}
```

#### 3. Collection Instantiation
**File**: `packages/cli/src/cli-generator.ts` (lines 1139-1181)

```typescript
private async getCollection(objectName) {
  const classInfo = ObjectRegistry.getClass(objectName);

  if (!classInfo || !classInfo.collectionConstructor) {
    throw new Error(
      `Object ${objectName} not found or has no collection constructor.`
    );
  }

  // ❌ Fails for external objects without loaded constructors
  const collection = new classInfo.collectionConstructor({...});
}
```

---

## Solution Architecture

### Overview

**5-Phase Implementation**:
1. **Enhanced Manifest Schema** - Add package metadata
2. **Consumer Plugin Enhancement** - Preserve metadata during aggregation
3. **Dynamic Class Loader** - Load classes from external packages at runtime
4. **CLI Integration** - Use loaded classes for command execution
5. **Testing & Documentation** - Comprehensive coverage

---

## Phase 1: Enhanced Manifest Schema

### Goal
Include package metadata needed for dynamic imports.

### New Type Definition

**File**: `packages/core/src/scanner/types.ts`

```typescript
export interface SmartObjectDefinition {
  // Existing fields
  name: string;
  className: string;
  collection: string;
  filePath: string;
  fields: Record<string, SmrtObjectField>;
  methods: Record<string, SmrtObjectMethod>;
  decoratorConfig: any;
  extends?: string;

  // NEW: Package metadata for dynamic loading
  packageName: string;          // e.g., "@happyvertical/praeco"
  packageVersion?: string;       // e.g., "1.2.3"
  importPath: string;            // e.g., "@happyvertical/praeco/objects"
  modulePath?: string;           // e.g., "dist/objects/agent.js"
  exportName: string;            // e.g., "Agent" or "default"
  collectionExportName?: string; // e.g., "AgentCollection"
}

export interface SmartObjectManifest {
  version: string;
  timestamp: number;
  packageName?: string;          // NEW: Root package name
  packageVersion?: string;       // NEW: Root package version
  objects: Record<string, SmartObjectDefinition>;
}
```

### Implementation

**File**: `packages/core/src/scanner/ast-scanner.ts`

```typescript
export function scanSmrtObjects(options: ScanOptions): SmartObjectManifest {
  const packageJson = loadPackageJson(options.projectRoot);

  // Scan for SMRT objects...

  return {
    version: '1.0.0',
    timestamp: Date.now(),
    packageName: packageJson.name,         // NEW
    packageVersion: packageJson.version,   // NEW
    objects: {
      [className]: {
        // ... existing fields ...

        // NEW: Package metadata
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        importPath: determineImportPath(packageJson, filePath),
        exportName: className,
        collectionExportName: `${className}Collection`,
      }
    }
  };
}

/**
 * Determine import path from package.json exports
 */
function determineImportPath(packageJson: any, filePath: string): string {
  // Try package.json exports field first
  if (packageJson.exports) {
    // Check for specific object exports
    if (packageJson.exports['./objects']) {
      return `${packageJson.name}/objects`;
    }

    // Check for main export
    if (packageJson.exports['.']) {
      return packageJson.name;
    }
  }

  // Fallback to main field
  if (packageJson.main) {
    return packageJson.name;
  }

  // Default fallback
  return `${packageJson.name}/dist/index.js`;
}
```

### Backwards Compatibility

Old manifests without package metadata:
- Treated as local objects
- `packageName` defaults to current project
- `importPath` defaults to local entry point

---

## Phase 2: Consumer Plugin Enhancement

### Goal
Preserve package metadata when aggregating manifests.

### Current Issue

**File**: `packages/core/src/consumer-plugin/index.ts` (line 254)

```typescript
// Current: Loses package context during merge
Object.assign(aggregatedManifest.objects, manifest.objects);
```

### Enhanced Implementation

```typescript
async function aggregateTypeManifests(
  packages: string[],
  projectRoot: string,
): Promise<any> {
  const aggregatedManifest = {
    version: '1.0.0',
    timestamp: Date.now(),
    objects: {} as Record<string, any>,
  };

  for (const packageName of packages) {
    try {
      const packageDir = path.join(projectRoot, 'node_modules', packageName);

      // Load package.json for version info
      const packageJsonPath = path.join(packageDir, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      // Try multiple manifest locations
      const manifestCandidates = [
        path.join(packageDir, 'dist', 'manifest', 'static-manifest.js'),
        path.join(packageDir, 'dist', 'manifest.json'),
        path.join(packageDir, 'manifest.json'),
      ];

      for (const manifestPath of manifestCandidates) {
        if (fs.existsSync(manifestPath)) {
          let manifest;
          if (manifestPath.endsWith('.js')) {
            const manifestModule = await import(manifestPath);
            manifest = manifestModule.staticManifest || manifestModule.default;
          } else {
            const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
            manifest = JSON.parse(manifestContent);
          }

          if (manifest?.objects) {
            console.log(
              `[smrt:consumer] Loaded manifest from ${packageName} (${Object.keys(manifest.objects).length} objects)`
            );

            // ENHANCED: Preserve package metadata for each object
            for (const [objectName, objectDef] of Object.entries(manifest.objects)) {
              aggregatedManifest.objects[objectName] = {
                ...objectDef,
                // Ensure package metadata is preserved
                packageName: manifest.packageName || packageName,
                packageVersion: manifest.packageVersion || packageJson.version,
                // Add fallback import paths if missing
                importPath: objectDef.importPath || determineImportPath(packageJson),
                exportName: objectDef.exportName || objectName,
                collectionExportName: objectDef.collectionExportName || `${objectName}Collection`,
              };
            }

            break; // Use first found manifest for this package
          }
        }
      }
    } catch (error) {
      console.warn(
        `[smrt:consumer] Error loading manifest from ${packageName}:`,
        error,
      );
    }
  }

  return aggregatedManifest;
}

/**
 * Determine import path from package.json
 */
function determineImportPath(packageJson: any): string {
  if (packageJson.exports?.['./objects']) {
    return `${packageJson.name}/objects`;
  }
  if (packageJson.exports?.['.']) {
    return packageJson.name;
  }
  return `${packageJson.name}/dist/index.js`;
}
```

---

## Phase 3: Dynamic Class Loader

### Goal
Load classes from external packages at runtime.

### New File: `packages/cli/src/loaders/class-loader.ts`

```typescript
/**
 * Dynamic Class Loader for SMRT CLI
 *
 * Loads SMRT object classes from external packages at runtime,
 * enabling CLI commands to work with objects from installed packages.
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
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

  constructor(options: { verbose?: boolean } = {}) {
    this.verbose = options.verbose || false;
  }

  /**
   * Load a class from package using manifest metadata
   */
  async loadClass(objectDef: SmartObjectDefinition): Promise<LoadedClasses> {
    const cacheKey = `${objectDef.packageName}:${objectDef.className}`;

    // Return cached if available
    if (this.classCache.has(cacheKey)) {
      if (this.verbose) {
        console.log(`[ClassLoader] Using cached ${cacheKey}`);
      }
      return this.classCache.get(cacheKey)!;
    }

    try {
      // Determine import path
      const importPath = this.resolveImportPath(objectDef);

      if (this.verbose) {
        console.log(`[ClassLoader] Loading ${cacheKey} from ${importPath}`);
      }

      // Dynamic import
      let module = this.loadedModules.get(importPath);
      if (!module) {
        module = await import(importPath);
        this.loadedModules.set(importPath, module);

        if (this.verbose) {
          console.log(`[ClassLoader] Imported module ${importPath}`);
        }
      }

      // Extract classes
      const ObjectClass = module[objectDef.exportName] || module.default;
      const CollectionClass = objectDef.collectionExportName
        ? module[objectDef.collectionExportName]
        : undefined;

      if (!ObjectClass) {
        throw new Error(
          `Failed to find export '${objectDef.exportName}' in ${importPath}`
        );
      }

      const result = { ObjectClass, CollectionClass };
      this.classCache.set(cacheKey, result);

      if (this.verbose) {
        console.log(
          `[ClassLoader] Loaded ${cacheKey} (Collection: ${CollectionClass ? 'yes' : 'no'})`
        );
      }

      return result;
    } catch (error) {
      throw new Error(
        `Failed to load class ${objectDef.className} from ${objectDef.packageName}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
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
      `Cannot determine import path for ${objectDef.className} - no importPath or packageName`
    );
  }

  /**
   * Try to load class with fallback strategies
   */
  private async tryImportWithFallbacks(
    importPath: string,
    objectDef: SmartObjectDefinition
  ): Promise<any> {
    const strategies = [
      // Strategy 1: Direct import path
      () => import(importPath),

      // Strategy 2: Package name only
      () => import(objectDef.packageName),

      // Strategy 3: Package + /dist/index.js
      () => import(`${objectDef.packageName}/dist/index.js`),

      // Strategy 4: Package + /objects
      () => import(`${objectDef.packageName}/objects`),
    ];

    let lastError: Error | null = null;

    for (const strategy of strategies) {
      try {
        const module = await strategy();
        if (module) {
          return module;
        }
      } catch (error) {
        lastError = error as Error;
        // Continue to next strategy
      }
    }

    throw lastError || new Error('All import strategies failed');
  }

  /**
   * Load all classes from manifest
   */
  async loadAllFromManifest(
    manifest: any
  ): Promise<Map<string, LoadedClasses>> {
    const loaded = new Map<string, LoadedClasses>();

    for (const [objectName, objectDef] of Object.entries(manifest.objects)) {
      try {
        const classes = await this.loadClass(objectDef as SmartObjectDefinition);
        loaded.set(objectName, classes);
      } catch (error) {
        if (this.verbose) {
          console.warn(
            `[ClassLoader] Skipping ${objectName}:`,
            error instanceof Error ? error.message : 'Unknown error'
          );
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
```

### Error Handling

The loader provides detailed error messages:

```typescript
// Missing package
Error: Failed to load class Agent from @happyvertical/praeco
Cause: Cannot find module '@happyvertical/praeco'

Solution: Install the package
  npm install @happyvertical/praeco

// Wrong export name
Error: Failed to find export 'Agent' in @happyvertical/praeco

Solution: Check package documentation for correct export name

// Import path resolution failed
Error: Cannot determine import path for Agent - no importPath or packageName

Solution: Ensure manifest includes packageName and importPath
```

---

## Phase 4: CLI Integration

### Goal
Use dynamically loaded classes for command execution.

### Updated: `packages/cli/src/cli-generator.ts`

#### 4.1 Update `tryLoadUserClasses()`

```typescript
/**
 * Try to load user's compiled classes for runtime execution
 */
private async tryLoadUserClasses(): Promise<void> {
  try {
    // 1. Load local classes (existing code)
    await this.loadLocalClasses();

    // 2. NEW: Load classes from external packages
    await this.loadExternalClasses();

    const registeredCount = ObjectRegistry.getAllClasses().size;
    if (this.config.verbose) {
      console.log(`[CLI] Successfully loaded ${registeredCount} SMRT objects`);
    }
  } catch (error) {
    const { getPackageConfig } = await import('@happyvertical/smrt-config');
    const { DEFAULT_CLI_CONFIG } = await import('./config.js');
    const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

    if (config.verbose) {
      console.warn(
        '[CLI] Failed to load classes:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      console.log('[CLI] Using manifest-only mode (some commands may not work)');
    }
  }
}

/**
 * Load classes from local project (existing behavior)
 */
private async loadLocalClasses(): Promise<void> {
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('./config.js');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

  // Determine entry point
  let entryPoint: string | null = config.entryPoint;

  if (!entryPoint) {
    // Read from package.json
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      entryPoint =
        packageJson.exports?.['.']?.import ||
        packageJson.exports?.['.'] ||
        packageJson.main ||
        './dist/index.js';
    }
  }

  if (!entryPoint) {
    entryPoint = './dist/index.js';
  }

  const fullPath = path.resolve(process.cwd(), entryPoint);

  if (!fs.existsSync(fullPath)) {
    if (config.verbose) {
      console.log(`[CLI] Entry point not found: ${fullPath}`);
    }
    return;
  }

  if (config.verbose) {
    console.log(`[CLI] Loading local SMRT classes from ${entryPoint}...`);
  }

  const fileUrl = `file://${fullPath}`;
  const importedModule = await import(fileUrl);

  // Register collections from exports
  for (const [exportName, exportValue] of Object.entries(importedModule)) {
    if (exportValue && typeof exportValue === 'function') {
      const itemClass = (exportValue as any)._itemClass;
      if (itemClass) {
        const tableName = itemClass.SMRT_TABLE_NAME || itemClass.name.toLowerCase();
        const existing = ObjectRegistry.getClass(tableName);
        if (existing && !existing.collectionConstructor) {
          ObjectRegistry.registerCollection(tableName, exportValue as any);
          if (config.verbose) {
            console.log(`[CLI] Registered local collection ${exportName}`);
          }
        }
      }
    }
  }
}

/**
 * NEW: Load classes from external packages
 */
private async loadExternalClasses(): Promise<void> {
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('./config.js');
  const { DynamicClassLoader } = await import('./loaders/class-loader.js');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

  // Read .smrt/manifest.json
  const manifestPath = path.join(process.cwd(), '.smrt/manifest.json');
  if (!fs.existsSync(manifestPath)) {
    if (config.verbose) {
      console.log('[CLI] No .smrt/manifest.json found - no external packages');
    }
    return;
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const manifest = JSON.parse(manifestContent);

  if (!manifest.objects || Object.keys(manifest.objects).length === 0) {
    if (config.verbose) {
      console.log('[CLI] No objects in manifest');
    }
    return;
  }

  const loader = new DynamicClassLoader({ verbose: config.verbose });

  // Load classes from external packages only
  for (const [objectName, objectDef] of Object.entries(manifest.objects)) {
    const def = objectDef as any;

    // Skip local objects (already loaded)
    if (!def.packageName || def.packageName === manifest.packageName) {
      continue;
    }

    try {
      const { ObjectClass, CollectionClass } = await loader.loadClass(def);

      // Register in ObjectRegistry
      const tableName = def.collection || objectName.toLowerCase();

      // Check if already registered
      const existing = ObjectRegistry.getClass(tableName);
      if (!existing) {
        // Register new object
        ObjectRegistry.register(tableName, ObjectClass);
        if (config.verbose) {
          console.log(`[CLI] Registered ${objectName} from ${def.packageName}`);
        }
      }

      // Register collection if available
      if (CollectionClass && (!existing || !existing.collectionConstructor)) {
        ObjectRegistry.registerCollection(tableName, CollectionClass);
        if (config.verbose) {
          console.log(
            `[CLI] Registered ${objectName}Collection from ${def.packageName}`
          );
        }
      }
    } catch (error) {
      console.warn(
        `[CLI] Failed to load ${objectName} from ${def.packageName}:`,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  const stats = loader.getStats();
  if (config.verbose) {
    console.log(
      `[CLI] External classes loaded: ${stats.classesCached} (${stats.modulesLoaded} modules)`
    );
  }
}
```

#### 4.2 Enhanced Error Messages

```typescript
/**
 * Get or create collection for an object
 */
private async getCollection(objectName: string): Promise<SmrtCollection<any>> {
  if (!this.collections.has(objectName)) {
    const classInfo = ObjectRegistry.getClass(objectName);

    if (!classInfo || !classInfo.collectionConstructor) {
      // Enhanced error message with troubleshooting
      const availableObjects = Array.from(ObjectRegistry.getAllClasses().keys());

      throw new Error(
        `Object '${objectName}' not found or has no collection constructor.\n\n` +
        `Available objects:\n  ${availableObjects.join('\n  ')}\n\n` +
        `Troubleshooting:\n` +
        `1. If from external package, ensure it's installed:\n` +
        `   npm install <package-name>\n\n` +
        `2. Rebuild your project to regenerate manifest:\n` +
        `   npm run build\n\n` +
        `3. Check .smrt/manifest.json contains the object\n\n` +
        `4. Verify package exports classes correctly\n`
      );
    }

    // ... rest of implementation
  }

  return this.collections.get(objectName)!;
}
```

---

## Phase 5: Testing & Documentation

### Unit Tests

**New File**: `packages/cli/src/loaders/class-loader.spec.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { DynamicClassLoader } from './class-loader.js';

describe('DynamicClassLoader', () => {
  let loader: DynamicClassLoader;

  beforeEach(() => {
    loader = new DynamicClassLoader({ verbose: false });
  });

  describe('loadClass', () => {
    it('should load class from package', async () => {
      const objectDef = {
        packageName: '@happyvertical/smrt-core',
        className: 'SmrtObject',
        importPath: '@happyvertical/smrt-core',
        exportName: 'SmrtObject',
        // ... other required fields
      } as any;

      const { ObjectClass } = await loader.loadClass(objectDef);

      expect(ObjectClass).toBeDefined();
      expect(ObjectClass.name).toBe('SmrtObject');
    });

    it('should cache loaded modules', async () => {
      const objectDef = {
        packageName: '@happyvertical/smrt-core',
        className: 'SmrtObject',
        importPath: '@happyvertical/smrt-core',
        exportName: 'SmrtObject',
      } as any;

      await loader.loadClass(objectDef);
      await loader.loadClass(objectDef); // Should use cache

      const stats = loader.getStats();
      expect(stats.modulesLoaded).toBe(1);
      expect(stats.classesCached).toBe(1);
    });

    it('should handle import failures gracefully', async () => {
      const invalidDef = {
        packageName: 'non-existent-package-12345',
        className: 'Fake',
        importPath: 'non-existent-package-12345',
        exportName: 'Fake',
      } as any;

      await expect(loader.loadClass(invalidDef)).rejects.toThrow(
        /Failed to load class Fake/
      );
    });

    it('should load collection class if available', async () => {
      const objectDef = {
        packageName: '@happyvertical/smrt-core',
        className: 'SmrtObject',
        importPath: '@happyvertical/smrt-core',
        exportName: 'SmrtObject',
        collectionExportName: 'SmrtCollection',
      } as any;

      const { ObjectClass, CollectionClass } = await loader.loadClass(objectDef);

      expect(ObjectClass).toBeDefined();
      expect(CollectionClass).toBeDefined();
    });
  });

  describe('loadAllFromManifest', () => {
    it('should load all classes from manifest', async () => {
      const manifest = {
        objects: {
          SmrtObject: {
            packageName: '@happyvertical/smrt-core',
            className: 'SmrtObject',
            importPath: '@happyvertical/smrt-core',
            exportName: 'SmrtObject',
          },
        },
      };

      const loaded = await loader.loadAllFromManifest(manifest);

      expect(loaded.size).toBe(1);
      expect(loaded.has('SmrtObject')).toBe(true);
    });

    it('should skip objects that fail to load', async () => {
      const manifest = {
        objects: {
          Valid: {
            packageName: '@happyvertical/smrt-core',
            className: 'SmrtObject',
            importPath: '@happyvertical/smrt-core',
            exportName: 'SmrtObject',
          },
          Invalid: {
            packageName: 'non-existent',
            className: 'Fake',
            importPath: 'non-existent',
            exportName: 'Fake',
          },
        },
      };

      const loaded = await loader.loadAllFromManifest(manifest);

      expect(loaded.size).toBe(1);
      expect(loaded.has('Valid')).toBe(true);
      expect(loaded.has('Invalid')).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should clear all caches', async () => {
      const objectDef = {
        packageName: '@happyvertical/smrt-core',
        className: 'SmrtObject',
        importPath: '@happyvertical/smrt-core',
        exportName: 'SmrtObject',
      } as any;

      await loader.loadClass(objectDef);

      expect(loader.getStats().classesCached).toBe(1);

      loader.clearCache();

      const stats = loader.getStats();
      expect(stats.modulesLoaded).toBe(0);
      expect(stats.classesCached).toBe(0);
    });
  });
});
```

### Integration Tests

**New File**: `packages/cli/src/cli-generator.integration.spec.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CLIGenerator } from './cli-generator.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('CLI with external packages', () => {
  const testDir = join(process.cwd(), 'test-fixtures', 'cli-external');

  beforeAll(() => {
    // Create test project structure
    mkdirSync(join(testDir, '.smrt'), { recursive: true });

    // Create mock manifest with external package
    const manifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: 'test-project',
      objects: {
        SmrtObject: {
          name: 'SmrtObject',
          className: 'SmrtObject',
          collection: 'smrtobjects',
          packageName: '@happyvertical/smrt-core',
          importPath: '@happyvertical/smrt-core',
          exportName: 'SmrtObject',
          collectionExportName: 'SmrtCollection',
          fields: {},
          methods: {},
          decoratorConfig: { cli: true },
        },
      },
    };

    writeFileSync(
      join(testDir, '.smrt', 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should list objects from external packages', async () => {
    const cli = new CLIGenerator();
    const commands = await cli['generateCommands']();

    // Should discover SmrtObject from manifest
    const objectCommands = commands.filter((c) =>
      c.name.startsWith('smrtobject:')
    );

    expect(objectCommands.length).toBeGreaterThan(0);
  });

  it('should execute commands on external objects', async () => {
    // This would require a full integration test with real database
    // For now, we verify command generation works

    const cli = new CLIGenerator();
    const commands = await cli['generateCommands']();

    const listCommand = commands.find((c) => c.name === 'smrtobject:list');
    expect(listCommand).toBeDefined();
    expect(listCommand?.handler).toBeDefined();
  });
});
```

### Documentation Updates

**File**: `packages/cli/README.md` (add section)

```markdown
## Using SMRT Objects from External Packages

The SMRT CLI automatically discovers and loads objects from installed packages,
enabling you to use CLI commands for objects defined in external libraries.

### Quick Start

1. **Install a SMRT package**:
   ```bash
   npm install @happyvertical/praeco
   ```

2. **Build your project** (generates `.smrt/manifest.json`):
   ```bash
   npm run build
   ```

3. **Use CLI commands**:
   ```bash
   # List all available objects (includes external packages)
   npx smrt objects

   # Use commands on external objects
   npx smrt agent:list
   npx smrt agent:get <id>
   npx smrt agent:research <id> --query "AI safety"
   ```

### How It Works

1. **Consumer Plugin**: During build, the `smrtConsumer` Vite plugin scans
   `node_modules` for packages with SMRT objects and aggregates their manifests
   into `.smrt/manifest.json`.

2. **CLI Discovery**: When you run `npx smrt`, the CLI reads the aggregated
   manifest and discovers all available objects.

3. **Dynamic Loading**: The CLI dynamically imports classes from external
   packages at runtime, enabling full CRUD and custom method execution.

### Troubleshooting

#### CLI doesn't see external objects

**Check 1**: Ensure package is installed
```bash
npm list @happyvertical/praeco
```

**Check 2**: Regenerate manifest
```bash
npm run build
```

**Check 3**: Verify manifest contains external objects
```bash
cat .smrt/manifest.json | grep packageName
```

#### Import errors

**Error**: `Cannot find module '@happyvertical/praeco'`

**Solution**: Package not installed or not in `node_modules`
```bash
npm install @happyvertical/praeco
```

**Error**: `Failed to find export 'Agent' in @happyvertical/praeco`

**Solution**: Package may not export classes correctly. Check package documentation.

#### Command execution fails

**Error**: `Object 'Agent' not found or has no collection constructor`

**Cause**: Class could not be loaded from external package.

**Solutions**:
1. Verify package exports classes:
   ```javascript
   // Package should export:
   export { Agent } from './objects/agent.js';
   export { AgentCollection } from './objects/agent.js';
   ```

2. Check package.json `exports` field:
   ```json
   {
     "exports": {
       ".": "./dist/index.js",
       "./objects": "./dist/objects/index.js"
     }
   }
   ```

3. Enable verbose mode for debugging:
   ```bash
   SMRT_CLI_VERBOSE=true npx smrt agent:list
   ```

### Package Author Guidelines

If you're creating a package with SMRT objects:

1. **Export classes properly**:
   ```typescript
   // src/objects/index.ts
   export { Agent, AgentCollection } from './agent.js';
   export { Document, DocumentCollection } from './document.js';
   ```

2. **Configure package.json**:
   ```json
   {
     "name": "@my-org/my-package",
     "exports": {
       ".": "./dist/index.js",
       "./objects": "./dist/objects/index.js"
     },
     "dependencies": {
       "@happyvertical/smrt-core": "^0.7.0"
     }
   }
   ```

3. **Use smrtPlugin in vite.config.js**:
   ```javascript
   import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';

   export default {
     plugins: [
       smrtPlugin({
         include: ['src/**/*.ts'],
         generateTypes: true
       })
     ]
   };
   ```

4. **Build before publishing**:
   ```bash
   npm run build
   npm publish
   ```

Your package will now be automatically discoverable by any project that installs it!
```

---

## Implementation Timeline

### Week 1: Manifest Schema Enhancement
- [x] Plan architecture
- [ ] Update `SmartObjectDefinition` interface
- [ ] Update AST scanner to include package metadata
- [ ] Update consumer plugin to preserve metadata
- [ ] Add tests for enhanced manifest generation
- [ ] Update manifest JSON schema documentation

**Deliverable**: Enhanced manifests with package metadata

### Week 2: Dynamic Class Loader
- [ ] Create `DynamicClassLoader` class
- [ ] Implement import path resolution with fallbacks
- [ ] Add class and module caching
- [ ] Handle import errors gracefully
- [ ] Add comprehensive error messages
- [ ] Write unit tests with 90%+ coverage

**Deliverable**: Working class loader utility

### Week 3: CLI Integration
- [ ] Update `tryLoadUserClasses()` to load external classes
- [ ] Implement `loadExternalClasses()` method
- [ ] Register external classes in ObjectRegistry
- [ ] Update `getCollection()` with enhanced error messages
- [ ] Add verbose logging for debugging
- [ ] Integration tests with real packages

**Deliverable**: CLI can execute commands from external packages

### Week 4: Testing & Documentation
- [ ] End-to-end tests with external packages
- [ ] Test error scenarios (missing packages, import failures)
- [ ] Test backwards compatibility with old manifests
- [ ] Update CLI README with usage examples
- [ ] Add troubleshooting guide
- [ ] Create migration guide for existing projects

**Deliverable**: Production-ready feature with comprehensive docs

### Week 5+: Optional Enhancements
- [ ] Namespace support for avoiding conflicts
- [ ] Performance optimization (lazy loading)
- [ ] Type generation for external objects
- [ ] IDE autocomplete support
- [ ] CLI plugin system

**Deliverable**: Enhanced UX features

---

## Success Criteria

✅ **User Experience**:
```bash
# Zero-configuration workflow
npm install @happyvertical/praeco
npm run build
npx smrt agent:research <id> --query "AI safety"  # Just works!
```

✅ **Technical Requirements**:
- [ ] CLI discovers objects from `.smrt/manifest.json`
- [ ] Dynamic loading works for all major package patterns
- [ ] Error messages are helpful and actionable
- [ ] Backwards compatible with existing projects
- [ ] Performance overhead < 200ms for 10 packages
- [ ] Test coverage > 90%

✅ **Documentation**:
- [ ] README examples work out of the box
- [ ] Troubleshooting covers common issues
- [ ] Package author guidelines are clear

---

## Future Enhancements

### Namespace Support
Avoid naming conflicts between packages:

```bash
# Fully qualified with package namespace
npx smrt praeco:agent research --query "AI"

# Auto-detect if unambiguous
npx smrt agent research --query "AI"

# Show package source
npx smrt objects --verbose
# Output:
#   • Agent (from @happyvertical/praeco)
#   • Document (local)
```

### Performance Optimization
- Lazy loading: Only load classes when command is executed
- Parallel loading: Import multiple packages concurrently
- Incremental caching: Cache across CLI invocations

### Type Generation
Generate TypeScript types for external objects:

```typescript
// Auto-generated types
import type { Agent } from '@smrt/types';

const agent: Agent = {
  id: '123',
  name: 'Research Agent',
  // Full autocomplete!
};
```

---

## References

- **Issue**: [#215](https://github.com/happyvertical/smrt/issues/215)
- **Branch**: `feat/issue-215-dynamic-class-loading`
- **Related PRs**: TBD
- **Documentation**: `packages/cli/README.md`

---

*This document serves as the architectural blueprint for implementing dynamic class loading in the SMRT CLI. It will be updated as implementation progresses.*
