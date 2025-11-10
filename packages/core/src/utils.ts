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
  // Fallback pattern matching when schema is not available
  // Primary date detection should use schema field types
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
 * const fields = await fieldsFromClass(Product);
 * console.log(fields.name.type); // 'TEXT'
 * console.log(fields.price.type); // 'REAL'
 * ```
 */
export async function fieldsFromClass(
  ClassType: new (...args: any[]) => any,
  values?: Record<string, any>,
) {
  const className = ClassType.name;
  // NEW: Use getAllFields() to include inherited fields from parent classes
  const cachedFields = await ObjectRegistry.getAllFields(className);

  // Phase 2: AST manifest only - no runtime introspection fallback
  if (cachedFields.size === 0) {
    // Return empty fields for unregistered classes (for backward compatibility)
    // generateSchema() will throw if it needs field definitions
    return {};
  }

  // Use cached field definitions from AST manifest
  const fields: Record<string, any> = {};

  // Base class fields that should always be included for SmrtObject subclasses
  // These match registry.ts SCHEMA_PROPERTIES
  const BASE_FIELDS = {
    id: { name: 'id', type: 'text' },
    slug: { name: 'slug', type: 'text' },
    context: { name: 'context', type: 'text' },
    created_at: { name: 'created_at', type: 'datetime' },
    updated_at: { name: 'updated_at', type: 'datetime' },
  };

  // Add base fields first (will be overridden if class defines them explicitly)
  for (const [key, fieldDef] of Object.entries(BASE_FIELDS)) {
    fields[key] = { ...fieldDef };
  }

  // Add/override with fields from cached registry
  for (const [key, field] of cachedFields.entries()) {
    fields[key] = {
      name: key,
      type: field.type || 'TEXT',
      ...(values && key in values ? { value: values[key] } : {}),
    };
  }

  return fields;
}

// NOTE: generateSchema and setupTableFromClass moved to schema/utils.ts
// to prevent bundling Node.js-only code (SchemaGenerator with node:crypto) in browser builds.
// Import from './schema/utils' in Node.js code that needs schema generation.

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
 * Formats data for JavaScript by converting date strings to Date objects
 * and snake_case column names to camelCase properties
 *
 * @param data - Object with data to format (snake_case column names from DB)
 * @param fields - Optional field definitions to determine types (from fieldsFromClass)
 * @returns Object with properly typed values and camelCase property names for JavaScript
 */
export function formatDataJs(
  data: Record<string, any>,
  fields?: Record<string, { type?: string }>,
) {
  const normalizedData: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    // Convert snake_case to camelCase for JavaScript
    const camelKey = toCamelCase(key);

    if (value instanceof Date) {
      normalizedData[camelKey] = value;
    } else if (typeof value === 'string') {
      // Use field definitions if available, otherwise fall back to name patterns
      const fieldType = fields?.[camelKey]?.type?.toLowerCase();
      const isDate = fieldType === 'datetime' || isDateField(key);

      if (isDate) {
        normalizedData[camelKey] = new Date(value);
      } else {
        normalizedData[camelKey] = value;
      }
    } else if (
      typeof value === 'number' &&
      fields?.[camelKey]?.type?.toLowerCase() === 'boolean'
    ) {
      // Convert SQLite integers (0/1) to booleans for boolean fields
      normalizedData[camelKey] = value === 1;
    } else {
      normalizedData[camelKey] = value;
    }
  }
  return normalizedData;
}

/**
 * Type guard to check if a value is a Field instance
 *
 * Uses instanceof check (most reliable) with structural fallback for edge cases.
 * Improves type safety over duck typing by properly narrowing the type.
 *
 * @param value - Value to check
 * @returns True if value is a Field instance, false otherwise
 * @example
 * ```typescript
 * import { text } from '@happyvertical/smrt-core/fields';
 *
 * const field = text({ default: 'hello' });
 * if (isFieldInstance(field)) {
 *   console.log(field.value); // TypeScript knows this is a Field
 * }
 * ```
 */
export function isFieldInstance(
  value: any,
): value is import('./fields/index.js').Field {
  if (!value || typeof value !== 'object') {
    return false;
  }

  // Try instanceof check first (most reliable)
  // Import Field class dynamically to avoid circular dependency issues
  try {
    const { Field } = require('./fields/index.js');
    if (value instanceof Field) {
      return true;
    }
  } catch {
    // Fall through to structural check if import fails
  }

  // Structural check as fallback: Field instances have 'type', 'value', and 'options' properties
  // This is more specific than just checking 'type' and 'value'
  return (
    'type' in value &&
    'value' in value &&
    'options' in value &&
    typeof value.type === 'string'
  );
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

    // Extract value from Field instances using type guard
    let actualValue = value;
    if (isFieldInstance(value)) {
      actualValue = value.value;
    }

    if (actualValue instanceof Date) {
      normalizedData[snakeKey] = actualValue.toISOString(); // Postgres accepts ISO format with timezone
    } else {
      normalizedData[snakeKey] = actualValue;
    }
  }
  return normalizedData;
}
