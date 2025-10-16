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
}
