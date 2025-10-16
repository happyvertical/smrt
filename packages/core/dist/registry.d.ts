import { SmrtCollection } from './collection';
import { SmrtObject } from './object';
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
     * API configuration
     */
    api?: {
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
    mcp?: {
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
    cli?: boolean | {
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
}
/**
 * Validation function that takes an object instance and returns
 * a ValidationError if validation fails, or null if validation passes
 */
type ValidatorFunction = (instance: any) => Promise<import('./errors').ValidationError | null>;
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
}
/**
 * Central registry for all SMRT objects
 */
export declare class ObjectRegistry {
    private static classes;
    private static collections;
    private static collectionCache;
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
    static register(ctor: typeof SmrtObject, config?: SmartObjectConfig): void;
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
    static registerCollection(objectName: string, collectionConstructor: new (options: any) => SmrtCollection<any>): void;
    /**
     * Helper method for case-insensitive class lookup
     * Tries exact match first, then falls back to case-insensitive search
     *
     * @param name - Name of the class to find
     * @returns Registered class information or undefined if not found
     * @private
     */
    private static findClass;
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
    static getClass(name: string): RegisteredClass | undefined;
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
    static getAllClasses(): Map<string, RegisteredClass>;
    /**
     * Get class names
     */
    static getClassNames(): string[];
    /**
     * Check if a class is registered (case-insensitive)
     */
    static hasClass(name: string): boolean;
    /**
     * Clear all registered classes (mainly for testing)
     */
    static clear(): void;
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
    static getCollection<T extends SmrtObject>(className: string, options?: any): Promise<SmrtCollection<T>>;
    /**
     * Extract field definitions from a class constructor
     */
    private static extractFields;
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
    private static compileValidators;
    /**
     * Get field definitions for a registered class
     */
    static getFields(name: string): Map<string, any>;
    /**
     * Get configuration for a registered class
     */
    static getConfig(name: string): SmartObjectConfig;
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
    static getSchema(name: string): SchemaDefinition | undefined;
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
    static getSchemaDDL(name: string): string | undefined;
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
    static getTableName(name: string): string | undefined;
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
    static getValidators(name: string): ValidatorFunction[] | undefined;
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
    static getDependencyGraph(): Map<string, string[]>;
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
    static getInitializationOrder(): string[];
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
    static getRelationshipMap(): Map<string, RelationshipMetadata[]>;
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
    static getRelationships(className: string): RelationshipMetadata[];
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
    } | null;
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
     *     required: field.options?.required || false
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
    }>;
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
    static getInverseRelationships(className: string): RelationshipMetadata[];
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
    static persistToDatabase(db: import('@have/sql').DatabaseInterface): Promise<void>;
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
    static loadFromDatabase(db: import('@have/sql').DatabaseInterface): Promise<any[]>;
}
/**
 * @smrt decorator for registering classes with the global registry
 *
 * Captures the original class name before minification and stores it as
 * a static property, ensuring table names remain consistent in production builds.
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
 * class Product extends SmrtObject {
 *   name = text({ required: true });
 * }
 *
 * @smrt({ api: { exclude: ['delete'] } })
 * class SensitiveData extends SmrtObject {
 *   secret = text({ encrypted: true });
 * }
 * ```
 */
export declare function smrt(config?: SmartObjectConfig): <T extends typeof SmrtObject>(ctor: T) => T;
export {};
//# sourceMappingURL=registry.d.ts.map