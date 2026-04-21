/**
 * Global object registry for SMRT classes
 *
 * Maintains a central registry of all @smrt decorated classes, enabling
 * module awareness, automatic API generation, and runtime introspection.
 * The registry tracks class definitions, field metadata, and configuration
 * options for code generation and runtime operations.
 *
 * @example Registering a class manually
 * ```typescript
 * import { ObjectRegistry } from '@happyvertical/smrt-core';
 *
 * ObjectRegistry.register(MyClass, {
 *   api: { exclude: ['delete'] },
 *   cli: true
 * });
 * ```
 *
 * @example Using the decorator (recommended)
 * ```typescript
 * import { smrt, field } from '@happyvertical/smrt-core';
 *
 * @smrt({ api: { exclude: ['delete'] } })
 * class Product extends SmrtObject {
 *   @field({ required: true })
 *   name: string = '';
 * }
 * ```
 */

import { SmrtCollection } from './collection';
import { applyPendingDecoratorRegistrations } from './decorators/compatibility.js';
import type {
  ClassEmbeddingConfig,
  ProjectEmbeddingConfig,
  ResolvedEmbeddingConfig,
} from './embeddings/types';
import { ConfigurationError } from './errors';
import { getDefaultCompositeSource } from './manifest/sources/composite.js';
import { ExplicitPathsManifestSource } from './manifest/sources/explicit-paths.js';
import {
  cloneManifestSchemaColumns,
  discoverCachedManifestSync,
  getNodeBuiltins,
  loadExternalManifestSyncWithNode,
} from './manifest/store.js';
import type { SmrtObject } from './object';
import {
  register as _register,
  registerCollection as _registerCollection,
  registerFromManifest as _registerFromManifest,
} from './registry/class-registration';
// ── Extracted modules (Issue #1006) ──────────────────────────────────────
import {
  clearRegistryDiagnostics,
  flushRegistryDiagnostics,
  getRegistryDiagnostics,
  type RegistryDiagnostic,
  recordRegistryDiagnostic,
} from './registry/diagnostics';
import {
  getEmbeddingClasses as _getEmbeddingClasses,
  getEmbeddingConfig as _getEmbeddingConfig,
  getProjectEmbeddingConfig as _getProjectEmbeddingConfig,
  hasEmbeddings as _hasEmbeddings,
  resolveEmbeddingConfig as _resolveEmbeddingConfig,
} from './registry/embedding-manager';
import {
  createFieldFromManifest,
  manifestFieldDiffers,
  mergeManifestField,
} from './registry/manifest-field-merge.js';
import {
  findClass as _findClass,
  findClassesByName as _findClassesByName,
  findClassStrict as _findClassStrict,
  getAllClasses as _getAllClasses,
  getCanonicalClassName as _getCanonicalClassName,
  getClass as _getClass,
  getClassByConstructor as _getClassByConstructor,
  getClassByQualifiedName as _getClassByQualifiedName,
  getClassesByPackage as _getClassesByPackage,
  getClassesByVisibility as _getClassesByVisibility,
  getClassInPackage as _getClassInPackage,
  getClassNames as _getClassNames,
  getPublicClasses as _getPublicClasses,
  hasClass as _hasClass,
  hasClassCaseInsensitive as _hasClassCaseInsensitive,
  resolveType as _resolveType,
} from './registry/name-resolver';
import {
  getDependencyGraph as _getDependencyGraph,
  getRelationshipMap as _getRelationshipMap,
} from './registry/relationship-graph';
import {
  getAllSchemas as _getAllSchemas,
  getAllSchemasAsDefinitions as _getAllSchemasAsDefinitions,
  getSchema as _getSchema,
  getSchemaDDL as _getSchemaDDL,
  getTableName as _getTableName,
} from './registry/schema-builder';
import {
  getClasses,
  getClassNameMap,
  getCollectionCache,
  getCollections,
  getCollectionTableNames,
  getDbInstanceIds,
  getDiscoveryAttemptCache,
  getFieldDecorators,
  getInheritanceCache,
  getInheritanceConfig,
  getNextDbId,
  getStiSiblingsLoaded,
  setNextDbId,
  verboseLog,
} from './registry/shared-state';
import type {
  RegisteredClass,
  RelationshipMetadata,
  SmartObjectConfig,
  SmrtObjectConstructor,
  ValidatorFunction,
} from './registry/types';
import { compileValidators as _compileValidators } from './registry/validator';
import type {
  QualifiedClassName,
  SmartObjectManifest,
  SmrtVisibility,
  ValidationRule,
} from './scanner/types.js';
import type { SchemaDefinition } from './schema/types.js';
import { prependSmrtSystemFields } from './system-fields';
import { classnameToTablename } from './utils';
import { LRUCache } from './utils/lru-cache';
import {
  createQualifiedName,
  isQualifiedName,
  parseQualifiedName,
} from './utils/qualified-names.js';

// Re-export types for backward compatibility
export type {
  RelationshipMetadata,
  RelationshipType,
  SmartObjectConfig,
} from './registry/types';

// Types, utility functions, and globalThis declarations have been extracted
// to registry/types.ts and registry/shared-state.ts (Issue #1006).
// The SmartObjectConfig, RelationshipType, and RelationshipMetadata types
// are re-exported above for backward compatibility.

type ManifestLoaderModule = typeof import('./manifest/index.js');

function getManifestLoaderSpecifier(): string {
  return import.meta.url.endsWith('.ts')
    ? './manifest/index.ts'
    : './manifest/index.js';
}

async function importManifestLoader(): Promise<ManifestLoaderModule> {
  return (await import(getManifestLoaderSpecifier())) as ManifestLoaderModule;
}

async function discoverInstalledSmrtPackages(): Promise<string[]> {
  const discoverSpecifier = import.meta.url.endsWith('.ts')
    ? './manifest/discover-smrt-packages.ts'
    : './manifest/discover-smrt-packages.js';

  const { discoverSmrtPackages } = await import(discoverSpecifier);
  return discoverSmrtPackages();
}

/**
 * Central registry for all SMRT objects
 *
 * Uses globalThis for cross-module state sharing, ensuring all module instances
 * (even from different package resolution paths) share the same registry state.
 */
export class ObjectRegistry {
  /**
   * Get the classes map from globalThis, initializing if needed
   */
  private static get classes(): Map<string, RegisteredClass> {
    return getClasses();
  }

  /**
   * Get the collections map from globalThis, initializing if needed
   */
  private static get collections(): Map<string, typeof SmrtCollection> {
    return getCollections();
  }

  /**
   * Get the collection table names map from globalThis, initializing if needed
   * Maps collection class name -> tableName for getTableName lookups
   */
  private static get collectionTableNames(): Map<string, string> {
    return getCollectionTableNames();
  }

  /**
   * Set the table name for a collection class
   * Used by @smrt() decorator to enable getTableName lookups for collections
   */
  static setCollectionTableName(
    collectionName: string,
    tableName: string,
  ): void {
    ObjectRegistry.collectionTableNames.set(collectionName, tableName);
  }

  /**
   * Get the collection cache from globalThis, initializing if needed
   */
  private static get collectionCache(): LRUCache<string, SmrtCollection<any>> {
    return getCollectionCache();
  }

  /**
   * Configure the collection cache size (for testing purposes)
   *
   * Resets the collection cache with a new maximum size.
   * Use this in tests to avoid creating many database files.
   *
   * @param maxSize - Maximum number of collections to cache (system default is 100)
   * @throws Error if maxSize is not a positive finite number
   * @example
   * ```typescript
   * // In test setup, use a small cache to test LRU eviction with fewer DBs
   * ObjectRegistry.configureCollectionCache(5);
   * ```
   */
  static configureCollectionCache(maxSize: number): void {
    if (!Number.isFinite(maxSize) || maxSize <= 0) {
      throw new Error(`maxSize must be a positive number, got: ${maxSize}`);
    }
    globalThis.__smrtRegistryCollectionCache = new LRUCache<
      string,
      SmrtCollection<any>
    >(maxSize);
  }

  /**
   * WeakMap to assign unique IDs to database instances for cache keys
   * Prevents cache key collisions when different db instances are used
   */
  private static get dbInstanceIds(): WeakMap<object, number> {
    return getDbInstanceIds();
  }

  /**
   * Get/set the next database ID counter
   */
  private static get nextDbId(): number {
    return getNextDbId();
  }

  private static set nextDbId(value: number) {
    setNextDbId(value);
  }

  /**
   * Storage for field decorator metadata (decorator pattern)
   * Maps className → Map<propertyKey, FieldOptions>
   * Used by @field(), @foreignKey(), @oneToMany(), @manyToMany() decorators
   */
  private static get fieldDecorators(): Map<string, Map<string, any>> {
    return getFieldDecorators();
  }

  /**
   * Track collections that have been processed for STI siblings
   * Prevents infinite recursion when loading siblings
   */
  private static get stiSiblingsLoaded(): Set<string> {
    return getStiSiblingsLoaded();
  }

  /**
   * Map lowercase class names to their canonical (registered) names
   * Used for case-insensitive duplicate detection to prevent
   * both 'praeco' and 'Praeco' from being registered separately
   */
  private static get classNameMap(): Map<string, string[]> {
    return getClassNameMap();
  }

  /**
   * Check if a class is already registered (case-insensitive)
   * Returns the canonical name if found, undefined otherwise
   */
  static getCanonicalClassName(name: string): string | undefined {
    return _getCanonicalClassName(name);
  }

  /**
   * Check if a class exists by name (case-insensitive)
   */
  static hasClassCaseInsensitive(name: string): boolean {
    return _hasClassCaseInsensitive(name);
  }

  /**
   * Global cache for inheritance chains (shared across all instances)
   * Maps className → full inheritance chain (base to child)
   * Performance optimization: ~100x faster than re-walking prototype chain
   * Cache size is configurable via smrt.inheritance.cacheSize (default: 200)
   */
  private static getInheritanceCache(): LRUCache<string, string[]> {
    return getInheritanceCache();
  }

  /**
   * Global cache for manifest discovery attempts (Issue #735 optimization)
   * Maps className → boolean (true = found and registered, false = not found)
   * Prevents repeated discoverManifestSync calls for the same class name
   */
  private static getDiscoveryAttemptCache(): Map<string, boolean> {
    return getDiscoveryAttemptCache();
  }

  /**
   * Register field decorator metadata
   *
   * Called by property decorators (@field, @foreignKey, etc.) to store
   * field configuration metadata. This enables the decorator pattern
   * where field metadata is attached at class definition time.
   *
   * @param className - Name of the class containing the field
   * @param propertyKey - Name of the property being decorated
   * @param options - Field options (type, constraints, etc.)
   * @example
   * ```typescript
   * // Called internally by decorators
   * ObjectRegistry.registerFieldDecorator('Product', 'name', {
   *   type: 'text',
   *   required: true
   * });
   * ```
   */
  static registerFieldDecorator(
    className: string,
    propertyKey: string,
    options: any,
  ): void {
    if (!ObjectRegistry.fieldDecorators.has(className)) {
      ObjectRegistry.fieldDecorators.set(className, new Map());
    }

    // Merge with existing decorator options to support multiple decorators on same field
    const classDecorators = ObjectRegistry.fieldDecorators.get(className);
    if (!classDecorators) {
      // Should not happen since we just set it above, but TypeScript doesn't know that
      return;
    }
    const existing = classDecorators.get(propertyKey);

    if (existing) {
      // Merge options, with new options taking precedence
      classDecorators.set(propertyKey, { ...existing, ...options });
    } else {
      classDecorators.set(propertyKey, options);
    }
  }

  /**
   * Get field decorator metadata for a specific field
   *
   * @param className - Name of the class
   * @param propertyKey - Name of the property
   * @returns Field options or undefined if not decorated
   * @example
   * ```typescript
   * const options = ObjectRegistry.getFieldDecorator('Product', 'name');
   * // { type: 'text', required: true }
   * ```
   */
  static getFieldDecorator(
    className: string,
    propertyKey: string,
  ): any | undefined {
    return ObjectRegistry.fieldDecorators.get(className)?.get(propertyKey);
  }

  /**
   * Get all field decorator metadata for a class
   *
   * @param className - Name of the class
   * @returns Map of property names to field options
   * @example
   * ```typescript
   * const fields = ObjectRegistry.getFieldDecorators('Product');
   * // Map { 'name' => { type: 'text', required: true }, ... }
   * ```
   */
  static getFieldDecorators(className: string): Map<string, any> {
    return ObjectRegistry.fieldDecorators.get(className) || new Map();
  }

  /**
   * Check if a class has any field decorators registered
   *
   * @param className - Name of the class
   * @returns True if the class has field decorators, false otherwise
   * @example
   * ```typescript
   * if (ObjectRegistry.hasFieldDecorators('Product')) {
   *   // Class uses decorators - skip legacy field initialization
   * }
   * ```
   */
  static hasFieldDecorators(className: string): boolean {
    const decorators = ObjectRegistry.fieldDecorators.get(className);
    return decorators !== undefined && decorators.size > 0;
  }

  /**
   * Register a new SMRT object class with the global registry
   *
   * @param constructor - The class constructor extending SmrtObject
   * @param config - Configuration options for API/CLI/MCP generation
   * @throws {Error} If the class cannot be introspected for field definitions
   * @example
   * ```typescript
   * ObjectRegistry.register(Product, {
   *   api: { exclude: ['delete'] },
   *   cli: true,
   *   mcp: { include: ['list', 'get'] }
   * });
   * ```
   */
  static register(
    ctor: typeof SmrtObject,
    config: SmartObjectConfig = {},
  ): void {
    _register(ctor, config);
  }

  /**
   * Register a collection class for an object
   *
   * @param objectName - Name of the object class this collection manages
   * @param collectionConstructor - The collection class constructor
   * @example
   * ```typescript
   * ObjectRegistry.registerCollection('Product', ProductCollection);
   * ```
   */
  static registerCollection(
    objectName: string,
    collectionConstructor: new (options: any) => SmrtCollection<any>,
  ): void {
    _registerCollection(objectName, collectionConstructor);
  }
  static registerFromManifest(
    name: string,
    objectDef: any,
    packageName?: string,
  ): void {
    _registerFromManifest(name, objectDef, packageName);
  }

  /**
   * Helper method for class lookup with qualified name support.
   *
   * Lookup priority:
   * 1. Direct hit on classes map (works for qualified names as keys)
   * 2. If input contains ':', treat as qualified name — direct only, no fallback
   * 3. classNameMap lookup by simple name (lowercase)
   *    - Unambiguous (1 entry) → return it
   *    - Ambiguous (>1 entry) → throw descriptive error
   * 4. Case-insensitive iteration fallback (backward compat)
   *
   * @param name - Name of the class to find (simple or qualified)
   * @returns Registered class information or undefined if not found
   * @remarks When a simple name is ambiguous (multiple packages define it),
   *          logs a warning and returns the first match. Use qualified names
   *          or resolveType() for strict disambiguation.
   * @private
   */
  private static findClass(name: string): RegisteredClass | undefined {
    return _findClass(name);
  }

  /**
   * Strict class lookup with package-aware disambiguation.
   *
   * Unlike `findClass()` which silently returns the first match when a simple
   * name is ambiguous, this method throws a `ConfigurationError` — making it
   * safe for inheritance-critical paths where wrong resolution creates phantom
   * circular chains.
   *
   * Lookup priority:
   * 1. Direct hit on classes map (works for qualified names as keys)
   * 2. If input contains ':', treat as qualified name — direct only, no fallback
   * 3. If `fromPackage` provided, try qualified name `fromPackage:name` first
   * 4. classNameMap lookup by simple name (lowercase)
   *    - Unambiguous (1 entry) → return it
   *    - Ambiguous (>1 entry) → throw ConfigurationError
   * 5. Case-insensitive iteration fallback (backward compat)
   *
   * @param name - Name of the class to find (simple or qualified)
   * @param fromPackage - Optional package context for disambiguation
   * @returns Registered class information or undefined if not found
   * @throws {ConfigurationError} When simple name is ambiguous and no package context resolves it
   * @see https://github.com/happyvertical/smrt/issues/1005
   * @private
   */
  private static findClassStrict(
    name: string,
    fromPackage?: string,
  ): RegisteredClass | undefined {
    return _findClassStrict(name, fromPackage);
  }

  /**
   * Get a registered class by name (case-insensitive)
   *
   * @param name - Name of the registered class
   * @returns Registered class information or undefined if not found
   * @example
   * ```typescript
   * const productInfo = ObjectRegistry.getClass('Product');
   * // Also works with: 'product', 'PRODUCT', etc.
   * if (productInfo) {
   *   console.log(productInfo.config.api?.exclude);
   * }
   * ```
   */
  static getClass(name: string): RegisteredClass | undefined {
    return _getClass(name);
  }

  /**
   * Get a registered class by its constructor reference.
   * This is the most reliable lookup method as it avoids name collision issues
   * that can occur when multiple packages define classes with the same name.
   *
   * Uses a WeakMap index for O(1) lookups.
   *
   * @param ctor - The class constructor to look up
   * @returns Registered class information or undefined if not found
   * @example
   * ```typescript
   * import { Meeting } from '@happyvertical/praeco';
   *
   * const info = ObjectRegistry.getClassByConstructor(Meeting);
   * if (info) {
   *   console.log(info.qualifiedName); // '@happyvertical/praeco:Meeting'
   * }
   * ```
   */
  static getClassByConstructor(
    ctor: SmrtObjectConstructor,
  ): RegisteredClass | undefined {
    return _getClassByConstructor(ctor);
  }

  /**
   * Get a registered class by its qualified name.
   * Qualified names are in format "@package/name:ClassName".
   *
   * @param qualifiedName - The fully qualified class name
   * @returns Registered class information or undefined if not found
   * @example
   * ```typescript
   * const product = ObjectRegistry.getClassByQualifiedName('@happyvertical/smrt-products:Product');
   * if (product) {
   *   console.log(`Found: ${product.name} from ${product.packageName}`);
   * }
   * ```
   */
  static getClassByQualifiedName(
    qualifiedName: string,
  ): RegisteredClass | undefined {
    return _getClassByQualifiedName(qualifiedName);
  }

  /**
   * Get a registered class by package name and class name.
   * This is a convenience method for looking up classes by their namespace components.
   *
   * @param packageName - The package name (e.g., "@happyvertical/smrt-products")
   * @param className - The class name (e.g., "Product")
   * @returns Registered class information or undefined if not found
   * @example
   * ```typescript
   * const product = ObjectRegistry.getClassInPackage('@happyvertical/smrt-products', 'Product');
   * ```
   */
  static getClassInPackage(
    packageName: string,
    className: string,
  ): RegisteredClass | undefined {
    return _getClassInPackage(packageName, className);
  }

  /**
   * Find all registered classes with a given simple class name.
   * Useful for detecting collisions or when multiple packages have the same class name.
   *
   * @param className - The simple class name to search for
   * @returns Array of registered classes with matching name
   * @example
   * ```typescript
   * const products = ObjectRegistry.findClassesByName('Product');
   * if (products.length > 1) {
   *   console.log(`Found ${products.length} classes named "Product":`);
   *   for (const p of products) {
   *     console.log(`  - ${p.qualifiedName} from ${p.packageName}`);
   *   }
   * }
   * ```
   */
  static findClassesByName(className: string): RegisteredClass[] {
    return _findClassesByName(className);
  }

  /**
   * Resolve a short class name to its qualified name.
   * Throws an error if the name is ambiguous (multiple packages define the same class name).
   *
   * @param shortName - The simple class name to resolve (e.g., 'MeetingRecap')
   * @returns The qualified class name (e.g., '@happyvertical/praeco:MeetingRecap')
   * @throws {Error} If no class with that name is registered
   * @throws {Error} If multiple classes with that name exist (ambiguous)
   *
   * @example
   * ```typescript
   * // Unambiguous resolution
   * const qualified = ObjectRegistry.resolveType('MeetingRecap');
   * // Returns: '@happyvertical/praeco:MeetingRecap'
   *
   * // Already qualified names pass through
   * const same = ObjectRegistry.resolveType('@happyvertical/praeco:MeetingRecap');
   * // Returns: '@happyvertical/praeco:MeetingRecap'
   *
   * // Ambiguous names throw
   * ObjectRegistry.resolveType('Event');
   * // Error: "Event" is ambiguous. Found in multiple packages:
   * //   - @happyvertical/smrt-events:Event
   * //   - @happyvertical/calendar:Event
   * // Use the fully qualified name instead.
   * ```
   */
  static resolveType(shortName: string): QualifiedClassName {
    return _resolveType(shortName);
  }

  /**
   * Get all registered classes from a specific package.
   *
   * @param packageName - The package name to filter by
   * @returns Map of class names to registered class information
   * @example
   * ```typescript
   * const coreClasses = ObjectRegistry.getClassesByPackage('@happyvertical/smrt-core');
   * for (const [name, info] of coreClasses) {
   *   console.log(`  ${name}: ${info.qualifiedName}`);
   * }
   * ```
   */
  static getClassesByPackage(
    packageName: string,
  ): Map<string, RegisteredClass> {
    return _getClassesByPackage(packageName);
  }

  /**
   * Get all registered classes with a specific visibility level.
   *
   * @param visibility - The visibility level to filter by
   * @returns Map of class names to registered class information
   * @example
   * ```typescript
   * const publicClasses = ObjectRegistry.getClassesByVisibility('public');
   * console.log(`Found ${publicClasses.size} public classes`);
   * ```
   */
  static getClassesByVisibility(
    visibility: SmrtVisibility,
  ): Map<string, RegisteredClass> {
    return _getClassesByVisibility(visibility);
  }

  /**
   * Get all public registered classes (excludes 'internal' and 'test' visibility).
   * Useful for generating published manifests or public APIs.
   *
   * @returns Map of class names to registered class information
   * @example
   * ```typescript
   * const publicClasses = ObjectRegistry.getPublicClasses();
   * console.log(`Publishing ${publicClasses.size} public classes to manifest`);
   * ```
   */
  static getPublicClasses(): Map<string, RegisteredClass> {
    return _getPublicClasses();
  }

  /**
   * Get all registered classes
   *
   * @returns Map of class names to registered class information
   * @example
   * ```typescript
   * const allClasses = ObjectRegistry.getAllClasses();
   * for (const [name, info] of allClasses) {
   *   console.log(`Class: ${name}, Fields: ${info.fields.size}`);
   * }
   * ```
   */
  static getAllClasses(): Map<string, RegisteredClass> {
    return _getAllClasses();
  }

  /**
   * Get class names
   */
  static getClassNames(): string[] {
    return _getClassNames();
  }

  /**
   * Try to load and register a class from external SMRT packages
   *
   * This method attempts to auto-discover classes from @happyvertical/smrt-* packages
   * when they're referenced but not yet registered. Solves issue #343 where STI classes
   * from external packages (e.g., Person from smrt-profiles) weren't loading correctly.
   *
   * @param className - Name of the class to load
   * @returns Promise<boolean> - True if successfully loaded and registered, false otherwise
   * @private
   */
  static async tryLoadFromExternalPackage(className: string): Promise<boolean> {
    const requestedQualifiedName = isQualifiedName(className)
      ? parseQualifiedName(className)
      : null;
    const requestedClassName = requestedQualifiedName?.className || className;
    const requestedPackageName = requestedQualifiedName?.packageName;
    const smrtPackages = requestedPackageName
      ? [requestedPackageName]
      : await discoverInstalledSmrtPackages();
    const { loadExternalManifest } = await importManifestLoader();

    verboseLog(
      `[ObjectRegistry] Attempting to auto-load ${className} from ${smrtPackages.length} external packages...`,
    );

    const matches: Array<{
      manifest: any;
      packageName: string;
      objectDef: any;
    }> = [];

    // Try each package
    for (const packageName of smrtPackages) {
      const manifest = await loadExternalManifest(packageName);

      if (!manifest || !manifest.objects) {
        continue;
      }

      // Look for the class in this manifest (case-insensitive)
      // Support both qualified keys (@pkg:Class) and simple class names
      const lowerClassName = requestedClassName.toLowerCase();
      let objectDef =
        manifest.objects[lowerClassName] ||
        manifest.objects[requestedClassName] ||
        (requestedPackageName
          ? manifest.objects[
              `${requestedPackageName}:${requestedClassName}` as string
            ]
          : undefined);

      // If not found by direct key lookup, search by className field (Issue #713)
      // This handles manifests with qualified keys while allowing simple name lookups
      if (!objectDef) {
        for (const [_key, def] of Object.entries(
          manifest.objects as Record<string, any>,
        )) {
          if (
            def.className?.toLowerCase() === lowerClassName ||
            def.className === requestedClassName
          ) {
            objectDef = def;
            break;
          }
        }
      }

      if (!objectDef) {
        continue;
      }

      matches.push({
        manifest,
        packageName: manifest.packageName || packageName,
        objectDef,
      });
    }

    if (matches.length === 0) {
      verboseLog(
        `[ObjectRegistry] ❌ Could not find ${className} in any SMRT package`,
      );
      return false;
    }

    if (!requestedPackageName && matches.length > 1) {
      throw new ConfigurationError(
        `Ambiguous class name "${className}" — found in multiple external SMRT packages: ` +
          `${matches.map((match) => match.packageName).join(', ')}. ` +
          'Preserve package identity or use a qualified class name to disambiguate.',
        'CONFIG_AMBIGUOUS_CLASS',
        {
          className,
          candidates: matches.map((match) => match.packageName),
        },
      );
    }

    const { manifest, packageName, objectDef } = matches[0];

    verboseLog(
      `[ObjectRegistry] ✅ Found ${className} in ${packageName} manifest`,
    );

    // Register the class from manifest
    ObjectRegistry.registerFromManifest(
      objectDef.className || requestedClassName,
      objectDef,
      manifest.packageName,
    );

    // If this is an STI class, also register the parent class
    // Skip if extends points to the same className (self-referential):
    // This happens when a child class in one package extends a parent with the
    // same name from another package (e.g., histrio:Performer extends smrt-video:Performer)
    // and only the child package is installed
    const childClassName = objectDef.className || requestedClassName;
    if (objectDef.extends && objectDef.extends !== childClassName) {
      const parentName = objectDef.extends;
      const lowerParentName = parentName.toLowerCase();
      let parentDef =
        manifest.objects[lowerParentName] || manifest.objects[parentName];

      // Search by className field if not found by key (Issue #713)
      if (!parentDef) {
        for (const [_key, def] of Object.entries(
          manifest.objects as Record<string, any>,
        )) {
          if (
            def.className?.toLowerCase() === lowerParentName ||
            def.className === parentName
          ) {
            parentDef = def;
            break;
          }
        }
      }

      if (parentDef && !ObjectRegistry.hasClass(objectDef.extends)) {
        verboseLog(
          `[ObjectRegistry] Also registering parent class ${objectDef.extends} for STI`,
        );
        ObjectRegistry.registerFromManifest(
          parentDef.className || objectDef.extends,
          parentDef,
          manifest.packageName,
        );
      }

      // Merge inherited fields from parent into child
      // This ensures STI child classes get all parent fields
      verboseLog(
        `[ObjectRegistry] Merging inherited fields for ${className}...`,
      );
      await ObjectRegistry.getAllFields(requestedClassName);
      const registered = ObjectRegistry.findClass(requestedClassName);
      if (registered?.inheritedFields) {
        verboseLog(
          `[ObjectRegistry] ✅ ${className} now has ${registered.inheritedFields.size} total fields (including inherited)`,
        );
      }
    }

    return true;
  }

  /**
   * Load all manifests upfront so inheritance queries are pure lookups.
   *
   * After this method completes, every class across all packages is
   * registered and `getInheritanceChain()` will never need to mutate
   * registry state.
   *
   * @param options - Optional configuration
   * @param options.manifestPaths - Explicit list of manifest.json file paths to load.
   *   When omitted the method discovers packages via `loadExternalManifestSync()`
   *   for every `@happyvertical` package found in `node_modules`.
   * @returns Summary statistics about the load operation
   *
   * @example
   * ```typescript
   * // At CLI / server startup
   * ObjectRegistry.loadAllManifests();
   * // All classes are now registered — inheritance lookups are side-effect free
   * ```
   *
   * @see https://github.com/happyvertical/smrt/issues/1007
   */
  static loadAllManifests(options?: { manifestPaths?: string[] }): {
    packagesLoaded: number;
    objectsRegistered: number;
  } {
    let packagesLoaded = 0;
    let objectsRegistered = 0;

    if (options?.manifestPaths) {
      // Explicit paths → ExplicitPathsManifestSource. Preserves the
      // full-registry-integration.test.ts:72-76 contract.
      const source = new ExplicitPathsManifestSource(options.manifestPaths);
      const seenPackages = new Set<string>();
      for (const entry of source.entries()) {
        if (!ObjectRegistry.hasClassCaseInsensitive(entry.className)) {
          ObjectRegistry.registerFromManifest(
            entry.className,
            entry.def,
            entry.packageName,
          );
          objectsRegistered++;
        }
        if (entry.packageName) seenPackages.add(entry.packageName);
      }
      packagesLoaded = seenPackages.size;
    } else {
      // Auto-discover: seed the embedded cache from every installed
      // @happyvertical/smrt-* package, then iterate composite.entries() —
      // LocalTest/Test sources gate themselves on isTestEnvironment() and
      // NodeModulesFallback is a no-op on `.lookup()`, so the iteration
      // yields exactly the same set of entries as the old manual scan.
      const packagePrefixes = ['@happyvertical/smrt-'];
      try {
        const builtins = getNodeBuiltins();
        if (!builtins) {
          return { packagesLoaded, objectsRegistered };
        }

        const scopeDir = builtins.path.join(
          process.cwd(),
          'node_modules',
          '@happyvertical',
        );
        if (!builtins.fs.existsSync(scopeDir)) {
          return { packagesLoaded, objectsRegistered };
        }

        const packages = builtins.fs
          .readdirSync(scopeDir)
          .filter((name) =>
            packagePrefixes.some((prefix) =>
              `@happyvertical/${name}`.startsWith(prefix),
            ),
          );

        const seenPackages = new Set<string>();
        for (const pkgDir of packages) {
          const packageName = `@happyvertical/${pkgDir}`;
          const manifest = loadExternalManifestSyncWithNode(packageName);
          if (!manifest?.objects) continue;
          seenPackages.add(packageName);
        }

        const composite = getDefaultCompositeSource();
        for (const entry of composite.entries()) {
          if (!entry.packageName || !seenPackages.has(entry.packageName)) {
            continue;
          }
          if (!ObjectRegistry.hasClassCaseInsensitive(entry.className)) {
            ObjectRegistry.registerFromManifest(
              entry.className,
              entry.def,
              entry.packageName,
            );
            objectsRegistered++;
          }
        }
        packagesLoaded = seenPackages.size;
      } catch (err) {
        verboseLog(
          `[ObjectRegistry] Auto-discovery of manifests failed: ${err}`,
        );
      }
    }

    verboseLog(
      `[ObjectRegistry] loadAllManifests complete: ${packagesLoaded} packages, ${objectsRegistered} objects registered`,
    );

    return { packagesLoaded, objectsRegistered };
  }

  /**
   * Register a package's own bundled manifest, called by the package itself at
   * import time to eliminate the consumer-runtime field-drop bug (issue #1132).
   *
   * Packages ship a `dist/manifest.json` next to their compiled entry. A small
   * `__smrt-register__.js` side-effect module imports that file URL and calls
   * this method *before* any `@smrt()` decorator in the package fires, so the
   * decorator's synchronous manifest lookup hits a populated cache instead of
   * registering classes with zero fields.
   *
   * Silently no-ops if the URL can't be read — in dev/test the vitest plugin
   * populates manifests through a different path, and this fallback is expected
   * to miss in those contexts.
   *
   * @param manifestUrl - File URL (or string) pointing to the package's
   *   manifest.json. Typical call site:
   *   `new URL('./manifest.json', import.meta.url)`
   * @returns Summary with loaded status, package name, and object count
   *
   * @example
   * ```typescript
   * // packages/smrt-places/src/__smrt-register__.ts
   * import { ObjectRegistry } from '@happyvertical/smrt-core';
   * ObjectRegistry.registerPackageManifest(
   *   new URL('./manifest.json', import.meta.url),
   * );
   * ```
   *
   * @see https://github.com/happyvertical/smrt/issues/1132
   */
  static registerPackageManifest(manifestUrl: string | URL): {
    loaded: boolean;
    packageName?: string;
    objectsRegistered: number;
  } {
    const builtins = getNodeBuiltins();
    if (!builtins) {
      return { loaded: false, objectsRegistered: 0 };
    }

    let manifest: SmartObjectManifest | null = null;
    try {
      // Decode file URLs via fileURLToPath() rather than `new URL(...).pathname`:
      // pathname leaves percent-encoding intact and on Windows yields paths like
      // `/C:/foo` that fs rejects. Either failure mode would otherwise make
      // self-registration silently no-op and reintroduce #1132.
      const urlString =
        manifestUrl instanceof URL ? manifestUrl.href : manifestUrl;
      let filePath: string;
      if (manifestUrl instanceof URL) {
        filePath = builtins.url.fileURLToPath(manifestUrl);
      } else if (urlString.startsWith('file:')) {
        filePath = builtins.url.fileURLToPath(urlString);
      } else {
        filePath = urlString;
      }

      if (!builtins.fs.existsSync(filePath)) {
        recordRegistryDiagnostic(
          'warn',
          'PACKAGE_MANIFEST_NOT_FOUND',
          `Package manifest not found at ${filePath}. Self-registration is a no-op; the vitest plugin may still populate this manifest via its own path.`,
          { manifestUrl: String(manifestUrl), filePath },
        );
        return { loaded: false, objectsRegistered: 0 };
      }

      const parsed = JSON.parse(
        builtins.fs.readFileSync(filePath, 'utf-8'),
      ) as SmartObjectManifest;

      if (!parsed?.objects || typeof parsed.objects !== 'object') {
        recordRegistryDiagnostic(
          'warn',
          'PACKAGE_MANIFEST_INVALID_SHAPE',
          `Package manifest at ${String(manifestUrl)} is missing an "objects" record`,
          { manifestUrl: String(manifestUrl) },
        );
        return { loaded: false, objectsRegistered: 0 };
      }

      manifest = parsed;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      recordRegistryDiagnostic(
        'error',
        'PACKAGE_MANIFEST_READ_FAILED',
        `registerPackageManifest: failed to read manifest at ${String(manifestUrl)}: ${errorMessage}`,
        { manifestUrl: String(manifestUrl), errorMessage },
      );
      verboseLog(
        `[ObjectRegistry] registerPackageManifest: failed to read manifest at ${String(manifestUrl)}: ${errorMessage}`,
      );
      return { loaded: false, objectsRegistered: 0 };
    }

    const packageName = manifest.packageName;

    // Seed the manifest cache so discoverManifestSync() finds entries when
    // @smrt() decorators run for classes in this package.
    const manifestGlobals = globalThis as typeof globalThis & {
      __smrtManifestCache?: Map<string, SmartObjectManifest>;
    };
    if (!manifestGlobals.__smrtManifestCache) {
      manifestGlobals.__smrtManifestCache = new Map();
    }
    const cacheKey = packageName || String(manifestUrl);
    manifestGlobals.__smrtManifestCache.set(cacheKey, manifest);

    // Merge manifest fields into any already-registered classes. This covers
    // the case where class modules were evaluated before the package's
    // self-register shim (e.g., a consumer imported a deep subpath that
    // bypassed the main entry).
    let objectsRegistered = 0;
    for (const [key, def] of Object.entries(manifest.objects)) {
      const objectDef = def as any;
      const className = objectDef.className || key;
      ObjectRegistry.registerFromManifest(className, objectDef, packageName);
      objectsRegistered++;
    }

    verboseLog(
      `[ObjectRegistry] registerPackageManifest: loaded ${objectsRegistered} objects from ${packageName || String(manifestUrl)}`,
    );

    return { loaded: true, packageName, objectsRegistered };
  }

  /**
   * Snapshot of diagnostics collected from registry load paths.
   *
   * Registry paths that previously `console.warn(...); return null` now also
   * record a structured diagnostic. Apps can inspect this buffer at startup
   * or from an error route to surface failures that would otherwise be silent.
   *
   * Set `SMRT_STRICT_REGISTRY=true` to make severity-`'error'` diagnostics
   * throw at record time instead of being collected silently.
   *
   * @see https://github.com/happyvertical/smrt/issues/1132
   * @see https://github.com/happyvertical/smrt/issues/1134
   */
  static getDiagnostics(): readonly RegistryDiagnostic[] {
    return getRegistryDiagnostics();
  }

  /** Clear the diagnostic buffer. Primarily for tests. */
  static clearDiagnostics(): void {
    clearRegistryDiagnostics();
  }

  /**
   * Pretty-print the diagnostic buffer via `console.warn` / `console.error`.
   * No-op when the buffer is empty.
   */
  static flushDiagnostics(): void {
    flushRegistryDiagnostics();
  }

  /**
   * Check if a class is registered (case-insensitive)
   */
  static hasClass(name: string): boolean {
    return _hasClass(name);
  }

  /**
   * Clear all registered classes (mainly for testing)
   */
  static clear(): void {
    ObjectRegistry.classes.clear();
    ObjectRegistry.collections.clear();
    ObjectRegistry.collectionCache.clear();
    ObjectRegistry.collectionTableNames.clear();
    ObjectRegistry.getInheritanceCache().clear();
    ObjectRegistry.getDiscoveryAttemptCache().clear();
    ObjectRegistry.fieldDecorators.clear();
    ObjectRegistry.stiSiblingsLoaded.clear();
    ObjectRegistry.classNameMap.clear();
    // Note: dbInstanceIds WeakMap and constructorIndex WeakMap will be
    // garbage collected automatically when classes are no longer referenced
    // Reset the counter for clean test state
    ObjectRegistry.nextDbId = 1;
  }

  /**
   * Invalidate inheritance cache for a specific class
   *
   * Clears cached inheritance chain and merged fields/methods for the given class.
   * Call this when a class definition changes at runtime (e.g., hot module reload).
   *
   * @param className - The class name to invalidate cache for
   * @example
   * ```typescript
   * // After hot module reload of a parent class
   * ObjectRegistry.invalidateInheritanceCache('BentleyContent');
   * ```
   */
  static invalidateInheritanceCache(className: string): void {
    // Clear inheritance chain cache
    ObjectRegistry.getInheritanceCache().delete(className);

    // Clear merged fields/methods cache
    const registered = ObjectRegistry.findClass(className);
    if (registered) {
      registered.inheritedFields = undefined;
      registered.inheritedMethods = undefined;
    }

    // Also invalidate all descendants (they depend on this class's fields)
    for (const [_key, childClass] of ObjectRegistry.classes) {
      if (childClass.extends === className) {
        ObjectRegistry.invalidateInheritanceCache(childClass.name || _key);
      }
    }
  }

  /**
   * Invalidate all inheritance caches
   *
   * Clears all cached inheritance chains and merged fields/methods.
   * Call this when multiple classes change at runtime.
   *
   * @example
   * ```typescript
   * // After hot module reload of multiple classes
   * ObjectRegistry.invalidateAllInheritanceCaches();
   * ```
   */
  static invalidateAllInheritanceCaches(): void {
    ObjectRegistry.getInheritanceCache().clear();
    ObjectRegistry.getDiscoveryAttemptCache().clear();

    for (const registered of ObjectRegistry.classes.values()) {
      registered.inheritedFields = undefined;
      registered.inheritedMethods = undefined;
    }
  }

  /**
   * Resolve a collection lookup name to the registered object metadata and
   * collection constructor that should back it.
   *
   * Accepts any supported collection identifier:
   * - simple class name (`FactRecord`)
   * - qualified class name (`@pkg:FactRecord`)
   * - explicit collection alias (`fact_records`) when registered
   *
   * Returns a canonical class identity so cache keys remain stable across
   * aliases that refer to the same underlying collection.
   */
  private static resolveCollectionRegistration(className: string): {
    canonicalName: string;
    registered?: RegisteredClass;
    collectionConstructor?: new (options: any) => SmrtCollection<any>;
  } {
    let registered = ObjectRegistry.findClass(className);
    let collectionConstructor = registered?.collectionConstructor;

    if (!collectionConstructor) {
      collectionConstructor = ObjectRegistry.collections.get(className);
    }

    if (!registered && collectionConstructor) {
      const itemClass = (collectionConstructor as any)._itemClass as
        | SmrtObjectConstructor
        | undefined;
      if (itemClass) {
        registered =
          ObjectRegistry.getClassByConstructor(itemClass) ||
          ObjectRegistry.findClass(itemClass.name);
      }
    }

    const canonicalName =
      registered?.qualifiedName || registered?.name || className;

    return {
      canonicalName,
      registered,
      collectionConstructor,
    };
  }

  /**
   * Get or create a cached collection instance (Singleton pattern - Phase 4 optimization)
   *
   * Returns a cached collection if one exists for the given class and options,
   * otherwise creates, initializes, and caches a new instance. This significantly
   * improves performance by avoiding repeated collection initialization.
   *
   * **Performance Impact**: 60-80% reduction in collection initialization overhead
   *
   * **Cache Key Strategy**: Collections are cached based on:
   * - className
   * - persistence configuration (type, url, baseUrl)
   * - db presence (not full config)
   * - ai presence (not full config)
   *
   * Different persistence configurations create separate cached instances.
   *
   * @param className - Name of the object class
   * @param options - Configuration options for the collection
   * @returns Cached or newly created collection instance
   * @throws {Error} If the class is not registered or has no collection
   *
   * @example
   * ```typescript
   * // First call creates and caches the collection
   * const orders1 = await ObjectRegistry.getCollection('Order', {
   *   persistence: { type: 'sql', url: 'orders.db' }
   * });
   *
   * // Subsequent calls return the cached instance (much faster)
   * const orders2 = await ObjectRegistry.getCollection('Order', {
   *   persistence: { type: 'sql', url: 'orders.db' }
   * });
   * console.log(orders1 === orders2); // true (same instance)
   *
   * // Different configuration creates new instance
   * const orders3 = await ObjectRegistry.getCollection('Order', {
   *   persistence: { type: 'sql', url: 'orders-copy.db' }
   * });
   * console.log(orders1 === orders3); // false (different config)
   * ```
   *
   * @see {@link https://github.com/happyvertical/sdk/blob/main/packages/core/CLAUDE.md#singleton-collection-management-phase-4|Phase 4 Documentation}
   */
  static async getCollection<T extends SmrtObject>(
    className: string,
    options: any = {},
  ): Promise<SmrtCollection<T>> {
    let { canonicalName, registered, collectionConstructor } =
      ObjectRegistry.resolveCollectionRegistration(className);

    if (!registered && !collectionConstructor) {
      // Try to auto-load from external SMRT packages before throwing error
      // This handles cases where classes from @happyvertical/smrt-* packages
      // are used without explicitly importing them (e.g., Person from smrt-profiles)
      const loaded = await ObjectRegistry.tryLoadFromExternalPackage(className);

      if (loaded) {
        ({ canonicalName, registered, collectionConstructor } =
          ObjectRegistry.resolveCollectionRegistration(className));
      }

      if (!registered && !collectionConstructor) {
        throw new Error(
          `Class ${className} not found in ObjectRegistry. Make sure to register it with @smrt() decorator or ObjectRegistry.register()`,
        );
      }
    }

    // Create a cache key from className and relevant options
    // We use a simplified key that includes only persistence config
    // to avoid cache misses from transient options

    // CRITICAL FIX for issue #384: Use unique db instance ID for cache key
    // Without this, different tests with different db instances would share
    // the same cached collection, causing queries to hit the wrong database
    let dbId: number | undefined;
    if (options.db && typeof options.db === 'object') {
      // Get or assign unique ID for this db instance
      if (!ObjectRegistry.dbInstanceIds.has(options.db)) {
        ObjectRegistry.dbInstanceIds.set(options.db, ObjectRegistry.nextDbId++);
      }
      dbId = ObjectRegistry.dbInstanceIds.get(options.db);
    }

    const cacheKey = `${canonicalName}:${JSON.stringify({
      persistence: options.persistence,
      db: dbId !== undefined ? `db:${dbId}` : undefined,
      ai: options.ai ? 'present' : undefined,
    })}`;

    // Return cached instance if available
    if (ObjectRegistry.collectionCache.has(cacheKey)) {
      return ObjectRegistry.collectionCache.get(cacheKey) as SmrtCollection<T>;
    }

    // Auto-create default collection if not registered
    if (!collectionConstructor) {
      if (!registered) {
        throw new Error(
          `Collection ${className} is registered without a backing object class, which is not supported.`,
        );
      }

      // Lazy-load SmrtCollection to avoid circular dependency
      const { SmrtCollection: SmrtCollectionClass } = await import(
        './collection'
      );

      // Create a default collection class dynamically
      class DefaultCollection extends SmrtCollectionClass<T> {
        static readonly _itemClass = registered?.constructor as any;
      }

      // Register it for future use
      collectionConstructor = DefaultCollection as any;
      registered.collectionConstructor = DefaultCollection as any;
      ObjectRegistry.collections.set(canonicalName, DefaultCollection as any);
    }

    // Create and initialize new collection instance using static factory method
    // collectionConstructor is guaranteed to be defined here
    const collection = (await (collectionConstructor as any).create(
      options,
    )) as SmrtCollection<T>;

    // Cache the initialized instance
    ObjectRegistry.collectionCache.set(cacheKey, collection);

    return collection;
  }

  /**
   * Get field definitions for a registered class.
   * Supports both qualified names and simple class names.
   */
  static getFields(name: string): Map<string, any> {
    // Issue #951: Use findClass for multi-strategy lookup (qualified key, classNameMap, case-insensitive)
    const registered = ObjectRegistry.findClass(name);
    return registered ? registered.fields : new Map();
  }

  /**
   * Get method definitions for a registered class
   *
   * Returns method metadata extracted from the manifest during AST scanning.
   * This enables code generators (CLI, API, MCP) to discover custom methods
   * and automatically generate corresponding commands/endpoints/tools.
   *
   * @param name - Name of the registered class
   * @returns Map of method names to MethodDefinition objects
   * @example
   * ```typescript
   * const methods = ObjectRegistry.getMethods('Agent');
   * for (const [name, methodDef] of methods) {
   *   console.log(`Method: ${name}`);
   *   console.log(`  Async: ${methodDef.async}`);
   *   console.log(`  Public: ${methodDef.isPublic}`);
   *   console.log(`  Params: ${methodDef.parameters.map(p => p.name).join(', ')}`);
   * }
   * ```
   */
  static getMethods(name: string): Map<string, any> {
    // Issue #951: Use findClass for multi-strategy lookup (qualified key, classNameMap, case-insensitive)
    const registered = ObjectRegistry.findClass(name);
    if (registered) {
      return registered.methods;
    }

    return new Map();
  }

  static compileValidators(
    className: string,
    fields: Map<string, any>,
  ): ValidatorFunction[] {
    return _compileValidators(className, fields);
  }

  /**
   * Ensure manifest is loaded for external package classes
   *
   * For classes from external packages, the manifest may not be loaded during
   * initial registration (which must be synchronous for decorator support).
   * This method loads the manifest asynchronously when needed.
   *
   * @param className - Name of the class to ensure manifest is loaded for
   * @returns Promise that resolves when manifest is loaded (or already loaded)
   * @throws {Error} If manifest cannot be found
   *
   * @example
   * ```typescript
   * // Before using fields from external package
   * await ObjectRegistry.ensureManifestLoaded('Place');
   * const fields = ObjectRegistry.getFields('Place'); // Now has fields
   * ```
   */
  static async ensureManifestLoaded(className: string): Promise<void> {
    let registered = ObjectRegistry.findClass(className);
    if (!registered) {
      const loaded = await ObjectRegistry.tryLoadFromExternalPackage(className);
      if (loaded) {
        registered = ObjectRegistry.findClass(className);
      }
    }

    if (!registered) {
      // Detect if running in test environment
      const isTestEnv =
        process.env.NODE_ENV === 'test' ||
        process.env.VITEST === 'true' ||
        typeof (globalThis as any).describe !== 'undefined' ||
        typeof (globalThis as any).it !== 'undefined';

      const testHint = isTestEnv
        ? `\n\n⚠️  Are you using 'smrt test'? ` +
          `Tests require manifest generation.\n` +
          `   ✅ Use: smrt test\n` +
          `   ❌ NOT:  npx vitest\n`
        : '';

      throw new Error(
        `Class '${className}' is not registered. ` +
          `Ensure the class is decorated with @smrt() before using it.` +
          testHint,
      );
    }

    // Try to load manifest from external package (even if some fields exist)
    // This handles cases where AST scanner missed optional fields without initializers
    const existingFieldCount = registered.fields.size;

    const { discoverManifestEntry } = await importManifestLoader();
    const manifestEntry = await discoverManifestEntry(
      registered.constructor,
      className,
    );

    if (!manifestEntry) {
      // Bundled consumers can register external classes without preserving the
      // package identity we normally use for direct manifest discovery. In
      // that case, fall back to class-name package scans and merge any fields
      // found into the existing registration instead of leaving a sparse entry.
      if (!registered.packageName || !registered.qualifiedName) {
        const loaded =
          await ObjectRegistry.tryLoadFromExternalPackage(className);
        if (loaded) {
          ObjectRegistry.invalidateInheritanceCache(className);
        }
      }
      return;
    }

    if (manifestEntry?.fields) {
      const manifestFieldCount = Object.keys(manifestEntry.fields).length;
      let didHydrate = false;
      const needsFieldHydration = Object.entries(manifestEntry.fields).some(
        ([fieldName, fieldDef]) => {
          const existingField = registered.fields.get(fieldName);
          if (!existingField) {
            return true;
          }

          return manifestFieldDiffers(existingField, fieldDef);
        },
      );
      const needsMethodHydration =
        !!manifestEntry.methods &&
        Object.entries(manifestEntry.methods).some(
          ([methodName, methodDef]) => {
            return (
              JSON.stringify(registered.methods.get(methodName)) !==
              JSON.stringify(methodDef)
            );
          },
        );
      const needsRegistrationHydration =
        (!!manifestEntry.packageName &&
          registered.packageName !== manifestEntry.packageName) ||
        (!!manifestEntry.extends &&
          registered.extends !== manifestEntry.extends);

      if (
        existingFieldCount > 0 &&
        existingFieldCount >= manifestFieldCount &&
        !needsFieldHydration &&
        !needsMethodHydration &&
        !needsRegistrationHydration
      ) {
        return;
      }

      // Convert FieldDefinition to Field objects and merge with existing
      for (const [fieldName, fieldDef] of Object.entries(
        manifestEntry.fields,
      )) {
        const existingField = registered.fields.get(fieldName);

        if (!existingField) {
          registered.fields.set(fieldName, createFieldFromManifest(fieldDef));
          didHydrate = true;
          continue;
        }

        if (manifestFieldDiffers(existingField, fieldDef)) {
          registered.fields.set(
            fieldName,
            mergeManifestField(existingField, fieldDef),
          );
          didHydrate = true;
        }
      }

      // Load method definitions from manifest
      if (manifestEntry.methods) {
        for (const [methodName, methodDef] of Object.entries(
          manifestEntry.methods,
        )) {
          registered.methods.set(methodName, methodDef);
        }
        didHydrate = true;
      }

      if (manifestEntry.schema) {
        registered.schema = {
          ddl: manifestEntry.schema.ddl,
          tableName:
            manifestEntry.schema.tableName ||
            registered.schema?.tableName ||
            classnameToTablename(registered.name),
          columns: cloneManifestSchemaColumns(manifestEntry.schema.columns),
          indexes:
            manifestEntry.schema.indexes?.map((indexDef) => ({
              ...indexDef,
              columns: [...(indexDef.columns || [])],
            })) || [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: manifestEntry.schema.version || '',
          packageName: manifestEntry.packageName,
          baseClass: registered.schema?.baseClass,
        };
        didHydrate = true;
      }

      // Extract and store package name from manifest entry (for getPackageName() lookup)
      if (manifestEntry.packageName) {
        registered.packageName = manifestEntry.packageName;
        registered.qualifiedName = createQualifiedName(
          manifestEntry.packageName,
          registered.name,
        ) as QualifiedClassName;
        didHydrate = true;
      }

      // Store extends info for getAllFields() to use (if present)
      if (manifestEntry.extends) {
        registered.extends = manifestEntry.extends;
        didHydrate = true;
      }

      if (didHydrate) {
        ObjectRegistry.invalidateInheritanceCache(className);
      }

      verboseLog(
        `📦 Loaded manifest for external package class: ${className} (${registered.fields.size} fields, ${registered.methods.size} methods)`,
      );
    } else {
      // Manifest not found - throw helpful error
      throw new Error(
        `Cannot find manifest for class '${className}'.\n\n` +
          `SMRT classes require a manifest generated at build time by the AST scanner.\n\n` +
          `If this is an external package class, verify:\n` +
          `  1. Package exports manifest: Check package.json has:\n` +
          `     "exports": { "./manifest": "./dist/manifest.json" }\n` +
          `  2. Package is built: Run npm run build in the package\n` +
          `  3. Manifest exists: Confirm dist/manifest.json exists\n\n` +
          `See: https://github.com/happyvertical/smrt/issues/131`,
      );
    }
  }

  /**
   * Get configuration for a registered class
   */
  static getConfig(name: string): SmartObjectConfig {
    // Issue #951: Use findClass for multi-strategy lookup
    const registered = ObjectRegistry.findClass(name);
    return registered ? registered.config : {};
  }

  /**
   * Get cached schema definition for a registered class
   */
  static getSchema(name: string): SchemaDefinition | undefined {
    return _getSchema(name);
  }

  /**
   * Get SQL DDL statement for a registered class
   */
  static getSchemaDDL(name: string): string | undefined {
    return _getSchemaDDL(name);
  }

  /**
   * Get table name for a registered class
   */
  static getTableName(name: string): string | undefined {
    return _getTableName(name);
  }

  /**
   * Get all pre-generated schemas for passing to database adapters
   */
  static getAllSchemas(): Record<
    string,
    { tableName: string; ddl: string; indexes?: string[] }
  > {
    return _getAllSchemas();
  }

  /**
   * Get all registered schemas as SchemaDefinition objects
   */
  static getAllSchemasAsDefinitions(): Record<string, SchemaDefinition> {
    return _getAllSchemasAsDefinitions();
  }
  /**
   * Get compiled validation functions for a registered class
   *
   * Returns pre-compiled validation functions that can be executed
   * at runtime for efficient validation without repeated setup.
   *
   * @param name - Name of the registered class
   * @returns Array of validation functions or undefined if not found
   * @example
   * ```typescript
   * const validators = ObjectRegistry.getValidators('Product');
   * for (const validator of validators || []) {
   *   const error = await validator(productInstance);
   *   if (error) console.error(error);
   * }
   * ```
   */
  static getValidators(name: string): ValidatorFunction[] | undefined {
    // Issue #951: Use findClass for multi-strategy lookup
    const registered = ObjectRegistry.findClass(name);
    return registered?.validators;
  }

  /**
   * Get pre-computed validation rules for a registered class
   *
   * Returns serializable validation rules that can be evaluated at runtime
   * without needing pre-compiled validator closures. This significantly
   * reduces CLI startup time for projects with many SMRT objects.
   *
   * @param name - Name of the registered class
   * @returns Array of validation rules or undefined if not found
   * @see https://github.com/happyvertical/smrt/issues/782
   */
  static getValidationRules(name: string): ValidationRule[] | undefined {
    // Issue #951: Use findClass for multi-strategy lookup
    const registered = ObjectRegistry.findClass(name);
    return registered?.validationRules;
  }

  /**
   * Validate an instance using pre-computed validation rules
   *
   * This method evaluates validation rules without creating closures,
   * providing faster validation than compiled validator functions.
   *
   * @param instance - The object instance to validate
   * @param rules - Array of validation rules to apply
   * @param className - Name of the class for error messages
   * @returns Array of validation errors (empty if valid)
   * @see https://github.com/happyvertical/smrt/issues/782
   */
  static async validateWithRules(
    instance: any,
    rules: ValidationRule[],
    className: string,
  ): Promise<any[]> {
    // Import ValidationError lazily to avoid circular dependency at module load
    const { ValidationError } = await import('./errors');
    const errors: any[] = [];

    for (const rule of rules) {
      const value = instance[rule.field];

      switch (rule.rule) {
        case 'required':
          if (value === null || value === undefined || value === '') {
            errors.push(ValidationError.requiredField(rule.field, className));
          }
          break;

        case 'min':
          if (
            value !== null &&
            value !== undefined &&
            value < (rule.value as number)
          ) {
            errors.push(
              ValidationError.rangeError(
                rule.field,
                value,
                rule.value as number,
                undefined,
              ),
            );
          }
          break;

        case 'max':
          if (
            value !== null &&
            value !== undefined &&
            value > (rule.value as number)
          ) {
            errors.push(
              ValidationError.rangeError(
                rule.field,
                value,
                undefined,
                rule.value as number,
              ),
            );
          }
          break;

        case 'minLength':
          if (
            value &&
            typeof value === 'string' &&
            value.length < (rule.value as number)
          ) {
            errors.push(
              ValidationError.invalidValue(
                rule.field,
                value,
                `string with minimum length ${rule.value}`,
              ),
            );
          }
          break;

        case 'maxLength':
          if (
            value &&
            typeof value === 'string' &&
            value.length > (rule.value as number)
          ) {
            errors.push(
              ValidationError.invalidValue(
                rule.field,
                value,
                `string with maximum length ${rule.value}`,
              ),
            );
          }
          break;

        case 'pattern':
          // Note: Creates regex on each validation call, trading runtime efficiency
          // for faster startup time (no closure compilation needed)
          if (value && typeof value === 'string') {
            const regex = new RegExp(rule.value as string);
            if (!regex.test(value)) {
              errors.push(
                ValidationError.invalidValue(
                  rule.field,
                  value,
                  `string matching pattern ${rule.value}`,
                ),
              );
            }
          }
          break;
      }
    }

    return errors;
  }

  /**
   * Build dependency graph from foreignKey relationships
   *
   * Returns a map where keys are class names and values are arrays
   * of class names that the key depends on (via foreignKey fields).
   *
   * @returns Map of class name to array of dependency class names
   * @example
   * ```typescript
   * const deps = ObjectRegistry.getDependencyGraph();
   * // { 'Order': ['Customer', 'Product'], 'Customer': [], 'Product': ['Category'] }
   * ```
   */
  static getDependencyGraph(): Map<string, string[]> {
    return _getDependencyGraph();
  }

  /**
   * Get initialization order for classes based on dependency graph
   *
   * Uses topological sort to ensure that classes are initialized in
   * an order that respects foreignKey dependencies (dependencies first).
   *
   * @returns Array of class names in initialization order
   * @throws {Error} If circular dependencies are detected
   * @example
   * ```typescript
   * const order = ObjectRegistry.getInitializationOrder();
   * // ['Category', 'Product', 'Customer', 'Order']
   * // Tables are created in this order to avoid foreign key errors
   * ```
   */
  static getInitializationOrder(): string[] {
    const graph = ObjectRegistry.getDependencyGraph();
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    function visit(className: string): void {
      // Circular dependency check
      if (visiting.has(className)) {
        throw new Error(
          `Circular dependency detected involving class: ${className}`,
        );
      }

      // Already processed
      if (visited.has(className)) {
        return;
      }

      visiting.add(className);

      // Visit all dependencies first
      const dependencies = graph.get(className) || [];
      for (const dep of dependencies) {
        visit(dep);
      }

      visiting.delete(className);
      visited.add(className);
      order.push(className);
    }

    // Visit all classes
    for (const className of graph.keys()) {
      if (!visited.has(className)) {
        visit(className);
      }
    }

    return order;
  }

  /**
   * Build comprehensive relationship map from all field types
   *
   * Returns a map containing all relationships (foreignKey, oneToMany, manyToMany)
   * discovered in registered classes. This enables runtime relationship traversal
   * and eager/lazy loading of related objects.
   *
   * @returns Map of class name to array of relationship metadata
   * @example
   * ```typescript
   * const relationships = ObjectRegistry.getRelationshipMap();
   * // {
   * //   'Order': [
   * //     { sourceClass: 'Order', fieldName: 'customerId', targetClass: 'Customer',
   * //       type: 'foreignKey', options: { onDelete: 'restrict' } }
   * //   ],
   * //   'Customer': [
   * //     { sourceClass: 'Customer', fieldName: 'orders', targetClass: 'Order',
   * //       type: 'oneToMany', options: {} }
   * //   ]
   * // }
   * ```
   */
  static getRelationshipMap(): Map<string, RelationshipMetadata[]> {
    return _getRelationshipMap();
  }

  /**
   * Get relationships for a specific class
   *
   * @param className - Name of the class to get relationships for
   * @returns Array of relationship metadata for the class
   * @example
   * ```typescript
   * const orderRelationships = ObjectRegistry.getRelationships('Order');
   * // [{ sourceClass: 'Order', fieldName: 'customerId', ... }]
   * ```
   */
  static getRelationships(className: string): RelationshipMetadata[] {
    return ObjectRegistry.getRelationshipMap().get(className) || [];
  }

  /**
   * Get full inheritance chain for a class
   *
   * Returns array of class names from base (SmrtObject) to child.
   * Results are cached globally for performance (~100x faster than re-walking).
   *
   * @param className - Name of the registered class
   * @returns Array of class names from base to child, or empty array if not found
   * @example
   * ```typescript
   * const chain = ObjectRegistry.getInheritanceChain('BentleyContent');
   * // ['SmrtObject', 'Content', 'PraecoContent', 'BentleyContent']
   * ```
   */
  static getInheritanceChain(className: string): string[] {
    const cache = ObjectRegistry.getInheritanceCache();

    // Check cache first
    const cached = cache.get(className);
    if (cached) {
      return cached;
    }

    // Get registered class
    const registered = ObjectRegistry.findClass(className);
    if (!registered) {
      return [];
    }

    // Check if already computed and stored
    if (registered.inheritanceChain) {
      cache.set(className, registered.inheritanceChain);
      return registered.inheritanceChain;
    }

    // Build chain from `extends` field (works for manifest-loaded classes)
    // This is critical because manifest-loaded classes have stub constructors
    // that only extend SmrtObject, not their actual parent class.
    // The `extends` field IS stored correctly during registerFromManifest().
    const chain: string[] = [];
    const visited = new Set<any>(); // Cycle detection using object identity
    let current: any = registered;
    let circularDetected = false;
    while (current) {
      // Cycle detection: use object identity to handle cases where distinct
      // classes share the same name (e.g., histrio:Performer vs smrt-video:Performer)
      if (visited.has(current)) {
        // Self-referential (chain length 1) is expected when a child package
        // extends a parent with the same className and only one is installed.
        // Longer cycles indicate misconfigured manifests.
        if (chain.length > 1) {
          console.warn(
            `[ObjectRegistry] Circular inheritance detected in chain: ${chain.join(' -> ')} -> ${current.name}. ` +
              `Check that '${current.extends ?? current.name}' resolves to the correct package class.`,
          );
          circularDetected = true;
        }
        break;
      }
      visited.add(current);

      chain.unshift(current.name); // Add at start to build [ancestor, ..., descendant]
      if (!current.extends) break;

      // Skip framework base classes that are never registered
      if (
        current.extends === 'SmrtObject' ||
        current.extends === 'SmrtClass' ||
        current.extends === 'SmrtCollection'
      ) {
        break;
      }

      // Try to find the parent class
      // Issue #1004/#1005: Use findClassStrict with package context for
      // unambiguous resolution. If extends is already qualified (from
      // qualifyExtendsName), this is an O(1) direct lookup.
      // If ambiguous, let the ConfigurationError propagate — callers
      // should fix their manifests rather than silently get wrong results.
      const parent = ObjectRegistry.findClassStrict(
        current.extends,
        current.packageName,
      );

      // Issue #1007: Parent not found — the class is not registered.
      // After loadAllManifests() completes at startup, all classes are
      // pre-registered so this path is only hit when a package is not
      // installed or the manifest is stale. We gracefully end the chain
      // here instead of mutating registry state during a read operation.
      if (!parent) {
        verboseLog(
          `[ObjectRegistry] Parent class '${current.extends}' not found ` +
            `while building inheritance chain. Ensure the parent package ` +
            `is installed and loadAllManifests() was called at startup.`,
        );
      }

      current = parent;
    }

    // Only cache complete, non-circular chains.
    // Caching a broken chain from a circular detection would cause all future
    // lookups to return incorrect inheritance data (e.g., ["VideoShot","VideoShot"]
    // instead of ["Content","VideoShot"]), breaking STI table resolution.
    if (!circularDetected) {
      registered.inheritanceChain = chain;
      cache.set(className, chain);
    }

    return chain;
  }

  /**
   * Get all fields including inherited ones from parent classes
   *
   * **Hybrid approach (v0.17+):**
   * - External packages: Use build-time merged fields from manifests
   * - Local classes: Use runtime merging by walking inheritance chain
   *
   * @param className - Name of the registered class
   * @returns Map of all fields (including inherited)
   */
  static async getAllFields(className: string): Promise<Map<string, any>> {
    let registered = ObjectRegistry.findClass(className);
    if (!registered) {
      const loaded = await ObjectRegistry.tryLoadFromExternalPackage(className);
      if (!loaded) {
        return new Map();
      }
      registered = ObjectRegistry.findClass(className);
      if (!registered) {
        return new Map();
      }
    }

    // Ensure manifest is loaded (handles external packages)
    await ObjectRegistry.ensureManifestLoaded(className);

    // Check if class has inheritedFields cache (set during manifest loading)
    if (registered.inheritedFields) {
      return prependSmrtSystemFields(new Map(registered.inheritedFields));
    }

    // Get config for error handling behavior
    const { onMissingAncestor } = getInheritanceConfig();

    // For local classes (not from manifests), merge fields from inheritance chain
    const allFields = new Map<string, any>();
    const chain = ObjectRegistry.getInheritanceChain(className);

    // Walk chain from base to child (parent fields first)
    for (const ancestorName of chain) {
      // Skip framework base classes
      if (
        ancestorName === 'SmrtObject' ||
        ancestorName === 'SmrtClass' ||
        ancestorName === 'SmrtCollection'
      ) {
        continue;
      }

      try {
        await ObjectRegistry.ensureManifestLoaded(ancestorName);
      } catch {
        // Local classes and pure test fixtures may not have manifests. In that
        // case we still want to use whatever runtime metadata is already
        // registered instead of failing the entire inheritance walk.
      }

      const ancestor = ObjectRegistry.findClass(ancestorName);
      if (!ancestor) {
        // Handle missing ancestors according to config
        const message = `Missing ancestor class "${ancestorName}" in inheritance chain for "${className}"`;

        if (onMissingAncestor === 'error') {
          throw new Error(
            `${message}\n\n` +
              `This usually means:\n` +
              `  1. The parent class is not registered with @smrt()\n` +
              `  2. The parent class file is not imported\n` +
              `  3. The manifest does not include the parent class\n\n` +
              `To fix:\n` +
              `  - Ensure all parent classes use @smrt() decorator\n` +
              `  - Import all parent class files before child classes\n` +
              `  - Rebuild to regenerate manifest\n` +
              `  - Or set smrt.inheritance.onMissingAncestor='warn' in config`,
          );
        } else if (onMissingAncestor === 'warn') {
          console.warn(`[ObjectRegistry] ${message}`);
        }

        continue;
      }

      // Merge fields from this ancestor
      for (const [fieldName, field] of ancestor.fields) {
        const existingField = allFields.get(fieldName);
        if (!existingField) {
          // New field from parent
          allFields.set(fieldName, field);
        } else {
          // Field exists - merge configs
          allFields.set(
            fieldName,
            ObjectRegistry.mergeFieldConfigs(existingField, field, fieldName),
          );
        }
      }
    }

    registered.inheritedFields = new Map(allFields);

    return prependSmrtSystemFields(allFields);
  }

  /**
   * Merge field configurations from parent and child
   *
   * Rules:
   * - Type: Child wins (warn if different)
   * - _meta: Deep merge with child precedence
   * - Numeric constraints: Take strictest (max of mins, min of maxes)
   * - Validators: Combine (both must pass)
   * - Unique: Take OR (unique if either says unique)
   * - Value: Child wins
   *
   * @param parentField - Field config from parent class
   * @param childField - Field config from child class
   * @param fieldName - Name of the field (for warning messages)
   * @returns Merged field configuration
   */
  private static mergeFieldConfigs(
    parentField: any,
    childField: any,
    fieldName: string,
  ): any {
    // Start with parent field as base
    const merged = { ...parentField };

    // Type: Child wins (warn if different)
    if (childField.type && childField.type !== parentField.type) {
      // Don't warn for tenantId field - expected type conflict between decorator and AST
      // The @tenantId decorator registers as 'foreignKey' but AST sees 'text' from type annotation
      // __tenancy can be at root level (from @tenantId decorator) or under _meta (from @smrt({ tenantScoped: true }))
      const isTenantField =
        parentField.__tenancy?.isTenantIdField ||
        parentField._meta?.__tenancy?.isTenantIdField;
      if (!(isTenantField && fieldName === 'tenantId')) {
        console.warn(
          `Field type mismatch: "${fieldName}" is ${parentField.type} in parent but ${childField.type} in child. Using child type.`,
        );
      }
      merged.type = childField.type;
    }

    // _meta: Merge with child precedence
    if (childField._meta || parentField._meta) {
      merged._meta = {
        ...(parentField._meta || {}),
        ...(childField._meta || {}),
      };

      // Special handling for numeric constraints (take strictest)
      if (
        parentField._meta?.min !== undefined &&
        childField._meta?.min !== undefined
      ) {
        // Take the larger min (strictest lower bound)
        merged._meta.min = Math.max(
          parentField._meta.min,
          childField._meta.min,
        );
      }
      if (
        parentField._meta?.max !== undefined &&
        childField._meta?.max !== undefined
      ) {
        // Take the smaller max (strictest upper bound)
        merged._meta.max = Math.min(
          parentField._meta.max,
          childField._meta.max,
        );
      }

      // Validators: Combine (both must pass)
      if (parentField._meta?.validate && childField._meta?.validate) {
        const parentValidator = parentField._meta.validate;
        const childValidator = childField._meta.validate;
        merged._meta.validate = async (value: any) => {
          const parentResult = await parentValidator(value);
          const childResult = await childValidator(value);
          return parentResult && childResult;
        };
      }

      // Unique: Take OR (unique if either says unique)
      if (parentField._meta?.unique || childField._meta?.unique) {
        merged._meta.unique = true;
      }
    }

    // __tenancy: Preserve from parent (decorator takes precedence)
    // This ensures @tenantId decorator metadata survives type conflicts (Issue #841)
    // The decorator registers __tenancy metadata, but AST scanner may override the type.
    // We need to preserve __tenancy so the interceptor can identify tenant fields.
    if (parentField.__tenancy || childField.__tenancy) {
      merged.__tenancy = {
        ...(childField.__tenancy || {}),
        ...(parentField.__tenancy || {}), // Parent (decorator) wins
      };
    }

    // Value: Child wins
    if (childField.value !== undefined) {
      merged.value = childField.value;
    }

    return merged;
  }

  /**
   * Get all methods including inherited ones from parent classes
   *
   * Walks the full inheritance chain and merges methods:
   * - Parent methods are added first
   * - Child methods override parent methods (no config merging for methods)
   *
   * Results are cached per-class for performance.
   *
   * **Note:** This is an async method that ensures manifests are loaded for external package classes.
   *
   * @param className - Name of the registered class
   * @returns Promise resolving to Map of all methods (own + inherited)
   * @example
   * ```typescript
   * // Given: Content → PraecoContent → BentleyContent
   * const allMethods = await ObjectRegistry.getAllMethods('BentleyContent');
   * // Includes: generateSummary() (from PraecoContent) + analyzeLocal() (from BentleyContent)
   * ```
   */
  static async getAllMethods(className: string): Promise<Map<string, any>> {
    const registered = ObjectRegistry.findClass(className);
    if (!registered) {
      return new Map();
    }

    // Check cache first
    if (registered.inheritedMethods) {
      return new Map(registered.inheritedMethods);
    }

    // Build merged methods from inheritance chain
    const allMethods = new Map<string, any>();
    const chain = ObjectRegistry.getInheritanceChain(className);

    // Walk chain from base to child (parent methods first)
    for (const ancestorName of chain) {
      // Skip framework base classes (check BEFORE looking up in registry)
      if (
        ancestorName === 'SmrtObject' ||
        ancestorName === 'SmrtClass' ||
        ancestorName === 'SmrtCollection'
      ) {
        continue;
      }

      // Load manifest for ancestor class (handles external packages)
      // This ensures inherited methods from external packages are available
      try {
        await ObjectRegistry.ensureManifestLoaded(ancestorName);
      } catch (error) {
        // Manifest loading failed - this is expected for classes not in manifest
        // Continue to next ancestor
      }

      const ancestor = ObjectRegistry.findClass(ancestorName);
      if (!ancestor) continue;

      // Merge parent methods into result
      for (const [methodName, method] of ancestor.methods) {
        // Child methods override parent methods (no merging)
        allMethods.set(methodName, method);
      }
    }

    // Cache the merged result
    registered.inheritedMethods = allMethods;

    return new Map(allMethods);
  }

  /**
   * Get complete metadata for a single object (convenience method)
   *
   * Returns all available metadata for an object in a single call, including:
   * - Class information
   * - Field definitions
   * - Configuration
   * - Schema definition
   * - Validators
   * - Relationships
   * - Tools (AI-callable methods)
   *
   * This is a convenience method that aggregates multiple registry queries
   * into a single comprehensive metadata object.
   *
   * @param className - Name of the class to get metadata for
   * @returns Complete metadata object or null if class not found
   * @example
   * ```typescript
   * const productMeta = ObjectRegistry.getObjectMetadata('Product');
   * if (productMeta) {
   *   console.log('Name:', productMeta.name);
   *   console.log('Table:', productMeta.schema.tableName);
   *   console.log('Fields:', productMeta.fields.size);
   *   console.log('API config:', productMeta.config.api);
   *   console.log('Relationships:', productMeta.relationships.length);
   * }
   * ```
   */
  static getObjectMetadata(className: string): {
    name: string;
    constructor: typeof SmrtObject;
    collectionConstructor?: new (options: any) => SmrtCollection<any>;
    config: SmartObjectConfig;
    fields: Map<string, any>;
    methods: Map<string, any>;
    schema: SchemaDefinition | undefined;
    validators: ValidatorFunction[];
    relationships: RelationshipMetadata[];
    inverseRelationships: RelationshipMetadata[];
    tools?: Array<{
      type: 'function';
      function: {
        name: string;
        description?: string;
        parameters?: Record<string, any>;
      };
    }>;
  } | null {
    const registered = ObjectRegistry.findClass(className);
    if (!registered) {
      return null;
    }

    return {
      name: registered.name,
      constructor: registered.constructor,
      collectionConstructor: registered.collectionConstructor,
      config: registered.config,
      fields: new Map(registered.fields), // Return copy to prevent mutations
      methods: new Map(registered.methods), // Return copy to prevent mutations
      schema: registered.schema,
      validators: registered.validators || [],
      relationships: ObjectRegistry.getRelationships(className),
      inverseRelationships: ObjectRegistry.getInverseRelationships(className),
      tools: registered.tools,
    };
  }

  /**
   * Get metadata for all registered objects (convenience method)
   *
   * Returns comprehensive metadata for every registered object, combining
   * multiple registry queries into a single convenient data structure.
   *
   * This is particularly useful for:
   * - Admin dashboards showing all objects
   * - Documentation generation
   * - Schema visualization
   * - Debugging and introspection
   *
   * @returns Array of complete metadata objects for all registered classes
   * @example
   * ```typescript
   * const allMetadata = ObjectRegistry.getAllObjectMetadata();
   *
   * // Generate admin dashboard
   * for (const meta of allMetadata) {
   *   console.log(`${meta.name}:`);
   *   console.log(`  Table: ${meta.schema?.tableName}`);
   *   console.log(`  Fields: ${meta.fields.size}`);
   *   console.log(`  API: ${meta.config.api ? 'enabled' : 'disabled'}`);
   *   console.log(`  Relationships: ${meta.relationships.length}`);
   * }
   *
   * // Generate schema documentation
   * const schemaDoc = allMetadata.map(meta => ({
   *   name: meta.name,
   *   table: meta.schema?.tableName,
   *   fields: Array.from(meta.fields.entries()).map(([name, field]) => ({
   *     name,
   *     type: field.type,
   *     required: field._meta?.required || false
   *   })),
   *   relationships: meta.relationships.map(rel => ({
   *     field: rel.fieldName,
   *     target: rel.targetClass,
   *     type: rel.type
   *   }))
   * }));
   * ```
   */
  static getAllObjectMetadata(): Array<{
    name: string;
    constructor: typeof SmrtObject;
    collectionConstructor?: new (options: any) => SmrtCollection<any>;
    config: SmartObjectConfig;
    fields: Map<string, any>;
    methods: Map<string, any>;
    schema: SchemaDefinition | undefined;
    validators: ValidatorFunction[];
    relationships: RelationshipMetadata[];
    inverseRelationships: RelationshipMetadata[];
    tools?: Array<{
      type: 'function';
      function: {
        name: string;
        description?: string;
        parameters?: Record<string, any>;
      };
    }>;
  }> {
    const allMetadata: Array<any> = [];

    // Issue #951: Use simple names (map keys may be qualified)
    for (const [_key, entry] of ObjectRegistry.classes) {
      const metadata = ObjectRegistry.getObjectMetadata(entry.name || _key);
      if (metadata) {
        allMetadata.push(metadata);
      }
    }

    return allMetadata;
  }

  /**
   * Get inverse relationships (relationships where this class is the target)
   *
   * @param className - Name of the class to find inverse relationships for
   * @returns Array of relationship metadata where this class is the target
   * @example
   * ```typescript
   * const customerInverseRels = ObjectRegistry.getInverseRelationships('Customer');
   * // [{ sourceClass: 'Order', fieldName: 'customerId', targetClass: 'Customer', ... }]
   * ```
   */
  static getInverseRelationships(className: string): RelationshipMetadata[] {
    const allRelationships = ObjectRegistry.getRelationshipMap();
    const inverseRelationships: RelationshipMetadata[] = [];

    for (const [_sourceClass, relationships] of allRelationships) {
      for (const rel of relationships) {
        if (rel.targetClass === className) {
          inverseRelationships.push(rel);
        }
      }
    }

    return inverseRelationships;
  }

  /**
   * Get table inheritance strategy for a class
   *
   * Returns the table strategy (CTI or STI) for a class, with automatic
   * inheritance from parent classes. If not explicitly configured,
   * walks up the inheritance chain to find the strategy.
   *
   * **Strategy Inheritance:**
   * - Set once on base class, children inherit automatically
   * - Children can explicitly override (not recommended)
   * - Default is 'cti' if not found in hierarchy
   *
   * @param className - Name of the class to get strategy for
   * @returns 'cti' (Class Table Inheritance) or 'sti' (Single Table Inheritance)
   * @example
   * ```typescript
   * @smrt({ tableStrategy: 'sti' })
   * class Event extends SmrtObject { }
   *
   * @smrt() // Inherits 'sti'
   * class Meeting extends Event { }
   *
   * ObjectRegistry.getTableStrategy('Meeting'); // 'sti'
   * ObjectRegistry.getTableStrategy('Event'); // 'sti'
   * ```
   */
  static getTableStrategy(className: string): 'cti' | 'sti' {
    const registered = ObjectRegistry.findClass(className);
    if (!registered) {
      return 'cti'; // Default for unregistered classes
    }

    // Explicit config wins
    if (registered.config?.tableStrategy) {
      return registered.config.tableStrategy;
    }

    // Inherit from ancestors
    const chain = ObjectRegistry.getInheritanceChain(className);
    for (const ancestorName of chain) {
      const ancestor = ObjectRegistry.findClass(ancestorName);
      if (ancestor?.config?.tableStrategy) {
        return ancestor.config.tableStrategy;
      }
    }

    return 'cti'; // Default strategy
  }

  /**
   * Get the conflict columns for UPSERT operations on a class
   *
   * Returns custom conflict columns if specified, otherwise defaults based on
   * table strategy:
   * - CTI: ['slug', 'context']
   * - STI: ['slug', 'context', '_meta_type']
   *
   * @param className - Name of the class to get conflict columns for
   * @returns Array of column names to use for conflict detection
   *
   * @example
   * ```typescript
   * // Junction table with custom conflict columns
   * @smrt({ conflictColumns: ['event_id', 'profile_id'] })
   * class EventParticipant extends SmrtObject {}
   *
   * ObjectRegistry.getConflictColumns('EventParticipant');
   * // Returns: ['event_id', 'profile_id']
   * ```
   */
  static getConflictColumns(className: string): string[] {
    const registered = ObjectRegistry.findClass(className);
    if (!registered) {
      return ['slug', 'context']; // Default for unregistered classes
    }

    // Explicit config wins
    if (registered.config?.conflictColumns) {
      return registered.config.conflictColumns;
    }

    // Fall back to table strategy-based defaults
    const tableStrategy = ObjectRegistry.getTableStrategy(className);
    return tableStrategy === 'sti'
      ? ['slug', 'context', '_meta_type']
      : ['slug', 'context'];
  }

  /**
   * Get the tenant scoping configuration for a class (Issue #688)
   *
   * Returns the normalized tenant scoping configuration if the class
   * was registered with `tenantScoped: true` or a tenantScoped config object.
   *
   * @param className - Name of the class to check
   * @returns Tenant scoping config or undefined if not tenant-scoped
   *
   * @example
   * ```typescript
   * @smrt({ tenantScoped: true })
   * class Document extends SmrtObject { }
   *
   * const config = ObjectRegistry.getTenantScopedConfig('Document');
   * // { mode: 'required', field: 'tenantId', autoFilter: true, autoPopulate: true, allowSuperAdminBypass: false }
   * ```
   */
  static getTenantScopedConfig(
    className: string,
  ): RegisteredClass['tenantScopedConfig'] | undefined {
    const registered = ObjectRegistry.findClass(className);
    return registered?.tenantScopedConfig;
  }

  /**
   * Check if a class is tenant-scoped (Issue #688)
   *
   * @param className - Name of the class to check
   * @returns true if the class has tenantScoped configuration
   */
  static isTenantScoped(className: string): boolean {
    return ObjectRegistry.getTenantScopedConfig(className) !== undefined;
  }

  /**
   * Get the base class for an STI hierarchy
   *
   * Walks up the inheritance chain to find the first class configured
   * with `tableStrategy: 'sti'`. This is the class that owns the shared table.
   *
   * **Returns:**
   * - The base class name if STI is configured in the hierarchy
   * - null if the class uses CTI strategy
   *
   * @param className - Name of the class to find STI base for
   * @returns Base class name or null if CTI
   * @example
   * ```typescript
   * @smrt({ tableStrategy: 'sti' })
   * class Event extends SmrtObject { }
   *
   * @smrt()
   * class Meeting extends Event { }
   *
   * ObjectRegistry.getSTIBase('Meeting'); // 'Event'
   * ObjectRegistry.getSTIBase('Event'); // 'Event'
   * ```
   */
  static getSTIBase(className: string): string | null {
    const strategy = ObjectRegistry.getTableStrategy(className);
    if (strategy === 'cti') {
      return null; // Not using STI
    }

    // Find the OLDEST/ROOT class in the chain with explicit tableStrategy: 'sti'
    // (Issue #703 fix: don't rely on tableName matching)
    //
    // In multi-level STI hierarchies (e.g., Council → Organization → Profile),
    // we need to return the oldest ancestor (Profile), not the first one found (Organization)
    //
    // IMPORTANT: Don't rely on tableName matching because:
    // 1. STI subclasses loaded from external manifests may have tableName: null
    // 2. registerFromManifest() derives a tableName from class name when null
    // 3. This causes tableName mismatch ('meetings' vs 'events')
    // 4. Instead, find the oldest ancestor with EXPLICIT tableStrategy: 'sti'
    const chain = ObjectRegistry.getInheritanceChain(className);

    // Walk the chain (ordered [root, ..., className]) to find oldest STI base
    for (const ancestorName of chain) {
      const ancestor = ObjectRegistry.findClass(ancestorName);
      if (!ancestor) continue;

      // Check if this ancestor EXPLICITLY declares tableStrategy: 'sti'
      // (not inherited via getTableStrategy(), but set directly in config)
      if (ancestor.config?.tableStrategy === 'sti') {
        // Found the OLDEST ancestor with explicit STI - this is the base
        // All descendants inherit from this table regardless of their tableName
        return ancestorName;
      }
    }

    // If no explicit STI ancestor found but we detected STI strategy,
    // this class is its own STI base (it must have declared tableStrategy: 'sti')
    return className;
  }

  /**
   * Get all descendant classes of a base class
   *
   * Returns all registered classes that inherit from the specified base class.
   * Uses the `extends` field from manifest to build the descendant tree.
   *
   * **Use cases:**
   * - Schema generation: Aggregate fields from all children for STI table
   * - Polymorphic queries: Find all types to instantiate
   * - Documentation: Show class hierarchy
   *
   * @param className - Name of the base class
   * @returns Array of descendant class names (direct and indirect)
   * @example
   * ```typescript
   * @smrt({ tableStrategy: 'sti' })
   * class Event extends SmrtObject { }
   *
   * @smrt()
   * class Meeting extends Event { }
   *
   * @smrt()
   * class HockeyGame extends Event { }
   *
   * ObjectRegistry.getDescendants('Event'); // ['Meeting', 'HockeyGame']
   * ```
   */
  static getDescendants(className: string): string[] {
    const descendants: string[] = [];

    // Find all classes that extend the given class
    // Issue #951: Use simple name for comparison since inheritance chains contain simple names
    for (const [_key, childClass] of ObjectRegistry.classes) {
      const simpleName = childClass.name || _key;
      const chain = ObjectRegistry.getInheritanceChain(simpleName);
      if (chain.includes(className) && simpleName !== className) {
        descendants.push(simpleName);
      }
    }

    return descendants;
  }

  /**
   * Persist registry state to system tables
   *
   * Saves all registered class metadata to the _smrt_registry system table
   * for runtime introspection and debugging. This enables applications to
   * query what SMRT objects exist and their configurations.
   *
   * @param db - Database interface to persist to
   * @returns Promise that resolves when persistence is complete
   * @example
   * ```typescript
   * // After registering all classes
   * await ObjectRegistry.persistToDatabase(db);
   *
   * // Later, query the system table
   * const rows = await db.all('SELECT * FROM _smrt_registry');
   * console.log('Registered classes:', rows.map(r => r.class_name));
   * ```
   */
  static async persistToDatabase(
    db: import('@happyvertical/sql').DatabaseInterface,
  ): Promise<void> {
    for (const [className, registered] of ObjectRegistry.classes.entries()) {
      const fieldsData: any = {};
      for (const [key, value] of registered.fields) {
        fieldsData[key] = {
          type: value.type,
          options: value.options,
        };
      }

      // Use upsert() for database-agnostic INSERT OR REPLACE
      // SQLite: INSERT OR REPLACE
      // Postgres/DuckDB: INSERT ... ON CONFLICT ... DO UPDATE
      await db.upsert(
        '_smrt_registry',
        ['class_name'], // PRIMARY KEY for conflict detection
        {
          class_name: className,
          schema_version: '1.0.0', // Could be derived from package version
          fields: JSON.stringify(fieldsData),
          relationships: JSON.stringify(
            ObjectRegistry.getRelationships(className),
          ),
          config: JSON.stringify(registered.config),
          manifest: JSON.stringify({
            name: registered.name,
            tableName: registered.schema?.tableName,
            tools: registered.tools,
          }),
          last_updated: new Date(),
        },
      );
    }
  }

  /**
   * Load registry metadata from system tables
   *
   * Reads the _smrt_registry system table to inspect what classes
   * have been registered. This is primarily for introspection and
   * debugging - actual class registration happens via @smrt() decorator.
   *
   * @param db - Database interface to load from
   * @returns Promise resolving to array of class metadata
   * @example
   * ```typescript
   * const metadata = await ObjectRegistry.loadFromDatabase(db);
   * for (const meta of metadata) {
   *   console.log(`Class: ${meta.class_name}`);
   *   console.log(`Table: ${JSON.parse(meta.manifest).tableName}`);
   * }
   * ```
   */
  static async loadFromDatabase(
    db: import('@happyvertical/sql').DatabaseInterface,
  ): Promise<any[]> {
    const { rows } = await db.query(
      'SELECT * FROM _smrt_registry ORDER BY class_name',
    );
    return rows;
  }

  // ============================================================================
  // Embedding Configuration Methods
  // ============================================================================

  /**
   * Get embedding configuration for a class
   *
   * Returns the class-specific embedding config if embeddings are enabled.
   * This includes the fields to embed, provider override, and generation options.
   *
   * @param className - Name of the class to get embedding config for
   * @returns Class embedding config or undefined if not configured
   * @example
   * ```typescript
   * @smrt({
   *   embeddings: {
   *     fields: ['title', 'body'],
   *     autoGenerate: true
   *   }
   * })
   * class Article extends SmrtObject { }
   *
   * const config = ObjectRegistry.getEmbeddingConfig('Article');
   * // { fields: ['title', 'body'], autoGenerate: true }
   * ```
   */
  static getEmbeddingConfig(
    className: string,
  ): ClassEmbeddingConfig | undefined {
    return _getEmbeddingConfig(className);
  }

  /**
   * Check if a class has embeddings enabled
   *
   * @param className - Name of the class to check
   * @returns True if the class has embedding configuration
   * @example
   * ```typescript
   * if (ObjectRegistry.hasEmbeddings('Article')) {
   *   await article.generateEmbeddings();
   * }
   * ```
   */
  static hasEmbeddings(className: string): boolean {
    return _hasEmbeddings(className);
  }

  /**
   * Get all registered classes that have embeddings enabled
   *
   * @returns Array of class names with embedding configuration
   * @example
   * ```typescript
   * const embeddableClasses = ObjectRegistry.getEmbeddingClasses();
   * // ['Article', 'Profile', 'Event']
   * ```
   */
  static getEmbeddingClasses(): string[] {
    return _getEmbeddingClasses();
  }

  /**
   * Get project-level embedding configuration
   *
   * Returns the global embedding settings from smrt.config (or defaults).
   * These settings apply to all classes unless overridden at the class level.
   *
   * @returns Project embedding configuration with defaults applied
   * @example
   * ```typescript
   * const projectConfig = ObjectRegistry.getProjectEmbeddingConfig();
   * // {
   * //   dimensions: 768,
   * //   provider: 'local',
   * //   localModel: 'Xenova/bge-base-en-v1.5',
   * //   aiModel: 'text-embedding-3-small',
   * //   fallbackToAI: true
   * // }
   * ```
   */
  static getProjectEmbeddingConfig(): ProjectEmbeddingConfig {
    return _getProjectEmbeddingConfig();
  }

  /**
   * Resolve complete embedding configuration for a class
   *
   * Merges project-level config with class-level overrides.
   * Returns undefined if the class doesn't have embeddings enabled.
   *
   * @param className - Name of the class to resolve config for
   * @returns Fully resolved embedding config or undefined
   * @example
   * ```typescript
   * const config = ObjectRegistry.resolveEmbeddingConfig('Article');
   * // Merges project defaults with class-specific settings
   * // {
   * //   fields: ['title', 'body'],
   * //   dimensions: 768,
   * //   provider: 'local',
   * //   localModel: 'Xenova/bge-base-en-v1.5',
   * //   autoGenerate: true,
   * //   regenerateOnChange: true,
   * //   ...
   * // }
   * ```
   */
  static resolveEmbeddingConfig(
    className: string,
  ): ResolvedEmbeddingConfig | undefined {
    return _resolveEmbeddingConfig(className);
  }
}

/**
 * Registers a `SmrtObject` or `SmrtCollection` subclass with the global `ObjectRegistry`.
 *
 * This decorator is the primary entry point for the SMRT framework. Applying it to a class:
 *
 * 1. Captures the original class name before minification and stores it as the
 *    `SMRT_TABLE_NAME` static property — ensuring table names are stable in production builds.
 * 2. Registers class metadata (fields, schema, config) in the singleton `ObjectRegistry`.
 * 3. Enables automatic code generation: REST API endpoints (`api`), CLI commands (`cli`),
 *    and MCP server tools (`mcp`) are generated at build time from the registered config.
 * 4. Activates lifecycle hooks (`hooks.beforeSave`, `hooks.afterDelete`, etc.).
 * 5. Configures AI-callable methods exposed to `is()` / `do()` via function calling (`ai`).
 * 6. Enables automatic vector embedding generation (`embeddings`).
 *
 * Apply to `SmrtCollection` subclasses as well — the decorator uses `_itemClass` to
 * register the collection under the correct table name and creates a collection-to-table
 * lookup used by the CLI and introspection tools.
 *
 * For Single Table Inheritance (STI), set `tableStrategy: 'sti'` on the base class only.
 * Child classes inherit the strategy automatically.
 *
 * @param config - Optional configuration for the class. All fields are optional; defaults
 *   are derived from the class name and framework conventions.
 * @returns A class decorator that registers the class and returns the original constructor
 *
 * @example
 * ```typescript
 * // Basic usage — convention-based defaults
 * @smrt()
 * class Product extends SmrtObject {
 *   @field({ required: true })
 *   name: string = '';
 *   price: number = 0.0; // 0.0 → DECIMAL column
 * }
 *
 * // Paired collection (required for collection.create())
 * @smrt()
 * class Products extends SmrtCollection<Product> {
 *   static readonly _itemClass = Product;
 * }
 *
 * // STI base class
 * @smrt({ tableStrategy: 'sti' })
 * class Content extends SmrtObject {
 *   title: string = '';
 * }
 *
 * // STI child — inherits strategy, adds @meta() fields stored in _meta_data JSON
 * @smrt()
 * class Article extends Content {
 *   @meta() wordCount: number = 0;
 * }
 *
 * // Restrict generated API surface
 * @smrt({ api: { exclude: ['delete'] }, mcp: true, cli: false })
 * class Invoice extends SmrtObject {}
 *
 * // Junction/upsert table with natural key
 * @smrt({ conflictColumns: ['event_id', 'profile_id'] })
 * class EventParticipant extends SmrtObject {
 *   eventId: string = '';
 *   profileId: string = '';
 * }
 * ```
 *
 * @see {@link SmartObjectConfig} for all available configuration options
 * @see {@link field} / {@link meta} / {@link foreignKey} for field decorators
 */
export function smrt(config: SmartObjectConfig = {}) {
  return <T extends abstract new (...args: any[]) => any>(
    ctor: T,
    decoratorContext?: ClassDecoratorContext<T>,
  ): T => {
    applyPendingDecoratorRegistrations(ctor, decoratorContext);

    // Check if this is a SmrtCollection class
    const isCollection = ctor.prototype instanceof SmrtCollection;

    if (isCollection) {
      // Handle SmrtCollection registration
      const itemClass = (ctor as any)._itemClass;
      if (itemClass) {
        // Register the item class (SmrtObject) with metadata
        // For STI: Check if this class uses STI and get the base class's table name
        let tableName = config.tableName;

        if (!tableName) {
          // Check if this class or any parent uses STI
          const itemClassName = itemClass.name;
          const stiBase = ObjectRegistry.getSTIBase(itemClassName);

          if (stiBase && stiBase !== itemClassName) {
            // Use STI base's table name
            tableName = classnameToTablename(stiBase);
          } else if (ObjectRegistry.getTableStrategy(itemClassName) === 'sti') {
            // This is the STI base - use its own table name
            tableName = classnameToTablename(itemClassName);
          } else {
            // CTI: Use own table name
            tableName = classnameToTablename(itemClassName);
          }
        }

        ObjectRegistry.register(itemClass, { ...config, tableName });

        const registeredItemClass = ObjectRegistry.getClass(itemClass.name);

        // Register the collection constructor under the item class identity first.
        // This ensures ObjectRegistry.getCollection('ItemClass') uses the explicit
        // collection subclass rather than falling back to a generated default.
        ObjectRegistry.registerCollection(itemClass.name, ctor as any);
        if (registeredItemClass?.qualifiedName) {
          ObjectRegistry.registerCollection(
            registeredItemClass.qualifiedName,
            ctor as any,
          );
        }

        // Also register the collection constructor using tableName.
        // This preserves existing CLI/introspection lookups by table name
        // (e.g., "meetings") and keeps backward compatibility.
        ObjectRegistry.registerCollection(tableName, ctor as any);

        // Store collection class name -> tableName mapping for getTableName lookups
        // This enables ObjectRegistry.getTableName('CollectionClassName') to work
        ObjectRegistry.setCollectionTableName(ctor.name, tableName);
      }
    } else {
      // Handle SmrtObject registration (existing behavior)
      let tableName = config.tableName;

      if (!tableName) {
        // First, check manifest for tableName (manifest generator correctly handles STI inheritance)
        // This handles the case where a child class sets tableStrategy: 'sti' explicitly
        // but should still inherit the parent's table name
        const manifestEntry = discoverCachedManifestSync(ctor.name);
        if (manifestEntry?.decoratorConfig?.tableName) {
          tableName = manifestEntry.decoratorConfig.tableName;
        } else if (config.tableStrategy === 'sti') {
          // Fallback: Runtime prototype chain walking for STI detection
          // This is used when:
          // 1. Class is dynamically registered (not in manifest)
          // 2. Development mode without a build
          // 3. Test scenarios without manifest generation
          // Note: This relies on parents being registered first, which is why
          // the manifest check above is preferred (it has correct build-time data).
          let proto = Object.getPrototypeOf(ctor);
          let stiBaseName: string | null = null;

          while (proto?.name && proto.name !== 'SmrtObject') {
            if (ObjectRegistry.getTableStrategy(proto.name) === 'sti') {
              stiBaseName = ObjectRegistry.getSTIBase(proto.name);
              break;
            }
            proto = Object.getPrototypeOf(proto);
          }

          if (stiBaseName) {
            // This is an STI child - use parent's table name
            tableName = classnameToTablename(stiBaseName);
          } else {
            // This is the actual STI base - use its own table name
            tableName = classnameToTablename(ctor.name);
          }
        } else {
          // Fallback: Check if any parent uses STI (implicit STI inheritance)
          // Same caveats as above - used only when manifest data unavailable.
          let proto = Object.getPrototypeOf(ctor);
          let stiBaseName: string | null = null;

          while (proto?.name && proto.name !== 'SmrtObject') {
            // Use getTableStrategy() to properly detect inherited STI strategy
            if (ObjectRegistry.getTableStrategy(proto.name) === 'sti') {
              // Get the actual STI base (may be higher up the chain)
              stiBaseName = ObjectRegistry.getSTIBase(proto.name);
              break;
            }
            proto = Object.getPrototypeOf(proto);
          }

          if (stiBaseName) {
            // Use STI base's table name
            tableName = classnameToTablename(stiBaseName);
          } else {
            // CTI: Use own table name
            tableName = classnameToTablename(ctor.name);
          }
        }
      }

      ObjectRegistry.register(ctor as any, { ...config, tableName });
    }

    return ctor;
  };
}
