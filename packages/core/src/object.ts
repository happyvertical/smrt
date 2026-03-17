// import type { AIMessageOptions } from '@happyvertical/ai';

import type { AITool } from '@happyvertical/ai';
import type { SmrtClassOptions } from './class';
import { SmrtClass } from './class';
import { ContentHasher } from './embeddings/hash';
import { EmbeddingProvider } from './embeddings/provider';
import { EmbeddingStorage } from './embeddings/storage';
import type { GenerateEmbeddingsOptions } from './embeddings/types';
import {
  DatabaseError,
  ErrorUtils,
  RuntimeError,
  ValidationError,
} from './errors';
import { createInterceptorContext, GlobalInterceptors } from './interceptors';
import { ObjectRegistry } from './registry';
import { isTableVerified, markTableVerified } from './table-cache';
import {
  executeToolCall as executeToolCallInternal,
  type ToolCall,
  type ToolCallResult,
} from './tools/tool-executor';
import { fieldsFromClass, tableNameFromClass, toSnakeCase } from './utils';

/**
 * Validate that _meta_type matches the expected class (Issue #713)
 *
 * Accepts both simple class name (e.g., 'Product') and qualified name
 * (e.g., '@happyvertical/smrt-core:Product') for namespace isolation support.
 *
 * @param actualMetaType - The _meta_type value from the data
 * @param className - The class name to validate against
 * @returns true if the meta type is valid for this class
 */
function isValidMetaType(actualMetaType: unknown, className: string): boolean {
  if (typeof actualMetaType !== 'string') {
    return false;
  }

  // Accept simple class name match
  if (actualMetaType === className) {
    return true;
  }

  // Accept qualified name match (namespace isolation)
  const registeredClass = ObjectRegistry.getClass(className);
  if (
    registeredClass?.qualifiedName &&
    actualMetaType === registeredClass.qualifiedName
  ) {
    return true;
  }

  return false;
}

/**
 * Get the expected qualified or simple name for a class (for error messages)
 */
function getExpectedMetaType(className: string): string {
  const registeredClass = ObjectRegistry.getClass(className);
  return registeredClass?.qualifiedName || className;
}

/**
 * Options for SmrtObject initialization
 */
export interface SmrtObjectOptions extends SmrtClassOptions {
  /**
   * Unique identifier for the object
   */
  id?: string;

  /**
   * URL-friendly identifier
   */
  slug?: string;

  /**
   * Optional context to scope the slug (could be a path, domain, etc.)
   */
  context?: string;

  /**
   * Creation timestamp
   */
  created_at?: Date;

  /**
   * Last update timestamp
   */
  updated_at?: Date;

  /**
   * Flag to skip automatic field extraction (internal use)
   */
  _extractingFields?: boolean;

  /**
   * Flag to skip database loading (internal use)
   */
  _skipLoad?: boolean;

  /**
   * Allow arbitrary field values to be passed
   */
  [key: string]: any;
}

/**
 * Base class for all persistent SMRT domain objects.
 *
 * Provides a full ORM lifecycle: construct with options, call `initialize()`,
 * then use `save()` / `delete()` for persistence. Objects are identified by a
 * UUID `id` and an optional URL-friendly `slug` (auto-generated from `name`,
 * `title`, `label`, or `id` if not provided).
 *
 * Key capabilities:
 * - **Persistence**: `save()` (upsert with retry), `delete()` (with hooks)
 * - **Loading**: `loadFromId()`, `loadFromSlug()` (called automatically by `initialize()`)
 * - **AI operations**: `is()` (boolean criteria check), `do()` (freeform instruction)
 * - **Relationships**: `loadRelated()` (foreignKey), `loadRelatedMany()` (oneToMany)
 * - **Context memory**: `remember()` / `recall()` / `recallAll()` / `forget()` / `forgetScope()`
 * - **STI support**: `_meta_type` discriminator, `_meta_data` JSONB for child fields
 * - **Serialization**: `toJSON()` (framework-managed, handles STI), `transformJSON()` (override hook)
 *
 * @example
 * ```typescript
 * @smrt()
 * class Product extends SmrtObject {
 *   name: string = '';
 *   price: number = 0.0;
 * }
 *
 * const product = new Product({ db: myDb, name: 'Widget', price: 9.99 });
 * await product.initialize();
 * await product.save();
 * console.log(product.id); // auto-generated UUID
 * ```
 */
export class SmrtObject extends SmrtClass {
  /**
   * Database table name for this object
   */
  public _tableName!: string;

  /**
   * Cache for loaded relationships to avoid repeated database queries
   * Maps fieldName to loaded object(s)
   */
  private _loadedRelationships: Map<string, any> = new Map();

  /**
   * Override options with SmrtObjectOptions type for proper type narrowing.
   * Initialized by parent constructor via super() call.
   */
  public declare options: SmrtObjectOptions;

  /**
   * Unique identifier for the object
   */
  protected _id: string | null | undefined;

  /**
   * URL-friendly identifier
   */
  protected _slug: string | null | undefined;

  /**
   * Optional context to scope the slug
   */
  protected _context: string | null | undefined;

  /**
   * Creation timestamp
   */
  public created_at: Date | null | undefined = null;

  /**
   * Last update timestamp
   */
  public updated_at: Date | null | undefined = null;

  /**
   * Creates a new SmrtObject instance
   *
   * @param options - Configuration options including identifiers and metadata
   * @throws Error if options is null
   */
  constructor(options: SmrtObjectOptions = {}) {
    super(options);
    // Explicitly set child's options property after parent initialization
    // This is required because the override declaration creates a new property slot
    this.options = options;
    if (options === null) {
      throw new Error('options cant be null');
    }
    this._id = options.id || null;
    this._slug = options.slug || null;
    this._context = options.context || '';

    // Auto-register the class if it's not already registered
    // and it's not the base SmrtObject class itself
    // Skip registration during field extraction to avoid infinite recursion
    if (
      this.constructor !== SmrtObject &&
      !ObjectRegistry.hasClass(this.constructor.name) &&
      !(options as any)?._skipRegistration
    ) {
      ObjectRegistry.register(this.constructor as typeof SmrtObject, {});
    }
  }

  /**
   * Protected setter for ID to maintain type safety
   * Used internally by collection.create() and other framework code
   * @internal
   */
  protected setId(id: string): void {
    this._id = id;
  }

  /**
   * Protected setter for STI discriminator to maintain type safety
   * Used internally for Single Table Inheritance support
   * @internal
   */
  protected setMetaType(metaType: string): void {
    (this as any)._meta_type = metaType;
  }

  /**
   * Smart clone helper to avoid array/object aliasing (Issue #22)
   *
   * Clones values to prevent shared references between options and instance properties:
   * - Primitives (string, number, boolean, null, undefined): No clone needed
   * - Dates: No clone needed (immutable)
   * - Field instances: No clone needed (framework objects)
   * - Arrays: Shallow clone
   * - Plain objects: Shallow clone
   * - Other objects: Pass through (class instances, etc.)
   *
   * @param value - Value to clone
   * @returns Cloned value or original if no cloning needed
   * @private
   */
  private cloneValue(value: any): any {
    // Primitives and null/undefined - no clone needed
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;

    // Dates - immutable, no clone needed
    if (value instanceof Date) return value;

    // Arrays - shallow clone to avoid aliasing
    if (Array.isArray(value)) return [...value];

    // Plain objects - shallow clone to avoid aliasing
    // Check if it's a plain object (created via {} or Object.create(null))
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) {
      return { ...value };
    }

    // Other objects (class instances, etc.) - pass through
    return value;
  }

  /**
   * Initialize properties from options after field initializers have run
   * This ensures option values take precedence over default field initializer values
   * Uses smart cloning to prevent array/object aliasing (Issue #22)
   */
  private async initializePropertiesFromOptions(): Promise<void> {
    const options = this.options;

    // Set base properties that exist on SmrtObject
    if (options.created_at !== undefined) this.created_at = options.created_at;
    if (options.updated_at !== undefined) this.updated_at = options.updated_at;

    // Set STI discriminator if present
    if (options._meta_type !== undefined) {
      this.setMetaType(options._meta_type);
    }

    // Get all fields (both Field instances and plain properties)
    const fields = await fieldsFromClass(
      this.constructor as new (
        ...args: any[]
      ) => any,
    );

    // Apply option values to all fields
    for (const [key, field] of Object.entries(fields)) {
      if (options[key] !== undefined) {
        // Clone value to avoid aliasing (Issue #22)
        const clonedValue = this.cloneValue(options[key]);

        // Check if property is writable before setting (Issue #61)
        // Get descriptor from instance or entire prototype chain
        let descriptor = Object.getOwnPropertyDescriptor(this, key);
        if (!descriptor) {
          let proto = Object.getPrototypeOf(this);
          while (proto && !descriptor) {
            descriptor = Object.getOwnPropertyDescriptor(proto, key);
            proto = Object.getPrototypeOf(proto);
          }
        }

        // Only set if property has a setter or is writable
        // Skip readonly properties (e.g., tableName getter without setter)
        if (!descriptor || descriptor.set || descriptor.writable === true) {
          // Set the property value
          this[key as keyof this] = clonedValue;
        }
      }
    }
  }

  /**
   * Gets the unique identifier for this object
   */
  get id(): string | null | undefined {
    return this._id;
  }

  /**
   * Sets the unique identifier for this object
   *
   * @param value - The ID to set
   * @throws Error if the value is invalid
   */
  set id(value: string | null | undefined) {
    if (!value || value === 'undefined' || value === 'null') {
      throw new Error(`id is required, ${value} given`);
    }
    this._id = value;
  }

  /**
   * Gets the URL-friendly slug for this object
   */
  get slug(): string | null | undefined {
    return this._slug;
  }

  /**
   * Sets the URL-friendly slug for this object
   *
   * @param value - The slug to set
   * @throws Error if the value is invalid
   */
  set slug(value: string | null | undefined) {
    if (!value || value === 'undefined' || value === 'null') {
      throw new Error(`slug is invalid, ${value} given`);
    }

    this._slug = value;
  }

  /**
   * Gets the context that scopes this object's slug
   */
  get context(): string {
    return this._context || '';
  }

  /**
   * Sets the context that scopes this object's slug
   *
   * @param value - The context to set
   * @throws Error if the value is invalid
   */
  set context(value: string | null | undefined) {
    if (value !== '' && !value) {
      throw new Error(`context is invalid, ${value} given`);
    }
    this._context = value;
  }

  /**
   * Initializes this object and optionally loads its data from the database.
   *
   * Initialization order:
   * 1. Runs TypeScript field initializers (class property defaults)
   * 2. Applies `options` values on top of defaults (options win)
   * 3. If `options.id` is set, calls `loadFromId()` to hydrate from DB
   * 4. If `options.slug` is set (and no id), calls `loadFromSlug()` instead
   *
   * Database table creation is deferred until the first actual DB operation
   * (lazy initialization — safe for SSR and prerendering).
   *
   * Called automatically by collection methods. Call manually only when
   * constructing objects outside of a collection.
   *
   * @returns This instance, ready to use (enables chaining)
   *
   * @example
   * ```typescript
   * const product = new Product({ db: myDb, id: 'existing-uuid' });
   * await product.initialize(); // loads product data from DB
   * console.log(product.name);
   * ```
   */
  public async initialize(): Promise<this> {
    await super.initialize();

    // Initialize properties from options AFTER all field initializers have run
    // This prevents TypeScript field initializers from overwriting option values
    // This must run for all classes (decorator-based or not) unless explicitly skipped
    if (!this.options._extractingFields) {
      await this.initializePropertiesFromOptions();
    }

    // NOTE: Database table setup is now deferred until first database operation (lazy initialization)
    // This prevents database connections during import/prerendering (issue #237)
    // Tables will be created automatically when calling save(), delete(), or query methods

    if (this._id && !(this.options as any)._skipLoad) {
      await this.loadFromId();
    } else if (this._slug && !(this.options as any)._skipLoad) {
      await this.loadFromSlug();
    }

    return this;
  }

  /**
   * Determines if this class needs automatic property initialization from options
   *
   * Decorator-based classes handle property assignment in their constructor,
   * so they don't need the automatic property initialization logic.
   * This optimization avoids redundant work and Field instance handling.
   *
   * @returns True if property initialization is needed, false otherwise
   * @private
   */
  private needsPropertyInitialization(): boolean {
    const className = this.constructor.name;

    // Check if this class has decorator metadata in the registry
    // If it does, it's using decorators and handles its own initialization
    if (ObjectRegistry.hasClass(className)) {
      const hasDecorators = ObjectRegistry.hasFieldDecorators(className);
      if (hasDecorators) {
        // Class uses decorators - properties are set in constructor
        return false;
      }
    }

    // Default: assume it needs property initialization (field helpers pattern)
    return true;
  }

  /**
   * Loads data from a database row into this object's properties
   *
   * STI Support: If using Single Table Inheritance (tableStrategy: 'sti'):
   * - Merges _meta_data JSONB fields into the main data object
   * - Validates _meta_type discriminator matches class name
   *
   * @param data - Database row data (with snake_case column names)
   * @throws Error if STI validation fails
   */
  async loadDataFromDb(data: any) {
    if (process.env.DEBUG_STI) {
      console.log('[loadDataFromDb] Loading:', {
        class: this.constructor.name,
        dataKeys: Object.keys(data),
        metaType: data._meta_type,
      });
    }

    // Get field definitions to pass to formatDataJs
    const fields = await this.getFields();

    if (process.env.DEBUG_STI) {
      console.log('[loadDataFromDb] Field definitions:', {
        class: this.constructor.name,
        fieldKeys: Object.keys(fields),
      });
    }

    // Format data: Convert snake_case column names to camelCase property names
    // and convert date strings to Date objects (Issue #339)
    const { formatDataJs } = await import('./utils.js');
    const formattedData = formatDataJs(data, fields);

    // Check if this class uses STI (Single Table Inheritance)
    const tableStrategy = ObjectRegistry.getTableStrategy(
      this.constructor.name,
    );
    const isSTI = tableStrategy === 'sti';

    if (process.env.DEBUG_STI) {
      console.log('[loadDataFromDb] After formatDataJs:', {
        class: this.constructor.name,
        isSTI,
        formattedDataKeys: Object.keys(formattedData),
      });
    }

    // STI: Fail-fast validation for _meta_type discriminator
    if (isSTI) {
      // Validation 1: _meta_type must be present in database row
      if (!formattedData._meta_type) {
        throw new Error(
          `STI validation failed: Missing _meta_type discriminator in database row for ${this.constructor.name}. ` +
            `Ensure the row was saved with STI support enabled.`,
        );
      }

      // Validation 2: _meta_type must match the class being instantiated
      // Accept both simple class name and qualified name (namespace isolation - Issue #713)
      if (!isValidMetaType(formattedData._meta_type, this.constructor.name)) {
        throw new Error(
          `STI validation failed: Type mismatch when loading ${this.constructor.name}. ` +
            `Database row has _meta_type='${formattedData._meta_type}' but expected '${getExpectedMetaType(this.constructor.name)}'. ` +
            `This usually means you're trying to load a row with the wrong class.`,
        );
      }

      // Set _meta_type on the object
      this.setMetaType(formattedData._meta_type);
    }

    // STI: Meta fields are already merged by formatDataJs
    // No additional processing needed

    if (process.env.DEBUG_STI) {
      console.log('[loadDataFromDb] Starting field hydration:', {
        class: this.constructor.name,
        fieldCount: Object.keys(fields).length,
      });
    }

    let hydratedCount = 0;
    let skippedCount = 0;

    for (const field in fields) {
      if (Object.hasOwn(fields, field)) {
        // Check if property is writable before setting (Issue #63)
        // Get descriptor from instance or entire prototype chain
        let descriptor = Object.getOwnPropertyDescriptor(this, field);
        if (!descriptor) {
          let proto = Object.getPrototypeOf(this);
          while (proto && !descriptor) {
            descriptor = Object.getOwnPropertyDescriptor(proto, field);
            proto = Object.getPrototypeOf(proto);
          }
        }

        // Only set if property has a setter or is writable
        // Skip readonly properties (e.g., tableName getter without setter)
        if (!descriptor || descriptor.set || descriptor.writable === true) {
          // Use formatted data (camelCase) instead of raw data (snake_case)
          // formatDataJs() already handles type conversions (dates, booleans, etc.)
          const value = formattedData[field];

          if (process.env.DEBUG_STI && value !== undefined) {
            console.log(`[loadDataFromDb] Setting field '${field}':`, {
              value,
              valueType: typeof value,
            });
          }

          this[field as keyof this] = value;
          hydratedCount++;
        } else {
          skippedCount++;
          if (process.env.DEBUG_STI) {
            console.log(`[loadDataFromDb] Skipping readonly field '${field}'`);
          }
        }
      }
    }

    if (process.env.DEBUG_STI) {
      console.log('[loadDataFromDb] Hydration complete:', {
        class: this.constructor.name,
        hydratedCount,
        skippedCount,
        totalFields: Object.keys(fields).length,
      });
    }
  }

  /**
   * Gets the database table name for this object
   */
  get tableName() {
    if (!this._tableName) {
      // For STI, use the base class's table name from schema (manifest-derived)
      const className = this.constructor.name;
      const tableStrategy = ObjectRegistry.getTableStrategy(className);

      if (tableStrategy === 'sti') {
        const stiBase = ObjectRegistry.getSTIBase(className);
        if (stiBase) {
          // Use base class's schema tableName (from manifest)
          const baseSchema = ObjectRegistry.getSchema(stiBase);
          if (baseSchema?.tableName) {
            this._tableName = baseSchema.tableName;
          } else {
            // Fallback to own schema tableName
            const ownSchema = ObjectRegistry.getSchema(className);
            this._tableName =
              ownSchema?.tableName || tableNameFromClass(this.constructor);
          }
        } else {
          // Fallback to own schema tableName
          const ownSchema = ObjectRegistry.getSchema(className);
          this._tableName =
            ownSchema?.tableName || tableNameFromClass(this.constructor);
        }
      } else {
        // CTI: Use own schema tableName
        const ownSchema = ObjectRegistry.getSchema(className);
        this._tableName =
          ownSchema?.tableName || tableNameFromClass(this.constructor);
      }
    }
    return this._tableName;
  }

  /**
   * Gets field definitions and current values for this object
   *
   * @returns Object containing field definitions with current values
   */
  async getFields() {
    // Use cached field definitions from ObjectRegistry (via fieldsFromClass)
    // This is much more efficient than creating temporary instances
    const fields = await fieldsFromClass(
      this.constructor as new (
        ...args: any[]
      ) => any,
    );

    // Add current instance values to the fields
    // Use getPropertyValue to unwrap Field instances
    for (const key in fields) {
      fields[key].value = this.getPropertyValue(key);
    }

    return fields;
  }

  /**
   * Override hook for customizing JSON serialization output.
   *
   * This is the **only safe way** to customize serialization. Do **not** override
   * `toJSON()` directly — it manages STI discriminator assignment (`_meta_type`),
   * meta-field extraction into `_meta_data`, and manifest-driven field enumeration.
   * Overriding it will silently break STI persistence.
   *
   * The `data` argument already contains all persisted fields. Return a new object
   * (spread `data` and add/modify/remove keys) to change what is serialized.
   * Non-persisted computed properties added here are excluded from `save()` because
   * the DB write path uses `toJSON()` output, not this hook's additions — unless
   * those keys also correspond to real schema columns.
   *
   * @param data - Fully serialized object produced by the framework's `toJSON()` logic
   * @returns Transformed data to use as the final serialization result
   *
   * @example
   * ```typescript
   * class Article extends SmrtObject {
   *   body: string = '';
   *
   *   protected transformJSON(data: any): any {
   *     return {
   *       ...data,
   *       wordCount: this.body.split(/\s+/).length,
   *       preview: this.body.substring(0, 100),
   *     };
   *   }
   * }
   * ```
   *
   * @see {@link toJSON} for the framework implementation (do not override)
   */
  protected transformJSON(data: any): any {
    return data; // Default: no transformation
  }

  /**
   * Custom JSON serialization
   * Returns a plain object with all field values for proper JSON.stringify() behavior
   * Field instances automatically call their toJSON() method during serialization
   *
   * Issue #205: Filters out undefined values to prevent database errors
   *
   * Note: This method cannot be async because JSON.stringify() expects synchronous toJSON()
   * It uses direct property access instead of getFields() to avoid async issues
   *
   * STI Support: If using Single Table Inheritance (tableStrategy: 'sti'):
   * - Sets _meta_type discriminator to class name
   * - Extracts meta fields to _meta_data JSONB column
   *
   * **Customization:** Override `transformJSON()` instead of this method.
   * See transformJSON() documentation for safe customization patterns.
   */
  toJSON() {
    const data: any = {
      id: this.id,
      slug: this.slug,
      context: this.context,
      created_at: this.created_at,
      updated_at: this.updated_at,
    };

    // Check if this class uses STI (Single Table Inheritance)
    const tableStrategy = ObjectRegistry.getTableStrategy(
      this.constructor.name,
    );
    const isSTI = tableStrategy === 'sti';

    // If STI, add discriminator and prepare meta_data container
    if (isSTI) {
      // Use qualified name for STI discriminator (namespace isolation)
      // The qualified name uses the child class's own package, not the parent's
      // This supports multi-package inheritance hierarchies (Issue #713)
      const registeredClass = ObjectRegistry.getClass(this.constructor.name);
      data._meta_type = registeredClass?.qualifiedName || this.constructor.name;
      data._meta_data = {};
    }

    // Get registered field definitions (synchronous access to already-loaded metadata)
    // For inheritance hierarchies, use cached inherited fields if available (populated by getAllFields())
    // This ensures multi-level STI classes serialize all parent fields correctly (Issue #332)
    const registered = ObjectRegistry.getClass(this.constructor.name);
    let registeredFields =
      registered?.inheritedFields ||
      ObjectRegistry.getFields(this.constructor.name);

    // In STI mode, we need to know about ALL sibling class fields to provide default values
    // for fields that exist in siblings but not in this class (Issue #391)
    if (isSTI) {
      const stiBase = ObjectRegistry.getSTIBase(this.constructor.name);
      if (stiBase) {
        // Get all descendants (siblings + this class)
        const descendants = ObjectRegistry.getDescendants(stiBase);
        const allSTIFields = new Map(registeredFields);

        // Merge fields from all sibling classes
        for (const descendant of descendants) {
          const descendantFields = ObjectRegistry.getFields(descendant);
          for (const [key, value] of descendantFields) {
            if (!allSTIFields.has(key)) {
              allSTIFields.set(key, value);
            }
          }
        }

        registeredFields = allSTIFields;
      }
    }

    // Use manifest fields exclusively (manifest-first architecture)
    // All schema fields are in the manifest from AST scanning
    // Dynamic properties added at runtime are intentionally excluded (not part of schema)
    for (const key of registeredFields.keys()) {
      // Skip private properties, methods, and already-handled core fields
      if (
        key.startsWith('_') ||
        key === 'id' ||
        key === 'slug' ||
        key === 'context' ||
        key === 'created_at' ||
        key === 'updated_at' ||
        key === 'options' || // Skip options object (not a database column)
        typeof (this as any)[key] === 'function'
      ) {
        continue;
      }

      // Get field definition (used for transient check and type checking)
      const fieldDef = registeredFields.get(key);

      // Skip transient fields (non-persisted fields like functions, computed properties)
      // NOTE: This filtering logic must match SchemaGenerator.generateColumns()
      // Changes to field filtering should be applied in BOTH places
      if (fieldDef && (fieldDef.transient || fieldDef._meta?.transient)) {
        continue;
      }

      // Skip relationship fields that don't create columns
      // oneToMany and manyToMany are relationship metadata, not actual database columns
      // NOTE: This must match the filtering in SchemaGenerator.generateColumns()
      if (
        fieldDef &&
        (fieldDef.type === 'oneToMany' || fieldDef.type === 'manyToMany')
      ) {
        continue;
      }

      const prop = (this as any)[key];
      const value = this.getPropertyValue(key);

      // Handle undefined values (Issue #205, #391)
      // In STI, a child class may not have a property defined on a sibling class.
      // This logic ensures undefined properties are serialized correctly based on their type.
      if (value === undefined) {
        // Get field type from either the property instance (field helper) or the manifest
        const fieldType =
          (prop && typeof prop === 'object' && 'type' in prop && prop.type) ||
          fieldDef?.type;

        if (fieldType === 'text') {
          // Don't convert tenant ID fields to empty string (Issue #841)
          // Tenant fields should remain null/undefined for interceptor to auto-populate.
          // Check both the property instance and field definition for __tenancy marker.
          // Note: __tenancy can be at fieldDef.__tenancy (from @tenantId decorator) or
          // fieldDef._meta.__tenancy (from @smrt({ tenantScoped: true }))
          const hasTenancyMarker =
            (prop &&
              typeof prop === 'object' &&
              '__tenancy' in prop &&
              (prop as any).__tenancy?.isTenantIdField) ||
            (fieldDef as any)?.__tenancy?.isTenantIdField ||
            (fieldDef as any)?._meta?.__tenancy?.isTenantIdField;

          if (hasTenancyMarker) {
            // Leave tenant field as null so interceptor can auto-populate
            if (isSTI && fieldDef?.type === 'meta') {
              data._meta_data[key] = null;
            } else {
              data[key] = null;
            }
          } else {
            // For regular TEXT fields, convert undefined to an empty string.
            if (isSTI && fieldDef?.type === 'meta') {
              data._meta_data[key] = '';
            } else {
              data[key] = '';
            }
          }
        } else if (fieldType === 'json') {
          // For JSON fields, use the default value from manifest to prevent:
          // 1. Invalid JSON casting errors in DuckDB (empty string "")
          // 2. Runtime errors when code expects arrays/objects (null)
          const defaultValue = fieldDef?.default ?? null;

          if (isSTI && fieldDef?.type === 'meta') {
            data._meta_data[key] = defaultValue;
          } else {
            data[key] = defaultValue;
          }
        }

        // For all cases of 'undefined' (handled or not), we continue to the next field.
        // This prevents the undefined value from being assigned to the data object below,
        // allowing the database to use its default value for unhandled types.
        continue;
      }

      // STI: Separate meta fields from regular fields
      if (isSTI && fieldDef && fieldDef.type === 'meta') {
        // Meta fields go into _meta_data JSONB column
        data._meta_data[key] = value;
      } else {
        // Regular fields become table columns
        data[key] = value;
      }
    }

    // Call transformation hook to allow safe customization
    // This enables subclasses to add/modify fields without overriding toJSON()
    return this.transformJSON(data);
  }

  /**
   * Converts this object to a plain JavaScript object (POJO)
   *
   * Unlike toJSON() which returns an object that can still be a class instance,
   * this method returns a true plain object suitable for:
   * - SvelteKit's load function returns (requires serializable data)
   * - Passing data through web workers
   * - Any context requiring non-class objects
   *
   * @returns Plain JavaScript object with all field values
   *
   * @example
   * ```typescript
   * // In a SvelteKit +page.server.ts load function:
   * const users = await userCollection.list();
   * return {
   *   users: users.map(u => u.toPlainObject())
   * };
   * ```
   */
  toPlainObject(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this));
  }

  /**
   * Gets or generates a unique ID for this object
   *
   * @returns Promise resolving to the object's ID
   */
  async getId() {
    // lookup by slug and context using adapter method
    const saved = await this.db.get(this.tableName, {
      slug: this.slug,
      context: this.context,
    });
    if (saved) {
      this.id = saved.id;
    }

    if (!this.id) {
      this.id = crypto.randomUUID();
    }
    return this.id;
  }

  /**
   * Returns the slug for this object, generating one if not already set.
   *
   * Generation falls back through the following fields in order:
   * `name` → `title` → `label` → `id`
   *
   * The generated slug is lowercased, with non-alphanumeric characters
   * replaced by hyphens and leading/trailing hyphens stripped.
   *
   * Called automatically by `save()` when no slug is present.
   *
   * @returns The existing slug or a newly generated one (may be `null` if
   *   none of the fallback fields and `id` are set)
   *
   * @example
   * ```typescript
   * const product = new Product({ name: 'My Widget' });
   * console.log(await product.getSlug()); // 'my-widget'
   * ```
   */
  async getSlug() {
    if (!this.slug) {
      // Try multiple fallback fields in order: name, title, label, id
      let sourceField = null;

      if ((this as any).name) {
        sourceField = String((this as any).name);
      } else if ((this as any).title) {
        sourceField = String((this as any).title);
      } else if ((this as any).label) {
        sourceField = String((this as any).label);
      } else if (this.id) {
        // Final fallback: use ID
        sourceField = String(this.id);
      }

      if (sourceField) {
        // Generate slug from source field
        this.slug = sourceField
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '');
      }
    }

    // check for existing slug and make unique?
    return this.slug;
  }

  /**
   * Gets the ID of this object if it's already saved in the database
   *
   * @returns Promise resolving to the saved ID or null if not saved
   */
  async getSavedId() {
    // Try to find by id first
    if (this.id) {
      const byId = await this.db.get(this.tableName, { id: this.id });
      if (byId) return byId.id;
    }

    // Fall back to finding by slug
    if (this.slug) {
      const bySlug = await this.db.get(this.tableName, { slug: this.slug });
      if (bySlug) return bySlug.id;
    }

    return null;
  }

  /**
   * Checks if this object is already saved in the database
   *
   * @returns Promise resolving to true if saved, false otherwise
   */
  async isSaved() {
    const saved = await this.getSavedId();
    return !!saved;
  }

  /**
   * Persists this object to the database using an upsert (insert or update).
   *
   * Steps performed on every save:
   * 1. Runs field-level validation (`validateBeforeSave()`)
   * 2. Executes `beforeSave` interceptors (e.g. tenant injection)
   * 3. Assigns a UUID `id` if not already set
   * 4. Generates a `slug` via `getSlug()` if not already set
   * 5. Updates `updated_at` (and sets `created_at` on first save)
   * 6. Upserts the row with automatic retry (3 attempts, 500 ms backoff)
   * 7. Executes `afterSave` interceptors
   * 8. Triggers embedding generation in the background if configured
   *
   * For STI classes, validates that `_meta_type` is present and correct
   * before writing to the database.
   *
   * @returns This instance after saving (enables chaining)
   * @throws {ValidationError} If a required field is missing or a unique constraint is violated
   * @throws {DatabaseError} If the table does not exist (`DB_SCHEMA_MISSING`) or the query fails
   * @throws {RuntimeError} For any other unexpected failure during save
   *
   * @example
   * ```typescript
   * const product = new Product({ db: myDb, name: 'Widget', price: 9.99 });
   * await product.initialize();
   * await product.save();
   * console.log(product.id); // UUID assigned during save
   *
   * // Update
   * product.price = 14.99;
   * await product.save();
   * ```
   */
  async save() {
    try {
      await ObjectRegistry.ensureManifestLoaded(this.constructor.name);
      const { ensureSchema } = await import('./schema/utils.js');
      await ensureSchema(this.db, this.constructor.name);

      // Validate object state before saving
      await this.validateBeforeSave();

      // Execute beforeSave interceptors (e.g., tenancy validation)
      const interceptorContext = createInterceptorContext(
        this.constructor.name,
        'save',
      );
      await GlobalInterceptors.executeBeforeSave(this, interceptorContext);

      if (!this.id) {
        this.id = crypto.randomUUID();
      }

      if (!this.slug) {
        this.slug = await this.getSlug();
      }

      // Update the updated_at timestamp
      this.updated_at = new Date();

      if (!this.created_at) {
        this.created_at = new Date();
      }

      // Verify table exists (tables must be created via smrt db:migrate)
      // This replaces automatic schema creation which caused race conditions (issue #665)
      // Cache verified tables to avoid redundant round-trips (issue #970)
      // Only check when the adapter explicitly opts in via requiresSchemaCheck: true
      if (this.db?.requiresSchemaCheck) {
        const tableName = this.tableName;
        const dbUrl = this.db.url || ':memory:';
        if (!isTableVerified(dbUrl, tableName)) {
          const tableExists = await this.db.tableExists(tableName);
          if (!tableExists) {
            throw DatabaseError.schemaMissing(tableName, this.constructor.name);
          }
          markTableVerified(dbUrl, tableName);
        }
      }

      // Execute save operation with retry logic for transient failures
      // Use per-adapter upsert method instead of generating SQL

      // Development-mode warning: Detect unsafe toJSON() overrides in STI classes
      if (process.env.NODE_ENV === 'development') {
        const hasOverride = this.toJSON !== SmrtObject.prototype.toJSON;
        const tableStrategy = ObjectRegistry.getTableStrategy(
          this.constructor.name,
        );
        const usesSTI = tableStrategy === 'sti';

        if (hasOverride && usesSTI) {
          console.warn(
            `[SMRT STI Warning] ${this.constructor.name} overrides toJSON() but uses STI.\n` +
              `Ensure super.toJSON() is called or _meta_type is set manually.\n` +
              `This can cause "Missing _meta_type discriminator" errors.\n` +
              `Prefer using the transformJSON() hook instead of overriding toJSON().\n` +
              `See issue #377: https://github.com/happyvertical/smrt/issues/377`,
          );
        }
      }

      const jsonData = this.toJSON();

      // STI: Fail-fast validation for _meta_type discriminator
      const tableStrategy = ObjectRegistry.getTableStrategy(
        this.constructor.name,
      );
      if (tableStrategy === 'sti') {
        if (!jsonData._meta_type) {
          throw new Error(
            `STI validation failed: Missing _meta_type discriminator when saving ${this.constructor.name}. ` +
              `This should have been set automatically by toJSON(). Please report this bug.`,
          );
        }
        // Accept both simple class name and qualified name (namespace isolation - Issue #713)
        if (!isValidMetaType(jsonData._meta_type, this.constructor.name)) {
          throw new Error(
            `STI validation failed: _meta_type mismatch when saving ${this.constructor.name}. ` +
              `Expected '${getExpectedMetaType(this.constructor.name)}' but got '${jsonData._meta_type}'. ` +
              `This should not happen - please report this bug.`,
          );
        }
      }

      // Convert camelCase keys to snake_case for database columns
      // Preserve leading underscore for special fields like _meta_type, _meta_data
      const data: Record<string, any> = {};
      for (const [key, value] of Object.entries(jsonData)) {
        if (key.startsWith('_')) {
          // Preserve leading underscore for special fields
          data[key] = value;
        } else {
          data[toSnakeCase(key)] = value;
        }
      }

      // Get conflict columns from registry (supports custom columns for junction tables)
      const conflictColumns = ObjectRegistry.getConflictColumns(
        this.constructor.name,
      );

      await ErrorUtils.withRetry(
        async () => {
          try {
            await this.db.upsert(this.tableName, conflictColumns, data);
          } catch (error) {
            // Detect specific database error types
            if (error instanceof Error) {
              if (error.message.includes('UNIQUE constraint failed')) {
                const field = this.extractConstraintField(error.message);
                throw ValidationError.uniqueConstraint(
                  field,
                  this.getFieldValue(field),
                );
              }
              if (error.message.includes('NOT NULL constraint failed')) {
                const field = this.extractConstraintField(error.message);
                throw ValidationError.requiredField(
                  field,
                  this.constructor.name,
                );
              }
              throw DatabaseError.queryFailed(
                `UPSERT INTO ${this.tableName}`,
                error,
              );
            }
            throw error;
          }
        },
        3,
        500,
      );

      // Execute afterSave interceptors (e.g., tenant audit logging)
      await GlobalInterceptors.executeAfterSave(this, interceptorContext);

      // Auto-generate embeddings if configured
      const embeddingConfig = ObjectRegistry.getEmbeddingConfig(
        this.constructor.name,
      );
      if (
        embeddingConfig &&
        embeddingConfig.autoGenerate !== false &&
        this.ai
      ) {
        // Check if any embedding field content has changed
        const isStale = await this.hasStaleEmbeddings();
        if (isStale) {
          // Generate embeddings in background to avoid blocking save
          this.generateEmbeddings().catch((error) => {
            console.warn(
              `Failed to auto-generate embeddings for ${this.constructor.name}:`,
              error instanceof Error ? error.message : error,
            );
          });
        }
      }

      return this;
    } catch (error) {
      // Re-throw SMRT errors as-is, wrap others
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }

      throw RuntimeError.operationFailed(
        'save',
        `${this.constructor.name}#${this.id}`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Validates object state before saving
   * Override in subclasses to add custom validation logic
   */
  protected async validateBeforeSave(): Promise<void> {
    const className = this.constructor.name;

    // Priority 1: Use pre-computed validation rules from manifest (Issue #782)
    // This is the fastest path - rules are serializable and don't require closures
    const validationRules = ObjectRegistry.getValidationRules(className);

    if (validationRules && validationRules.length > 0) {
      const errors = await ObjectRegistry.validateWithRules(
        this,
        validationRules,
        className,
      );

      if (errors.length > 0) {
        throw errors[0];
      }
      return;
    }

    // Priority 2: Use compiled validators (backward compatibility)
    const validators = ObjectRegistry.getValidators(className);

    if (validators && validators.length > 0) {
      // Execute all cached validators
      const errors: ValidationError[] = [];

      for (const validator of validators) {
        const error = await validator(this);
        if (error) {
          errors.push(error);
        }
      }

      // If there are validation errors, throw the first one
      // (In the future, we could throw all errors as a ValidationReport)
      if (errors.length > 0) {
        throw errors[0];
      }
      return;
    }

    // Priority 3: Fallback to old validation logic if no cached validators
    // (for classes not registered with ObjectRegistry)
    const fields = await fieldsFromClass(this.constructor as any);

    for (const [fieldName, field] of Object.entries(fields)) {
      // With decorators, field definitions are plain objects with nested options
      if ((field as any).options?.required) {
        const value = this.getFieldValue(fieldName);
        if (value === null || value === undefined || value === '') {
          throw ValidationError.requiredField(fieldName, className);
        }
      }
    }
  }

  /**
   * Gets the value of a field on this object
   */
  protected getFieldValue(fieldName: string): any {
    return (this as any)[fieldName];
  }

  /**
   * Gets the value of a property.
   *
   * @param key - Property name to get value from
   * @returns The property value
   */
  protected getPropertyValue(key: string): any {
    return (this as any)[key];
  }

  /**
   * Extracts field name from database constraint error messages
   */
  protected extractConstraintField(errorMessage: string): string {
    // Try to extract field name from common SQLite constraint patterns
    const patterns = [
      /UNIQUE constraint failed: \w+\.(\w+)/,
      /NOT NULL constraint failed: \w+\.(\w+)/,
      /constraint failed: (\w+)/i,
    ];

    for (const pattern of patterns) {
      const match = errorMessage.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return 'unknown_field';
  }

  /**
   * Hydrates this object from the database using its `id` property.
   *
   * Queries the database for a row matching `{ id: this._id }` and calls
   * `loadDataFromDb()` if found. Uses a 3-attempt retry with 250 ms initial
   * delay to handle transient failures.
   *
   * Called automatically by `initialize()` when `options.id` is provided.
   * Typically you do not need to call this directly.
   *
   * @returns Promise that resolves when loading is complete (no-op if not found)
   * @throws {ValidationError} If `this._id` is not set
   * @throws {DatabaseError} If the query fails after all retries
   *
   * @example
   * ```typescript
   * const product = new Product({ db: myDb });
   * await product.initialize();
   * product._id = 'some-uuid';
   * await product.loadFromId(); // hydrates from DB
   * ```
   */
  public async loadFromId() {
    try {
      if (!this._id) {
        throw ValidationError.requiredField('id', this.constructor.name);
      }

      await ErrorUtils.withRetry(
        async () => {
          try {
            const existing = await this.db.get(this.tableName, {
              id: this._id,
            });
            if (existing) {
              await this.loadDataFromDb(existing);
            }
          } catch (error) {
            throw DatabaseError.queryFailed(
              `get(${this.tableName}, { id: ${this._id} })`,
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        },
        3,
        250,
      );
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }

      throw RuntimeError.operationFailed(
        'loadFromId',
        `${this.constructor.name}#${this._id}`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Hydrates this object from the database using its `slug` (and `context`).
   *
   * Queries for a row matching `{ slug, context }`. The `context` defaults to
   * an empty string when not provided. Calls `loadDataFromDb()` if a matching
   * row is found.
   *
   * Called automatically by `initialize()` when `options.slug` is provided and
   * no `options.id` is set. Typically you do not need to call this directly.
   *
   * @returns Promise that resolves when loading is complete (no-op if not found)
   *
   * @example
   * ```typescript
   * const product = new Product({ db: myDb, slug: 'my-widget', context: 'shop' });
   * await product.initialize(); // calls loadFromSlug() automatically
   * console.log(product.name);
   * ```
   */
  public async loadFromSlug() {
    const existing = await this.db.get(this.tableName, {
      slug: this._slug,
      context: this._context || '',
    });
    if (existing) {
      await this.loadDataFromDb(existing);
    }
  }

  /**
   * Evaluates whether this object satisfies the given natural-language criteria using AI.
   *
   * Sends the object's JSON representation to the AI with the criteria prompt and
   * asks for a `{ result: boolean }` JSON response. Uses any AI-callable tools
   * registered on this class (via `@smrt({ ai })`) as part of the function-calling context.
   *
   * @param criteria - Natural-language description of the condition to evaluate
   * @param options - AI message options passed to `ai.message()` (e.g. model override)
   * @returns `true` if the object meets the criteria, `false` otherwise
   * @throws Error if the AI returns a non-boolean or malformed JSON response
   *
   * @example
   * ```typescript
   * const article = await articles.get('article-uuid');
   * const isSuitable = await article.is('appropriate for a general audience');
   * if (isSuitable) await article.publish();
   * ```
   *
   * @see {@link do} for open-ended instructions instead of boolean checks
   */
  public async is(criteria: string, options: any = {}) {
    const prompt = `--- Beginning of criteria ---\n${criteria}\n--- End of criteria ---\nDoes the content meet all the given criteria? Reply with a json object with a single boolean 'result' property`;

    // Get available tools for AI function calling
    const tools = this.getAvailableTools();

    const message = await this.ai.message(prompt, {
      ...(options as any),
      responseFormat: { type: 'json_object' },
      tools: tools.length > 0 ? tools : undefined,
    });

    try {
      const { result } = JSON.parse(message);
      if (result === true || result === false) {
        return result;
      }
    } catch (_e) {
      throw new Error(`Unexpected answer: ${message}`);
    }
  }

  /**
   * Performs a freeform operation on this object using AI instructions.
   *
   * Sends the object's JSON representation to the AI together with the given
   * instructions and returns the raw text response. Unlike `is()`, this method
   * does not constrain the response format — use it for transformations,
   * summaries, extractions, or any open-ended AI task.
   *
   * Uses any AI-callable tools registered on this class (via `@smrt({ ai })`)
   * as part of the function-calling context.
   *
   * @param instructions - Natural-language instructions for the AI to follow
   * @param options - AI message options passed to `ai.message()` (e.g. model override)
   * @returns The raw AI response string
   *
   * @example
   * ```typescript
   * const article = await articles.get('article-uuid');
   * const summary = await article.do('summarize this article in 3 bullet points');
   * const translated = await article.do('translate the title and body to Spanish');
   * ```
   *
   * @see {@link is} for boolean criteria checks
   */
  public async do(instructions: string, options: any = {}) {
    const prompt = `--- Beginning of instructions ---\n${instructions}\n--- End of instructions ---\nBased on the content body, please follow the instructions and provide a response. Never make use of codeblocks.`;

    // Get available tools for AI function calling
    const tools = this.getAvailableTools();

    const result = await this.ai.message(prompt, {
      ...options,
      tools: tools.length > 0 ? tools : undefined,
    });

    return result;
  }

  /**
   * Generates a description of this object using AI (Issue #52)
   *
   * Creates a concise, human-readable description based on the object's content
   * and properties. Useful for summaries, previews, and documentation.
   *
   * @param options - AI message options (can include style, length, focus, etc.)
   * @returns Promise resolving to the AI-generated description
   *
   * @example
   * ```typescript
   * const product = await products.get('product-123');
   * const description = await product.describe();
   * // "A high-quality widget for home improvement..."
   *
   * // With custom options
   * const shortDesc = await product.describe({ maxTokens: 50 });
   * // "Premium widget, steel construction"
   * ```
   */
  public async describe(options: any = {}) {
    const prompt = `Generate a concise, professional description of this object based on its content and properties. The description should be clear, informative, and suitable for display to end users. Focus on the most important and distinctive characteristics.`;

    // Get available tools for AI function calling
    const tools = this.getAvailableTools();

    const result = await this.ai.message(prompt, {
      ...options,
      tools: tools.length > 0 ? tools : undefined,
    });

    return result;
  }

  /**
   * Runs a lifecycle hook if it's defined in the object's configuration
   *
   * @param hookName - Name of the hook to run (e.g., 'beforeDelete', 'afterDelete')
   * @returns Promise that resolves when the hook completes
   */
  protected async runHook(hookName: string): Promise<void> {
    const config = ObjectRegistry.getConfig(this.constructor.name);
    const hook = config.hooks?.[hookName as keyof typeof config.hooks];

    if (!hook) {
      return; // No hook defined, nothing to do
    }

    if (typeof hook === 'string') {
      // Hook is a method name to call on this instance
      const method = (this as any)[hook];
      if (typeof method === 'function') {
        await method.call(this);
      } else {
        console.warn(
          `Hook method '${hook}' not found on ${this.constructor.name}`,
        );
      }
    } else if (typeof hook === 'function') {
      // Hook is a function to call with this instance as parameter
      await hook(this);
    }
  }

  /**
   * Deletes this object from the database.
   *
   * Runs the full lifecycle in order:
   * 1. `beforeDelete` interceptors (e.g. tenant validation)
   * 2. `beforeDelete` lifecycle hook (defined in `@smrt({ hooks })`)
   * 3. Database row deletion
   * 4. `afterDelete` lifecycle hook
   * 5. `afterDelete` interceptors
   *
   * Prefer `collection.delete(id)` from application code — it loads the
   * object first (returning `false` when not found) before calling this method.
   *
   * @returns Promise that resolves when deletion is complete
   *
   * @example
   * ```typescript
   * const product = await products.get('product-uuid');
   * if (product) await product.delete();
   * ```
   */
  public async delete(): Promise<void> {
    await ObjectRegistry.ensureManifestLoaded(this.constructor.name);
    const { ensureSchema } = await import('./schema/utils.js');
    await ensureSchema(this.db, this.constructor.name);

    // Execute beforeDelete interceptors (e.g., tenant validation)
    const interceptorContext = createInterceptorContext(
      this.constructor.name,
      'delete',
    );
    await GlobalInterceptors.executeBeforeDelete(this, interceptorContext);

    await this.runHook('beforeDelete');

    await this.db.delete(this.tableName, { id: this.id });

    await this.runHook('afterDelete');

    // Execute afterDelete interceptors (e.g., tenant audit logging)
    await GlobalInterceptors.executeAfterDelete(this, interceptorContext);
  }

  /**
   * Check if a relationship has been loaded
   *
   * @param fieldName - Name of the relationship field
   * @returns True if the relationship is loaded, false otherwise
   * @example
   * ```typescript
   * if (order.isRelatedLoaded('customer')) {
   *   console.log('Customer already loaded');
   * }
   * ```
   */
  public isRelatedLoaded(fieldName: string): boolean {
    return this._loadedRelationships.has(fieldName);
  }

  /**
   * Lazy-loads a `foreignKey` relationship and caches the result.
   *
   * Looks up the relationship metadata in the ObjectRegistry, reads the
   * foreign key value on this object, and fetches the related object from
   * the database. Subsequent calls return the cached value without hitting
   * the database again.
   *
   * For STI relationships, the correct subclass is determined by reading
   * `_meta_type` from the database row before instantiation.
   *
   * @param fieldName - Name of the `@foreignKey()` decorated property
   * @returns The related object, or `null` if the foreign key is empty
   * @throws {RuntimeError} If `fieldName` is not a `foreignKey` relationship,
   *   or the target class is not found in the ObjectRegistry
   *
   * @example
   * ```typescript
   * // class Order { @foreignKey(Customer) customerId: string = ''; }
   * const customer = await order.loadRelated('customerId');
   * console.log(customer?.name);
   * ```
   *
   * @see {@link getRelated} for a convenience wrapper that auto-detects relationship type
   */
  public async loadRelated(fieldName: string): Promise<any> {
    // Check if already loaded
    if (this._loadedRelationships.has(fieldName)) {
      return this._loadedRelationships.get(fieldName);
    }

    // Ensure manifest is loaded for external packages before accessing relationships
    // This is critical for cross-package relationship resolution (Issue #746)
    await ObjectRegistry.ensureManifestLoaded(this.constructor.name);

    // Get relationship metadata from ObjectRegistry
    const relationships = ObjectRegistry.getRelationships(
      this.constructor.name,
    );
    const relationship = relationships.find(
      (r) => r.fieldName === fieldName && r.type === 'foreignKey',
    );

    if (!relationship) {
      throw RuntimeError.invalidState(
        `Field ${fieldName} is not a foreignKey relationship on ${this.constructor.name}`,
        { fieldName, className: this.constructor.name },
      );
    }

    // Get the foreign key value
    const foreignKeyValue = this[fieldName as keyof this];
    if (!foreignKeyValue) {
      // No related object (foreign key is null)
      this._loadedRelationships.set(fieldName, null);
      return null;
    }

    // Get the target class constructor
    const targetClassInfo = ObjectRegistry.getClass(relationship.targetClass);
    if (!targetClassInfo) {
      throw RuntimeError.invalidState(
        `Target class ${relationship.targetClass} not found in ObjectRegistry`,
        { targetClass: relationship.targetClass, fieldName },
      );
    }

    // Check if target class uses STI (Single Table Inheritance)
    const tableStrategy = ObjectRegistry.getTableStrategy(
      relationship.targetClass,
    );
    const isSTI = tableStrategy === 'sti';

    // For STI classes, we need to determine the actual subclass from the database row
    let actualClassInfo = targetClassInfo;
    if (isSTI) {
      // First, fetch just the row to get the _meta_type discriminator
      const tempInstance = new targetClassInfo.constructor(this.options);
      await tempInstance.initialize();
      const row = await tempInstance.db.get(tempInstance.tableName, {
        id: foreignKeyValue as string,
      });

      if (row?._meta_type) {
        // Get the actual class from the registry based on _meta_type
        // Support both qualified names (new format: @pkg:Class) and simple names (legacy)
        let actualClass = ObjectRegistry.getClassByQualifiedName(
          row._meta_type,
        );
        if (!actualClass) {
          // Fall back to simple name lookup for legacy data
          actualClass = ObjectRegistry.getClass(row._meta_type);
        }
        if (actualClass) {
          actualClassInfo = actualClass;
        }
      }
    }

    // Create an instance of the correct class and load by ID
    const relatedInstance = new actualClassInfo.constructor(this.options);
    await relatedInstance.initialize();
    relatedInstance.id = foreignKeyValue as string;
    await relatedInstance.loadFromId();

    // Cache the loaded object
    this._loadedRelationships.set(fieldName, relatedInstance);
    return relatedInstance;
  }

  /**
   * Load related objects for oneToMany or manyToMany fields (lazy loading)
   *
   * Loads all related objects from the database. For oneToMany, queries by
   * the inverse foreign key. For manyToMany, queries through the join table.
   *
   * @param fieldName - Name of the oneToMany or manyToMany field
   * @returns Promise resolving to array of related objects
   * @throws {RuntimeError} If the field is not a relationship or not implemented
   * @example
   * ```typescript
   * // Given: class Customer with orders = oneToMany(Order)
   * const orders = await customer.loadRelatedMany('orders');
   * console.log(`${orders.length} orders found`);
   * ```
   */
  public async loadRelatedMany(fieldName: string): Promise<any[]> {
    // Check if already loaded
    if (this._loadedRelationships.has(fieldName)) {
      return this._loadedRelationships.get(fieldName);
    }

    // Ensure manifest is loaded for external packages before accessing relationships
    // This is critical for cross-package relationship resolution (Issue #746)
    await ObjectRegistry.ensureManifestLoaded(this.constructor.name);

    // Get relationship metadata from ObjectRegistry
    const relationships = ObjectRegistry.getRelationships(
      this.constructor.name,
    );
    const relationship = relationships.find((r) => r.fieldName === fieldName);

    if (!relationship) {
      throw RuntimeError.invalidState(
        `Field ${fieldName} is not a relationship on ${this.constructor.name}`,
        { fieldName, className: this.constructor.name },
      );
    }

    if (relationship.type === 'oneToMany') {
      // Find the inverse foreignKey field on the target class
      const inverseRelationships = ObjectRegistry.getInverseRelationships(
        this.constructor.name,
      );
      const inverseForeignKey = inverseRelationships.find(
        (r) =>
          r.sourceClass === relationship.targetClass &&
          r.type === 'foreignKey' &&
          r.targetClass === this.constructor.name,
      );

      if (!inverseForeignKey) {
        throw RuntimeError.invalidState(
          `Could not find inverse foreignKey on ${relationship.targetClass} for oneToMany relationship ${fieldName}`,
          { fieldName, targetClass: relationship.targetClass },
        );
      }

      // Get or create cached collection instance
      const collection = await ObjectRegistry.getCollection(
        relationship.targetClass,
        this.options,
      );

      // Query using the inverse foreign key
      const relatedObjects = await collection.list({
        where: { [inverseForeignKey.fieldName]: this.id },
      });

      // Cache the loaded objects
      this._loadedRelationships.set(fieldName, relatedObjects);
      return relatedObjects;
    }

    if (relationship.type === 'manyToMany') {
      // manyToMany requires a join table - not implemented yet
      throw RuntimeError.invalidState(
        `manyToMany relationship loading not yet implemented for ${fieldName}`,
        { fieldName, type: 'manyToMany' },
      );
    }

    throw RuntimeError.invalidState(
      `Field ${fieldName} is not a oneToMany or manyToMany relationship`,
      { fieldName, type: relationship.type },
    );
  }

  /**
   * Get a related object, loading it if not already loaded
   *
   * Convenience method that checks if the relationship is loaded and
   * loads it if necessary. Automatically detects foreignKey vs oneToMany/manyToMany.
   *
   * @param fieldName - Name of the relationship field
   * @returns Promise resolving to the related object(s)
   * @example
   * ```typescript
   * // Loads customer if not already loaded
   * const customer = await order.getRelated('customerId');
   *
   * // Loads orders if not already loaded
   * const orders = await customer.getRelated('orders');
   * ```
   */
  public async getRelated(fieldName: string): Promise<any> {
    if (this._loadedRelationships.has(fieldName)) {
      return this._loadedRelationships.get(fieldName);
    }

    // Ensure manifest is loaded for external packages before accessing relationships
    // This is critical for cross-package relationship resolution (Issue #746)
    await ObjectRegistry.ensureManifestLoaded(this.constructor.name);

    // Determine relationship type
    const relationships = ObjectRegistry.getRelationships(
      this.constructor.name,
    );
    const relationship = relationships.find((r) => r.fieldName === fieldName);

    if (!relationship) {
      throw RuntimeError.invalidState(
        `Field ${fieldName} is not a relationship on ${this.constructor.name}`,
        { fieldName, className: this.constructor.name },
      );
    }

    // Load based on relationship type
    if (relationship.type === 'foreignKey') {
      return this.loadRelated(fieldName);
    }

    return this.loadRelatedMany(fieldName);
  }

  /**
   * Get available AI-callable tools for this object
   *
   * Returns the pre-generated tool definitions from the manifest.
   * Tools are generated at build time based on the @smrt decorator's AI config.
   *
   * @returns Array of AITool definitions for LLM function calling
   * @example
   * ```typescript
   * const tools = document.getAvailableTools();
   * console.log(`${tools.length} AI-callable methods available`);
   * ```
   */
  public getAvailableTools(): AITool[] {
    const classInfo = ObjectRegistry.getClass(this.constructor.name);
    return classInfo?.tools || [];
  }

  /**
   * Execute a tool call from AI on this object instance
   *
   * Validates the tool call against allowed methods and executes it with
   * proper error handling and timing.
   *
   * @param toolCall - Tool call from AI response
   * @returns Promise resolving to the tool call result
   * @example
   * ```typescript
   * const toolCall = {
   *   id: 'call_123',
   *   type: 'function',
   *   function: {
   *     name: 'analyze',
   *     arguments: '{"type": "detailed"}'
   *   }
   * };
   *
   * const result = await document.executeToolCall(toolCall);
   * console.log(result.success ? result.result : result.error);
   * ```
   */
  public async executeToolCall(toolCall: ToolCall): Promise<ToolCallResult> {
    const tools = this.getAvailableTools();
    const allowedMethods = tools.map((tool) => tool.function.name);

    return executeToolCallInternal(this, toolCall, allowedMethods);
  }

  /**
   * Stores a named value in the `_smrt_contexts` system table, scoped to this object.
   *
   * Context entries are keyed by `(owner_class, owner_id, scope, key, version)` and
   * support an optional `confidence` score (0–1, default 1.0) for learned patterns.
   * Calling `remember()` with the same scope+key upserts the existing entry.
   *
   * Requires `initialize()` to have been called (needs `this.systemDb`).
   *
   * @param options.id - Optional explicit ID for the context entry (auto-generated if omitted)
   * @param options.scope - Hierarchical path scoping the context (e.g. `'parser/example.com'`)
   * @param options.key - Lookup key within the scope (e.g. a normalized URL)
   * @param options.value - Any JSON-serializable value to store
   * @param options.metadata - Optional additional JSON metadata
   * @param options.confidence - Confidence score (0–1, default 1.0)
   * @param options.version - Schema version for the stored value (default 1)
   * @param options.expiresAt - Optional expiry date after which `recall()` will ignore this entry
   * @returns Promise that resolves when the context is stored
   * @throws Error if `initialize()` has not been called
   *
   * @example
   * ```typescript
   * await agent.remember({
   *   scope: 'parser/example.com',
   *   key: normalizedUrl,
   *   value: { patterns: ['regex1', 'regex2'] },
   *   confidence: 0.9,
   * });
   * ```
   *
   * @see {@link recall} to retrieve a single entry
   * @see {@link recallAll} to retrieve all entries in a scope
   * @see {@link forget} to delete a specific entry
   */
  public async remember(options: {
    id?: string;
    scope: string;
    key: string;
    value: any;
    metadata?: any;
    confidence?: number;
    version?: number;
    expiresAt?: Date;
  }): Promise<void> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const id = options.id || crypto.randomUUID();
    const now = new Date();

    // Ensure the object has an ID - generate one if it doesn't exist
    if (!this.id) {
      this._id = crypto.randomUUID();
    }

    await this.systemDb.upsert(
      '_smrt_contexts',
      ['owner_class', 'owner_id', 'scope', 'key', 'version'],
      {
        id,
        owner_class: this._className,
        owner_id: this.id,
        scope: options.scope,
        key: options.key,
        value: JSON.stringify(options.value),
        metadata: options.metadata ? JSON.stringify(options.metadata) : null,
        version: options.version ?? 1,
        confidence: options.confidence ?? 1.0,
        created_at: now,
        updated_at: now,
        last_used_at: now,
        expires_at: options.expiresAt ?? null,
      },
    );
  }

  /**
   * Retrieves a single remembered context value for this object.
   *
   * Looks up the most recent (highest confidence, then highest version) entry
   * matching `(owner_class, owner_id, scope, key)`. Returns the JSON-parsed value
   * or `null` if no matching entry exists.
   *
   * When `includeAncestors: true`, walks up the scope hierarchy by progressively
   * removing the last path segment (e.g. `'a/b/c'` → `'a/b'` → `'a'` → `'global'`)
   * until a match is found.
   *
   * @param options.scope - Scope path to search (e.g. `'parser/example.com/article'`)
   * @param options.key - Lookup key within the scope
   * @param options.includeAncestors - If `true`, fall back to parent scopes (default `false`)
   * @param options.minConfidence - Only return entries at or above this confidence (0–1)
   * @returns The stored value (parsed from JSON), or `null` if not found
   * @throws Error if `initialize()` has not been called
   *
   * @example
   * ```typescript
   * const strategy = await agent.recall({
   *   scope: 'parser/example.com/article',
   *   key: normalizedUrl,
   *   includeAncestors: true,
   *   minConfidence: 0.6,
   * });
   * ```
   *
   * @see {@link remember} to store a context entry
   * @see {@link recallAll} to retrieve all entries in a scope
   */
  public async recall(options: {
    scope: string;
    key: string;
    includeAncestors?: boolean;
    minConfidence?: number;
  }): Promise<any | null> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    // Use single() with template literals for custom SQL query
    let result: Record<string, any> | null;
    if (options.minConfidence !== undefined) {
      result = await this.systemDb.single`
        SELECT value, confidence
        FROM _smrt_contexts
        WHERE owner_class = ${this._className}
          AND owner_id = ${this.id}
          AND scope = ${options.scope}
          AND key = ${options.key}
          AND confidence >= ${options.minConfidence}
        ORDER BY confidence DESC, version DESC
        LIMIT 1
      `;
    } else {
      result = await this.systemDb.single`
        SELECT value, confidence
        FROM _smrt_contexts
        WHERE owner_class = ${this._className}
          AND owner_id = ${this.id}
          AND scope = ${options.scope}
          AND key = ${options.key}
        ORDER BY confidence DESC, version DESC
        LIMIT 1
      `;
    }

    if (result) {
      return JSON.parse(result.value);
    }

    // Hierarchical fallback to parent scopes
    if (options.includeAncestors) {
      const scopeParts = options.scope.split('/');
      while (scopeParts.length > 0) {
        scopeParts.pop();
        const parentScope = scopeParts.join('/') || 'global';

        const parentResult = await this.recall({
          ...options,
          scope: parentScope,
          includeAncestors: false,
        });

        if (parentResult) return parentResult;
      }
    }

    return null;
  }

  /**
   * Retrieves all remembered context entries for this object in a scope.
   *
   * Returns a `Map<key, value>` for every entry owned by this object that matches
   * the scope and optional filters. When `includeDescendants: true`, a LIKE query
   * (`scope%`) matches the scope itself and all child scopes.
   *
   * @param options.scope - Optional scope path filter; omit to retrieve all scopes
   * @param options.includeDescendants - If `true`, match `scope` and all child scopes (default `false`)
   * @param options.minConfidence - Only include entries at or above this confidence (0–1)
   * @returns `Map<string, any>` of key → JSON-parsed value pairs
   * @throws Error if `initialize()` has not been called
   *
   * @example
   * ```typescript
   * const strategies = await agent.recallAll({
   *   scope: 'parser/example.com',
   *   minConfidence: 0.5,
   * });
   * for (const [url, pattern] of strategies) {
   *   console.log(`Cached pattern for ${url}:`, pattern);
   * }
   * ```
   *
   * @see {@link recall} to retrieve a single entry by key
   * @see {@link forgetScope} to delete all entries in a scope
   */
  public async recallAll(
    options: {
      scope?: string;
      includeDescendants?: boolean;
      minConfidence?: number;
    } = {},
  ): Promise<Map<string, any>> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const results = new Map<string, any>();

    // Build where clause for db.list()
    const where: Record<string, any> = {
      owner_class: this._className,
      owner_id: this.id,
    };

    if (options.scope) {
      if (options.includeDescendants) {
        // Use LIKE pattern to match scope and all descendants
        // Pattern 'scope%' matches both 'scope' and 'scope/child'
        where['scope like'] = `${options.scope}%`;
      } else {
        where.scope = options.scope;
      }
    }

    if (options.minConfidence !== undefined) {
      where['confidence >='] = options.minConfidence;
    }

    const rows = await this.systemDb.list('_smrt_contexts', where);

    for (const row of rows) {
      results.set(row.key, JSON.parse(row.value));
    }

    return results;
  }

  /**
   * Deletes a specific remembered context entry for this object.
   *
   * Removes the entry matching `(owner_class, owner_id, scope, key)`. A no-op
   * if the entry does not exist.
   *
   * @param options.scope - Scope path of the entry to delete
   * @param options.key - Key of the entry to delete
   * @returns Promise that resolves when the entry is deleted
   * @throws Error if `initialize()` has not been called
   *
   * @example
   * ```typescript
   * await agent.forget({ scope: 'parser/example.com', key: normalizedUrl });
   * ```
   *
   * @see {@link forgetScope} to delete all entries in a scope at once
   * @see {@link remember} to store a context entry
   */
  public async forget(options: { scope: string; key: string }): Promise<void> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    await this.systemDb.delete('_smrt_contexts', {
      owner_class: this._className,
      owner_id: this.id,
      scope: options.scope,
      key: options.key,
    });
  }

  /**
   * Deletes all remembered context entries in a scope for this object.
   *
   * When `includeDescendants: true`, uses a LIKE query (`scope%`) that matches
   * the scope itself and all child scopes (e.g. `'parser/example.com'` also
   * deletes `'parser/example.com/article'`).
   *
   * @param options.scope - Scope path to clear
   * @param options.includeDescendants - If `true`, also delete all child scopes (default `false`)
   * @returns Number of context entries deleted
   * @throws Error if `initialize()` has not been called
   *
   * @example
   * ```typescript
   * const count = await agent.forgetScope({
   *   scope: 'parser/example.com',
   *   includeDescendants: true,
   * });
   * console.log(`Cleared ${count} cached strategies`);
   * ```
   *
   * @see {@link forget} to delete a single entry by key
   * @see {@link recallAll} to bulk-retrieve before clearing
   */
  public async forgetScope(options: {
    scope: string;
    includeDescendants?: boolean;
  }): Promise<number> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    // Build where clause for db.delete()
    const where: Record<string, any> = {
      owner_class: this._className,
      owner_id: this.id,
    };

    if (options.includeDescendants) {
      // Use LIKE pattern to match scope and all descendants
      where['scope like'] = `${options.scope}%`;
    } else {
      where.scope = options.scope;
    }

    const result = await this.systemDb.delete('_smrt_contexts', where);
    return result.affected || 0;
  }

  // ============================================================================
  // Embedding Methods for Semantic Search
  // ============================================================================

  /**
   * Generate embeddings for configured fields
   *
   * Creates embedding vectors for fields configured in the @smrt decorator
   * and stores them in the _smrt_embeddings system table. Uses content hashing
   * to detect changes and avoid regenerating unchanged content.
   *
   * @param options - Generation options
   * @returns Promise that resolves when embeddings are generated
   * @throws Error if no embedding configuration or database not initialized
   *
   * @example
   * ```typescript
   * // Generate embeddings for all configured fields
   * await article.generateEmbeddings();
   *
   * // Generate only for specific fields
   * await article.generateEmbeddings({ fields: ['title'] });
   *
   * // Force regeneration (ignore content hash)
   * await article.generateEmbeddings({ force: true });
   * ```
   */
  public async generateEmbeddings(
    options: GenerateEmbeddingsOptions = {},
  ): Promise<void> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    if (!this.id) {
      throw new Error('Object must have an ID before generating embeddings.');
    }

    // Get embedding configuration for this class
    const config = ObjectRegistry.resolveEmbeddingConfig(this.constructor.name);
    if (!config) {
      throw new Error(
        `No embedding configuration found for ${this.constructor.name}. ` +
          `Add embeddings config to the @smrt() decorator.`,
      );
    }

    // Determine which fields to process
    const fieldsToProcess = options.fields || config.fields;
    const provider = options.provider || config.provider;

    // Create embedding provider
    const embeddingProvider = new EmbeddingProvider(
      {
        dimensions: config.dimensions,
        provider,
        localModel: config.localModel,
        aiModel: config.aiModel,
        fallbackToAI: config.fallbackToAI,
      },
      this._ai,
    );

    // Resolve vector capabilities for native storage
    const projectConfig = ObjectRegistry.getProjectEmbeddingConfig();
    const vector =
      projectConfig?.storage === 'native' ? this.systemDb.vector : undefined;

    // Process each field
    for (const fieldName of fieldsToProcess) {
      const content = this.getPropertyValue(fieldName);
      if (!content || typeof content !== 'string') {
        continue; // Skip empty or non-string fields
      }

      // Check content hash to avoid regenerating unchanged content
      const contentHash = ContentHasher.hash(content);

      if (!options.force) {
        const existing = await EmbeddingStorage.get(
          this.systemDb,
          this.constructor.name,
          this.id,
          fieldName,
          embeddingProvider.getModelName(),
        );

        if (existing && existing.content_hash === contentHash) {
          continue; // Content unchanged, skip regeneration
        }
      }

      // Generate embedding
      const embeddings = await embeddingProvider.embed(content);
      const embedding = embeddings[0];

      // Store embedding (with optional native vector storage)
      await EmbeddingStorage.upsert(
        this.systemDb,
        {
          objectClass: this.constructor.name,
          objectId: this.id,
          fieldName,
          contentHash,
          embedding,
          model: embeddingProvider.getModelName(),
          dimensions: config.dimensions,
          provider,
        },
        vector,
      );
    }

    // Handle combined field if configured
    if (config.combinedField) {
      const { name, template } = config.combinedField;

      // Build combined content from template
      let combinedContent = template;
      for (const fieldName of config.fields) {
        const value = this.getPropertyValue(fieldName) || '';
        combinedContent = combinedContent.replace(
          new RegExp(`\\{${fieldName}\\}`, 'g'),
          String(value),
        );
      }

      if (combinedContent.trim()) {
        const contentHash = ContentHasher.hash(combinedContent);

        if (!options.force) {
          const existing = await EmbeddingStorage.get(
            this.systemDb,
            this.constructor.name,
            this.id,
            name,
            embeddingProvider.getModelName(),
          );

          if (existing && existing.content_hash === contentHash) {
            return; // Combined content unchanged
          }
        }

        const embeddings = await embeddingProvider.embed(combinedContent);
        const embedding = embeddings[0];

        await EmbeddingStorage.upsert(
          this.systemDb,
          {
            objectClass: this.constructor.name,
            objectId: this.id,
            fieldName: name,
            contentHash,
            embedding,
            model: embeddingProvider.getModelName(),
            dimensions: config.dimensions,
            provider,
          },
          vector,
        );
      }
    }
  }

  /**
   * Get stored embedding for a field
   *
   * Retrieves the embedding vector for a specific field from storage.
   * Returns null if no embedding exists for the field.
   *
   * @param fieldName - Name of the field to get embedding for
   * @param model - Optional model name (defaults to configured model)
   * @returns Promise resolving to embedding vector or null
   *
   * @example
   * ```typescript
   * const embedding = await article.getEmbedding('title');
   * if (embedding) {
   *   console.log(`Embedding has ${embedding.length} dimensions`);
   * }
   * ```
   */
  public async getEmbedding(
    fieldName: string,
    model?: string,
  ): Promise<number[] | null> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    if (!this.id) {
      return null;
    }

    // Determine model name using EmbeddingProvider for consistency with generateEmbeddings()
    let modelName = model;
    if (!modelName) {
      const config = ObjectRegistry.resolveEmbeddingConfig(
        this.constructor.name,
      );
      if (config) {
        // Create EmbeddingProvider to get consistent model name
        const provider = new EmbeddingProvider(
          {
            dimensions: config.dimensions,
            provider: config.provider,
            localModel: config.localModel,
            aiModel: config.aiModel,
            fallbackToAI: config.fallbackToAI,
          },
          this._ai,
        );
        modelName = provider.getModelName();
      } else {
        // Fallback to default
        modelName = 'Xenova/bge-base-en-v1.5';
      }
    }

    const stored = await EmbeddingStorage.get(
      this.systemDb,
      this.constructor.name,
      this.id,
      fieldName,
      modelName,
    );

    return stored?.embedding || null;
  }

  /**
   * Check if any embeddings are stale (content has changed)
   *
   * Compares content hashes of configured fields with stored embeddings
   * to determine if regeneration is needed.
   *
   * @returns Promise resolving to true if any embeddings are stale
   *
   * @example
   * ```typescript
   * if (await article.hasStaleEmbeddings()) {
   *   await article.generateEmbeddings();
   * }
   * ```
   */
  public async hasStaleEmbeddings(): Promise<boolean> {
    if (!this.systemDb || !this.id) {
      return false;
    }

    const config = ObjectRegistry.resolveEmbeddingConfig(this.constructor.name);
    if (!config) {
      return false;
    }

    // Get stored embeddings for this object
    const storedEmbeddings = await EmbeddingStorage.getForObject(
      this.systemDb,
      this.constructor.name,
      this.id,
    );

    // Check each configured field
    for (const fieldName of config.fields) {
      const content = this.getPropertyValue(fieldName);
      if (!content || typeof content !== 'string') {
        continue;
      }

      const currentHash = ContentHasher.hash(content);
      const stored = storedEmbeddings.find((e) => e.field_name === fieldName);

      if (!stored) {
        return true; // No embedding exists
      }

      if (stored.content_hash !== currentHash) {
        return true; // Content has changed
      }
    }

    // Check combined field if configured
    if (config.combinedField) {
      let combinedContent = config.combinedField.template;
      for (const fieldName of config.fields) {
        const value = this.getPropertyValue(fieldName) || '';
        combinedContent = combinedContent.replace(
          new RegExp(`\\{${fieldName}\\}`, 'g'),
          String(value),
        );
      }

      const currentHash = ContentHasher.hash(combinedContent);
      const stored = storedEmbeddings.find(
        (e) => e.field_name === config.combinedField?.name,
      );

      if (!stored || stored.content_hash !== currentHash) {
        return true;
      }
    }

    return false;
  }

  /**
   * Clear all embeddings for this object
   *
   * Removes all stored embeddings from the _smrt_embeddings table.
   * Useful when deleting objects or resetting embedding state.
   *
   * @returns Promise that resolves when embeddings are cleared
   *
   * @example
   * ```typescript
   * await article.clearEmbeddings();
   * ```
   */
  public async clearEmbeddings(): Promise<void> {
    if (!this.systemDb || !this.id) {
      return;
    }

    await EmbeddingStorage.deleteForObject(
      this.systemDb,
      this.constructor.name,
      this.id,
    );
  }
}
