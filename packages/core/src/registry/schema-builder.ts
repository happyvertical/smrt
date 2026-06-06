/**
 * Schema building logic for the SMRT ObjectRegistry.
 *
 * Extracted from registry.ts as part of issue #1006.
 */

import { ObjectRegistry } from '../registry';
import type { FieldDefinition } from '../scanner/types.js';
import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaDefinition,
  SQLDataType,
} from '../schema/types.js';
import { classnameToTablename, toSnakeCase } from '../utils';
import {
  type CollectionRegistrationLookup,
  isCollectionRegistration,
} from './collection-resolution';
import { findClass } from './name-resolver';
import { getClasses, getCollectionTableNames } from './shared-state';

type ForeignKeyAction = NonNullable<
  NonNullable<ColumnDefinition['foreignKey']>['onDelete']
>;

const collectionRegistrationLookup: CollectionRegistrationLookup = {
  findClass,
  findClassInPackage: (packageName, className) =>
    ObjectRegistry.getClassInPackage(packageName, className),
  getInheritanceChain: (className) =>
    ObjectRegistry.getInheritanceChain(className),
};

function applyDecoratorSqlTypeOverrides(
  className: string,
  columns: Record<string, ColumnDefinition>,
): Record<string, ColumnDefinition> {
  const decorators = ObjectRegistry.getFieldDecorators(className);
  if (!decorators.size) {
    return columns;
  }

  for (const [fieldName, options] of decorators) {
    if (!options?.sqlType) {
      continue;
    }

    const columnName = toSnakeCase(fieldName);
    const existing = columns[columnName];
    if (!existing) {
      continue;
    }

    const referenceKind = getReferenceKind(options as FieldDefinition);
    columns[columnName] = {
      ...existing,
      type: String(options.sqlType).toUpperCase() as SQLDataType,
      ...(referenceKind ? { referenceKind } : {}),
    };
  }

  return columns;
}

function mergeRuntimeFieldColumns(
  className: string,
  schemaColumns: Record<string, ColumnDefinition> | undefined,
  fields: Map<string, FieldDefinition>,
): Record<string, ColumnDefinition> {
  const columnsToUse = { ...(schemaColumns || {}) };

  if (fields.size > 0) {
    const fieldColumns = fieldsToColumns(fields);
    for (const [columnName, columnDef] of Object.entries(fieldColumns)) {
      if (!columnsToUse[columnName]) {
        columnsToUse[columnName] = columnDef;
      }
    }

    for (const [fieldName, fieldDef] of fields) {
      const columnName = toSnakeCase(fieldName);
      const existing = columnsToUse[columnName];
      if (!existing) {
        continue;
      }

      const sqlType = fieldDef._meta?.sqlType || (fieldDef as any).sqlType;
      const referenceKind = getReferenceKind(fieldDef);
      columnsToUse[columnName] = {
        ...existing,
        ...(sqlType
          ? { type: String(sqlType).toUpperCase() as SQLDataType }
          : {}),
        ...(referenceKind ? { referenceKind } : {}),
      };
    }
  }

  applyDecoratorSqlTypeOverrides(className, columnsToUse);
  return columnsToUse;
}

function getReferenceKind(
  fieldDef: FieldDefinition,
): ColumnDefinition['referenceKind'] | undefined {
  if (
    (fieldDef as any).__tenancy?.isTenantIdField ||
    fieldDef._meta?.__tenancy?.isTenantIdField
  ) {
    return 'tenantId';
  }

  if (fieldDef.type === 'foreignKey') {
    return 'foreignKey';
  }

  if (fieldDef.type === 'crossPackageRef') {
    return 'crossPackageRef';
  }

  return undefined;
}

function shouldEmitDefault(fieldDef: FieldDefinition, sqlType: SQLDataType) {
  return !(
    getReferenceKind(fieldDef) === 'tenantId' &&
    sqlType === 'UUID' &&
    fieldDef.default === ''
  );
}

/**
 * Get cached schema definition for a registered class
 *
 * @param name - Name of the registered class
 * @returns Schema definition or undefined if not found
 * @example
 * ```typescript
 * const schema = getSchema('Product');
 * console.log(schema.tableName); // 'products'
 * console.log(schema.ddl);       // 'CREATE TABLE...'
 * ```
 */
export function getSchema(name: string): SchemaDefinition | undefined {
  // Issue #951: Use findClass for multi-strategy lookup
  const registered = findClass(name);
  return registered?.schema;
}

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
export function getSchemaDDL(name: string): string | undefined {
  return getSchema(name)?.ddl;
}

/**
 * Get table name for a registered class
 *
 * @param name - Name of the registered class
 * @returns Table name or undefined if not found
 * @example
 * ```typescript
 * const tableName = getTableName('Product');
 * console.log(tableName); // 'products'
 * ```
 */
export function getTableName(name: string): string | undefined {
  // Check if this is a collection class - collections have their own tableName mapping
  const collectionTableName = getCollectionTableNames().get(name);
  if (collectionTableName) {
    return collectionTableName;
  }

  // For STI classes, return the STI base class's table name.
  // R5-canon: `getSTIBase` returns the qualified name; resolve `name`
  // (which may be simple) to its registration's qualified form for the
  // comparison.
  const stiBase = ObjectRegistry.getSTIBase(name);
  const registered = ObjectRegistry.getClass(name);
  const qualifiedName = registered?.qualifiedName ?? registered?.name ?? name;
  if (stiBase && stiBase !== qualifiedName) {
    return getSchema(stiBase)?.tableName;
  }
  return getSchema(name)?.tableName;
}

/**
 * Get all pre-generated schemas for explicit adapter bootstrap paths.
 *
 * Returns schemas in SDK SchemaProvider format for all registered classes.
 * Tooling and test helpers can pass these to `getDatabase()` when they want
 * to bootstrap schema before runtime. Core runtime no longer does this
 * implicitly.
 *
 * @returns Record of table names to schema definitions
 * @example
 * ```typescript
 * const schemas = ObjectRegistry.getAllSchemas();
 * const db = await getDatabase({ type: 'json', url: './data', schemas });
 * ```
 */
export function getAllSchemas(): Record<
  string,
  { tableName: string; ddl: string; indexes?: string[] }
> {
  // Step 1: Collect all schemas grouped by tableName
  // For STI, multiple classes may share the same table
  const tableSchemas: Record<
    string,
    {
      tableName: string;
      columns: Record<string, ColumnDefinition>;
      indexes: Array<{ name: string; columns: string[]; unique?: boolean }>;
      ddl: string;
      isSTI: boolean;
    }
  > = {};

  for (const [_className, registered] of getClasses()) {
    // Skip collection classes - they don't have their own tables
    // Their schemas incorrectly contain collection properties (loaded, options, etc.)
    if (
      isCollectionRegistration(
        _className,
        registered,
        collectionRegistrationLookup,
      )
    ) {
      continue;
    }

    // Issue #951: Use simple name for STI comparisons (map key may be qualified)
    const simpleName = registered.name || _className;

    // Issue #703: Handle STI subclasses with null tableName from external manifests
    // When loaded from external manifests, tableName may be null, causing
    // registerFromManifest() to derive a tableName from class name.
    // For STI subclasses, we need to use the STI base's tableName instead.
    if (!registered.schema?.tableName && registered.extends) {
      // R5-canon: use the qualified key for STI lookups so colliding
      // simple names don't resolve to the wrong package's class.
      // `getTableStrategy` / `getSTIBase` both accept qualified names
      // via `findClass`'s multi-strategy lookup.
      const qualifiedName = (registered as any).qualifiedName ?? simpleName;
      const lookupKey = qualifiedName;
      const tableStrategy = ObjectRegistry.getTableStrategy(lookupKey);
      if (tableStrategy === 'sti') {
        const stiBaseName = ObjectRegistry.getSTIBase(lookupKey);
        if (stiBaseName && stiBaseName !== qualifiedName) {
          const stiBaseClass = findClass(stiBaseName);
          if (stiBaseClass?.schema?.tableName) {
            // Ensure we have a schema object to modify
            if (!registered.schema) {
              registered.schema = {
                tableName: '',
                ddl: '',
                columns: {},
                indexes: [],
                triggers: [],
                foreignKeys: [],
                dependencies: [],
                version: '',
              };
            }
            // Set tableName from STI base so the following block processes this class
            registered.schema.tableName = stiBaseClass.schema.tableName;
          }
        }
      }
    }

    if (registered.schema?.tableName) {
      // For STI subclasses, use the STI base class's tableName
      // This ensures all STI subclass columns are merged into the parent table
      // (Issue #693: STI subclasses with separate tableName still serialize to parent table)
      let tableName = registered.schema.tableName;
      // R5-canon: same qualified-key strategy as the block above.
      const qualifiedName = (registered as any).qualifiedName ?? simpleName;
      const lookupKey = qualifiedName;
      const tableStrategy = ObjectRegistry.getTableStrategy(lookupKey);
      if (tableStrategy === 'sti') {
        const stiBaseName = ObjectRegistry.getSTIBase(lookupKey);
        if (stiBaseName && stiBaseName !== qualifiedName) {
          // This is an STI subclass - use the base class's tableName
          const stiBaseClass = findClass(stiBaseName);
          if (stiBaseClass?.schema?.tableName) {
            tableName = stiBaseClass.schema.tableName;
          }
        }
      }

      // Start with manifest columns, then backfill any columns that only exist
      // in runtime field metadata (for example tenantScoped injections). We do
      // not replace existing manifest column metadata here, because the manifest
      // is authoritative for foreign keys, defaults, and other schema details.
      // Explicit decorator sqlType overrides are patched onto the merged column.
      const columnsToUse = mergeRuntimeFieldColumns(
        simpleName,
        registered.schema.columns,
        registered.fields,
      );

      if (!tableSchemas[tableName]) {
        // First class for this table - initialize with base columns
        // These are required for all tables but are skipped by fieldsToColumns()
        const baseColumns: Record<string, ColumnDefinition> = {
          id: { type: 'UUID', primaryKey: true, referenceKind: 'id' },
          slug: { type: 'TEXT', notNull: true },
          context: { type: 'TEXT' },
          created_at: { type: 'TIMESTAMP' },
          updated_at: { type: 'TIMESTAMP' },
        };

        // For STI tables, add discriminator and data columns
        // (Issue #690: db:diff needs these columns to detect schema changes)
        const isSTI = tableStrategy === 'sti';
        if (isSTI) {
          baseColumns._meta_type = {
            type: 'TEXT',
            notNull: true,
            defaultValue: '',
          };
          baseColumns._meta_data = { type: 'JSON' };
        }

        tableSchemas[tableName] = {
          tableName,
          columns: { ...baseColumns, ...columnsToUse },
          indexes: [],
          ddl: registered.schema.ddl || '',
          isSTI,
        };
      } else {
        // Additional class sharing this table (STI scenario)
        // Merge columns from this class into the existing schema
        for (const [colName, colDef] of Object.entries(columnsToUse)) {
          if (!tableSchemas[tableName].columns[colName]) {
            // New column from this subtype - add it
            tableSchemas[tableName].columns[colName] = colDef;
          }
        }
      }

      // Merge indexes (avoid duplicates by name)
      if (registered.schema.indexes && registered.schema.indexes.length > 0) {
        const existingNames = new Set(
          tableSchemas[tableName].indexes.map((idx) =>
            typeof idx === 'string' ? idx : idx.name,
          ),
        );
        for (const idx of registered.schema.indexes) {
          const indexName = typeof idx === 'string' ? idx : idx.name;
          if (!existingNames.has(indexName)) {
            if (typeof idx === 'string') {
              // Legacy string format - skip, can't merge properly
            } else {
              tableSchemas[tableName].indexes.push(idx);
              existingNames.add(idx.name);
            }
          }
        }
      }
    }
  }

  // Step 2: Convert to output format, regenerating DDL for merged schemas
  const schemas: Record<
    string,
    { tableName: string; ddl: string; indexes?: string[] }
  > = {};

  for (const [tableName, tableSchema] of Object.entries(tableSchemas)) {
    // Generate DDL from merged columns (or use original DDL if columns are empty)
    let ddl: string;
    if (Object.keys(tableSchema.columns).length === 0 && tableSchema.ddl) {
      // No columns merged - use original DDL to avoid generating invalid SQL
      ddl = tableSchema.ddl;
    } else if (Object.keys(tableSchema.columns).length === 0) {
      // Skip schemas with no columns and no original DDL
      continue;
    } else {
      ddl = generateDDLFromColumns(
        tableName,
        tableSchema.columns,
        tableSchema.isSTI,
      );
    }

    // Convert index definitions to SQL strings for SDK compatibility
    let indexSQL: string[] | undefined;
    if (tableSchema.indexes.length > 0) {
      indexSQL = tableSchema.indexes.map((idx) => {
        const indexType = idx.unique ? 'UNIQUE INDEX' : 'INDEX';
        const columnList = idx.columns.map((col) => `"${col}"`).join(', ');
        return `CREATE ${indexType} IF NOT EXISTS "${idx.name}" ON "${tableName}" (${columnList});`;
      });
    }

    schemas[tableName] = {
      tableName,
      ddl,
      indexes: indexSQL,
    };
  }

  return schemas;
}

/**
 * Get all registered schemas as SchemaDefinition objects
 *
 * Similar to getAllSchemas(), but returns SchemaDefinition format suitable
 * for use with SchemaComparer (migrations/differ.ts).
 *
 * Key difference: Indexes are kept as IndexDefinition objects instead of
 * being converted to SQL strings.
 *
 * @returns Map of tableName to SchemaDefinition
 */
export function getAllSchemasAsDefinitions(): Record<string, SchemaDefinition> {
  // Step 1: Collect all schemas grouped by tableName
  // For STI, multiple classes may share the same table
  const tableSchemas: Record<
    string,
    {
      tableName: string;
      columns: Record<string, ColumnDefinition>;
      indexes: IndexDefinition[];
      isSTI: boolean;
    }
  > = {};

  for (const [_className, registered] of getClasses()) {
    // Skip collection classes - they don't have their own tables
    if (
      isCollectionRegistration(
        _className,
        registered,
        collectionRegistrationLookup,
      )
    ) {
      continue;
    }

    // Issue #951: Use simple name for STI comparisons (map key may be qualified)
    const simpleName = registered.name || _className;

    // Handle STI subclasses with null tableName from external manifests
    if (!registered.schema?.tableName && registered.extends) {
      // R5-canon: use the qualified key for STI lookups so colliding
      // simple names don't resolve to the wrong package's class.
      // `getTableStrategy` / `getSTIBase` both accept qualified names
      // via `findClass`'s multi-strategy lookup.
      const qualifiedName = (registered as any).qualifiedName ?? simpleName;
      const lookupKey = qualifiedName;
      const tableStrategy = ObjectRegistry.getTableStrategy(lookupKey);
      if (tableStrategy === 'sti') {
        const stiBaseName = ObjectRegistry.getSTIBase(lookupKey);
        if (stiBaseName && stiBaseName !== qualifiedName) {
          const stiBaseClass = findClass(stiBaseName);
          if (stiBaseClass?.schema?.tableName) {
            if (!registered.schema) {
              registered.schema = {
                tableName: '',
                ddl: '',
                columns: {},
                indexes: [],
                triggers: [],
                foreignKeys: [],
                dependencies: [],
                version: '',
              };
            }
            registered.schema.tableName = stiBaseClass.schema.tableName;
          }
        }
      }
    }

    if (registered.schema?.tableName) {
      // For STI subclasses, use the STI base class's tableName.
      // R5-canon: qualified-key lookup so a colliding simple name in
      // another package can't yield the wrong tableStrategy / STI base
      // and move this class's columns under that other package's table.
      let tableName = registered.schema.tableName;
      const qualifiedName = (registered as any).qualifiedName ?? simpleName;
      const lookupKey = qualifiedName;
      const tableStrategy = ObjectRegistry.getTableStrategy(lookupKey);
      if (tableStrategy === 'sti') {
        const stiBaseName = ObjectRegistry.getSTIBase(lookupKey);
        if (stiBaseName && stiBaseName !== qualifiedName) {
          const stiBaseClass = findClass(stiBaseName);
          if (stiBaseClass?.schema?.tableName) {
            tableName = stiBaseClass.schema.tableName;
          }
        }
      }

      // Manifest schema remains authoritative for existing columns. Runtime
      // field metadata can backfill missing columns and apply explicit sqlType
      // overrides without erasing richer manifest metadata.
      const columnsToUse = mergeRuntimeFieldColumns(
        simpleName,
        registered.schema.columns,
        registered.fields,
      );

      if (!tableSchemas[tableName]) {
        // First class for this table - initialize with base columns
        const baseColumns: Record<string, ColumnDefinition> = {
          id: { type: 'UUID', primaryKey: true, referenceKind: 'id' },
          slug: { type: 'TEXT', notNull: true },
          context: { type: 'TEXT' },
          created_at: { type: 'TIMESTAMP' },
          updated_at: { type: 'TIMESTAMP' },
        };

        const isSTI = tableStrategy === 'sti';
        if (isSTI) {
          baseColumns._meta_type = {
            type: 'TEXT',
            notNull: true,
            defaultValue: '',
          };
          baseColumns._meta_data = { type: 'JSON' };
        }

        tableSchemas[tableName] = {
          tableName,
          columns: { ...baseColumns, ...columnsToUse },
          indexes: [],
          isSTI,
        };
      } else {
        // Additional class sharing this table (STI scenario) - merge columns
        for (const [colName, colDef] of Object.entries(columnsToUse)) {
          if (!tableSchemas[tableName].columns[colName]) {
            tableSchemas[tableName].columns[colName] = colDef;
          }
        }
      }

      // Merge indexes (avoid duplicates by name)
      if (registered.schema.indexes && registered.schema.indexes.length > 0) {
        const existingNames = new Set(
          tableSchemas[tableName].indexes.map((idx) => idx.name),
        );
        for (const idx of registered.schema.indexes) {
          if (!existingNames.has(idx.name)) {
            tableSchemas[tableName].indexes.push(idx);
            existingNames.add(idx.name);
          }
        }
      }
    }
  }

  // Step 2: Convert to SchemaDefinition format
  const schemas: Record<string, SchemaDefinition> = {};

  for (const [tableName, tableSchema] of Object.entries(tableSchemas)) {
    if (Object.keys(tableSchema.columns).length === 0) {
      continue;
    }

    // Generate DDL from columns
    const ddl = generateDDLFromColumns(
      tableName,
      tableSchema.columns,
      tableSchema.isSTI,
    );

    schemas[tableName] = {
      tableName,
      ddl,
      columns: tableSchema.columns,
      indexes: tableSchema.indexes, // Keep as IndexDefinition[]
      triggers: [],
      foreignKeys: [],
      version: '',
      dependencies: [],
    };
  }

  return schemas;
}

/**
 * Generate DDL CREATE TABLE statement from columns
 *
 * Used internally by getAllSchemas() to regenerate DDL after merging
 * columns from multiple STI subtypes that share the same table.
 *
 * @param tableName - Name of the table
 * @param columns - Column definitions
 * @returns DDL CREATE TABLE statement
 */
export function generateDDLFromColumns(
  tableName: string,
  columns: Record<string, ColumnDefinition>,
  isSTI = false,
): string {
  let sql = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n`;

  const columnLines: string[] = [];
  for (const [columnName, columnDef] of Object.entries(columns)) {
    const parts: string[] = [];

    // Column name and type
    parts.push(`  "${columnName}" ${columnDef.type}`);

    // Primary key
    if (columnDef.primaryKey) {
      parts.push('PRIMARY KEY');
    }

    // Not null constraint
    if (columnDef.notNull) {
      parts.push('NOT NULL');
    }

    // Unique constraint (skip if primary key already implies uniqueness)
    if (columnDef.unique && !columnDef.primaryKey) {
      parts.push('UNIQUE');
    }

    // Default value
    if (columnDef.defaultValue !== undefined) {
      const defaultSQL = formatDefaultValue(
        columnDef.defaultValue,
        columnDef.type,
      );
      parts.push(`DEFAULT ${defaultSQL}`);
    }

    columnLines.push(parts.join(' '));
  }

  sql += columnLines.join(',\n');

  // Add UNIQUE constraint for UPSERT operations
  // For STI tables: UNIQUE(slug, context, _meta_type) - different types can have same slug+context
  // For non-STI tables: UNIQUE(slug, context)
  if (columns.slug && columns.context) {
    if (isSTI && columns._meta_type) {
      sql += ',\n  UNIQUE(slug, context, _meta_type)';
    } else {
      sql += ',\n  UNIQUE(slug, context)';
    }
  }

  sql += '\n);';

  return sql;
}

/**
 * Format default value for SQL DDL
 *
 * @param value - Default value
 * @param type - Column SQL type
 * @returns Formatted SQL default value
 */
export function formatDefaultValue(value: any, type: string): string {
  // Handle NULL
  if (value === null || value === undefined) {
    return 'NULL';
  }

  // Handle SQL functions and keywords
  if (typeof value === 'string') {
    if (value.includes('(')) {
      return value;
    }
    const sqlKeywords = [
      'current_timestamp',
      'current_date',
      'current_time',
      'now()',
      'uuid_generate_v4()',
      'null',
    ];
    if (sqlKeywords.some((kw) => value.toLowerCase() === kw)) {
      return value;
    }
  }

  // Handle by type
  if (type === 'TEXT' || type === 'VARCHAR') {
    return `'${String(value).replace(/'/g, "''")}'`;
  }
  if (type === 'INTEGER' || type === 'REAL') {
    return String(value);
  }
  if (type === 'BOOLEAN') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (type === 'JSON') {
    if (typeof value === 'string') {
      if (value === '') return "'null'";
      if (value === '[object Object]') return "'{}'";
      try {
        JSON.parse(value);
        return `'${value.replace(/'/g, "''")}'`;
      } catch {
        const json = JSON.stringify(value);
        return `'${json.replace(/'/g, "''")}'`;
      }
    }
    const json = JSON.stringify(value);
    return `'${json.replace(/'/g, "''")}'`;
  }

  // Fallback: quote as string
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Convert a Map of field definitions to column definitions
 *
 * Used by getAllSchemas() to generate columns from fields when a class
 * has no pre-generated schema (e.g., STI subclasses registered from manifest).
 *
 * @param fields - Map of field name to field definition
 * @returns Record of column name to column definition
 * @private
 */
export function fieldsToColumns(
  fields: Map<string, FieldDefinition>,
): Record<string, ColumnDefinition> {
  const columns: Record<string, ColumnDefinition> = {};

  for (const [fieldName, fieldDef] of fields) {
    // Skip id, timestamps - they're on the base table
    if (
      fieldName === 'id' ||
      fieldName === 'created_at' ||
      fieldName === 'updated_at' ||
      fieldName === 'slug' ||
      fieldName === 'context'
    ) {
      continue;
    }

    // Skip transient fields (non-persisted)
    if (fieldDef.transient || fieldDef._meta?.transient) {
      continue;
    }

    // Skip relationship fields that don't create columns
    // oneToMany and manyToMany are relationship metadata, not actual database columns
    if (fieldDef.type === 'oneToMany' || fieldDef.type === 'manyToMany') {
      continue;
    }

    // Skip meta fields - they're stored in _meta_data JSONB column
    if (fieldDef.type === 'meta') {
      continue;
    }

    // Map field type to SQL type
    const sqlType =
      fieldDef._meta?.sqlType ||
      (fieldDef.type === 'crossPackageRef' &&
      (fieldDef._meta?.idType === 'text' || (fieldDef as any).idType === 'text')
        ? 'TEXT'
        : mapFieldTypeToSQL(fieldDef.type));
    const normalizedSqlType = String(sqlType).toUpperCase() as SQLDataType;
    const referenceKind = getReferenceKind(fieldDef);

    const column: ColumnDefinition = {
      type: normalizedSqlType,
      referenceKind,
      notNull: fieldDef._meta?.nullable ? false : fieldDef.required || false,
      unique: fieldDef._meta?.unique || false,
      description: fieldDef.description,
    };

    // Handle default values
    if (
      fieldDef.default !== undefined &&
      shouldEmitDefault(fieldDef, normalizedSqlType)
    ) {
      column.defaultValue = fieldDef.default;
    }

    // Handle foreign keys
    if (fieldDef.type === 'foreignKey' && fieldDef.related) {
      const [table, columnName = 'id'] = fieldDef.related.split('.');
      const fieldMeta = fieldDef._meta as
        | {
            onDelete?: ForeignKeyAction;
            onUpdate?: ForeignKeyAction;
          }
        | undefined;
      column.foreignKey = {
        table: classnameToTablename(table),
        column: columnName,
        onDelete: fieldMeta?.onDelete ?? 'CASCADE',
        onUpdate: fieldMeta?.onUpdate ?? 'CASCADE',
      };
    }

    // Use snake_case for column names
    columns[toSnakeCase(fieldName)] = column;
  }

  return columns;
}

/**
 * Map field type to SQL data type
 * @private
 */
export function mapFieldTypeToSQL(
  fieldType: FieldDefinition['type'],
): SQLDataType {
  switch (fieldType) {
    case 'text':
      return 'TEXT';
    case 'integer':
      return 'INTEGER';
    case 'decimal':
      return 'REAL';
    case 'boolean':
      return 'BOOLEAN';
    case 'datetime':
      return 'TIMESTAMP';
    case 'json':
      return 'JSON';
    case 'foreignKey':
      return 'UUID';
    case 'crossPackageRef':
      return 'UUID';
    default:
      return 'TEXT';
  }
}
