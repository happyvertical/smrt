import { syncSchema } from '@have/sql';
import { ObjectRegistry } from './registry';
import { SchemaGenerator } from './schema/generator';

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
export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

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
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Converts all keys in an object from camelCase to snake_case
 *
 * @param obj - Object with camelCase keys
 * @returns Object with snake_case keys
 */
export function keysToSnakeCase(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[toSnakeCase(key)] = value;
  }
  return result;
}

/**
 * Converts all keys in an object from snake_case to camelCase
 *
 * @param obj - Object with snake_case keys
 * @returns Object with camelCase keys
 */
export function keysToCamelCase(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[toCamelCase(key)] = value;
  }
  return result;
}

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
export function isDateField(key: string) {
  return key.endsWith('_date') || key.endsWith('_at') || key === 'date';
}

/**
 * Converts a date string to a Date object
 *
 * @param date - Date as string or Date object
 * @returns Date object
 */
export function dateAsString(date: Date | string) {
  if (typeof date === 'string') {
    return new Date(date);
  }
  return date;
}

/**
 * Converts a Date object to an ISO string
 *
 * @param date - Date as Date object or string
 * @returns ISO date string or the original string
 */
export function dateAsObject(date: Date | string) {
  if (date instanceof Date) {
    return date.toISOString();
  }
  return date;
}

/**
 * Extracts field definitions from a class constructor
 *
 * Uses ObjectRegistry cached fields from AST manifest exclusively.
 * No runtime introspection fallback - classes must be decorated with @smrt()
 * for schema generation to work.
 *
 * @param ClassType - Class constructor to extract fields from
 * @param values - Optional values to set for the fields
 * @returns Object containing field definitions with names, types, and values
 * @throws {Error} If the class is not registered in ObjectRegistry
 * @example
 * ```typescript
 * @smrt()
 * class Product extends SmrtObject {
 *   name = text();
 *   price = decimal();
 * }
 *
 * const fields = fieldsFromClass(Product);
 * console.log(fields.name.type); // 'TEXT'
 * console.log(fields.price.type); // 'REAL'
 * ```
 */
export function fieldsFromClass(
  ClassType: new (...args: any[]) => any,
  values?: Record<string, any>,
) {
  const className = ClassType.name;
  const cachedFields = ObjectRegistry.getFields(className);

  // Phase 2: AST manifest only - no runtime introspection fallback
  if (cachedFields.size === 0) {
    // Return empty fields for unregistered classes (for backward compatibility)
    // generateSchema() will throw if it needs field definitions
    return {};
  }

  // Use cached field definitions from AST manifest
  const fields: Record<string, any> = {};

  for (const [key, field] of cachedFields.entries()) {
    fields[key] = {
      name: key,
      type: field.type || 'TEXT',
      ...(values && key in values ? { value: values[key] } : {}),
    };
  }

  return fields;
}

/**
 * Generates a complete database schema SQL statement for a class
 *
 * This is now a thin wrapper around SchemaGenerator that provides the
 * single source of truth for schema generation. Uses ObjectRegistry
 * cached fields from AST manifest for consistent schema generation.
 *
 * @param ClassType - Class constructor to generate schema for
 * @param providedFields - Optional fields map (used during registration)
 * @returns SQL schema creation statement with CREATE TABLE and CREATE INDEX statements
 * @example
 * ```typescript
 * const schema = generateSchema(Product);
 * console.log(schema);
 * // Output:
 * // CREATE TABLE IF NOT EXISTS products (
 * //   id TEXT PRIMARY KEY,
 * //   slug TEXT NOT NULL,
 * //   context TEXT NOT NULL DEFAULT CAST('' AS TEXT),
 * //   name TEXT,
 * //   price INTEGER,
 * //   UNIQUE(slug, context)
 * // );
 * ```
 */
export function generateSchema(
  ClassType: new (...args: any[]) => any,
  providedFields?: Map<string, any>,
) {
  const className = ClassType.name;
  const tableName = tableNameFromClass(ClassType);

  // Use provided fields if available AND non-empty (during registration), otherwise get from registry
  const cachedFields =
    providedFields && providedFields.size > 0
      ? providedFields
      : ObjectRegistry.getFields(className);

  // Throw error if class is not registered AND no fields provided
  if (cachedFields.size === 0) {
    throw new Error(
      `Cannot generate schema for unregistered class '${className}'. ` +
        `Ensure the class is decorated with @smrt() for schema generation to work. ` +
        `Runtime introspection has been removed in Phase 2 of the schema management refactor.`,
    );
  }

  // Use SchemaGenerator for consistent SQL generation
  const generator = new SchemaGenerator();
  const schemaDefinition = generator.generateSchemaFromRegistry(
    className,
    tableName,
    cachedFields,
  );

  return generator.generateSQL(schemaDefinition);
}

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
export function tableNameFromClass(
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  ClassType: Function | (new (...args: any[]) => any),
) {
  // Check for SMRT_TABLE_NAME property set by @smrt() decorator (survives minification)
  if ('SMRT_TABLE_NAME' in ClassType) {
    return (ClassType as any).SMRT_TABLE_NAME;
  }

  // Fallback: derive from class name (breaks with minification)
  return (
    ClassType.name
      // Insert underscore between lower & upper case letters
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      // Convert to lowercase
      .toLowerCase()
      // Handle basic pluralization rules
      .replace(/([^s])$/, '$1s')
      // Handle special cases ending in 'y'
      .replace(/y$/, 'ies')
  );
}

/**
 * Converts a class name to a table name with pluralization
 *
 * @param className - Name of the class
 * @returns Pluralized snake_case table name
 */
export function classnameToTablename(className: string) {
  // Convert camelCase/PascalCase to snake_case and pluralize
  const tableName = className
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
 * Cache of table setup promises to avoid duplicate setup operations
 */
const _setup_table_from_class_promises: Record<string, Promise<void> | null> =
  {};

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
export async function setupTableFromClass(db: any, ClassType: any) {
  const tableName = classnameToTablename(ClassType.name);

  if (_setup_table_from_class_promises[tableName] !== undefined || null) {
    return _setup_table_from_class_promises[tableName];
  }

  _setup_table_from_class_promises[tableName] = (async () => {
    try {
      const className = ClassType.name;

      // Get fields from registry, or extract if not registered
      let cachedFields = ObjectRegistry.getFields(className);
      if (cachedFields.size === 0) {
        // Class not registered - extract fields at runtime for test classes
        cachedFields = ObjectRegistry.extractFields(ClassType);
      }

      // Always generate fresh schema to ensure latest field mapping is used
      const schema = generateSchema(ClassType, cachedFields);
      let primaryKeyColumn = 'id'; // default

      if (cachedFields.size > 0) {
        for (const [key, field] of cachedFields.entries()) {
          if (field.options?.primaryKey) {
            primaryKeyColumn = toSnakeCase(key);
            break;
          }
        }
      }

      await syncSchema({ db, schema });
    } catch (error) {
      _setup_table_from_class_promises[tableName] = null; // Allow retry on failure
      throw error;
    }
  })();

  return _setup_table_from_class_promises[tableName];
}

/**
 * Formats data for JavaScript by converting date strings to Date objects
 * and snake_case column names to camelCase properties
 *
 * @param data - Object with data to format (snake_case column names from DB)
 * @returns Object with properly typed values and camelCase property names for JavaScript
 */
export function formatDataJs(data: Record<string, any>) {
  const normalizedData: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    // Convert snake_case to camelCase for JavaScript
    const camelKey = toCamelCase(key);

    if (value instanceof Date) {
      normalizedData[camelKey] = value;
    } else if (isDateField(key) && typeof value === 'string') {
      normalizedData[camelKey] = new Date(value);
    } else {
      normalizedData[camelKey] = value;
    }
  }
  return normalizedData;
}

/**
 * Formats data for SQL by converting Date objects to ISO strings
 * and camelCase property names to snake_case column names
 *
 * @param data - Object with data to format (camelCase property names from JavaScript)
 * @returns Object with properly formatted values and snake_case column names for SQL
 */
export function formatDataSql(data: Record<string, any>) {
  const normalizedData: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    // Convert camelCase to snake_case for SQL
    const snakeKey = toSnakeCase(key);

    if (value instanceof Date) {
      normalizedData[snakeKey] = value.toISOString(); // Postgres accepts ISO format with timezone
    } else {
      normalizedData[snakeKey] = value;
    }
  }
  return normalizedData;
}
