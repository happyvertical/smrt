import pluralizeLib from 'pluralize';
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
 *   name: string = '';
 *   price: number = 0.0;
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
    id: { name: 'id', type: 'text', _meta: {} },
    slug: { name: 'slug', type: 'text', _meta: {} },
    context: { name: 'context', type: 'text', _meta: {} },
    created_at: { name: 'created_at', type: 'datetime', _meta: {} },
    updated_at: { name: 'updated_at', type: 'datetime', _meta: {} },
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
      _meta: field._meta || {},
      ...(values && key in values ? { value: values[key] } : {}),
    };
  }

  return fields;
}

// NOTE: generateSchema and setupTableFromClass moved to schema/utils.ts
// to prevent bundling Node.js-only code (SchemaGenerator with node:crypto) in browser builds.
// Import from './schema/utils' in Node.js code that needs schema generation.

/**
 * Pluralizes an English word using the pluralize library.
 *
 * Uses the well-tested `pluralize` npm package which handles all English
 * pluralization rules including irregular plurals (person → people,
 * child → children), special cases (quiz → quizzes), and more.
 *
 * For snake_case table names with multiple words (e.g., 'journal_entry'),
 * only the last word is pluralized ('journal_entries').
 *
 * @param word - The word to pluralize (should be lowercase)
 * @returns The pluralized word
 * @example
 * ```typescript
 * pluralize('currency');        // 'currencies'
 * pluralize('journal_entry');   // 'journal_entries'
 * pluralize('statement_batch'); // 'statement_batches'
 * pluralize('product');         // 'products'
 * pluralize('person');          // 'people'
 * pluralize('child');           // 'children'
 * ```
 */
export function pluralize(word: string): string {
  // For snake_case words, only pluralize the last segment
  // e.g., 'journal_entry' → 'journal_entries' (not 'journals_entries')
  if (word.includes('_')) {
    const parts = word.split('_');
    const lastWord = parts.pop();
    if (!lastWord) return word; // Safety check (shouldn't happen)
    return [...parts, pluralizeLib(lastWord)].join('_');
  }

  return pluralizeLib(word);
}

/**
 * Returns the old (incorrect) pluralized table name for migration purposes.
 *
 * This function replicates the previous buggy behavior where 'y' → 'ies'
 * transformation was applied AFTER adding 's', resulting in incorrect
 * pluralization (e.g., 'currency' → 'currencys' instead of 'currencies').
 *
 * Use this to generate migration SQL that renames old tables to new names.
 *
 * @param className - Name of the class
 * @returns The incorrectly pluralized table name (old behavior)
 * @example
 * ```typescript
 * // Generate migration for a class
 * const oldName = legacyClassnameToTablename('Currency');    // 'currencys'
 * const newName = classnameToTablename('Currency');          // 'currencies'
 * console.log(`ALTER TABLE ${oldName} RENAME TO ${newName};`);
 * ```
 */
export function legacyClassnameToTablename(className: string): string {
  return className
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/([^s])$/, '$1s')
    .replace(/y$/, 'ies'); // This runs AFTER 's' is added, so it's a no-op for 'y' words
}

/**
 * Generates migration SQL for renaming tables from old to new naming convention.
 *
 * Returns an array of SQL statements to rename tables that were affected
 * by the pluralization bug (Issue #839).
 *
 * @param classNames - Array of class names to check for migration
 * @returns Array of SQL RENAME statements (empty if no changes needed)
 * @example
 * ```typescript
 * const migrations = generateTableRenameMigrations([
 *   'Currency',
 *   'JournalEntry',
 *   'Product'  // Not affected
 * ]);
 * // Returns:
 * // [
 * //   'ALTER TABLE currencys RENAME TO currencies;',
 * //   'ALTER TABLE journal_entrys RENAME TO journal_entries;'
 * // ]
 * ```
 */
export function generateTableRenameMigrations(classNames: string[]): string[] {
  const migrations: string[] = [];

  for (const className of classNames) {
    const oldName = legacyClassnameToTablename(className);
    const newName = classnameToTablename(className);

    if (oldName !== newName) {
      migrations.push(`ALTER TABLE ${oldName} RENAME TO ${newName};`);
    }
  }

  return migrations;
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
  const snakeCase = ClassType.name
    // Insert underscore between lower & upper case letters
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    // Convert to lowercase
    .toLowerCase();

  return pluralize(snakeCase);
}

/**
 * Converts a class name to a table name with pluralization
 *
 * @param className - Name of the class
 * @returns Pluralized snake_case table name
 */
export function classnameToTablename(className: string) {
  // Convert camelCase/PascalCase to snake_case
  const snakeCase = className
    // Insert underscore between lower & upper case letters
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    // Convert to lowercase
    .toLowerCase();

  // Pluralize using proper English rules
  return pluralize(snakeCase);
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

  if (process.env.DEBUG_STI) {
    console.log('[formatDataJs] Input data:', {
      hasMetaData: !!data._meta_data,
      metaType: data._meta_type,
      keys: Object.keys(data),
    });
  }

  // STI: If _meta_data exists, merge it into data first
  // This ensures meta fields are available during formatting
  if (data._meta_data) {
    const metaData =
      typeof data._meta_data === 'string'
        ? JSON.parse(data._meta_data)
        : data._meta_data;

    if (process.env.DEBUG_STI) {
      console.log('[formatDataJs] Merging _meta_data:', {
        metaDataKeys: Object.keys(metaData),
        metaData,
      });
    }

    // Merge meta fields into data (will be formatted below)
    Object.assign(data, metaData);

    if (process.env.DEBUG_STI) {
      console.log('[formatDataJs] After merge, data keys:', Object.keys(data));
    }
  }

  for (const [key, value] of Object.entries(data)) {
    // Preserve keys with leading underscore (e.g., _meta_type, _meta_data)
    // These are special STI/framework fields that should not be camelCased
    const camelKey = key.startsWith('_') ? key : toCamelCase(key);

    // Determine the actual output key based on what's in fields
    // If the original key (snake_case) is in fields, use it; otherwise use camelCase
    // This supports both conventions (e.g., publish_date vs publishDate)
    let outputKey = camelKey;
    if (fields && key in fields && !(camelKey in fields)) {
      // Original key exists in fields but camelCase doesn't - use original (snake_case)
      outputKey = key;
    }

    // Get field type from fields, trying both key variants
    const fieldDef = fields?.[outputKey] ?? fields?.[camelKey] ?? fields?.[key];
    const fieldType = fieldDef?.type?.toLowerCase();

    if (value instanceof Date) {
      normalizedData[outputKey] = value;
    } else if (typeof value === 'string') {
      // Use field definitions if available, otherwise fall back to name patterns
      const isDate = fieldType === 'datetime' || isDateField(key);

      if (isDate) {
        normalizedData[outputKey] = new Date(value);
      } else if (fieldType === 'json') {
        // Parse JSON strings back to objects
        try {
          normalizedData[outputKey] = JSON.parse(value);
        } catch {
          // Keep as string if parsing fails
          normalizedData[outputKey] = value;
        }
      } else if (fieldType === 'integer') {
        // Convert string numbers to integers for INTEGER fields
        // SQLite may return "2.0" as a string in some cases
        const parsed = Number.parseInt(value, 10);
        normalizedData[outputKey] = Number.isNaN(parsed) ? value : parsed;
      } else if (fieldType === 'real' || fieldType === 'decimal') {
        // Convert string numbers to floats for REAL/DECIMAL fields
        const parsed = Number.parseFloat(value);
        normalizedData[outputKey] = Number.isNaN(parsed) ? value : parsed;
      } else {
        normalizedData[outputKey] = value;
      }
    } else if (typeof value === 'number') {
      if (fieldType === 'boolean') {
        // Convert SQLite integers (0/1) to booleans for boolean fields
        normalizedData[outputKey] = value === 1;
      } else {
        // Pass through numeric values as-is
        // Note: In JavaScript, 2.0 === 2 so no conversion needed
        // Non-integers in INTEGER fields (e.g., 2.9) are kept to surface data issues
        normalizedData[outputKey] = value;
      }
    } else {
      normalizedData[outputKey] = value;
    }
  }

  if (process.env.DEBUG_STI) {
    console.log('[formatDataJs] Output normalizedData:', {
      keys: Object.keys(normalizedData),
      metaType: normalizedData._meta_type,
    });
  }

  return normalizedData;
}

/**
 * Type guard to check if a value is a Field instance
 *
 * @deprecated Field helpers have been removed. This function always returns false.
 * @param value - Value to check
 * @returns Always false (Field class no longer exists)
 */
export function isFieldInstance(value: any): value is never {
  return false;
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

    // Field helpers removed - no need to extract values (deprecated code removed)
    if (value instanceof Date) {
      normalizedData[snakeKey] = value.toISOString(); // Postgres accepts ISO format with timezone
    } else {
      normalizedData[snakeKey] = value;
    }
  }
  return normalizedData;
}
