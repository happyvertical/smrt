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
import {
  executeToolCall as executeToolCallInternal,
  type ToolCall,
  type ToolCallResult,
} from './tools/tool-executor';
import { fieldsFromClass, tableNameFromClass, toSnakeCase } from './utils';

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
 * Core persistent object with unique identifiers and database storage
 *
 * SmrtObject provides functionality for creating, loading, and saving objects
 * to a database. It supports identification via unique IDs and URL-friendly
 * slugs, with optional context scoping.
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
   * Initializes this object, setting up database tables and loading data if identifiers are provided
   *
   * @returns Promise that resolves to this instance for chaining
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
      if (formattedData._meta_type !== this.constructor.name) {
        throw new Error(
          `STI validation failed: Type mismatch when loading ${this.constructor.name}. ` +
            `Database row has _meta_type='${formattedData._meta_type}' but expected '${this.constructor.name}'. ` +
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
   * Hook for customizing JSON serialization
   *
   * Override this method to add custom fields or transform serialized data.
   * This is the **recommended way** to customize serialization.
   *
   * **DO NOT override toJSON() directly** as it handles critical framework infrastructure:
   * - STI discriminator (`_meta_type`) assignment
   * - Meta field extraction (`_meta_data`)
   * - Field serialization from manifest
   *
   * @param data - Serialized object data from framework
   * @returns Transformed data (can add/modify/remove fields)
   *
   * @example
   * ```typescript
   * class Article extends SmrtObject {
   *   protected transformJSON(data: any): any {
   *     return {
   *       ...data,
   *       wordCount: this.body.split(/\s+/).length,
   *       preview: this.body.substring(0, 100)
   *     };
   *   }
   * }
   * ```
   *
   * @see https://github.com/happyvertical/smrt/issues/377
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
      data._meta_type = this.constructor.name;
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
          // For TEXT fields, convert undefined to an empty string.
          if (isSTI && fieldDef?.type === 'meta') {
            data._meta_data[key] = '';
          } else {
            data[key] = '';
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
   * Gets or generates a slug for this object
   *
   * Fallback order: name → title → label → id
   *
   * @returns Promise resolving to the object's slug
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
   * Saves this object to the database
   *
   * @returns Promise resolving to this object
   */
  async save() {
    try {
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

      // Verify table exists (tables must be created via smrt db:setup or smrt db:migrate)
      // This replaces automatic schema creation which caused race conditions (issue #665)
      if (this.db) {
        const tableName = this.tableName;
        const tableExists = await this.db.tableExists(tableName);
        if (!tableExists) {
          throw DatabaseError.schemaMissing(tableName, this.constructor.name);
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
        if (jsonData._meta_type !== this.constructor.name) {
          throw new Error(
            `STI validation failed: _meta_type mismatch when saving ${this.constructor.name}. ` +
              `Expected '${this.constructor.name}' but got '${jsonData._meta_type}'. ` +
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

      // STI: Include _meta_type in conflict columns
      const conflictColumns =
        tableStrategy === 'sti'
          ? ['slug', 'context', '_meta_type']
          : ['slug', 'context'];

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
    // Use cached validators from ObjectRegistry for efficient validation
    const validators = ObjectRegistry.getValidators(this.constructor.name);

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
    } else {
      // Fallback to old validation logic if no cached validators
      // (for classes not registered with ObjectRegistry)
      const fields = await fieldsFromClass(this.constructor as any);

      for (const [fieldName, field] of Object.entries(fields)) {
        // With decorators, field definitions are plain objects with nested options
        if ((field as any).options?.required) {
          const value = this.getFieldValue(fieldName);
          if (value === null || value === undefined || value === '') {
            throw ValidationError.requiredField(
              fieldName,
              this.constructor.name,
            );
          }
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
   * Gets the actual value from a property, whether it's a plain value or a Field instance
   *
   * Handles both simple and advanced field patterns:
   * - Simple: `name: string = ''` - returns the string directly
   * - Advanced: `name = text()` - extracts and returns field.value
   *
   * @param key - Property name to extract value from
   * @returns The actual value (unwrapped from Field if necessary)
   */
  protected getPropertyValue(key: string): any {
    const prop = (this as any)[key];

    // If it's a Field instance, return its value
    if (prop && typeof prop === 'object' && 'value' in prop && 'type' in prop) {
      return prop.value;
    }

    // Otherwise return the property directly
    return prop;
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
   * Loads this object's data from the database using its ID
   *
   * @returns Promise that resolves when loading is complete
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
   * Loads this object's data from the database using its slug and context
   *
   * @returns Promise that resolves when loading is complete
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
   * Evaluates whether this object meets given criteria using AI
   *
   * @param criteria - Criteria to evaluate against
   * @param options - AI message options
   * @returns Promise resolving to true if criteria are met, false otherwise
   * @throws Error if the AI response is invalid
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
   * Performs actions on this object based on instructions using AI
   *
   * @param instructions - Instructions for the AI to follow
   * @param options - AI message options
   * @returns Promise resolving to the AI response
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
   * Delete this object from the database
   *
   * @returns Promise that resolves when deletion is complete
   */
  public async delete(): Promise<void> {
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
   * Load a related object for a foreignKey field (lazy loading)
   *
   * Automatically loads the related object from the database using the
   * foreign key value. The loaded object is cached to avoid repeated queries.
   *
   * @param fieldName - Name of the foreignKey field
   * @returns Promise resolving to the related object or null if not found
   * @throws {RuntimeError} If the field is not a foreignKey or target class not found
   * @example
   * ```typescript
   * // Given: class Order with customerId = foreignKey(Customer)
   * const customer = await order.loadRelated('customerId');
   * console.log(customer.name); // Access customer properties
   * ```
   */
  public async loadRelated(fieldName: string): Promise<any> {
    // Check if already loaded
    if (this._loadedRelationships.has(fieldName)) {
      return this._loadedRelationships.get(fieldName);
    }

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
        const actualClass = ObjectRegistry.getClass(row._meta_type);
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
   * Remember context about this object
   *
   * Stores hierarchical context with confidence tracking for learned patterns.
   * Context is stored in the _smrt_contexts system table.
   *
   * @param options - Context options
   * @returns Promise that resolves when context is stored
   * @example
   * ```typescript
   * // Remember a discovered parsing strategy
   * await agent.remember({
   *   scope: 'discovery/parser/example.com',
   *   key: normalizedUrl,
   *   value: { patterns: ['regex1', 'regex2'] },
   *   metadata: { aiProvider: 'openai' },
   *   confidence: 0.9
   * });
   *
   * // Update an existing context entry by specifying id
   * await agent.remember({
   *   id: 'existing-context-id',
   *   scope: 'discovery/parser/example.com',
   *   key: normalizedUrl,
   *   value: { patterns: ['regex1', 'regex2', 'regex3'] },
   *   confidence: 0.95
   * });
   * ```
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
   * Recall remembered context for this object
   *
   * Retrieves context values with hierarchical search and confidence filtering.
   * Returns only the value (parsed from JSON if applicable).
   *
   * @param options - Recall options
   * @returns Promise resolving to the context value or null if not found
   * @example
   * ```typescript
   * // Recall a strategy with fallback to parent scopes
   * const strategy = await agent.recall({
   *   scope: 'discovery/parser/example.com/article',
   *   key: normalizedUrl,
   *   includeAncestors: true,
   *   minConfidence: 0.6
   * });
   * ```
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
   * Recall all remembered context for this object in a scope
   *
   * Returns a Map of key -> value for all context matching the criteria.
   * Useful for bulk retrieval of strategies or cached patterns.
   *
   * @param options - Recall options without key (returns all keys in scope)
   * @returns Promise resolving to Map of key -> value pairs
   * @example
   * ```typescript
   * // Get all strategies for a domain
   * const strategies = await agent.recallAll({
   *   scope: 'discovery/parser/example.com',
   *   minConfidence: 0.5
   * });
   *
   * for (const [url, pattern] of strategies) {
   *   console.log(`Cached pattern for ${url}:`, pattern);
   * }
   * ```
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
   * Forget specific remembered context for this object
   *
   * Deletes context by scope and key. Use for invalidating cached strategies
   * or removing outdated patterns.
   *
   * @param options - Context identification (scope and key required)
   * @returns Promise that resolves when context is deleted
   * @example
   * ```typescript
   * // Remove an outdated strategy
   * await agent.forget({
   *   scope: 'discovery/parser/example.com',
   *   key: normalizedUrl
   * });
   * ```
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
   * Forget all remembered context in a scope for this object
   *
   * Deletes all context matching the scope pattern. Useful for clearing
   * cached strategies for an entire domain or category.
   *
   * @param options - Scope options (scope required, includeDescendants optional)
   * @returns Promise resolving to number of contexts deleted
   * @example
   * ```typescript
   * // Clear all strategies for a domain
   * const count = await agent.forgetScope({
   *   scope: 'discovery/parser/example.com',
   *   includeDescendants: true
   * });
   * console.log(`Cleared ${count} cached strategies`);
   * ```
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

      // Store embedding
      await EmbeddingStorage.upsert(this.systemDb, {
        objectClass: this.constructor.name,
        objectId: this.id,
        fieldName,
        contentHash,
        embedding,
        model: embeddingProvider.getModelName(),
        dimensions: config.dimensions,
        provider,
      });
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

        await EmbeddingStorage.upsert(this.systemDb, {
          objectClass: this.constructor.name,
          objectId: this.id,
          fieldName: name,
          contentHash,
          embedding,
          model: embeddingProvider.getModelName(),
          dimensions: config.dimensions,
          provider,
        });
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
