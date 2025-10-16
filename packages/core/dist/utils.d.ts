/**
 * Converts a camelCase string to snake_case
 *
 * @param str - String in camelCase format
 * @returns String in snake_case format
 * @example
 * ```typescript
 * toSnakeCase('meetingsUrl'); // 'meetings_url'
 * toSnakeCase('createdAt'); // 'created_at'
 * toSnakeCase('id'); // 'id'
 * ```
 */
export declare function toSnakeCase(str: string): string;
/**
 * Converts a snake_case string to camelCase
 *
 * @param str - String in snake_case format
 * @returns String in camelCase format
 * @example
 * ```typescript
 * toCamelCase('meetings_url'); // 'meetingsUrl'
 * toCamelCase('created_at'); // 'createdAt'
 * toCamelCase('id'); // 'id'
 * ```
 */
export declare function toCamelCase(str: string): string;
/**
 * Converts all keys in an object from camelCase to snake_case
 *
 * @param obj - Object with camelCase keys
 * @returns Object with snake_case keys
 */
export declare function keysToSnakeCase(obj: Record<string, any>): Record<string, any>;
/**
 * Converts all keys in an object from snake_case to camelCase
 *
 * @param obj - Object with snake_case keys
 * @returns Object with camelCase keys
 */
export declare function keysToCamelCase(obj: Record<string, any>): Record<string, any>;
/**
 * Checks if a field name indicates a date field based on naming conventions
 *
 * Recognizes common date field patterns like '_at', '_date', and 'date'.
 * Used for automatic type inference during schema generation.
 *
 * @param key - Field name to check
 * @returns Boolean indicating if the field is likely a date field
 * @example
 * ```typescript
 * isDateField('created_at'); // true
 * isDateField('updated_date'); // true
 * isDateField('name'); // false
 * ```
 */
export declare function isDateField(key: string): boolean;
/**
 * Converts a date string to a Date object
 *
 * @param date - Date as string or Date object
 * @returns Date object
 */
export declare function dateAsString(date: Date | string): Date;
/**
 * Converts a Date object to an ISO string
 *
 * @param date - Date as Date object or string
 * @returns ISO date string or the original string
 */
export declare function dateAsObject(date: Date | string): string;
/**
 * Extracts field definitions from a class constructor
 *
 * Creates a temporary instance to introspect field definitions and their types.
 * This enables automatic schema generation from TypeScript class properties.
 *
 * @param ClassType - Class constructor to extract fields from
 * @param values - Optional values to set for the fields
 * @returns Object containing field definitions with names, types, and values
 * @throws {Error} If the class cannot be instantiated for introspection
 * @example
 * ```typescript
 * const fields = fieldsFromClass(Product);
 * console.log(fields.name.type); // 'TEXT'
 * console.log(fields.price.type); // 'INTEGER'
 * ```
 */
export declare function fieldsFromClass(ClassType: new (...args: any[]) => any, values?: Record<string, any>): Record<string, any>;
/**
 * Generates a complete database schema SQL statement for a class
 *
 * Creates CREATE TABLE statement with all fields, constraints, and indexes.
 * Automatically adds id, slug, and context fields for SMRT object support.
 * Column names are generated in snake_case for database convention.
 *
 * @param ClassType - Class constructor to generate schema for
 * @returns SQL schema creation statement with CREATE TABLE and CREATE INDEX statements
 * @example
 * ```typescript
 * const schema = generateSchema(Product);
 * console.log(schema);
 * // Output:
 * // CREATE TABLE IF NOT EXISTS products (
 * //   id TEXT PRIMARY KEY,
 * //   slug TEXT NOT NULL,
 * //   context TEXT NOT NULL DEFAULT '',
 * //   name TEXT,
 * //   price INTEGER,
 * //   UNIQUE(slug, context)
 * // );
 * ```
 */
export declare function generateSchema(ClassType: new (...args: any[]) => any): string;
/**
 * Generates a table name from a class constructor
 *
 * Checks for SMRT_TABLE_NAME static property first (set by @smrt() decorator),
 * which survives code minification. Falls back to deriving from ClassType.name
 * for backward compatibility.
 *
 * @param ClassType - Class constructor or function
 * @returns Pluralized snake_case table name
 * @example
 * ```typescript
 * // With @smrt() decorator (recommended)
 * @smrt()
 * class Product extends SmrtObject { }
 * tableNameFromClass(Product); // "products" (captured before minification)
 *
 * // Without decorator (fallback)
 * class Category extends SmrtObject { }
 * tableNameFromClass(Category); // "categories" (derived from runtime name)
 * ```
 */
export declare function tableNameFromClass(ClassType: Function | (new (...args: any[]) => any)): any;
/**
 * Converts a class name to a table name with pluralization
 *
 * @param className - Name of the class
 * @returns Pluralized snake_case table name
 */
export declare function classnameToTablename(className: string): string;
/**
 * Sets up database tables for a class with caching to prevent duplicate operations
 *
 * Creates the database table, indexes, and triggers for a SMRT class.
 * Uses promise caching to ensure each table is only set up once.
 * Now leverages ObjectRegistry's cached schema for instant retrieval.
 *
 * @param db - Database connection interface
 * @param ClassType - Class constructor to create tables for
 * @returns Promise that resolves when setup is complete
 * @throws {Error} If schema creation or trigger setup fails
 * @example
 * ```typescript
 * await setupTableFromClass(db, Product);
 * // Table 'products' is now ready for use
 * ```
 */
export declare function setupTableFromClass(db: any, ClassType: any): Promise<void | null>;
/**
 * Formats data for JavaScript by converting date strings to Date objects
 * and snake_case column names to camelCase properties
 *
 * @param data - Object with data to format (snake_case column names from DB)
 * @returns Object with properly typed values and camelCase property names for JavaScript
 */
export declare function formatDataJs(data: Record<string, any>): Record<string, any>;
/**
 * Formats data for SQL by converting Date objects to ISO strings
 * and camelCase property names to snake_case column names
 *
 * @param data - Object with data to format (camelCase property names from JavaScript)
 * @returns Object with properly formatted values and snake_case column names for SQL
 */
export declare function formatDataSql(data: Record<string, any>): Record<string, any>;
//# sourceMappingURL=utils.d.ts.map