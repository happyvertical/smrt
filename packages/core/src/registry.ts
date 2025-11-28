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
 * import { smrt } from '@happyvertical/smrt-core';
 *
 * @smrt({ api: { exclude: ['delete'] } })
 * class Product extends SmrtObject {
 *   name = text({ required: true });
 * }
 * ```
 */

import type { SmrtGlobalConfig } from '@happyvertical/smrt-config';
import { getModuleConfig } from '@happyvertical/smrt-config';
import { SmrtCollection } from './collection';
import { ConfigurationError } from './errors';
import {
  discoverManifestEntry,
  discoverManifestSync,
  getPackageName,
} from './manifest/manifest-loader.js';
import { SmrtObject } from './object';
import type { SmartObjectManifest } from './scanner/types.js';
import type { ColumnDefinition } from './schema/types.js';
import { classnameToTablename, tableNameFromClass } from './utils';
import { LRUCache } from './utils/lru-cache';

/**
 * Get inheritance config synchronously
 * Uses the config package's sync accessor which returns already-loaded config
 */
function getInheritanceConfig() {
  const config = getModuleConfig<SmrtGlobalConfig>('smrt', {});
  return {
    cacheSize: config.inheritance?.cacheSize ?? 200,
    onMissingAncestor:
      config.inheritance?.onMissingAncestor ?? ('warn' as 'warn' | 'error'),
  };
}

/**
 * Configuration options for SMRT objects registered in the system
 *
 * Controls how objects are exposed through generated APIs, CLIs, and MCP servers.
 * Each section configures a different aspect of code generation and runtime behavior.
 *
 * @interface SmartObjectConfig
 */
export interface SmartObjectConfig {
  /**
   * Custom name for the object (defaults to class name)
   */
  name?: string;

  /**
   * Custom table name for database storage (defaults to pluralized snake_case class name)
   * Explicitly setting this ensures the table name survives code minification
   */
  tableName?: string;

  /**
   * Table inheritance strategy (defaults to 'cti')
   * - 'cti': Class Table Inheritance - one table per class (current default)
   * - 'sti': Single Table Inheritance - shared table with discriminator column
   *
   * Set once on base class, children inherit automatically.
   *
   * @example
   * ```typescript
   * @smrt({ tableStrategy: 'sti' })
   * class Event extends SmrtObject {
   *   title: string = '';
   * }
   *
   * // Meeting inherits 'sti' strategy
   * @smrt()
   * class Meeting extends Event {
   *   roomId = foreignKey(Room);
   * }
   * ```
   */
  tableStrategy?: 'cti' | 'sti';

  /**
   * API configuration
   */
  api?:
    | boolean
    | {
        /**
         * Exclude specific endpoints (supports both standard CRUD actions and custom methods)
         */
        exclude?: string[];

        /**
         * Include only specific endpoints (supports both standard CRUD actions and custom methods)
         */
        include?: string[];

        /**
         * Custom middleware for this object's endpoints
         */
        middleware?: any[];

        /**
         * Custom endpoint handlers (supports both standard CRUD actions and custom methods)
         */
        customize?: Record<string, (req: any, collection: any) => Promise<any>>;
      };

  /**
   * MCP server configuration
   */
  mcp?:
    | boolean
    | {
        /**
         * Include specific tools (supports both standard CRUD actions and custom methods)
         */
        include?: string[];

        /**
         * Exclude specific tools (supports both standard CRUD actions and custom methods)
         */
        exclude?: string[];
      };

  /**
   * CLI configuration
   */
  cli?:
    | boolean
    | {
        /**
         * Include specific commands (supports both standard CRUD actions and custom methods)
         */
        include?: string[];

        /**
         * Exclude specific commands (supports both standard CRUD actions and custom methods)
         */
        exclude?: string[];
      };

  /**
   * AI callable configuration
   */
  ai?: {
    /**
     * Methods that AI can call
     * - Array of method names, e.g., ['analyze', 'validate']
     * - 'public-async' to auto-include all public async methods
     * - 'all' to include all methods (not recommended)
     */
    callable?: string[] | 'public-async' | 'all';

    /**
     * Methods to exclude from AI calling (higher priority than callable)
     */
    exclude?: string[];

    /**
     * Additional tool descriptions to override method JSDoc
     */
    descriptions?: Record<string, string>;
  };

  /**
   * Lifecycle hooks
   */
  hooks?: {
    beforeSave?: string | ((instance: any) => Promise<void>);
    afterSave?: string | ((instance: any) => Promise<void>);
    beforeCreate?: string | ((instance: any) => Promise<void>);
    afterCreate?: string | ((instance: any) => Promise<void>);
    beforeUpdate?: string | ((instance: any) => Promise<void>);
    afterUpdate?: string | ((instance: any) => Promise<void>);
    beforeDelete?: string | ((instance: any) => Promise<void>);
    afterDelete?: string | ((instance: any) => Promise<void>);
  };

  /**
   * Synchronous manifest for build-time imports (Issue #270 Phase 1)
   * Allows passing manifest directly instead of async loading
   * @internal Advanced usage - typically set by build tools
   */
  _manifest?: SmartObjectManifest;
}

/**
 * Schema definition for a registered class
 */
interface SchemaDefinition {
  /** SQL DDL statement for table creation */
  ddl: string;
  /** Index creation statements */
  indexes: string[];
  /** Trigger definitions for automatic timestamp management */
  triggers: Array<{
    name: string;
    when: 'BEFORE' | 'AFTER';
    event: 'INSERT' | 'UPDATE' | 'DELETE';
    tableName: string;
    condition?: string;
    body: string;
    description?: string;
  }>;
  /** Table name derived from class name */
  tableName: string;
  /**
   * Column definitions with full metadata (for STI: includes all descendant fields)
   * Used by database adapters to validate fields without re-generating schema
   */
  columns?: Record<string, ColumnDefinition>;
}

/**
 * Validation function that takes an object instance and returns
 * a ValidationError if validation fails, or null if validation passes
 */
type ValidatorFunction = (
  instance: any,
) => Promise<import('./errors').ValidationError | null>;

/**
 * Relationship type for the relationship map
 */
export type RelationshipType = 'foreignKey' | 'oneToMany' | 'manyToMany';

/**
 * Metadata about a relationship between classes
 */
export interface RelationshipMetadata {
  /** Source class name */
  sourceClass: string;
  /** Field name on the source class */
  fieldName: string;
  /** Target/related class name */
  targetClass: string;
  /** Type of relationship */
  type: RelationshipType;
  /** Options for the relationship (onDelete, etc.) */
  options: any;
}

/**
 * Internal representation of a registered SMRT class
 *
 * @interface RegisteredClass
 * @private
 */
interface RegisteredClass {
  name: string;
  constructor: typeof SmrtObject;
  collectionConstructor?: new (options: any) => SmrtCollection<any>;
  config: SmartObjectConfig;
  fields: Map<string, any>;
  /** Method definitions from manifest (for custom CLI/API/MCP generation) */
  methods: Map<string, any>;
  /** Cached schema definition generated during registration */
  schema?: SchemaDefinition;
  /** Compiled validation functions for efficient runtime validation */
  validators?: ValidatorFunction[];
  /** AI-callable tools generated from methods at build time */
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, any>;
    };
  }>;
  /** Package name from manifest (for external package classes) */
  packageName?: string;
  /** Parent class name (for inheritance chain tracking) */
  extends?: string;
  /** Full inheritance chain from base to this class (cached for performance) */
  inheritanceChain?: string[];
  /** Merged fields from entire inheritance chain (cached, includes parent fields) */
  inheritedFields?: Map<string, any>;
  /** Merged methods from entire inheritance chain (cached, includes parent methods) */
  inheritedMethods?: Map<string, any>;
  /** Decorator config passed to @smrt() (includes tableStrategy) */
  decorator?: SmartObjectConfig;
}

/**
 * Central registry for all SMRT objects
 */
export class ObjectRegistry {
  private static classes = new Map<string, RegisteredClass>();
  private static collections = new Map<string, typeof SmrtCollection>();
  private static collectionCache = new LRUCache<string, SmrtCollection<any>>(
    100,
  );
  /**
   * WeakMap to assign unique IDs to database instances for cache keys
   * Prevents cache key collisions when different db instances are used
   */
  private static dbInstanceIds = new WeakMap<object, number>();
  private static nextDbId = 1;
  /**
   * Global cache for inheritance chains (shared across all instances)
   * Maps className → full inheritance chain (base to child)
   * Performance optimization: ~100x faster than re-walking prototype chain
   * Cache size is configurable via smrt.inheritance.cacheSize (default: 200)
   */
  private static inheritanceChainCache: LRUCache<string, string[]>;

  /**
   * Storage for field decorator metadata (decorator pattern)
   * Maps className → Map<propertyKey, FieldOptions>
   * Used by @field(), @foreignKey(), @oneToMany(), @manyToMany() decorators
   */
  private static fieldDecorators = new Map<string, Map<string, any>>();

  /**
   * Initialize the inheritance chain cache with size from config
   */
  private static getInheritanceCache(): LRUCache<string, string[]> {
    if (!ObjectRegistry.inheritanceChainCache) {
      const { cacheSize } = getInheritanceConfig();
      ObjectRegistry.inheritanceChainCache = new LRUCache<string, string[]>(
        cacheSize,
      );
    }
    return ObjectRegistry.inheritanceChainCache;
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
    const name = config.name || ctor.name;

    // Prevent duplicate registrations
    if (ObjectRegistry.classes.has(name)) {
      const existing = ObjectRegistry.classes.get(name);
      if (!existing) {
        throw new Error(
          `Registry inconsistency: ${name} exists in classes Map but get() returned undefined`,
        );
      }

      // Check if this is the exact same constructor (re-registration is OK)
      if (existing.constructor === ctor) {
        return; // Same class, skip silently
      }

      // Different constructors with same name - this is a collision!
      // This will cause silent bugs where the wrong fields are used
      throw new Error(
        `SMRT Class Name Collision: "${name}"\n\n` +
          `A class with this name is already registered, but with a different constructor.\n` +
          `This usually happens when:\n` +
          `  1. Multiple test files define classes with the same name\n` +
          `  2. Different packages export classes with the same name\n\n` +
          `The collision will cause the wrong field definitions to be used,\n` +
          `leading to properties not being initialized correctly.\n\n` +
          `To fix:\n` +
          `  - Use unique class names (e.g., ${name}_UniqueId)\n` +
          `  - Or use @smrt({ name: 'unique_name' }) to override the registration name`,
      );
    }

    // CRITICAL: Capture package name NOW, while stack trace still shows external package
    // This is called from the @smrt() decorator during import, so the stack trace
    // includes the external package file path. Later calls won't have this context.
    // Skip registry check to avoid circular dependency - class isn't registered yet!
    // This solves issue #159 where external package manifests couldn't be loaded.
    const packageNameFromStack = getPackageName(ctor, true) || undefined;

    // Get field definitions from manifest
    // Priority order (Issue #270 Phase 1 - synchronous manifest loading):
    // 1. Explicitly provided manifest (_manifest parameter)
    // 2. Test manifests (for test classes)
    // 3. Static manifests (for core framework classes)
    // 4. Cached external manifests (if already loaded)
    // For external packages not yet loaded, manifest discovery happens lazily during schema generation
    const manifestEntry =
      config._manifest?.objects?.[name.toLowerCase()] ??
      discoverManifestSync(name);
    const fields = new Map<string, any>();
    const methods = new Map<string, any>();
    let packageName: string | undefined;

    console.log(
      `[registry] Registering ${name}: manifestEntry =`,
      manifestEntry ? 'found' : 'not found',
    );
    if (manifestEntry?.fields) {
      console.log(
        `[registry] Manifest has ${Object.keys(manifestEntry.fields).length} fields:`,
        Object.keys(manifestEntry.fields),
      );
    }

    if (manifestEntry?.fields) {
      // Use manifest fields (from build-time AST scanning)
      // Store field definitions as plain objects with nested options
      for (const [fieldName, fieldDef] of Object.entries(
        manifestEntry.fields,
      ) as [string, import('./scanner/types.js').FieldDefinition][]) {
        // Build options object, only including defined values
        const options: any = { ...fieldDef._meta };
        if (fieldDef.required !== undefined)
          options.required = fieldDef.required;
        if (fieldDef.default !== undefined) options.default = fieldDef.default;
        if (fieldDef.description !== undefined)
          options.description = fieldDef.description;
        if (fieldDef.transient !== undefined)
          options.transient = fieldDef.transient;

        // Store field definition as plain object maintaining Field-like structure
        const field: any = {
          type: fieldDef.type,
        };

        // Only include options if not empty
        if (Object.keys(options).length > 0) {
          field._meta = options;
        }

        // Preserve top-level flags from manifest
        if (fieldDef.transient !== undefined) {
          field.transient = fieldDef.transient;
        }
        if (fieldDef.required !== undefined) {
          field.required = fieldDef.required;
        }

        fields.set(fieldName, field);
      }

      console.log(
        `[registry] ✅ Loaded ${fields.size} fields for ${name} from manifest`,
      );

      // Use packageName from manifest if available, otherwise from stack trace
      // Priority: explicit manifest > manifestEntry > stack trace
      packageName =
        config._manifest?.packageName ||
        manifestEntry.packageName ||
        packageNameFromStack;
    } else {
      // No manifest found yet - use package name from stack trace
      // This will be used later by ensureManifestLoaded() to load the external manifest
      console.log(
        `[registry] ⚠️  No manifest entry for ${name} - fields will be loaded later`,
      );
      packageName = packageNameFromStack;
    }

    // Apply decorator metadata to override/extend manifest fields
    // Decorators take priority over AST-scanned types (Issue #316)
    const decorators = ObjectRegistry.fieldDecorators.get(name);
    if (decorators && decorators.size > 0) {
      console.log(
        `[registry] Applying ${decorators.size} field decorators for ${name}`,
      );

      for (const [fieldName, decoratorOptions] of decorators) {
        const existingField = fields.get(fieldName);

        if (existingField) {
          // Merge decorator options with manifest field
          // Decorator type takes priority over AST-scanned type
          const mergedField: any = {
            type: decoratorOptions.type || existingField.type,
            _meta: {
              ...existingField._meta,
              ...decoratorOptions,
            },
          };

          // Remove 'type' from _meta if it was moved to top level
          if (mergedField._meta.type) {
            delete mergedField._meta.type;
          }

          // Preserve top-level flags (transient, required, etc.)
          if (decoratorOptions.transient !== undefined) {
            mergedField.transient = decoratorOptions.transient;
          } else if (existingField.transient !== undefined) {
            mergedField.transient = existingField.transient;
          }

          // Handle required flag: nullable fields should not be required
          if (decoratorOptions.nullable === true) {
            // Nullable explicitly set to true means field is NOT required
            mergedField.required = false;
            mergedField._meta.required = false;
          } else if (decoratorOptions.required !== undefined) {
            mergedField.required = decoratorOptions.required;
          } else if (existingField.required !== undefined) {
            mergedField.required = existingField.required;
          }

          fields.set(fieldName, mergedField);
          console.log(
            `[registry]   ✅ Merged decorator for ${fieldName}: type=${mergedField.type}`,
          );
        } else {
          // Decorator for field not in manifest - add it
          const newField: any = {
            type: decoratorOptions.type || 'text',
            _meta: decoratorOptions,
          };

          // Set top-level flags from decorator options
          if (decoratorOptions.transient !== undefined) {
            newField.transient = decoratorOptions.transient;
          }
          // Handle required flag: nullable fields should not be required
          if (decoratorOptions.nullable === true) {
            newField.required = false;
            newField._meta.required = false;
          } else if (decoratorOptions.required !== undefined) {
            newField.required = decoratorOptions.required;
          }

          fields.set(fieldName, newField);
          console.log(
            `[registry]   ✅ Added field ${fieldName} from decorator: type=${decoratorOptions.type || 'text'}`,
          );
        }
      }
    }

    if (manifestEntry?.methods) {
      // Load method definitions from manifest (for custom CLI/API/MCP generation)
      for (const [methodName, methodDef] of Object.entries(
        manifestEntry.methods,
      )) {
        methods.set(methodName, methodDef);
      }
    }

    // Note: If manifest not found here, it will be loaded asynchronously when needed
    // via ensureManifestLoaded(). This allows decorators to remain synchronous while
    // supporting dynamic external package manifest loading.

    // Build inheritance chain from constructor (needed for STI table name resolution)
    const inheritanceChain = ObjectRegistry.buildInheritanceChain(ctor);

    // Validate table strategy compatibility with parent (STI requirement)
    if (inheritanceChain.length > 1) {
      // This class has a parent - validate strategy compatibility
      const parentName = inheritanceChain[inheritanceChain.length - 2]; // Second-to-last is parent
      const parentEntry = ObjectRegistry.classes.get(parentName);

      if (parentEntry) {
        const parentStrategy =
          parentEntry.decorator?.tableStrategy || 'default';
        const childStrategy = config.tableStrategy; // Don't default - undefined means inherit

        // Only validate if child has an EXPLICIT strategy that differs from parent
        // undefined childStrategy means it will inherit from parent
        if (childStrategy !== undefined && parentStrategy !== childStrategy) {
          throw ConfigurationError.incompatibleStrategy(
            name,
            childStrategy,
            parentName,
            parentStrategy,
          );
        }
      }
    }

    // Defer schema generation until needed (generateSchema now uses dynamic import)
    // Store table name for lazy schema generation
    // Note: For STI classes, tableName is already set correctly by the decorator
    const tableName = config.tableName || tableNameFromClass(ctor);

    // Load pre-generated schema from manifest if available, otherwise placeholder
    let schema: SchemaDefinition;
    if (manifestEntry?.schema) {
      // Pre-generated schema from manifest (build-time)
      schema = {
        ddl: manifestEntry.schema.ddl,
        indexes:
          manifestEntry.schema.indexes?.map((idx: any) =>
            typeof idx === 'string'
              ? idx
              : `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${idx.name} ON "${tableName}" (${idx.columns.map((c: string) => `"${c}"`).join(', ')})`,
          ) || [],
        triggers: [],
        tableName: manifestEntry.schema.tableName || tableName,
        // Cast manifest columns to ColumnDefinition (same shape, TypeScript just needs help)
        columns: manifestEntry.schema.columns as Record<
          string,
          ColumnDefinition
        >,
      };
      console.log(
        `[registry] Loaded pre-generated schema for ${name} (${Object.keys(manifestEntry.schema.columns || {}).length} columns)`,
      );
    } else {
      // Placeholder schema - will be generated lazily when first needed
      schema = {
        ddl: '', // Generated lazily
        indexes: [], // Parsed from DDL lazily
        triggers: [], // No longer using database triggers - timestamps managed by application
        tableName,
      };
    }

    // Compile validation functions from field definitions
    const validators = ObjectRegistry.compileValidators(name, fields);

    ObjectRegistry.classes.set(name, {
      name,
      constructor: ctor,
      config,
      fields,
      methods,
      schema,
      validators,
      packageName, // Store package name from manifest for getPackageName() lookup
      extends: manifestEntry?.extends, // NEW: Capture parent class name from manifest
      inheritanceChain, // NEW: Pre-compute and cache inheritance chain
      decorator: config, // Store decorator config (includes tableStrategy)
    });

    console.log(
      `🎯 Registered smrt object: ${name} with schema for ${tableName} and ${validators.length} validators`,
    );
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
    const registered = ObjectRegistry.classes.get(objectName);
    if (registered) {
      registered.collectionConstructor = collectionConstructor;
    }

    ObjectRegistry.collections.set(objectName, collectionConstructor as any);
  }

  /**
   * Register an object from manifest metadata (for CLI/tools without importing actual classes)
   *
   * This method allows tools like the CLI to register objects from build-time manifest data
   * without needing to import the actual class. This solves the bootstrap problem where
   * `npx smrt` can't access user project classes but needs to generate commands for them.
   *
   * @param name - Name of the object class
   * @param objectDef - Object definition from manifest
   * @param packageName - Package name from manifest
   * @example
   * ```typescript
   * const manifest = loadLocalTestManifestSync();
   * for (const [name, objectDef] of Object.entries(manifest.objects)) {
   *   ObjectRegistry.registerFromManifest(name, objectDef, manifest.packageName);
   * }
   * ```
   */
  static registerFromManifest(
    name: string,
    objectDef: any,
    packageName?: string,
  ): void {
    // Prevent duplicate registrations
    if (ObjectRegistry.classes.has(name)) {
      return;
    }

    // Create stub constructor - not needed for CLI command generation
    // The CLI only needs metadata (fields, methods, config)
    const stubConstructor = class extends SmrtObject {} as typeof SmrtObject;
    Object.defineProperty(stubConstructor, 'name', { value: name });

    // Convert manifest field definitions to Field objects
    const fields = new Map<string, any>();
    if (objectDef.fields) {
      for (const [fieldName, fieldDef] of Object.entries(
        objectDef.fields as any,
      )) {
        const fd = fieldDef as any;
        fields.set(fieldName, {
          type: fd.type,
          _meta: {
            required: fd.required,
            default: fd.default,
            description: fd.description,
            ...fd._meta,
          },
        });
      }
    }

    // Load method definitions
    const methods = new Map<string, any>();
    if (objectDef.methods) {
      for (const [methodName, methodDef] of Object.entries(objectDef.methods)) {
        methods.set(methodName, methodDef);
      }
    }

    // Get config from manifest
    const config = objectDef.decoratorConfig || {};
    const tableName = config.tableName || tableNameFromClass(stubConstructor);

    // Load pre-generated schema from manifest if available
    // This enables efficient external package consumption without runtime schema generation
    let schema: SchemaDefinition;
    if (objectDef.schema) {
      // Pre-generated schema from manifest (build-time)
      schema = {
        ddl: objectDef.schema.ddl,
        indexes:
          objectDef.schema.indexes?.map((idx: any) =>
            typeof idx === 'string'
              ? idx
              : `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${idx.name} ON "${tableName}" (${idx.columns.map((c: string) => `"${c}"`).join(', ')})`,
          ) || [],
        triggers: [],
        tableName: objectDef.schema.tableName,
        columns: objectDef.schema.columns,
      };
      console.log(
        `[registry] Loaded pre-generated schema for ${name} (${Object.keys(objectDef.schema.columns || {}).length} columns)`,
      );
    } else {
      // Placeholder schema - will be generated at runtime if needed
      schema = {
        ddl: '',
        indexes: [],
        triggers: [],
        tableName,
      };
    }

    // Compile validators
    const validators = ObjectRegistry.compileValidators(name, fields);

    // Register in ObjectRegistry (metadata only, no collection constructor)
    // Manifest registration is for command discovery and help text.
    // Runtime execution requires real classes loaded from entry point.
    ObjectRegistry.classes.set(name, {
      name,
      constructor: stubConstructor,
      config,
      fields,
      methods,
      schema,
      validators,
      packageName,
      extends: objectDef.extends, // Parent class name for inheritance chain
      decorator: config, // Decorator config (includes tableStrategy for STI)
    });

    console.log(
      `📦 Registered ${name} from manifest (${fields.size} fields, ${methods.size} methods)`,
    );
  }

  /**
   * Helper method for case-insensitive class lookup
   * Tries exact match first, then falls back to case-insensitive search
   *
   * @param name - Name of the class to find
   * @returns Registered class information or undefined if not found
   * @private
   */
  private static findClass(name: string): RegisteredClass | undefined {
    // Try exact match first (fast path)
    const registered = ObjectRegistry.classes.get(name);
    if (registered) {
      return registered;
    }

    // Fall back to case-insensitive search
    const lowerName = name.toLowerCase();
    for (const [key, value] of ObjectRegistry.classes.entries()) {
      if (key.toLowerCase() === lowerName) {
        return value;
      }
    }

    return undefined;
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
    return ObjectRegistry.findClass(name);
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
    return new Map(ObjectRegistry.classes);
  }

  /**
   * Get class names
   */
  static getClassNames(): string[] {
    return Array.from(ObjectRegistry.classes.keys());
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
    // Dynamically discover all SMRT packages in node_modules
    const { discoverSmrtPackages } = await import(
      './manifest/discover-smrt-packages.js'
    );
    const { loadExternalManifest } = await import(
      './manifest/manifest-loader.js'
    );

    const smrtPackages = discoverSmrtPackages();

    console.log(
      `[ObjectRegistry] Attempting to auto-load ${className} from ${smrtPackages.length} external packages...`,
    );

    // Try each package
    for (const packageName of smrtPackages) {
      const manifest = await loadExternalManifest(packageName);

      if (!manifest || !manifest.objects) {
        continue;
      }

      // Look for the class in this manifest (case-insensitive)
      const lowerClassName = className.toLowerCase();
      const objectDef =
        manifest.objects[lowerClassName] || manifest.objects[className];

      if (!objectDef) {
        continue;
      }

      console.log(
        `[ObjectRegistry] ✅ Found ${className} in ${packageName} manifest`,
      );

      // Register the class from manifest
      ObjectRegistry.registerFromManifest(
        objectDef.className || className,
        objectDef,
        manifest.packageName,
      );

      // If this is an STI class, also register the parent class
      if (objectDef.extends) {
        const parentDef =
          manifest.objects[objectDef.extends.toLowerCase()] ||
          manifest.objects[objectDef.extends];

        if (parentDef && !ObjectRegistry.hasClass(objectDef.extends)) {
          console.log(
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
        console.log(
          `[ObjectRegistry] Merging inherited fields for ${className}...`,
        );
        await ObjectRegistry.getAllFields(className);
        const registered = ObjectRegistry.findClass(className);
        if (registered?.inheritedFields) {
          console.log(
            `[ObjectRegistry] ✅ ${className} now has ${registered.inheritedFields.size} total fields (including inherited)`,
          );
        }
      }

      return true;
    }

    console.log(
      `[ObjectRegistry] ❌ Could not find ${className} in any SMRT package`,
    );
    return false;
  }

  /**
   * Check if a class is registered (case-insensitive)
   */
  static hasClass(name: string): boolean {
    return ObjectRegistry.findClass(name) !== undefined;
  }

  /**
   * Clear all registered classes (mainly for testing)
   */
  static clear(): void {
    ObjectRegistry.classes.clear();
    ObjectRegistry.collections.clear();
    ObjectRegistry.collectionCache.clear();
    ObjectRegistry.getInheritanceCache().clear();
    ObjectRegistry.fieldDecorators.clear();
    // Note: dbInstanceIds WeakMap will be garbage collected automatically
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
    const registered = ObjectRegistry.classes.get(className);
    if (registered) {
      registered.inheritedFields = undefined;
      registered.inheritedMethods = undefined;
    }

    // Also invalidate all descendants (they depend on this class's fields)
    for (const [childName, childClass] of ObjectRegistry.classes) {
      if (childClass.extends === className) {
        ObjectRegistry.invalidateInheritanceCache(childName);
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

    for (const registered of ObjectRegistry.classes.values()) {
      registered.inheritedFields = undefined;
      registered.inheritedMethods = undefined;
    }
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

    const cacheKey = `${className}:${JSON.stringify({
      persistence: options.persistence,
      db: dbId !== undefined ? `db:${dbId}` : undefined,
      ai: options.ai ? 'present' : undefined,
    })}`;

    // Return cached instance if available
    if (ObjectRegistry.collectionCache.has(cacheKey)) {
      return ObjectRegistry.collectionCache.get(cacheKey) as SmrtCollection<T>;
    }

    // Get registered class info (case-insensitive)
    let registered = ObjectRegistry.findClass(className);
    if (!registered) {
      // Try to auto-load from external SMRT packages before throwing error
      // This handles cases where classes from @happyvertical/smrt-* packages
      // are used without explicitly importing them (e.g., Person from smrt-profiles)
      const loaded = await ObjectRegistry.tryLoadFromExternalPackage(className);

      if (loaded) {
        // Successfully loaded and registered from external package
        registered = ObjectRegistry.findClass(className);
      }

      if (!registered) {
        throw new Error(
          `Class ${className} not found in ObjectRegistry. Make sure to register it with @smrt() decorator or ObjectRegistry.register()`,
        );
      }
    }

    // Auto-create default collection if not registered
    let collectionConstructor = registered.collectionConstructor;

    if (!collectionConstructor) {
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
      ObjectRegistry.collections.set(className, DefaultCollection as any);
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
   * Compile validation functions from field definitions
   *
   * Extracts validation rules from field options and compiles them into
   * efficient validation functions that can be executed at runtime.
   *
   * @param className - Name of the class being validated
   * @param fields - Map of field definitions
   * @returns Array of compiled validation functions
   * @private
   */
  private static compileValidators(
    className: string,
    fields: Map<string, any>,
  ): ValidatorFunction[] {
    const validators: ValidatorFunction[] = [];

    for (const [fieldName, field] of fields) {
      const options = field._meta || {};

      // Skip transient fields (they're not persisted, so no validation needed)
      if (options.transient || field.transient) {
        continue;
      }

      // Required field validator
      if (options.required) {
        validators.push(async (instance: any) => {
          const value = instance[fieldName];
          if (value === null || value === undefined || value === '') {
            const ValidationError = await import('./errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.requiredField(fieldName, className);
          }
          return null;
        });
      }

      // Numeric range validators
      if (
        field.type === 'integer' ||
        field.type === 'decimal' ||
        field.type === 'number'
      ) {
        if (options.min !== undefined) {
          validators.push(async (instance: any) => {
            const value = instance[fieldName];
            if (value !== null && value !== undefined && value < options.min) {
              const ValidationError = await import('./errors').then(
                (m) => m.ValidationError,
              );
              return ValidationError.rangeError(
                fieldName,
                value,
                options.min,
                options.max,
              );
            }
            return null;
          });
        }

        if (options.max !== undefined) {
          validators.push(async (instance: any) => {
            const value = instance[fieldName];
            if (value !== null && value !== undefined && value > options.max) {
              const ValidationError = await import('./errors').then(
                (m) => m.ValidationError,
              );
              return ValidationError.rangeError(
                fieldName,
                value,
                options.min,
                options.max,
              );
            }
            return null;
          });
        }
      }

      // String length validators
      if (field.type === 'text') {
        if (options.minLength !== undefined) {
          validators.push(async (instance: any) => {
            const value = instance[fieldName];
            if (
              value &&
              typeof value === 'string' &&
              value.length < options.minLength
            ) {
              const ValidationError = await import('./errors').then(
                (m) => m.ValidationError,
              );
              return ValidationError.invalidValue(
                fieldName,
                value,
                `string with minimum length ${options.minLength}`,
              );
            }
            return null;
          });
        }

        if (options.maxLength !== undefined) {
          validators.push(async (instance: any) => {
            const value = instance[fieldName];
            if (
              value &&
              typeof value === 'string' &&
              value.length > options.maxLength
            ) {
              const ValidationError = await import('./errors').then(
                (m) => m.ValidationError,
              );
              return ValidationError.invalidValue(
                fieldName,
                value,
                `string with maximum length ${options.maxLength}`,
              );
            }
            return null;
          });
        }

        // Pattern validator (regex)
        if (options.pattern) {
          const regex = new RegExp(options.pattern);
          validators.push(async (instance: any) => {
            const value = instance[fieldName];
            if (value && typeof value === 'string' && !regex.test(value)) {
              const ValidationError = await import('./errors').then(
                (m) => m.ValidationError,
              );
              return ValidationError.invalidValue(
                fieldName,
                value,
                `string matching pattern ${options.pattern}`,
              );
            }
            return null;
          });
        }
      }

      // Custom validator function
      if (options.validate && typeof options.validate === 'function') {
        validators.push(async (instance: any) => {
          const value = instance[fieldName];
          try {
            const isValid = await options.validate(value);
            if (!isValid) {
              const ValidationError = await import('./errors').then(
                (m) => m.ValidationError,
              );
              const message =
                options.customMessage ||
                `Field ${fieldName} failed custom validation`;
              return ValidationError.invalidValue(fieldName, value, message);
            }
          } catch (error) {
            const ValidationError = await import('./errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.invalidValue(
              fieldName,
              value,
              `custom validation error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return null;
        });
      }
    }

    return validators;
  }

  /**
   * Get field definitions for a registered class
   */
  static getFields(name: string): Map<string, any> {
    const registered = ObjectRegistry.classes.get(name);
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
    const registered = ObjectRegistry.classes.get(name);
    return registered ? registered.methods : new Map();
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
    const registered = ObjectRegistry.classes.get(className);
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
    const manifestEntry = await discoverManifestEntry(
      registered.constructor,
      className,
    );

    if (!manifestEntry) {
      return;
    }

    if (manifestEntry?.fields) {
      const manifestFieldCount = Object.keys(manifestEntry.fields).length;
      const existingFieldCount = registered.fields.size;

      if (existingFieldCount > 0 && existingFieldCount >= manifestFieldCount) {
        return;
      }

      // Convert FieldDefinition to Field objects and merge with existing
      for (const [fieldName, fieldDef] of Object.entries(
        manifestEntry.fields,
      )) {
        // Only add if not already present (don't overwrite AST-scanned fields)
        if (!registered.fields.has(fieldName)) {
          registered.fields.set(fieldName, {
            type: fieldDef.type,
            _meta: {
              required: fieldDef.required,
              default: fieldDef.default,
              description: fieldDef.description,
              ...fieldDef._meta, // Includes unique, primaryKey, index, etc.
            },
          });
        }
      }

      // Load method definitions from manifest
      if (manifestEntry.methods) {
        for (const [methodName, methodDef] of Object.entries(
          manifestEntry.methods,
        )) {
          registered.methods.set(methodName, methodDef);
        }
      }

      // Extract and store package name from manifest entry (for getPackageName() lookup)
      if (manifestEntry.packageName) {
        registered.packageName = manifestEntry.packageName;
      }

      // Store extends info for getAllFields() to use (if present)
      if (manifestEntry.extends) {
        registered.extends = manifestEntry.extends;
      }

      console.log(
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
    const registered = ObjectRegistry.classes.get(name);
    return registered ? registered.config : {};
  }

  /**
   * Get cached schema definition for a registered class
   *
   * @param name - Name of the registered class
   * @returns Schema definition or undefined if not found
   * @example
   * ```typescript
   * const schema = ObjectRegistry.getSchema('Product');
   * console.log(schema.tableName); // 'products'
   * console.log(schema.ddl);       // 'CREATE TABLE...'
   * ```
   */
  static getSchema(name: string): SchemaDefinition | undefined {
    const registered = ObjectRegistry.classes.get(name);
    return registered?.schema;
  }

  /**
   * Get SQL DDL statement for a registered class
   *
   * @param name - Name of the registered class
   * @returns SQL DDL statement or undefined if not found
   * @example
   * ```typescript
   * const ddl = ObjectRegistry.getSchemaDDL('Product');
   * await db.query(ddl);
   * ```
   */
  static getSchemaDDL(name: string): string | undefined {
    return ObjectRegistry.getSchema(name)?.ddl;
  }

  /**
   * Get table name for a registered class
   *
   * @param name - Name of the registered class
   * @returns Table name or undefined if not found
   * @example
   * ```typescript
   * const tableName = ObjectRegistry.getTableName('Product');
   * console.log(tableName); // 'products'
   * ```
   */
  static getTableName(name: string): string | undefined {
    return ObjectRegistry.getSchema(name)?.tableName;
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
    const registered = ObjectRegistry.classes.get(name);
    return registered?.validators;
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
    const graph = new Map<string, string[]>();

    // Initialize graph with all registered classes
    for (const [className] of ObjectRegistry.classes) {
      graph.set(className, []);
    }

    // Scan all fields for foreignKey relationships
    for (const [className, registered] of ObjectRegistry.classes) {
      const dependencies: string[] = [];

      for (const [_fieldName, field] of registered.fields) {
        if (field.type === 'foreignKey' && field.related) {
          const relatedClass = field.related;
          // Only add if the related class is registered
          if (ObjectRegistry.classes.has(relatedClass)) {
            dependencies.push(relatedClass);
          }
        }
      }

      graph.set(className, dependencies);
    }

    return graph;
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
    const relationshipMap = new Map<string, RelationshipMetadata[]>();

    // Initialize map with all registered classes
    for (const [className] of ObjectRegistry.classes) {
      relationshipMap.set(className, []);
    }

    // Scan all fields for relationship types
    for (const [className, registered] of ObjectRegistry.classes) {
      const relationships: RelationshipMetadata[] = [];

      for (const [fieldName, field] of registered.fields) {
        // Check for foreignKey relationships
        if (field.type === 'foreignKey' && field.related) {
          relationships.push({
            sourceClass: className,
            fieldName,
            targetClass: field.related,
            type: 'foreignKey',
            options: field._meta,
          });
        }

        // Check for oneToMany relationships
        if (field.type === 'oneToMany' && field.related) {
          relationships.push({
            sourceClass: className,
            fieldName,
            targetClass: field.related,
            type: 'oneToMany',
            options: field._meta,
          });
        }

        // Check for manyToMany relationships
        if (field.type === 'manyToMany' && field.related) {
          relationships.push({
            sourceClass: className,
            fieldName,
            targetClass: field.related,
            type: 'manyToMany',
            options: field._meta,
          });
        }
      }

      relationshipMap.set(className, relationships);
    }

    return relationshipMap;
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
   * Build inheritance chain by walking prototype chain
   *
   * Walks from child → parent → ... → SmrtObject, building array from base to child.
   * Stops at SmrtObject (the framework base class).
   *
   * @param ctor - Class constructor to build chain for
   * @returns Array of class names from base to child (e.g., ['SmrtObject', 'Content', 'PraecoContent'])
   * @private
   */
  private static buildInheritanceChain(ctor: typeof SmrtObject): string[] {
    const chain: string[] = [];
    const visited = new Set<string>();
    let current: any = ctor;

    // Walk up the prototype chain
    while (current?.name) {
      // Stop at SmrtObject (don't include it in chain unless it's the class itself)
      if (current.name === 'SmrtObject') {
        break;
      }

      // Circular inheritance detection
      if (visited.has(current.name)) {
        throw ConfigurationError.circularInheritance(
          current.name,
          Array.from(chain),
        );
      }

      visited.add(current.name);
      chain.unshift(current.name); // Add to front (we're walking child → base)

      current = Object.getPrototypeOf(current);
    }

    return chain;
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

    // Build chain from constructor
    const chain = ObjectRegistry.buildInheritanceChain(registered.constructor);

    // Cache in both places
    registered.inheritanceChain = chain;
    cache.set(className, chain);

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
    const registered = ObjectRegistry.findClass(className);
    if (!registered) {
      return new Map();
    }

    // Ensure manifest is loaded (handles external packages)
    await ObjectRegistry.ensureManifestLoaded(className);

    // Check if class has inheritedFields cache (set during manifest loading)
    if (registered.inheritedFields) {
      return new Map(registered.inheritedFields);
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

    return allFields;
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
      console.warn(
        `Field type mismatch: "${fieldName}" is ${parentField.type} in parent but ${childField.type} in child. Using child type.`,
      );
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

    for (const [className] of ObjectRegistry.classes) {
      const metadata = ObjectRegistry.getObjectMetadata(className);
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

    // Explicit config wins (check decorator first)
    if (registered.decorator?.tableStrategy) {
      return registered.decorator.tableStrategy;
    }

    // Inherit from ancestors
    const chain = ObjectRegistry.getInheritanceChain(className);
    for (const ancestorName of chain) {
      const ancestor = ObjectRegistry.findClass(ancestorName);
      if (ancestor?.decorator?.tableStrategy) {
        return ancestor.decorator.tableStrategy;
      }
    }

    return 'cti'; // Default strategy
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

    // Find the first class in the chain with tableStrategy: 'sti'
    const registered = ObjectRegistry.findClass(className);
    if (!registered) {
      return null;
    }

    // Check if this class itself defines STI
    if (registered.decorator?.tableStrategy === 'sti') {
      return className;
    }

    // Walk up the chain to find the base
    const chain = ObjectRegistry.getInheritanceChain(className);
    for (const ancestorName of chain) {
      const ancestor = ObjectRegistry.findClass(ancestorName);
      if (ancestor?.decorator?.tableStrategy === 'sti') {
        return ancestorName;
      }
    }

    return null;
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
    for (const [childName, childClass] of ObjectRegistry.classes) {
      const chain = ObjectRegistry.getInheritanceChain(childName);
      if (chain.includes(className) && childName !== className) {
        descendants.push(childName);
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
}

/**
 * @smrt decorator for registering classes with the global registry
 *
 * Captures the original class name before minification and stores it as
 * a static property, ensuring table names remain consistent in production builds.
 *
 * Supports both SmrtObject and SmrtCollection subclasses.
 *
 * @example
 * ```typescript
 * @smrt()
 * class Product extends SmrtObject {
 *   name = text({ required: true });
 *   price = decimal({ min: 0 });
 * }
 *
 * @smrt({ tableName: 'custom_products' })
 * class ProductCollection extends SmrtCollection<Product> {
 *   static readonly _itemClass = Product;
 * }
 *
 * @smrt({ api: { exclude: ['delete'] } })
 * class SensitiveData extends SmrtObject {
 *   secret = text({ encrypted: true });
 * }
 * ```
 */
export function smrt(config: SmartObjectConfig = {}) {
  return <T extends new (...args: any[]) => any>(ctor: T): T => {
    // Check if this is a SmrtCollection class
    const isCollection = ctor.prototype instanceof SmrtCollection;

    if (isCollection) {
      // Handle SmrtCollection registration
      const itemClass = (ctor as any)._itemClass;
      if (itemClass) {
        // Register the item class (SmrtObject) with metadata
        const tableName =
          config.tableName || classnameToTablename(itemClass.name);

        // Only define SMRT_TABLE_NAME if it doesn't exist (avoid redefinition errors)
        if (!Object.hasOwn(itemClass, 'SMRT_TABLE_NAME')) {
          Object.defineProperty(itemClass, 'SMRT_TABLE_NAME', {
            value: tableName,
            writable: false,
            enumerable: false,
            configurable: false,
          });
        }

        ObjectRegistry.register(itemClass, { ...config, tableName });

        // Register the collection constructor using tableName (not class name)
        // This ensures CLI lookups by tableName (e.g., "meetings") find the collection
        ObjectRegistry.registerCollection(tableName, ctor as any);
      }
    } else {
      // Handle SmrtObject registration (existing behavior)
      let tableName = config.tableName;

      if (!tableName) {
        // For STI: Use base class's table name if this is a child
        if (config.tableStrategy === 'sti') {
          // This class is the STI base - use its own table name
          tableName = classnameToTablename(ctor.name);
        } else {
          // Check if any parent uses STI
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

      Object.defineProperty(ctor, 'SMRT_TABLE_NAME', {
        value: tableName,
        writable: false,
        enumerable: false,
        configurable: false,
      });

      ObjectRegistry.register(ctor as any, { ...config, tableName });
    }

    return ctor;
  };
}
