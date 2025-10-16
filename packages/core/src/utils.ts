import { syncSchema } from '@have/sql';
import { ObjectRegistry } from './registry';

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
export function fieldsFromClass(
  ClassType: new (...args: any[]) => any,
  values?: Record<string, any>,
) {
  // First, try to get cached fields from ObjectRegistry
  const className = ClassType.name;
  const cachedFields = ObjectRegistry.getFields(className);

  if (cachedFields.size > 0) {
    // Use cached field definitions - much more efficient
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

  // Fallback: Create temporary instance for introspection (for unregistered classes)
  const fields: Record<string, any> = {};
  const instance = new ClassType({
    ai: {
      type: 'openai',
      apiKey: 'sk-proj-1234567890',
    },
    db: {
      url: 'file:/tmp/dummy.db',
    },
    _extractingFields: true, // Prevent infinite recursion in initializeFields
    _skipRegistration: true, // Don't register during field extraction
  });

  // Get descriptors from the instance and all ancestors
  const descriptors = new Map<string, PropertyDescriptor>();

  // Start with the instance
  Object.entries(Object.getOwnPropertyDescriptors(instance)).forEach(
    ([key, descriptor]) => {
      descriptors.set(key, descriptor);
    },
  );

  // Walk up the prototype chain
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    Object.entries(Object.getOwnPropertyDescriptors(proto)).forEach(
      ([key, descriptor]) => {
        // Only add if we haven't seen this property before
        if (!descriptors.has(key)) {
          descriptors.set(key, descriptor);
        }
      },
    );
    proto = Object.getPrototypeOf(proto);
  }

  // Process all collected descriptors
  for (const [key, descriptor] of descriptors) {
    // Skip methods, getters/setters, and internal properties
    if (
      typeof descriptor.value === 'function' ||
      descriptor.get ||
      descriptor.set ||
      key.startsWith('_') ||
      key.startsWith('#') ||
      key === 'constructor'
    ) {
      continue;
    }

    // If it's a data property with a defined type
    if (descriptor.value !== undefined) {
      let type: string | undefined;

      // Check the property definition
      const defaultValue = descriptor.value;
      if (defaultValue instanceof Date || isDateField(key)) {
        type = 'DATETIME';
      } else if (typeof defaultValue === 'string') {
        type = 'TEXT';
      } else if (typeof defaultValue === 'number') {
        type = 'INTEGER';
      } else if (defaultValue === null) {
        type = 'TEXT';
      }

      if (type) {
        fields[key] = {
          name: key,
          type,
          ...(values && key in values
            ? {
                value: values[key],
              }
            : {}),
        };
      }
    }
  }
  return fields;
}

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
export function generateSchema(ClassType: new (...args: any[]) => any) {
  const tableName = tableNameFromClass(ClassType);
  const fields = fieldsFromClass(ClassType);

  // Check if any field is marked as primaryKey
  let customPKField: string | null = null;
  let customPKColumnName: string | null = null;

  // First, check cached fields from ObjectRegistry (more reliable)
  const className = ClassType.name;
  const cachedFields = ObjectRegistry.getFields(className);

  if (cachedFields.size > 0) {
    for (const [key, field] of cachedFields.entries()) {
      if (field.options?.primaryKey) {
        customPKField = key;
        customPKColumnName = toSnakeCase(key);
        break;
      }
    }
  }

  // Quote table name to handle SQL reserved keywords (e.g., "is", "as", "select")
  let schema = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n`;

  // If there's a custom primary key, use it; otherwise use default id field
  const hasCustomPK = customPKField !== null;

  if (!hasCustomPK) {
    // Default behavior: Add id field first (always required)
    schema += '  id TEXT PRIMARY KEY,\n';

    // Add slug and context fields
    schema += '  slug TEXT NOT NULL,\n';
    schema += "  context TEXT NOT NULL DEFAULT CAST('' AS TEXT),\n";
  }

  // Track which timestamp fields we've added to avoid duplicates
  let hasCreatedAt = false;
  let hasUpdatedAt = false;

  // Add all fields - convert camelCase property names to snake_case column names
  for (const [key, field] of Object.entries(fields)) {
    // Skip id, slug, context only if we're using default PK behavior
    if (!hasCustomPK && (key === 'id' || key === 'slug' || key === 'context')) {
      continue;
    }

    // Track timestamp fields and skip duplicates
    if (key === 'created_at' || key === 'createdAt') {
      if (hasCreatedAt) continue; // Skip duplicate
      hasCreatedAt = true;
    }
    if (key === 'updated_at' || key === 'updatedAt') {
      if (hasUpdatedAt) continue; // Skip duplicate
      hasUpdatedAt = true;
    }

    const columnName = toSnakeCase(key);
    const fieldDef = cachedFields.get(key);
    const sqlType = fieldDef?.getSqlType() || field.type || 'TEXT';
    let constraints = fieldDef?.getSqlConstraints() || [];

    // For TEXT columns without Field definitions (simple properties like url = ''),
    // add NOT NULL DEFAULT '' to prevent DuckDB ANY type inference
    if (constraints.length === 0 && sqlType === 'TEXT') {
      constraints = ["NOT NULL DEFAULT ''"];
    }

    schema += `  ${columnName} ${sqlType}${constraints.length > 0 ? ' ' + constraints.join(' ') : ''},\n`;
  }

  // Ensure timestamp columns exist for triggers (if not already added)
  if (!hasCreatedAt) {
    schema += '  created_at DATETIME,\n';
  }
  if (!hasUpdatedAt) {
    schema += '  updated_at DATETIME,\n';
  }

  // Add composite unique constraint for slug and context only if using default PK
  if (!hasCustomPK) {
    schema += '  UNIQUE(slug, context),\n';
  }

  schema = schema.slice(0, -2); // Remove trailing comma and newline
  schema += '\n);';

  // Add indexes
  if (hasCustomPK) {
    schema += `\nCREATE INDEX IF NOT EXISTS ${tableName}_${customPKColumnName}_idx ON ${tableName} (${customPKColumnName});`;
  } else {
    schema += `\nCREATE INDEX IF NOT EXISTS ${tableName}_id_idx ON ${tableName} (id);`;
    schema += `\nCREATE INDEX IF NOT EXISTS ${tableName}_slug_context_idx ON ${tableName} (slug, context);`;
  }

  return schema;
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
      // Always generate fresh schema to ensure latest field mapping is used
      const schema = generateSchema(ClassType);

      // Detect custom primary key field
      const className = ClassType.name;
      const cachedFields = ObjectRegistry.getFields(className);
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
