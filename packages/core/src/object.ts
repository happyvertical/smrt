// import type { AIMessageOptions } from '@have/ai';

import type { AITool } from '@have/ai';
import type { SmrtClassOptions } from './class';
import { SmrtClass } from './class';
import {
  DatabaseError,
  ErrorUtils,
  RuntimeError,
  ValidationError,
} from './errors';
import { Field } from './fields/index';
import { ObjectRegistry } from './registry';
import {
  executeToolCall as executeToolCallInternal,
  type ToolCall,
  type ToolCallResult,
} from './tools/tool-executor';
import {
  fieldsFromClass,
  setupTableFromClass,
  tableNameFromClass,
  toSnakeCase,
} from './utils';

/**
 * Options for SmrtObject initialization
 */
export interface SmrtObjectOptions extends SmrtClassOptions {
  /**
   * Unique identifier for the object
   */
  id?: string;

  /**
   * Human-readable name for the object
   */
  name?: string;

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
  protected declare options: SmrtObjectOptions;

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
   * Human-readable name, primarily for display purposes
   * Can be a string value or a Field instance (for Field-based schema definition)
   */
  public name?: string | Field | null = null;

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
   * Initialize properties from options after field initializers have run
   * This ensures option values take precedence over default field initializer values
   */
  private initializePropertiesFromOptions(): void {
    const options = this.options;

    // Set base properties that exist on SmrtObject
    if (options.name !== undefined) this.name = options.name;
    if (options.created_at !== undefined) this.created_at = options.created_at;
    if (options.updated_at !== undefined) this.updated_at = options.updated_at;

    // Get all fields (both Field instances and plain properties)
    const fields = fieldsFromClass(
      this.constructor as new (
        ...args: any[]
      ) => any,
    );

    // Apply option values to all fields
    for (const [key, field] of Object.entries(fields)) {
      if (options[key] !== undefined) {
        // Set the property value
        this[key as keyof this] = options[key];

        // If it's a Field instance, also update field.value
        if (field instanceof Field) {
          field.value = options[key];
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
    if (!this.options._extractingFields) {
      this.initializePropertiesFromOptions();
    }

    // Setup database tables if database is configured
    if (this.options.db) {
      await setupTableFromClass(this.db, this.constructor);
      // Note: SchemaGenerator already creates the unique index on (slug, context)
      // No need to create it manually here
    }

    if (this._id && !(this.options as any)._skipLoad) {
      await this.loadFromId();
    } else if (this._slug && !(this.options as any)._skipLoad) {
      await this.loadFromSlug();
    }

    return this;
  }

  /**
   * Loads data from a database row into this object's properties
   *
   * @param data - Database row data
   */
  loadDataFromDb(data: any) {
    const fields = this.getFields();
    for (const field in fields) {
      if (Object.hasOwn(fields, field)) {
        this[field as keyof this] = data[field];
      }
    }
  }

  /**
   * Gets all property descriptors from this object's prototype
   *
   * @returns Object containing all property descriptors
   */
  allDescriptors() {
    const proto = Object.getPrototypeOf(this);
    const descriptors = Object.getOwnPropertyDescriptors(proto);
    return descriptors;
  }

  /**
   * Gets the database table name for this object
   */
  get tableName() {
    if (!this._tableName) {
      this._tableName = tableNameFromClass(this.constructor);
    }
    return this._tableName;
  }

  /**
   * Gets field definitions and current values for this object
   *
   * @returns Object containing field definitions with current values
   */
  getFields() {
    // Use cached field definitions from ObjectRegistry (via fieldsFromClass)
    // This is much more efficient than creating temporary instances
    const fields = fieldsFromClass(
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
   * Custom JSON serialization
   * Returns a plain object with all field values for proper JSON.stringify() behavior
   * Field instances automatically call their toJSON() method during serialization
   */
  toJSON() {
    const fields = this.getFields();
    const data: any = {
      id: this.id,
      slug: this.slug,
      context: this.context,
      name: this.name,
      created_at: this.created_at,
      updated_at: this.updated_at,
    };

    // Add all field values
    // Field.toJSON() is called automatically for Field instances
    for (const [key, field] of Object.entries(fields)) {
      data[key] = field.value;
    }

    return data;
  }

  /**
   * Gets or generates a unique ID for this object
   *
   * @returns Promise resolving to the object's ID
   */
  async getId() {
    // lookup by slug and context
    const saved = await this.db
      .pluck`SELECT id FROM ${this.tableName} WHERE slug = ${this.slug} AND context = ${this.context} LIMIT 1`;
    if (saved) {
      this.id = saved;
    }

    if (!this.id) {
      this.id = crypto.randomUUID();
    }
    return this.id;
  }

  /**
   * Gets or generates a slug for this object based on its name
   *
   * @returns Promise resolving to the object's slug
   */
  async getSlug() {
    if (!this.slug && this.name) {
      // Generate slug from name if not set
      // Explicitly convert Field to string for TypeScript
      const nameStr = String(this.name);
      this.slug = nameStr
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
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
    const { pluck } = this.db;
    const saved =
      await pluck`SELECT id FROM ${this.tableName} WHERE id = ${this.id} OR slug = ${this.slug} LIMIT 1`;
    return saved;
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

      // Setup database table with proper error handling
      try {
        await setupTableFromClass(this.db, this.constructor);
      } catch (error) {
        throw DatabaseError.schemaError(
          this._tableName || this.constructor.name,
          'table setup',
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      // Execute save operation with retry logic for transient failures
      // Use per-adapter upsert method instead of generating SQL
      const jsonData = this.toJSON();

      // Convert camelCase keys to snake_case for database columns
      const data: Record<string, any> = {};
      for (const [key, value] of Object.entries(jsonData)) {
        data[toSnakeCase(key)] = value;
      }

      await ErrorUtils.withRetry(
        async () => {
          try {
            await this.db.upsert(this.tableName, ['slug', 'context'], data);
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
      const fields = fieldsFromClass(this.constructor as any);

      for (const [fieldName, field] of Object.entries(fields)) {
        if (field instanceof Field && field.options.required) {
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

      const sql = `SELECT * FROM ${this.tableName} WHERE id = ?`;

      await ErrorUtils.withRetry(
        async () => {
          try {
            const {
              rows: [existing],
            } = await this.db.query(sql, [this._id]);
            if (existing) {
              this.loadDataFromDb(existing);
            }
          } catch (error) {
            throw DatabaseError.queryFailed(
              sql,
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
    const {
      rows: [existing],
    } = await this.db.query(
      `SELECT * FROM ${this.tableName} WHERE slug = ? AND context = ?`,
      [this._slug, this._context || ''],
    );
    if (existing) {
      this.loadDataFromDb(existing);
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
    await this.runHook('beforeDelete');

    await this.db.query(`DELETE FROM ${this.tableName} WHERE id = ?`, [
      this.id,
    ]);

    await this.runHook('afterDelete');
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

    // Create an instance and load by ID
    const relatedInstance = new targetClassInfo.constructor(this.options);
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

    await this.systemDb.query(
      `INSERT OR REPLACE INTO _smrt_contexts (
        id, owner_class, owner_id, scope, key, value, metadata,
        version, confidence, created_at, updated_at, last_used_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      this._className,
      this.id,
      options.scope,
      options.key,
      JSON.stringify(options.value),
      options.metadata ? JSON.stringify(options.metadata) : null,
      options.version ?? 1,
      options.confidence ?? 1.0,
      now,
      now,
      now,
      options.expiresAt ?? null,
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

    let query = `
      SELECT value, confidence
      FROM _smrt_contexts
      WHERE owner_class = ? AND owner_id = ? AND scope = ? AND key = ?
    `;
    const params: any[] = [
      this._className,
      this.id,
      options.scope,
      options.key,
    ];

    if (options.minConfidence !== undefined) {
      query += ` AND confidence >= ?`;
      params.push(options.minConfidence);
    }

    query += ` ORDER BY confidence DESC, version DESC LIMIT 1`;

    const result = await this.systemDb.get(query, params);

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

    let query = `
      SELECT key, value, confidence
      FROM _smrt_contexts
      WHERE owner_class = ? AND owner_id = ?
    `;
    const params: any[] = [this._className, this.id];

    if (options.scope) {
      if (options.includeDescendants) {
        query += ` AND (scope = ? OR scope LIKE ?)`;
        params.push(options.scope, `${options.scope}/%`);
      } else {
        query += ` AND scope = ?`;
        params.push(options.scope);
      }
    }

    if (options.minConfidence !== undefined) {
      query += ` AND confidence >= ?`;
      params.push(options.minConfidence);
    }

    query += ` ORDER BY confidence DESC`;

    const { rows } = await this.systemDb.query(query, ...params);

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

    await this.systemDb.query(
      `DELETE FROM _smrt_contexts
       WHERE owner_class = ? AND owner_id = ? AND scope = ? AND key = ?`,
      this._className,
      this.id,
      options.scope,
      options.key,
    );
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

    let query = `
      DELETE FROM _smrt_contexts
      WHERE owner_class = ? AND owner_id = ?
    `;
    const params: any[] = [this._className, this.id];

    if (options.includeDescendants) {
      query += ` AND (scope = ? OR scope LIKE ?)`;
      params.push(options.scope, `${options.scope}/%`);
    } else {
      query += ` AND scope = ?`;
      params.push(options.scope);
    }

    const { rowCount } = await this.systemDb.query(query, ...params);
    return rowCount || 0;
  }
}
