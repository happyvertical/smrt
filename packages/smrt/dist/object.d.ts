import { AITool } from '../../ai/src';
import { SmrtClassOptions, SmrtClass } from './class';
import { Field } from './fields/index';
import { ToolCall, ToolCallResult } from './tools/tool-executor';
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
export declare class SmrtObject extends SmrtClass {
    /**
     * Database table name for this object
     */
    _tableName: string;
    /**
     * Cache for loaded relationships to avoid repeated database queries
     * Maps fieldName to loaded object(s)
     */
    private _loadedRelationships;
    /**
     * Override options with SmrtObjectOptions type for proper type narrowing.
     * Initialized by parent constructor via super() call.
     */
    protected options: SmrtObjectOptions;
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
    name?: string | Field | null;
    /**
     * Creation timestamp
     */
    created_at: Date | null | undefined;
    /**
     * Last update timestamp
     */
    updated_at: Date | null | undefined;
    /**
     * Creates a new SmrtObject instance
     *
     * @param options - Configuration options including identifiers and metadata
     * @throws Error if options is null
     */
    constructor(options?: SmrtObjectOptions);
    /**
     * Initialize properties from options after field initializers have run
     * This ensures option values take precedence over default field initializer values
     */
    private initializePropertiesFromOptions;
    /**
     * Gets the unique identifier for this object
     */
    get id(): string | null | undefined;
    /**
     * Sets the unique identifier for this object
     *
     * @param value - The ID to set
     * @throws Error if the value is invalid
     */
    set id(value: string | null | undefined);
    /**
     * Gets the URL-friendly slug for this object
     */
    get slug(): string | null | undefined;
    /**
     * Sets the URL-friendly slug for this object
     *
     * @param value - The slug to set
     * @throws Error if the value is invalid
     */
    set slug(value: string | null | undefined);
    /**
     * Gets the context that scopes this object's slug
     */
    get context(): string;
    /**
     * Sets the context that scopes this object's slug
     *
     * @param value - The context to set
     * @throws Error if the value is invalid
     */
    set context(value: string | null | undefined);
    /**
     * Initializes this object, setting up database tables and loading data if identifiers are provided
     *
     * @returns Promise that resolves to this instance for chaining
     */
    initialize(): Promise<this>;
    /**
     * Loads data from a database row into this object's properties
     *
     * @param data - Database row data
     */
    loadDataFromDb(data: any): void;
    /**
     * Gets all property descriptors from this object's prototype
     *
     * @returns Object containing all property descriptors
     */
    allDescriptors(): {
        [x: string]: TypedPropertyDescriptor<any>;
    } & {
        [x: string]: PropertyDescriptor;
    };
    /**
     * Gets the database table name for this object
     */
    get tableName(): string;
    /**
     * Gets field definitions and current values for this object
     *
     * @returns Object containing field definitions with current values
     */
    getFields(): Record<string, any>;
    /**
     * Custom JSON serialization
     * Returns a plain object with all field values for proper JSON.stringify() behavior
     * Field instances automatically call their toJSON() method during serialization
     */
    toJSON(): any;
    /**
     * Gets or generates a unique ID for this object
     *
     * @returns Promise resolving to the object's ID
     */
    getId(): Promise<string>;
    /**
     * Gets or generates a slug for this object based on its name
     *
     * @returns Promise resolving to the object's slug
     */
    getSlug(): Promise<string | null | undefined>;
    /**
     * Gets the ID of this object if it's already saved in the database
     *
     * @returns Promise resolving to the saved ID or null if not saved
     */
    getSavedId(): Promise<any>;
    /**
     * Checks if this object is already saved in the database
     *
     * @returns Promise resolving to true if saved, false otherwise
     */
    isSaved(): Promise<boolean>;
    /**
     * Saves this object to the database
     *
     * @returns Promise resolving to this object
     */
    save(): Promise<this>;
    /**
     * Validates object state before saving
     * Override in subclasses to add custom validation logic
     */
    protected validateBeforeSave(): Promise<void>;
    /**
     * Gets the value of a field on this object
     */
    protected getFieldValue(fieldName: string): any;
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
    protected getPropertyValue(key: string): any;
    /**
     * Extracts field name from database constraint error messages
     */
    protected extractConstraintField(errorMessage: string): string;
    /**
     * Loads this object's data from the database using its ID
     *
     * @returns Promise that resolves when loading is complete
     */
    loadFromId(): Promise<void>;
    /**
     * Loads this object's data from the database using its slug and context
     *
     * @returns Promise that resolves when loading is complete
     */
    loadFromSlug(): Promise<void>;
    /**
     * Evaluates whether this object meets given criteria using AI
     *
     * @param criteria - Criteria to evaluate against
     * @param options - AI message options
     * @returns Promise resolving to true if criteria are met, false otherwise
     * @throws Error if the AI response is invalid
     */
    is(criteria: string, options?: any): Promise<any>;
    /**
     * Performs actions on this object based on instructions using AI
     *
     * @param instructions - Instructions for the AI to follow
     * @param options - AI message options
     * @returns Promise resolving to the AI response
     */
    do(instructions: string, options?: any): Promise<string>;
    /**
     * Runs a lifecycle hook if it's defined in the object's configuration
     *
     * @param hookName - Name of the hook to run (e.g., 'beforeDelete', 'afterDelete')
     * @returns Promise that resolves when the hook completes
     */
    protected runHook(hookName: string): Promise<void>;
    /**
     * Delete this object from the database
     *
     * @returns Promise that resolves when deletion is complete
     */
    delete(): Promise<void>;
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
    isRelatedLoaded(fieldName: string): boolean;
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
    loadRelated(fieldName: string): Promise<any>;
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
    loadRelatedMany(fieldName: string): Promise<any[]>;
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
    getRelated(fieldName: string): Promise<any>;
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
    getAvailableTools(): AITool[];
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
    executeToolCall(toolCall: ToolCall): Promise<ToolCallResult>;
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
    remember(options: {
        id?: string;
        scope: string;
        key: string;
        value: any;
        metadata?: any;
        confidence?: number;
        version?: number;
        expiresAt?: Date;
    }): Promise<void>;
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
    recall(options: {
        scope: string;
        key: string;
        includeAncestors?: boolean;
        minConfidence?: number;
    }): Promise<any | null>;
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
    recallAll(options?: {
        scope?: string;
        includeDescendants?: boolean;
        minConfidence?: number;
    }): Promise<Map<string, any>>;
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
    forget(options: {
        scope: string;
        key: string;
    }): Promise<void>;
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
    forgetScope(options: {
        scope: string;
        includeDescendants?: boolean;
    }): Promise<number>;
}
//# sourceMappingURL=object.d.ts.map