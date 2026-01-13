import { buildWhere } from '@happyvertical/sql';
import type { SmrtClassOptions } from './class';
import { SmrtClass } from './class';
import { EmbeddingProvider } from './embeddings/provider';
import { CosineSimilarity } from './embeddings/similarity';
import { EmbeddingStorage } from './embeddings/storage';
import {
  createInterceptorContext,
  GlobalInterceptors,
  type ListOptions as InterceptorListOptions,
} from './interceptors';
import type { SmrtObject } from './object';
import { ObjectRegistry } from './registry';
import { generateSchema } from './schema/utils';
import {
  fieldsFromClass,
  formatDataJs,
  formatDataSql,
  tableNameFromClass,
  toSnakeCase,
} from './utils';

/**
 * Resolve _meta_type in WHERE clause from simple class name to qualified name (Issue #713)
 *
 * This helper function allows queries like { _meta_type: 'Image' } to work correctly
 * when the database stores qualified names like '@happyvertical/smrt-assets:Image'.
 *
 * @param where - The original WHERE clause object
 * @returns Modified WHERE clause with qualified _meta_type, or original if no resolution needed
 */
function resolveMetaTypeInWhere<T extends Record<string, unknown>>(
  where: T | undefined,
): T | undefined {
  if (!where?._meta_type || typeof where._meta_type !== 'string') {
    return where;
  }

  const metaTypeValue = where._meta_type as string;

  // Only resolve if it's a simple class name (no ':' means not qualified)
  if (metaTypeValue.includes(':')) {
    return where;
  }

  const registeredClass = ObjectRegistry.getClass(metaTypeValue);
  if (registeredClass?.qualifiedName) {
    return {
      ...where,
      _meta_type: registeredClass.qualifiedName,
    };
  }

  return where;
}

/**
 * Configuration options for SmrtCollection
 */
export interface SmrtCollectionOptions extends SmrtClassOptions {}

/**
 * Collection interface for managing sets of SmrtObjects
 *
 * SmrtCollection provides methods for querying, creating, and managing
 * collections of persistent objects. It handles database setup, schema
 * generation, and provides a fluent interface for querying objects.
 */
export class SmrtCollection<ModelType extends SmrtObject> extends SmrtClass {
  /**
   * Cached fields for sync access during queries.
   * Populated during create() to avoid async getFields() calls on every query.
   * @private
   */
  private _cachedFields: Map<string, any> | null = null;

  /**
   * Convert WHERE clause field names from camelCase to snake_case while preserving operators.
   * Validates operators and field names to prevent SQL injection and invalid queries.
   *
   * Uses cached fields for sync access (issue #663) to avoid async overhead on every query.
   *
   * @param where - WHERE clause object with camelCase field names
   * @returns WHERE clause object with snake_case field names
   * @private
   *
   * @example
   * ```typescript
   * // Input: { 'typeId': 'foo', 'categoryId >': 100 }
   * // Output: { 'type_id': 'foo', 'category_id >': 100 }
   * ```
   */
  private convertWhereKeys(where: Record<string, any>): Record<string, any> {
    // Whitelist of allowed SQL operators
    const VALID_OPERATORS = ['=', '>', '<', '>=', '<=', '!=', 'in', 'like'];

    // Get schema fields for validation (sync from cache)
    const fields = this.getFieldsSync();
    const validFieldNames = new Set(
      Object.keys(fields).map((f) => toSnakeCase(f)),
    );

    // Add standard SMRT fields that are always valid
    validFieldNames.add('id');
    validFieldNames.add('slug');
    validFieldNames.add('context');
    validFieldNames.add('created_at');
    validFieldNames.add('updated_at');

    // Add STI discriminator field for polymorphic queries
    const tableStrategy = ObjectRegistry.getTableStrategy(this._itemClass.name);
    if (tableStrategy === 'sti') {
      // Add both with and without leading underscore (toSnakeCase strips leading _)
      validFieldNames.add('_meta_type');
      validFieldNames.add('meta_type');
      validFieldNames.add('_meta_data');
      validFieldNames.add('meta_data');
    }

    const converted: Record<string, any> = {};

    // Check for prototype pollution attempts using own properties only
    // __proto__ is a special property that doesn't show up in Object.entries()
    // but can still be checked with hasOwnProperty
    if (
      Object.hasOwn(where, '__proto__') ||
      Object.hasOwn(where, 'constructor') ||
      Object.hasOwn(where, 'prototype')
    ) {
      throw new Error(
        `Invalid WHERE clause: Prototype pollution attempts are not allowed. ` +
          `Detected dangerous properties in WHERE clause.`,
      );
    }

    for (const [key, value] of Object.entries(where)) {
      // Split field name and operator (e.g., "typeId >" → ["typeId", ">"])
      const parts = key.trim().split(/\s+/);
      const fieldName = parts[0];
      const operator = parts.slice(1).join(' ') || '=';

      // Check for dangerous prototype pollution field names
      if (
        fieldName === '__proto__' ||
        fieldName === 'constructor' ||
        fieldName === 'prototype' ||
        fieldName.includes('__proto__') ||
        fieldName.includes('constructor') ||
        fieldName.includes('prototype')
      ) {
        throw new Error(
          `Invalid WHERE clause field: '${fieldName}'. ` +
            `Prototype pollution attempts are not allowed.`,
        );
      }

      // Convert field name to snake_case, preserving leading underscores for special fields
      const snakeFieldName = fieldName.startsWith('_')
        ? `_${toSnakeCase(fieldName.slice(1))}`
        : toSnakeCase(fieldName);

      // Auto-detect IN operator when value is an array without explicit operator
      const effectiveOperator =
        operator === '=' && Array.isArray(value) ? 'in' : operator;

      // Validate operator
      if (!VALID_OPERATORS.includes(effectiveOperator)) {
        throw new Error(
          `Invalid WHERE clause operator: '${operator}'. ` +
            `Valid operators: ${VALID_OPERATORS.join(', ')}`,
        );
      }

      // Validate field name exists in schema
      if (!validFieldNames.has(snakeFieldName)) {
        throw new Error(
          `Invalid WHERE clause field: '${fieldName}'. ` +
            `Field does not exist on ${this._itemClass.name}. ` +
            `Valid fields: ${Array.from(validFieldNames).sort().join(', ')}`,
        );
      }

      // Validate operator-specific value types
      if (effectiveOperator === 'in' && !Array.isArray(value)) {
        throw new Error(
          `WHERE clause operator 'in' requires an array value for field '${fieldName}', ` +
            `got ${typeof value}`,
        );
      }

      // Reject empty arrays for IN operator (generates invalid SQL "IN ()")
      if (
        effectiveOperator === 'in' &&
        Array.isArray(value) &&
        value.length === 0
      ) {
        throw new Error(
          `WHERE clause operator 'in' requires a non-empty array for field '${fieldName}'. ` +
            `Use listByIds([]) for graceful empty array handling.`,
        );
      }

      if (effectiveOperator === 'like' && typeof value !== 'string') {
        throw new Error(
          `WHERE clause operator 'like' requires a string value for field '${fieldName}', ` +
            `got ${typeof value}`,
        );
      }

      // Reconstruct key with operator
      const newKey =
        effectiveOperator === '='
          ? snakeFieldName
          : `${snakeFieldName} ${effectiveOperator}`;

      converted[newKey] = value;
    }

    return converted;
  }

  /**
   * Gets the class constructor for items in this collection
   */
  protected get _itemClass(): (new (
    options: any,
  ) => ModelType) & {
    create(options: any): ModelType | Promise<ModelType>;
  } {
    const ctor = this.constructor as {
      readonly _itemClass?: (new (
        options: any,
      ) => ModelType) & {
        create(options: any): ModelType | Promise<ModelType>;
      };
    };
    if (!ctor._itemClass) {
      const className = this.constructor.name;
      const errorMessage = [
        `Collection "${className}" must define a static _itemClass property.`,
        '',
        'Example:',
        `  class ${className} extends SmrtCollection<YourItemClass> {`,
        '    static readonly _itemClass = YourItemClass;',
        '  }',
        '',
        'Make sure your item class is imported and defined before the collection class.',
      ].join('\n');

      throw new Error(errorMessage);
    }
    return ctor._itemClass;
  }

  /**
   * Static reference to the item class constructor
   */
  static readonly _itemClass: any;

  /**
   * Validates that the collection is properly configured
   * Call this during development to catch configuration issues early
   */
  static validate(): void {
    if (!SmrtCollection._itemClass) {
      const className = SmrtCollection.name;
      const errorMessage = [
        `Collection "${className}" is missing required static _itemClass property.`,
        '',
        'Fix by adding:',
        `  class ${className} extends SmrtCollection<YourItemClass> {`,
        '    static readonly _itemClass = YourItemClass;',
        '  }',
      ].join('\n');
      throw new Error(errorMessage);
    }

    // Validate that _itemClass has required methods
    if (typeof SmrtCollection._itemClass !== 'function') {
      throw new Error(
        `Collection "${SmrtCollection.name}"._itemClass must be a constructor function`,
      );
    }

    // Check if it has a create method (static or prototype)
    const hasCreateMethod =
      typeof SmrtCollection._itemClass.create === 'function' ||
      typeof SmrtCollection._itemClass.prototype?.create === 'function';

    if (!hasCreateMethod) {
      console.warn(
        `Collection "${SmrtCollection.name}"._itemClass should have a create() method for optimal functionality`,
      );
    }
  }

  /**
   * Database table name for this collection
   */
  public _tableName!: string;

  /**
   * Creates a new SmrtCollection instance
   *
   * @deprecated Use the static create() factory method instead
   * @param options - Configuration options
   */
  constructor(options: SmrtCollectionOptions = {}) {
    super(options);

    // Auto-register the collection if it's not the base SmrtCollection and has an _itemClass
    if (
      this.constructor !== SmrtCollection &&
      (this.constructor as any)._itemClass
    ) {
      const itemClassName = (this.constructor as any)._itemClass.name;
      ObjectRegistry.registerCollection(itemClassName, this.constructor as any);
    }
  }

  /**
   * Static factory method for creating fully initialized collection instances
   *
   * This is the recommended way to create collections. It accepts broad option types
   * (SmrtClassOptions) and handles option extraction internally, then returns a
   * fully initialized, ready-to-use collection instance.
   *
   * TypeScript Note: Uses instance type constraint (T extends SmrtCollection<any>)
   * with constructor type for 'this' parameter to properly preserve subclass types
   * through the static factory method. This ensures custom collection methods are
   * properly typed and subclass constructors are compatible.
   *
   * @param options - Configuration options (accepts both SmrtClassOptions and SmrtCollectionOptions)
   * @returns Promise resolving to a fully initialized collection instance
   *
   * @example
   * ```typescript
   * // Create collection from object options
   * const collection = await ProductCollection.create(smrtObject.options);
   *
   * // Create collection with specific config
   * const collection = await ProductCollection.create({
   *   persistence: { type: 'sql', url: 'products.db' },
   *   ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
   * });
   * ```
   */
  static async create<T extends SmrtCollection<any>>(
    this: new (
      options?: SmrtCollectionOptions,
    ) => T,
    options: SmrtClassOptions = {},
  ): Promise<T> {
    // Extract only collection-compatible options from broader SmrtClassOptions
    const {
      _className,
      db,
      persistence, // Also extract persistence alias
      ai,
      fs,
      logging,
      metrics,
      pubsub,
      sanitization,
      signals,
    } = options;

    const collectionOptions: SmrtCollectionOptions = {
      _className,
      db,
      persistence, // Pass persistence through so initialize() can map it to db
      ai,
      fs,
      logging,
      metrics,
      pubsub,
      sanitization,
      signals,
    };

    // Create instance using protected constructor
    const instance = new this(collectionOptions);

    // Perform async initialization
    await instance.initialize();

    // Verify table exists (tables must be created via smrt db:setup or smrt db:migrate)
    // This replaces automatic schema creation which caused race conditions (issue #665)
    if (instance.db && (this as any)._itemClass) {
      const className = (this as any)._itemClass.name;
      const tableName = ObjectRegistry.getTableName(className);
      if (tableName) {
        const tableExists = await instance.db.tableExists(tableName);
        if (!tableExists) {
          const { DatabaseError } = await import('./errors.js');
          throw DatabaseError.schemaMissing(tableName, className);
        }
      }
    }

    // Cache fields for sync access during queries (issue #663)
    // This eliminates async getFields() calls on every query
    const fields = await instance.getFields();
    instance._cachedFields = fields;

    // Return fully initialized instance
    return instance;
  }

  /**
   * Initializes the collection, setting up database tables
   *
   * @returns Promise that resolves to this instance for chaining
   */
  public async initialize(): Promise<this> {
    await super.initialize();

    // NOTE: Database table setup is now deferred until first database operation (lazy initialization)
    // This prevents database connections during import/prerendering (issue #237)
    // Tables will be created automatically when calling list(), get(), create(), etc.

    return this;
  }

  /**
   * Find a single record by criteria (convenience method - delegates to get())
   *
   * @param options - Query options with where clause
   * @returns Promise resolving to the object or null if not found
   *
   * @example
   * ```typescript
   * const councils = await Councils.create({ persistence: { type: 'sql', url: 'db.sqlite' } });
   * const council = await councils.findOne({ where: { name: 'Example Council' } });
   * ```
   */
  public async findOne(options: {
    where: Record<string, any>;
  }): Promise<ModelType | null> {
    return await this.get(options.where);
  }

  /**
   * Find a record by ID (convenience method - delegates to get())
   *
   * @param id - Record ID to find (string or Field instance)
   * @returns Promise resolving to the object or null if not found
   *
   * @example
   * ```typescript
   * const councils = await Councils.create({ persistence: { type: 'sql', url: 'db.sqlite' } });
   * const council = await councils.findById('uuid-123');
   *
   * // Also works with Field instances (e.g., from foreignKey fields)
   * const meeting = new Meeting({ councilId: 'uuid-123' });
   * const council = await councils.findById(meeting.councilId);
   * ```
   */
  public async findById(id: string): Promise<ModelType | null> {
    return await this.get(id);
  }

  /**
   * Find all records matching criteria (convenience method - delegates to list())
   *
   * @param options - Query options (where, orderBy, limit, etc.)
   * @returns Promise resolving to array of objects
   *
   * @example
   * ```typescript
   * const councils = await Councils.create({ persistence: { type: 'sql', url: 'db.sqlite' } });
   * const active = await councils.findAll({ where: { status: 'active' } });
   * ```
   */
  public async findAll(
    options: {
      where?: Record<string, any>;
      orderBy?: string | string[];
      limit?: number;
      offset?: number;
      include?: string[];
    } = {},
  ): Promise<ModelType[]> {
    return await this.list(options);
  }

  /**
   * Find multiple objects by their IDs in a single query.
   *
   * This is a convenience method that avoids N+1 queries when you have
   * a list of IDs and need to fetch the corresponding records.
   *
   * @param ids - Array of UUIDs to fetch
   * @returns Promise resolving to array of objects (order not guaranteed)
   *
   * @example
   * ```typescript
   * const profiles = await profileCollection.listByIds(['id1', 'id2', 'id3']);
   * ```
   */
  public async listByIds(ids: string[]): Promise<ModelType[]> {
    if (ids.length === 0) return [];
    return this.list({ where: { id: ids } });
  }

  /**
   * Retrieves a single object from the collection by ID, slug, or custom filter
   *
   * @param filter - String ID/slug, Field instance, or object with filter conditions
   * @returns Promise resolving to the object or null if not found
   */
  public async get(filter: string | Record<string, any>) {
    // Schema already initialized in Collection.create() static factory

    // Ensure manifest is loaded for external packages before validating WHERE clause
    await ObjectRegistry.ensureManifestLoaded(this._itemClass.name);

    // Execute beforeGet interceptors (e.g., tenancy validation)
    const interceptorContext = createInterceptorContext(
      this._itemClass.name,
      'get',
      this.constructor.name,
    );
    const interceptedFilter = await GlobalInterceptors.executeBeforeGet(
      this._itemClass.name,
      filter,
      interceptorContext,
    );

    let where =
      typeof interceptedFilter === 'string'
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            interceptedFilter,
          )
          ? { id: interceptedFilter }
          : { slug: interceptedFilter, context: '' }
        : interceptedFilter;

    // Fix for issue #386: Add _meta_type filter for STI child collections
    const tableStrategy = ObjectRegistry.getTableStrategy(this._itemClass.name);
    const isSTI = tableStrategy === 'sti';

    if (isSTI) {
      const stiBase = ObjectRegistry.getSTIBase(this._itemClass.name);
      // If this is a child collection (not the base), auto-filter by type
      if (stiBase && stiBase !== this._itemClass.name) {
        // Use qualified name for STI filtering (namespace isolation)
        const registeredClass = ObjectRegistry.getClass(this._itemClass.name);
        const metaType = registeredClass?.qualifiedName || this._itemClass.name;
        where = {
          _meta_type: metaType,
          ...where,
        };
      }
    }

    // convertWhereKeys is now sync (issue #663) - no await needed
    const convertedWhere = this.convertWhereKeys(where);
    const { sql: whereSql, values: whereValues } = buildWhere(convertedWhere);

    const fullSQL = `SELECT * FROM ${this.tableName} ${whereSql}`;
    const { rows } = await this.db.query(fullSQL, ...whereValues);

    if (!rows?.[0]) {
      // Execute afterGet with null result
      return await GlobalInterceptors.executeAfterGet(
        this._itemClass.name,
        null,
        interceptorContext,
      );
    }

    const fields = await this.getFields();
    const formattedData = formatDataJs(rows[0], fields);

    let instance: T;
    if (isSTI && formattedData._meta_type) {
      instance = await this.createPolymorphic(
        formattedData._meta_type,
        formattedData,
      );
    } else {
      // CTI: Use collection's item class
      instance = this.create(formattedData);
    }

    // Execute afterGet interceptors (e.g., tenant validation)
    return await GlobalInterceptors.executeAfterGet(
      this._itemClass.name,
      instance,
      interceptorContext,
    );
  }

  /**
   * Lists records from the collection with flexible filtering options
   *
   * @param options - Query options object
   * @param options.where - Record of conditions to filter results. Each key can include an operator
   *                      separated by a space (e.g., 'price >', 'name like'). Default operator is '='.
   * @param options.offset - Number of records to skip
   * @param options.limit - Maximum number of records to return
   * @param options.orderBy - Field(s) to order results by, with optional direction
   *
   * @example
   * ```typescript
   * // Find active products priced between $100-$200
   * await collection.list({
   *   where: {
   *     'price >': 100,
   *     'price <=': 200,
   *     'status': 'active',              // equals operator is default
   *     'category in': ['A', 'B', 'C'],  // IN operator for arrays
   *     'name like': '%shirt%',          // LIKE for pattern matching
   *     'deleted_at !=': null            // exclude deleted items
   *   },
   *   limit: 10,
   *   offset: 0
   * });
   *
   * // Find users matching pattern but not in specific roles
   * await users.list({
   *   where: {
   *     'email like': '%@company.com',
   *     'active': true,
   *     'role in': ['guest', 'blocked'],
   *     'last_login <': lastMonth
   *   }
   * });
   * ```
   *
   * @returns Promise resolving to an array of model instances
   */
  public async list(options: {
    where?: Record<string, any>;
    offset?: number;
    limit?: number;
    orderBy?: string | string[];
    /**
     * Relationships to eagerly load (avoids N+1 query problem)
     * @example
     * ```typescript
     * // Load orders with their customers pre-loaded
     * const orders = await orderCollection.list({
     *   include: ['customerId']
     * });
     * // Access customer without additional query
     * orders[0].getRelated('customerId');
     * ```
     */
    include?: string[];
  }): Promise<ModelType[]> {
    // Schema already initialized in Collection.create() static factory

    // Ensure manifest is loaded for external packages before validating WHERE clause
    await ObjectRegistry.ensureManifestLoaded(this._itemClass.name);

    // Execute beforeList interceptors (e.g., tenancy filtering)
    const interceptorContext = createInterceptorContext(
      this._itemClass.name,
      'list',
      this.constructor.name,
    );
    const interceptedOptions = await GlobalInterceptors.executeBeforeList(
      this._itemClass.name,
      options as InterceptorListOptions,
      interceptorContext,
    );

    let { where, offset, limit, orderBy } = interceptedOptions;

    // STI: Child collections should automatically filter by _meta_type
    const tableStrategy = ObjectRegistry.getTableStrategy(this._itemClass.name);
    const isSTI = tableStrategy === 'sti';

    if (isSTI) {
      const stiBase = ObjectRegistry.getSTIBase(this._itemClass.name);
      // If this is a child collection (not the base), auto-filter by type
      if (stiBase && stiBase !== this._itemClass.name) {
        // Use qualified name for STI filtering (namespace isolation)
        const registeredClass = ObjectRegistry.getClass(this._itemClass.name);
        const metaType = registeredClass?.qualifiedName || this._itemClass.name;
        where = {
          _meta_type: metaType,
          ...(where || {}),
        };
      }
    }

    // Resolve _meta_type to qualified name if user provided simple class name (Issue #713)
    where = resolveMetaTypeInWhere(where);

    // convertWhereKeys is now sync (issue #663) - no await needed
    const convertedWhere = this.convertWhereKeys(where || {});
    const { sql: whereSql, values: whereValues } = buildWhere(convertedWhere);

    let orderBySql = '';
    if (orderBy) {
      orderBySql = ' ORDER BY ';
      const orderByItems = Array.isArray(orderBy) ? orderBy : [orderBy];

      orderBySql += orderByItems
        .map((item) => {
          const [field, direction = 'ASC'] = item.split(' ');

          // Validate field name
          if (!/^[a-zA-Z0-9_]+$/.test(field)) {
            throw new Error(`Invalid field name for ordering: ${field}`);
          }

          // Validate direction
          const normalizedDirection = direction.toUpperCase();
          if (normalizedDirection !== 'ASC' && normalizedDirection !== 'DESC') {
            throw new Error(
              `Invalid sort direction: ${direction}. Must be ASC or DESC.`,
            );
          }

          // Convert field name to snake_case
          const snakeField = toSnakeCase(field);
          return `${snakeField} ${normalizedDirection}`;
        })
        .join(', ');
    }

    let limitOffsetSql = '';
    const limitOffsetValues: (number | undefined)[] = [];
    let paramIndex = whereValues.length + 1;

    if (limit !== undefined) {
      limitOffsetSql += ` LIMIT $${paramIndex++}`;
      limitOffsetValues.push(limit);
    }

    if (offset !== undefined) {
      limitOffsetSql += ` OFFSET $${paramIndex++}`;
      limitOffsetValues.push(offset);
    }

    const sql = `SELECT * FROM ${this.tableName} ${whereSql} ${orderBySql} ${limitOffsetSql}`;
    const params = [...whereValues, ...limitOffsetValues];

    const result = await this.db.query(sql, ...params);
    const fields = await this.getFields();

    // STI: Hydrate instances polymorphically based on _meta_type
    // Reuse tableStrategy and isSTI from earlier in the function
    const instances = await Promise.all(
      result.rows.map(async (item: any) => {
        const formattedData = formatDataJs(item, fields);

        // STI: Use _meta_type to determine correct class to instantiate
        if (isSTI && formattedData._meta_type) {
          return await this.createPolymorphic(
            formattedData._meta_type,
            formattedData,
          );
        }

        // CTI: Use collection's item class
        return this.create(formattedData);
      }),
    );

    // Eager load specified relationships
    if (interceptedOptions.include && interceptedOptions.include.length > 0) {
      // Cast to ModelType[] - instances are guaranteed to be subtypes of ModelType
      // even in STI mode where they may be different subclasses
      await this.eagerLoadRelationships(
        instances as ModelType[],
        interceptedOptions.include,
      );
    }

    // Execute afterList interceptors (e.g., tenant validation)
    const finalInstances = await GlobalInterceptors.executeAfterList(
      this._itemClass.name,
      instances,
      interceptorContext,
    );

    return finalInstances;
  }

  /**
   * Eagerly load relationships for a collection of instances
   *
   * Optimizes loading by batching queries for foreignKey relationships to avoid N+1 queries.
   *
   * @param instances - Array of object instances to load relationships for
   * @param relationships - Array of relationship field names to load
   * @private
   */
  private async eagerLoadRelationships(
    instances: ModelType[],
    relationships: string[],
  ): Promise<void> {
    if (instances.length === 0) return;

    for (const fieldName of relationships) {
      // Get relationship metadata
      const relationshipMeta = ObjectRegistry.getRelationships(
        this._itemClass.name,
      );
      const relationship = relationshipMeta.find(
        (r) => r.fieldName === fieldName,
      );

      if (!relationship) {
        console.warn(
          `Relationship ${fieldName} not found on ${this._itemClass.name}, skipping eager load`,
        );
        continue;
      }

      if (relationship.type === 'foreignKey') {
        // Batch load foreignKey relationships
        await this.batchLoadForeignKeys(instances, fieldName, relationship);
      } else if (relationship.type === 'oneToMany') {
        // Load oneToMany relationships (less optimizable)
        await this.batchLoadOneToMany(instances, fieldName, relationship);
      } else if (relationship.type === 'manyToMany') {
        console.warn(
          `manyToMany eager loading not yet implemented for ${fieldName}`,
        );
      }
    }
  }

  /**
   * Batch load foreignKey relationships to avoid N+1 queries
   *
   * @param instances - Instances to load relationships for
   * @param fieldName - Name of the foreignKey field
   * @param relationship - Relationship metadata
   * @private
   */
  private async batchLoadForeignKeys(
    instances: ModelType[],
    fieldName: string,
    relationship: import('./registry').RelationshipMetadata,
  ): Promise<void> {
    // Collect all unique foreign key values
    const foreignKeyValues = new Set<string>();
    for (const instance of instances) {
      const value = instance[fieldName as keyof ModelType];
      if (value && typeof value === 'string') {
        foreignKeyValues.add(value);
      }
    }

    if (foreignKeyValues.size === 0) return;

    // Get or create cached collection instance
    let targetCollection: SmrtCollection<any> | undefined;
    try {
      targetCollection = await ObjectRegistry.getCollection(
        relationship.targetClass,
        this.options,
      );
    } catch (error) {
      console.warn(
        `Could not get collection for ${relationship.targetClass}:`,
        error,
      );
      return;
    }

    // Load all related objects in a single query
    const relatedObjects = await targetCollection.list({
      where: { 'id in': Array.from(foreignKeyValues) },
    });

    // Build a map of ID to object for quick lookup
    const relatedMap = new Map();
    for (const obj of relatedObjects) {
      relatedMap.set(obj.id, obj);
    }

    // Assign loaded objects to instances
    for (const instance of instances) {
      const foreignKeyValue = instance[fieldName as keyof ModelType];
      if (foreignKeyValue && typeof foreignKeyValue === 'string') {
        const relatedObject = relatedMap.get(foreignKeyValue);
        if (relatedObject) {
          // Set in the relationship cache
          (instance as any)._loadedRelationships.set(fieldName, relatedObject);
        }
      }
    }
  }

  /**
   * Batch load oneToMany relationships
   *
   * @param instances - Instances to load relationships for
   * @param fieldName - Name of the oneToMany field
   * @param relationship - Relationship metadata
   * @private
   */
  private async batchLoadOneToMany(
    instances: ModelType[],
    fieldName: string,
    relationship: import('./registry').RelationshipMetadata,
  ): Promise<void> {
    // Find the inverse foreignKey field
    const inverseRelationships = ObjectRegistry.getInverseRelationships(
      this._itemClass.name,
    );
    const inverseForeignKey = inverseRelationships.find(
      (r) =>
        r.sourceClass === relationship.targetClass &&
        r.type === 'foreignKey' &&
        r.targetClass === this._itemClass.name,
    );

    if (!inverseForeignKey) {
      console.warn(
        `Could not find inverse foreignKey for oneToMany ${fieldName}`,
      );
      return;
    }

    // Collect all instance IDs
    const instanceIds = instances
      .map((i) => i.id)
      .filter((id): id is string => !!id);

    if (instanceIds.length === 0) return;

    // Get or create cached collection instance
    let targetCollection: SmrtCollection<any> | undefined;
    try {
      targetCollection = await ObjectRegistry.getCollection(
        relationship.targetClass,
        this.options,
      );
    } catch (error) {
      console.warn(
        `Could not get collection for ${relationship.targetClass}:`,
        error,
      );
      return;
    }

    // Load all related objects in a single query
    const relatedObjects = await targetCollection.list({
      where: { [`${inverseForeignKey.fieldName} in`]: instanceIds },
    });

    // Group related objects by the foreign key value
    const relatedMap = new Map<string, any[]>();
    for (const obj of relatedObjects) {
      // Access dynamic property safely - obj is a SmrtObject with dynamic fields
      const foreignKeyValue = (obj as Record<string, any>)[
        inverseForeignKey.fieldName
      ];
      if (!relatedMap.has(foreignKeyValue)) {
        relatedMap.set(foreignKeyValue, []);
      }
      relatedMap.get(foreignKeyValue)?.push(obj);
    }

    // Assign loaded objects to instances
    for (const instance of instances) {
      const relatedArray = relatedMap.get(instance.id as string) || [];
      (instance as any)._loadedRelationships.set(fieldName, relatedArray);
    }
  }

  /**
   * Creates a new instance of the collection's item class
   *
   * @param options - Options for creating the item
   * @returns New item instance
   */
  public async create(options: any) {
    // Ensure manifest is loaded for external packages before creating instance
    // This is critical for STI children to have inherited fields available during toJSON()
    await ObjectRegistry.ensureManifestLoaded(this._itemClass.name);

    // STI: Check for polymorphic instantiation
    const tableStrategy = ObjectRegistry.getTableStrategy(this._itemClass.name);

    if (tableStrategy === 'sti' && options._meta_type) {
      // Use polymorphic instantiation for STI child classes
      // Pass raw options (not params) - createPolymorphic() will add ai, db, _skipLoad
      const instance = await this.createPolymorphic(
        options._meta_type,
        options,
      );
      // Generate ID if not provided, then save
      if (!instance.id) {
        (instance as any)._id = crypto.randomUUID();
      }
      await instance.save();
      return instance;
    }

    // For non-STI or STI base class without _meta_type, proceed with direct instantiation
    // Schema already initialized in Collection.create() static factory
    const params = {
      ai: this.options.ai,
      // Pass the actual database instance, not options
      // This ensures objects share the same connection as the collection
      // Critical for in-memory databases like DuckDB :memory: where each
      // connection gets a separate database
      db: this.db,
      _skipLoad: true, // Don't try to load from DB - this is a new object
      ...options,
    };

    // Direct instantiation - all SmrtObject classes support this pattern
    const instance = new this._itemClass(params);
    await instance.initialize();

    // For STI collections, set _meta_type to the qualified class name (fix for issue #442)
    // This ensures _meta_type is available immediately after creation, not just after DB load
    // Use qualified name for namespace isolation (issue #713)
    if (tableStrategy === 'sti') {
      const registeredClass = ObjectRegistry.getClass(this._itemClass.name);
      (instance as any)._meta_type =
        registeredClass?.qualifiedName || this._itemClass.name;
    }
    // Generate ID if not provided, then save
    if (!instance.id) {
      (instance as any)._id = crypto.randomUUID();
    }
    await instance.save();
    return instance;
  }

  /**
   * Creates an instance of the correct subclass for STI polymorphic queries
   *
   * @param className - Name of the class to instantiate (from _meta_type)
   * @param options - Data to initialize the instance with
   * @returns Promise resolving to the instance of the correct subclass
   * @private
   */
  private async createPolymorphic(
    className: string | null | undefined,
    options: any,
  ): Promise<ModelType> {
    // Schema already initialized in Collection.create() static factory

    // Validate discriminator is present
    if (!className || className === null || className === undefined) {
      const { DatabaseError } = await import('./errors.js');
      throw DatabaseError.missingDiscriminator(
        this._itemClass.name,
        options?.id,
      );
    }

    // Get the correct class constructor from ObjectRegistry
    // Support both qualified names (new format: @pkg:Class) and simple names (legacy)
    let registeredClass = ObjectRegistry.getClassByQualifiedName(className);
    if (!registeredClass) {
      // Fall back to simple name lookup for legacy data
      registeredClass = ObjectRegistry.getClass(className);
    }

    if (!registeredClass) {
      throw new Error(
        `STI polymorphic query failed: Class '${className}' not found in ObjectRegistry. ` +
          `Ensure the class is registered with @smrt() decorator.`,
      );
    }

    const params = {
      ai: this.options.ai,
      db: this.db,
      _skipLoad: true,
      ...options,
    };

    // Instantiate the correct subclass
    const instance = new registeredClass.constructor(params);
    await instance.initialize();

    // Ensure _meta_type is set on the instance (fix for issue #442)
    // Use qualified name if available, otherwise keep the input className
    // (which may already be qualified for new data or simple for legacy data)
    (instance as any)._meta_type = registeredClass?.qualifiedName || className;

    return instance as ModelType;
  }

  /**
   * Gets an existing item or creates a new one if it doesn't exist
   *
   * @param data - Object data to find or create
   * @param defaults - Default values to use if creating a new object
   * @returns Promise resolving to the existing or new object
   */
  public async getOrUpsert(data: any, defaults: any = {}) {
    data = formatDataSql(data);
    let where: any = {};
    if (data.id) {
      where = { id: data.id };
    } else if (data.slug) {
      where = { slug: data.slug, context: data.context || '' };
    } else {
      where = data;
    }
    const existing = await this.get(where);
    if (existing) {
      const diff = await this.getDiff(existing, data);
      if (diff) {
        Object.assign(existing, diff);
        await existing.save();
        return existing;
      }
      return existing;
    }
    const upsertData = { ...defaults, ...data };
    const upserted = await this.create(upsertData);
    await upserted.save();
    return upserted;
  }

  /**
   * Gets differences between an existing object and new data
   *
   * @param existing - Existing object
   * @param data - New data
   * @returns Object containing only the changed fields
   */
  async getDiff(
    existing: Record<string, any>,
    data: Record<string, any>,
  ): Promise<Record<string, any>> {
    const fields = await this._itemClass.prototype.getFields();
    return Object.keys(data).reduce(
      (acc, key) => {
        if (fields[key] && existing[key] !== data[key]) {
          acc[key] = data[key];
        }
        return acc;
      },
      {} as Record<string, any>,
    );
  }

  /**
   * Gets field definitions for the collection's item class
   *
   * @returns Object containing field definitions
   */
  async getFields() {
    return await fieldsFromClass(this._itemClass);
  }

  /**
   * Gets field definitions synchronously from cache.
   *
   * This method provides sync access to fields for use in query methods,
   * avoiding the async overhead of getFields() on every query.
   * Fields are cached during create() initialization.
   *
   * @returns Map containing field definitions
   * @private
   */
  getFieldsSync(): Record<string, any> {
    if (this._cachedFields) {
      return this._cachedFields;
    }
    // Fallback to ObjectRegistry sync method if cache not populated
    // This handles edge cases where collection wasn't created via static create()
    const className = this._itemClass.name;
    const fields = ObjectRegistry.getFields(className);
    // Convert Map to Record for consistency with getFields() return type
    return Object.fromEntries(fields);
  }

  /**
   * Generates database schema for the collection's item class
   *
   * Leverages ObjectRegistry's cached schema for instant retrieval.
   *
   * @returns Schema object for database setup
   */
  async generateSchema() {
    // Always generate fresh schema to ensure latest field mapping is used
    return await generateSchema(this._itemClass);
  }

  /**
   * Gets the database table name for this collection
   */
  get tableName() {
    if (!this._tableName) {
      // For STI, use the base class's table name from schema (manifest-derived)
      const className = this._itemClass.name;
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
              ownSchema?.tableName || tableNameFromClass(this._itemClass);
          }
        } else {
          // Fallback to own schema tableName
          const ownSchema = ObjectRegistry.getSchema(className);
          this._tableName =
            ownSchema?.tableName || tableNameFromClass(this._itemClass);
        }
      } else {
        // CTI: Use own schema tableName
        const ownSchema = ObjectRegistry.getSchema(className);
        this._tableName =
          ownSchema?.tableName || tableNameFromClass(this._itemClass);
      }
    }
    return this._tableName;
  }

  /**
   * Generates a table name from the collection class name
   *
   * @returns Generated table name
   */
  generateTableName() {
    // Convert camelCase/PascalCase to snake_case and pluralize
    const tableName = this._className
      // Insert underscore between lower & upper case letters
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      // Convert to lowercase
      .toLowerCase()
      // Handle basic pluralization rules
      .replace(/([^s])$/, '$1s')
      // Handle special cases ending in 'y'
      .replace(/y$/, 'ies');

    return tableName;
  }

  /**
   * Counts records in the collection matching the given filters
   *
   * Accepts the same where conditions as list() but ignores limit/offset/orderBy.
   *
   * @param options - Query options object
   * @param options.where - Record of conditions to filter results
   * @returns Promise resolving to the total count of matching records
   */
  public async count(options: { where?: Record<string, any> } = {}) {
    // Schema already initialized in Collection.create() static factory

    let { where } = options;

    // Fix for issue #386: Add _meta_type filter for STI child collections
    const tableStrategy = ObjectRegistry.getTableStrategy(this._itemClass.name);
    const isSTI = tableStrategy === 'sti';

    if (isSTI) {
      const stiBase = ObjectRegistry.getSTIBase(this._itemClass.name);
      // If this is a child collection (not the base), auto-filter by type
      if (stiBase && stiBase !== this._itemClass.name) {
        // Use qualified name for STI filtering (namespace isolation - issue #713)
        const registeredClass = ObjectRegistry.getClass(this._itemClass.name);
        const metaType = registeredClass?.qualifiedName || this._itemClass.name;
        where = {
          _meta_type: metaType,
          ...(where || {}),
        };
      }
    }

    // Resolve _meta_type to qualified name if user provided simple class name (Issue #713)
    where = resolveMetaTypeInWhere(where);

    // convertWhereKeys is now sync (issue #663) - no await needed
    const { sql: whereSql, values: whereValues } = buildWhere(
      this.convertWhereKeys(where || {}),
    );

    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM ${this.tableName} ${whereSql}`,
      ...whereValues,
    );

    return Number.parseInt(result.rows[0].count, 10);
  }

  /**
   * Execute a raw SQL query and hydrate results as collection item instances
   *
   * Provides full SQL power for complex queries (JOINs, CTEs, NOT EXISTS, etc.)
   * while still returning properly hydrated SMRT objects.
   *
   * @param sql - Raw SQL query string (should select from this.tableName)
   * @param params - Query parameters for prepared statement
   * @returns Promise resolving to array of hydrated model instances
   *
   * @example
   * ```typescript
   * // Find meetings without corresponding recaps (NOT EXISTS pattern)
   * const meetings = await meetingCollection.query(`
   *   SELECT m.* FROM meetings m
   *   WHERE m.start_date < datetime('now')
   *   AND NOT EXISTS (
   *     SELECT 1 FROM contents c
   *     WHERE c.meeting_id = m.id
   *     AND c._meta_type = 'MeetingRecap'
   *   )
   *   ORDER BY m.start_date DESC
   *   LIMIT ?
   * `, [10]);
   *
   * // Complex JOIN query
   * const products = await productCollection.query(`
   *   SELECT p.* FROM products p
   *   INNER JOIN categories c ON p.category_id = c.id
   *   WHERE c.name = ? AND p.price > ?
   *   ORDER BY p.price ASC
   * `, ['Electronics', 100]);
   * ```
   */
  public async query(
    sql: string,
    params: any[] = [],
    options: { allowRawOnTenantScoped?: boolean } = {},
  ): Promise<ModelType[]> {
    // Schema already initialized in Collection.create() static factory

    // Ensure manifest is loaded for external packages
    await ObjectRegistry.ensureManifestLoaded(this._itemClass.name);

    // Execute beforeQuery interceptors (e.g., tenant raw SQL policy)
    const interceptorContext = createInterceptorContext(
      this._itemClass.name,
      'query',
      this.constructor.name,
    );
    const interceptedQuery = await GlobalInterceptors.executeBeforeQuery(
      this._itemClass.name,
      { sql, params, allowRawOnTenantScoped: options.allowRawOnTenantScoped },
      interceptorContext,
    );

    const result = await this.db.query(
      interceptedQuery.sql,
      ...interceptedQuery.params,
    );
    const fields = await this.getFields();

    // STI: Check if we need polymorphic hydration
    const tableStrategy = ObjectRegistry.getTableStrategy(this._itemClass.name);
    const isSTI = tableStrategy === 'sti';

    const instances = await Promise.all(
      result.rows.map(async (row: any) => {
        const formattedData = formatDataJs(row, fields);

        // STI: Use _meta_type to determine correct class to instantiate
        if (isSTI && formattedData._meta_type) {
          return await this.createPolymorphic(
            formattedData._meta_type,
            formattedData,
          );
        }

        // CTI or STI base: Use collection's item class
        const instanceParams = {
          ai: this.options.ai,
          db: this.db,
          _skipLoad: true,
          ...formattedData,
        };

        const instance = new this._itemClass(instanceParams);
        await instance.initialize();

        // For STI collections, set _meta_type to the qualified class name (namespace isolation - issue #713)
        if (isSTI) {
          const registeredClass = ObjectRegistry.getClass(this._itemClass.name);
          (instance as any)._meta_type =
            registeredClass?.qualifiedName || this._itemClass.name;
        }

        return instance;
      }),
    );

    // Execute afterQuery interceptors
    return await GlobalInterceptors.executeAfterQuery(
      this._itemClass.name,
      instances,
      interceptorContext,
    );
  }

  /**
   * Remember collection-level context
   *
   * Stores context applicable to all instances of this collection type.
   * Use for patterns that apply to the entire collection (e.g., default parsing strategies).
   *
   * @param options - Context options
   * @returns Promise that resolves when context is stored
   * @example
   * ```typescript
   * // Remember a default parsing strategy for all documents
   * await documentCollection.remember({
   *   scope: 'parser/default',
   *   key: 'selector',
   *   value: { pattern: '.content article' },
   *   confidence: 0.8
   * });
   *
   * // Update an existing context entry by specifying id
   * await documentCollection.remember({
   *   id: 'existing-context-id',
   *   scope: 'parser/default',
   *   key: 'selector',
   *   value: { pattern: '.content main article' },
   *   confidence: 0.85
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

    // Use upsert() for database-agnostic INSERT OR REPLACE
    // SQLite: INSERT OR REPLACE
    // Postgres/DuckDB: INSERT ... ON CONFLICT ... DO UPDATE
    await this.systemDb.upsert(
      '_smrt_contexts',
      // UNIQUE constraint: (owner_class, owner_id, scope, key, version)
      ['owner_class', 'owner_id', 'scope', 'key', 'version'],
      {
        id,
        owner_class: this._itemClass.name,
        owner_id: '__collection__',
        scope: options.scope,
        key: options.key,
        value: JSON.stringify(options.value),
        metadata: options.metadata ? JSON.stringify(options.metadata) : null,
        version: options.version ?? 1,
        confidence: options.confidence ?? 1.0,
        success_count: 0,
        failure_count: 0,
        created_at: now,
        updated_at: now,
        last_used_at: now,
        expires_at: options.expiresAt ?? null,
      },
    );
  }

  /**
   * Recall collection-level context
   *
   * Retrieves context that applies to all instances of this collection.
   *
   * @param options - Recall options
   * @returns Promise resolving to the context value or null if not found
   * @example
   * ```typescript
   * // Recall default parsing strategy
   * const strategy = await documentCollection.recall({
   *   scope: 'parser/default',
   *   key: 'selector',
   *   minConfidence: 0.5
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
        WHERE owner_class = ${this._itemClass.name}
          AND owner_id = ${'__collection__'}
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
        WHERE owner_class = ${this._itemClass.name}
          AND owner_id = ${'__collection__'}
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
   * Recall all collection-level context in a scope
   *
   * Returns a Map of key -> value for all collection contexts matching the criteria.
   *
   * @param options - Recall options
   * @returns Promise resolving to Map of key -> value pairs
   * @example
   * ```typescript
   * // Get all default strategies
   * const strategies = await documentCollection.recallAll({
   *   scope: 'parser/default',
   *   minConfidence: 0.5
   * });
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
    const params: any[] = [this._itemClass.name, '__collection__'];

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
   * Forget collection-level context
   *
   * Deletes collection context by scope and key.
   *
   * @param options - Context identification
   * @returns Promise that resolves when context is deleted
   * @example
   * ```typescript
   * // Remove a default strategy
   * await documentCollection.forget({
   *   scope: 'parser/default',
   *   key: 'selector'
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
      this._itemClass.name,
      '__collection__',
      options.scope,
      options.key,
    );
  }

  /**
   * Forget all collection-level context in a scope
   *
   * Deletes all collection contexts matching the scope pattern.
   *
   * @param options - Scope options
   * @returns Promise resolving to number of contexts deleted
   * @example
   * ```typescript
   * // Clear all default strategies
   * const count = await documentCollection.forgetScope({
   *   scope: 'parser/default',
   *   includeDescendants: true
   * });
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
    const params: any[] = [this._itemClass.name, '__collection__'];

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

  // ============================================================================
  // Semantic Search Methods
  // ============================================================================

  /**
   * Semantic search by text query
   *
   * Generates an embedding for the query text and finds similar objects
   * based on cosine similarity of stored embeddings.
   *
   * @param query - Text to search for
   * @param options - Search options
   * @param options.field - Specific field to search (defaults to first embedding field)
   * @param options.limit - Maximum results to return (default: 10)
   * @param options.minSimilarity - Minimum similarity threshold 0-1 (default: 0)
   * @param options.where - Additional WHERE filters to apply
   * @returns Promise resolving to array of objects with _similarity score
   *
   * @example
   * ```typescript
   * const results = await articles.semanticSearch('machine learning trends', {
   *   limit: 10,
   *   minSimilarity: 0.7
   * });
   *
   * for (const article of results) {
   *   console.log(`${article.title} (similarity: ${article._similarity})`);
   * }
   * ```
   */
  public async semanticSearch(
    query: string,
    options: {
      field?: string;
      limit?: number;
      minSimilarity?: number;
      where?: Record<string, any>;
    } = {},
  ): Promise<Array<ModelType & { _similarity: number }>> {
    const { field, limit = 10, minSimilarity = 0, where } = options;

    // Get embedding config
    const embeddingConfig = ObjectRegistry.resolveEmbeddingConfig(
      this._itemClass.name,
    );

    if (!embeddingConfig) {
      throw new Error(
        `No embedding configuration found for ${this._itemClass.name}. ` +
          `Add embeddings config to @smrt() decorator.`,
      );
    }

    // Determine which field to search
    const searchField = field || embeddingConfig.fields[0];
    if (!embeddingConfig.fields.includes(searchField)) {
      throw new Error(
        `Field '${searchField}' is not configured for embeddings on ${this._itemClass.name}. ` +
          `Available fields: ${embeddingConfig.fields.join(', ')}`,
      );
    }

    // Get project config for embedding provider
    const projectConfig = ObjectRegistry.getProjectEmbeddingConfig();

    // Create embedding provider
    const provider = new EmbeddingProvider(projectConfig, this.ai);

    // Generate embedding for query
    const [queryEmbedding] = await provider.embed(query);

    // Find similar embeddings
    return this.findSimilarToEmbedding(queryEmbedding, {
      field: searchField,
      limit,
      minSimilarity,
      where,
    });
  }

  /**
   * Find objects similar to a given object
   *
   * Uses stored embeddings to find objects most similar to the provided object.
   *
   * @param object - Object to find similar items for (or object ID)
   * @param options - Search options
   * @param options.field - Specific field to compare (defaults to first embedding field)
   * @param options.limit - Maximum results to return (default: 5)
   * @param options.excludeSelf - Whether to exclude the source object (default: true)
   * @returns Promise resolving to array of similar objects with _similarity score
   *
   * @example
   * ```typescript
   * const article = await articles.get('some-article-id');
   * const similar = await articles.findSimilar(article, {
   *   limit: 5,
   *   excludeSelf: true
   * });
   * ```
   */
  public async findSimilar(
    object: ModelType | string,
    options: {
      field?: string;
      limit?: number;
      excludeSelf?: boolean;
    } = {},
  ): Promise<Array<ModelType & { _similarity: number }>> {
    const { field, limit = 5, excludeSelf = true } = options;

    // Get the object if ID was provided
    let sourceObject: ModelType;
    if (typeof object === 'string') {
      const found = await this.get(object);
      if (!found) {
        throw new Error(`Object not found: ${object}`);
      }
      sourceObject = found;
    } else {
      sourceObject = object;
    }

    // Get embedding config
    const embeddingConfig = ObjectRegistry.resolveEmbeddingConfig(
      this._itemClass.name,
    );

    if (!embeddingConfig) {
      throw new Error(
        `No embedding configuration found for ${this._itemClass.name}.`,
      );
    }

    // Determine which field to use
    const searchField = field || embeddingConfig.fields[0];

    // Get the source object's embedding using consistent model name from EmbeddingProvider
    const provider = new EmbeddingProvider(
      {
        dimensions: embeddingConfig.dimensions,
        provider: embeddingConfig.provider,
        localModel: embeddingConfig.localModel,
        aiModel: embeddingConfig.aiModel,
        fallbackToAI: embeddingConfig.fallbackToAI,
      },
      this.ai,
    );
    const model = provider.getModelName();

    const storedEmbedding = await EmbeddingStorage.get(
      this.systemDb,
      this._itemClass.name,
      sourceObject.id as string,
      searchField,
      model,
    );

    if (!storedEmbedding) {
      throw new Error(
        `No embedding found for object ${sourceObject.id} field '${searchField}'. ` +
          `Generate embeddings first with object.generateEmbeddings().`,
      );
    }

    // Find similar using the embedding
    const where = excludeSelf ? { 'id !=': sourceObject.id } : undefined;

    return this.findSimilarToEmbedding(storedEmbedding.embedding, {
      field: searchField,
      limit,
      minSimilarity: 0,
      where,
    });
  }

  /**
   * Find objects similar to a raw embedding vector
   *
   * Low-level method for finding objects by embedding similarity.
   *
   * @param embedding - Embedding vector to compare against
   * @param options - Search options
   * @param options.field - Field name to search (defaults to first embedding field)
   * @param options.limit - Maximum results to return (default: 10)
   * @param options.minSimilarity - Minimum similarity threshold 0-1 (default: 0)
   * @param options.where - Additional WHERE filters to apply
   * @returns Promise resolving to array of objects with _similarity score
   *
   * @example
   * ```typescript
   * // Using a pre-computed embedding
   * const results = await articles.findSimilarToEmbedding(myEmbedding, {
   *   limit: 10,
   *   minSimilarity: 0.5
   * });
   * ```
   */
  public async findSimilarToEmbedding(
    embedding: number[],
    options: {
      field?: string;
      limit?: number;
      minSimilarity?: number;
      where?: Record<string, any>;
    } = {},
  ): Promise<Array<ModelType & { _similarity: number }>> {
    const { field, limit = 10, minSimilarity = 0, where } = options;

    // Get embedding config
    const embeddingConfig = ObjectRegistry.resolveEmbeddingConfig(
      this._itemClass.name,
    );

    if (!embeddingConfig) {
      throw new Error(
        `No embedding configuration found for ${this._itemClass.name}.`,
      );
    }

    // Determine which field to search
    const searchField = field || embeddingConfig.fields[0];

    // Get model name using EmbeddingProvider for consistency
    const provider = new EmbeddingProvider(
      {
        dimensions: embeddingConfig.dimensions,
        provider: embeddingConfig.provider,
        localModel: embeddingConfig.localModel,
        aiModel: embeddingConfig.aiModel,
        fallbackToAI: embeddingConfig.fallbackToAI,
      },
      this.ai,
    );
    const model = provider.getModelName();

    // Get all embeddings for this class and field
    const storedEmbeddings = await EmbeddingStorage.listForClass(
      this.systemDb,
      this._itemClass.name,
      searchField,
      model,
    );

    if (storedEmbeddings.length === 0) {
      return [];
    }

    // Calculate similarity scores
    const scored = storedEmbeddings
      .map((stored) => ({
        objectId: stored.object_id,
        similarity: CosineSimilarity.calculate(embedding, stored.embedding),
      }))
      .filter((item) => item.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    if (scored.length === 0) {
      return [];
    }

    // Load the objects
    const objectIds = scored.map((s) => s.objectId);
    const similarityMap = new Map(
      scored.map((s) => [s.objectId, s.similarity]),
    );

    // Build where clause with additional filters
    const whereClause = where
      ? { 'id in': objectIds, ...where }
      : { 'id in': objectIds };

    const objects = await this.list({ where: whereClause });

    // Add similarity scores to objects and sort by similarity
    // We directly assign _similarity to avoid losing class properties when spreading
    const results = objects.map((obj) => {
      (obj as any)._similarity = similarityMap.get(obj.id as string) || 0;
      return obj as ModelType & { _similarity: number };
    });

    results.sort((a, b) => b._similarity - a._similarity);

    return results;
  }

  /**
   * Generate missing embeddings for all objects in the collection
   *
   * Batch generates embeddings for objects that don't have them yet
   * or have stale embeddings.
   *
   * @param options - Generation options
   * @param options.batchSize - Number of objects to process at once (default: 50)
   * @param options.onProgress - Progress callback
   * @returns Promise resolving to generation statistics
   *
   * @example
   * ```typescript
   * const stats = await articles.generateMissingEmbeddings({
   *   batchSize: 100,
   *   onProgress: ({ completed, total }) => {
   *     console.log(`Progress: ${completed}/${total}`);
   *   }
   * });
   *
   * console.log(`Generated: ${stats.generated}, Skipped: ${stats.skipped}`);
   * ```
   */
  public async generateMissingEmbeddings(
    options: {
      batchSize?: number;
      onProgress?: (progress: { completed: number; total: number }) => void;
    } = {},
  ): Promise<{ generated: number; skipped: number }> {
    const { batchSize = 50, onProgress } = options;

    // Get embedding config
    const embeddingConfig = ObjectRegistry.resolveEmbeddingConfig(
      this._itemClass.name,
    );

    if (!embeddingConfig) {
      throw new Error(
        `No embedding configuration found for ${this._itemClass.name}.`,
      );
    }

    // Count total objects
    const total = await this.count({});
    let completed = 0;
    let generated = 0;
    let skipped = 0;

    // Process in batches
    let offset = 0;
    while (offset < total) {
      const batch = await this.list({ limit: batchSize, offset });

      for (const obj of batch) {
        try {
          // Check if embeddings are stale
          const hasStale = await (obj as any).hasStaleEmbeddings();
          if (hasStale) {
            await (obj as any).generateEmbeddings();
            generated++;
          } else {
            skipped++;
          }
        } catch (error) {
          console.warn(
            `Failed to generate embeddings for ${obj.id}:`,
            error instanceof Error ? error.message : error,
          );
          skipped++;
        }

        completed++;
        if (onProgress) {
          onProgress({ completed, total });
        }
      }

      offset += batchSize;
    }

    return { generated, skipped };
  }
}
