/**
 * Schema generator for SMRT objects
 * Converts AST field definitions to database schema definitions
 */

import type { FieldDefinition, SmartObjectDefinition } from '../scanner/types';
import type {
  SchemaDefinition,
  ColumnDefinition,
  IndexDefinition,
  TriggerDefinition,
  SQLDataType,
  ForeignKeyDefinition,
} from './types';
import { createHash } from 'crypto';
import type { Field } from '../fields/index';

export class SchemaGenerator {
  /**
   * Generate schema definition from SMRT object definition
   */
  generateSchema(objectDef: SmartObjectDefinition): SchemaDefinition {
    const tableName = this.getTableName(objectDef);
    const columns = this.generateColumns(objectDef.fields);
    const indexes = this.generateIndexes(objectDef, columns);
    const triggers = this.generateTriggers(objectDef, tableName);
    const foreignKeys = this.extractForeignKeys(columns);
    const dependencies = this.extractDependencies(objectDef, foreignKeys);
    const version = this.generateVersion(objectDef);

    return {
      tableName,
      columns,
      indexes,
      triggers,
      foreignKeys,
      dependencies,
      version,
      packageName: this.extractPackageName(objectDef.filePath),
      baseClass: objectDef.extends,
    };
  }

  /**
   * Convert field type to SQL data type
   */
  private mapFieldTypeToSQL(fieldType: FieldDefinition['type']): SQLDataType {
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
        return 'DATETIME';
      case 'json':
        return 'JSON';
      case 'foreignKey':
        return 'TEXT'; // Foreign keys are typically TEXT
      default:
        return 'TEXT'; // Default fallback
    }
  }

  /**
   * Generate column definitions
   */
  private generateColumns(
    fields: Record<string, FieldDefinition>,
  ): Record<string, ColumnDefinition> {
    const columns: Record<string, ColumnDefinition> = {};

    // Always include base SMRT fields
    columns.id = {
      type: 'TEXT',
      primaryKey: true,
      notNull: true,
      description: 'Primary identifier',
    };

    columns.created_at = {
      type: 'DATETIME',
      notNull: true,
      defaultValue: "datetime('now')",
      description: 'Creation timestamp',
    };

    columns.updated_at = {
      type: 'DATETIME',
      notNull: true,
      defaultValue: "datetime('now')",
      description: 'Last update timestamp',
    };

    // Add fields from object definition
    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      // Skip id fields as we handle them above
      if (
        fieldName === 'id' ||
        fieldName === 'created_at' ||
        fieldName === 'updated_at'
      ) {
        continue;
      }

      const column: ColumnDefinition = {
        type: this.mapFieldTypeToSQL(fieldDef.type),
        notNull: fieldDef.required || false,
        description: fieldDef.description,
      };

      // Handle default values
      if (fieldDef.default !== undefined) {
        column.defaultValue = fieldDef.default;
      } else if (!fieldDef.required && this.mapFieldTypeToSQL(fieldDef.type) === 'TEXT') {
        // For TEXT columns without explicit default or required constraint,
        // add NOT NULL DEFAULT '' to prevent DuckDB ANY type inference
        // DuckDB infers ANY type for nullable TEXT columns without defaults
        column.notNull = true;
        column.defaultValue = '';
      }

      // Handle foreign keys
      if (fieldDef.type === 'foreignKey' && fieldDef.related) {
        const [table, column_name = 'id'] = fieldDef.related.split('.');
        column.foreignKey = {
          table,
          column: column_name,
          onDelete: 'CASCADE', // Default behavior
          onUpdate: 'CASCADE',
        };
      }

      // Handle unique constraints
      if (fieldName === 'slug' || fieldName === 'email') {
        column.unique = true;
      }

      columns[fieldName] = column;
    }

    return columns;
  }

  /**
   * Generate index definitions
   */
  private generateIndexes(
    objectDef: SmartObjectDefinition,
    columns: Record<string, ColumnDefinition>,
  ): IndexDefinition[] {
    const indexes: IndexDefinition[] = [];
    const tableName = this.getTableName(objectDef);

    // Create indexes for foreign keys
    for (const [columnName, columnDef] of Object.entries(columns)) {
      if (columnDef.foreignKey) {
        indexes.push({
          name: `idx_${tableName}_${columnName}`,
          columns: [columnName],
          description: `Index for foreign key ${columnName}`,
        });
      }
    }

    // Create index for updated_at (common query pattern)
    indexes.push({
      name: `idx_${tableName}_updated_at`,
      columns: ['updated_at'],
      description: 'Index for timestamp queries',
    });

    // Create unique indexes
    for (const [columnName, columnDef] of Object.entries(columns)) {
      if (columnDef.unique && !columnDef.primaryKey) {
        indexes.push({
          name: `idx_${tableName}_${columnName}_unique`,
          columns: [columnName],
          unique: true,
          description: `Unique index for ${columnName}`,
        });
      }
    }

    return indexes;
  }

  /**
   * Generate trigger definitions for automatic timestamp updates
   */
  private generateTriggers(
    objectDef: SmartObjectDefinition,
    tableName: string,
  ): TriggerDefinition[] {
    return [
      {
        name: `trg_${tableName}_updated_at`,
        when: 'BEFORE',
        event: 'UPDATE',
        body: `UPDATE ${tableName} SET updated_at = datetime('now') WHERE id = NEW.id;`,
        description: 'Automatically update updated_at timestamp',
      },
    ];
  }

  /**
   * Extract foreign key definitions
   */
  private extractForeignKeys(
    columns: Record<string, ColumnDefinition>,
  ): ForeignKeyDefinition[] {
    const foreignKeys: ForeignKeyDefinition[] = [];

    for (const [columnName, columnDef] of Object.entries(columns)) {
      if (columnDef.foreignKey) {
        foreignKeys.push({
          column: columnName,
          referencesTable: columnDef.foreignKey.table,
          referencesColumn: columnDef.foreignKey.column,
          onDelete: columnDef.foreignKey.onDelete,
          onUpdate: columnDef.foreignKey.onUpdate,
        });
      }
    }

    return foreignKeys;
  }

  /**
   * Extract schema dependencies from foreign keys and inheritance
   */
  private extractDependencies(
    objectDef: SmartObjectDefinition,
    foreignKeys: ForeignKeyDefinition[],
  ): string[] {
    const dependencies = new Set<string>();

    // Add dependencies from foreign keys
    for (const fk of foreignKeys) {
      dependencies.add(fk.referencesTable);
    }

    // Add dependencies from base class
    if (
      objectDef.extends &&
      objectDef.extends !== 'SmrtObject' &&
      objectDef.extends !== 'SmrtCollection'
    ) {
      dependencies.add(this.classNameToTableName(objectDef.extends));
    }

    return Array.from(dependencies);
  }

  /**
   * Generate version hash for schema
   */
  private generateVersion(objectDef: SmartObjectDefinition): string {
    const content = JSON.stringify({
      className: objectDef.className,
      fields: objectDef.fields,
      extends: objectDef.extends,
    });
    return createHash('sha256').update(content).digest('hex').substring(0, 8);
  }

  /**
   * Get table name from object definition
   */
  private getTableName(objectDef: SmartObjectDefinition): string {
    return this.classNameToTableName(objectDef.className);
  }

  /**
   * Convert class name to table name (camelCase to snake_case, pluralized)
   */
  private classNameToTableName(className: string): string {
    return (
      className
        .replace(/([A-Z])/g, '_$1')
        .toLowerCase()
        .replace(/^_/, '')
        .replace(/s$/, '') + 's'
    ); // Simple pluralization
  }

  /**
   * Extract package name from file path
   */
  private extractPackageName(filePath: string): string {
    const match = filePath.match(/packages\/([^/]+)/);
    return match ? match[1] : 'unknown';
  }

  /**
   * Generate schema definition from ObjectRegistry fields (runtime)
   *
   * This method builds a SchemaDefinition from ObjectRegistry cached fields,
   * enabling schema generation from decorated classes at runtime.
   *
   * @param className - Class name to look up in ObjectRegistry
   * @param tableName - Table name (from SMRT_TABLE_NAME or derived)
   * @param fields - Map of Field definitions from ObjectRegistry
   * @returns Schema definition object
   */
  generateSchemaFromRegistry(
    className: string,
    tableName: string,
    fields: Map<string, Field>
  ): SchemaDefinition {
    const columns: Record<string, ColumnDefinition> = {};

    // Check for custom primary key
    let hasCustomPK = false;
    for (const [fieldName, field] of fields.entries()) {
      if (field.options?.primaryKey) {
        hasCustomPK = true;
        break;
      }
    }

    // Add default SMRT fields if no custom primary key
    if (!hasCustomPK) {
      columns.id = {
        type: 'TEXT',
        primaryKey: true,
        notNull: true,
        description: 'Primary identifier',
      };

      columns.slug = {
        type: 'TEXT',
        notNull: true,
        description: 'URL-friendly identifier',
      };

      columns.context = {
        type: 'TEXT',
        notNull: true,
        defaultValue: '',
        description: 'Context for slug scoping',
      };
    }

    // Track timestamp fields to avoid duplicates
    let hasCreatedAt = false;
    let hasUpdatedAt = false;

    // Add fields from ObjectRegistry
    for (const [fieldName, field] of fields.entries()) {
      // Skip default fields if already added
      if (!hasCustomPK && (fieldName === 'id' || fieldName === 'slug' || fieldName === 'context')) {
        continue;
      }

      // Track timestamp fields
      if (fieldName === 'created_at' || fieldName === 'createdAt') {
        if (hasCreatedAt) continue;
        hasCreatedAt = true;
      }
      if (fieldName === 'updated_at' || fieldName === 'updatedAt') {
        if (hasUpdatedAt) continue;
        hasUpdatedAt = true;
      }

      const sqlType = (field.getSqlType?.() || 'TEXT') as SQLDataType;

      const columnDef: ColumnDefinition = {
        type: sqlType,
        notNull: field.options?.required || false,
        primaryKey: field.options?.primaryKey || false,
        unique: field.options?.unique || false,
        description: field.options?.description,
      };

      // Get default value
      if (field.options?.default !== undefined) {
        columnDef.defaultValue = field.options.default;
      } else if (!columnDef.notNull && columnDef.type === 'TEXT') {
        // Prevent DuckDB ANY type inference for nullable TEXT columns
        columnDef.notNull = true;
        columnDef.defaultValue = '';
      }

      // Handle foreign keys
      if (field.type === 'foreignKey') {
        // Type cast to access relationship-specific properties
        const relatedName = (field.options as any).related;
        const onDeleteAction = (field.options as any).onDelete;

        if (relatedName) {
          columnDef.foreignKey = {
            table: this.classNameToTableName(relatedName),
            column: 'id',
            onDelete: onDeleteAction || 'CASCADE',
            onUpdate: 'CASCADE',
          };
        }
      }

      columns[this.toSnakeCase(fieldName)] = columnDef;
    }

    // Ensure timestamp columns exist
    if (!hasCreatedAt) {
      columns.created_at = {
        type: 'DATETIME',
        notNull: false,
        description: 'Creation timestamp',
      };
    }
    if (!hasUpdatedAt) {
      columns.updated_at = {
        type: 'DATETIME',
        notNull: false,
        description: 'Last update timestamp',
      };
    }

    // Generate indexes
    const indexes: IndexDefinition[] = [];

    if (!hasCustomPK) {
      indexes.push({
        name: `${tableName}_id_idx`,
        columns: ['id'],
        description: 'Primary key index',
      });

      indexes.push({
        name: `${tableName}_slug_context_idx`,
        columns: ['slug', 'context'],
        unique: true,
        description: 'Unique index for slug and context',
      });
    } else {
      // Find custom PK column and create index
      for (const [colName, colDef] of Object.entries(columns)) {
        if (colDef.primaryKey) {
          indexes.push({
            name: `${tableName}_${colName}_idx`,
            columns: [colName],
            description: `Primary key index`,
          });
          break;
        }
      }
    }

    // Create indexes for foreign keys
    for (const [colName, colDef] of Object.entries(columns)) {
      if (colDef.foreignKey) {
        indexes.push({
          name: `idx_${tableName}_${colName}`,
          columns: [colName],
          description: `Foreign key index for ${colName}`,
        });
      }
    }

    return {
      tableName,
      columns,
      indexes,
      triggers: [],
      foreignKeys: this.extractForeignKeys(columns),
      dependencies: [],
      version: createHash('sha256').update(JSON.stringify(columns)).digest('hex').substring(0, 8),
      packageName: 'runtime',
      baseClass: 'SmrtObject',
    };
  }

  /**
   * Convert camelCase to snake_case
   */
  private toSnakeCase(str: string): string {
    return str
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '');
  }

  /**
   * Generate SQL CREATE TABLE statement from schema definition
   *
   * This is the single source of truth for SQL generation, consolidating
   * logic that was previously duplicated across multiple code paths.
   *
   * @param schema - Schema definition object
   * @returns SQL CREATE TABLE statement with indexes
   */
  generateSQL(schema: SchemaDefinition): string {
    const { tableName, columns } = schema;

    // Quote table name to handle SQL reserved keywords
    let sql = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n`;

    // Track which columns we've added
    const addedColumns: string[] = [];

    // Add all columns
    for (const [columnName, columnDef] of Object.entries(columns)) {
      const parts: string[] = [];

      // Column name and type
      parts.push(`  ${columnName} ${columnDef.type}`);

      // Primary key
      if (columnDef.primaryKey) {
        parts.push('PRIMARY KEY');
      }

      // Not null constraint
      if (columnDef.notNull) {
        parts.push('NOT NULL');
      }

      // Unique constraint
      if (columnDef.unique && !columnDef.primaryKey) {
        parts.push('UNIQUE');
      }

      // Default value with CAST for DuckDB compatibility
      if (columnDef.defaultValue !== undefined) {
        const defaultSQL = this.formatDefaultValue(
          columnDef.defaultValue,
          columnDef.type
        );
        parts.push(`DEFAULT ${defaultSQL}`);
      }

      sql += parts.join(' ') + ',\n';
      addedColumns.push(columnName);
    }

    // Remove trailing comma and close table
    sql = sql.slice(0, -2) + '\n);';

    // Add indexes
    for (const index of schema.indexes) {
      const indexType = index.unique ? 'UNIQUE INDEX' : 'INDEX';
      const columnList = index.columns.join(', ');
      sql += `\nCREATE ${indexType} IF NOT EXISTS ${index.name} ON ${tableName} (${columnList});`;
    }

    return sql;
  }

  /**
   * Format default value for SQL with proper CAST for DuckDB compatibility
   *
   * DuckDB requires explicit CAST for default values to prevent type inference issues.
   *
   * @param value - Default value
   * @param type - Column SQL type
   * @returns Formatted SQL default value expression
   */
  private formatDefaultValue(value: any, type: SQLDataType): string {
    // Handle SQL expressions (like datetime('now'))
    if (typeof value === 'string' && value.includes('(')) {
      return value;
    }

    // Handle different types
    if (type === 'TEXT') {
      const stringValue = String(value);
      return `CAST('${stringValue.replace(/'/g, "''")}' AS TEXT)`;
    }

    if (type === 'INTEGER' || type === 'REAL') {
      return `CAST(${value} AS ${type})`;
    }

    if (type === 'BOOLEAN') {
      return value ? 'TRUE' : 'FALSE';
    }

    if (type === 'DATETIME') {
      if (typeof value === 'string') {
        return `CAST('${value}' AS DATETIME)`;
      }
      return "datetime('now')";
    }

    // Fallback for other types
    return `'${String(value).replace(/'/g, "''")}'`;
  }
}
