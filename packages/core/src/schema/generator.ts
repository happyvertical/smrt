/**
 * Schema generator for SMRT objects
 * Converts AST field definitions to database schema definitions
 */

import { createHash } from 'node:crypto';
import type { FieldDefinition, SmartObjectDefinition } from '../scanner/types';
import type {
  ColumnDefinition,
  ForeignKeyDefinition,
  IndexDefinition,
  SchemaDefinition,
  SQLDataType,
  TriggerDefinition,
} from './types';

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
        return 'TIMESTAMP';
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
      type: 'TIMESTAMP',
      notNull: true,
      defaultValue: 'current_timestamp',
      description: 'Creation timestamp',
    };

    columns.updated_at = {
      type: 'TIMESTAMP',
      notNull: true,
      defaultValue: 'current_timestamp',
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

      // Skip transient fields (non-persisted)
      // NOTE: This filtering logic must match SmrtObject.toJSON()
      // Changes to field filtering should be applied in BOTH places
      if (fieldDef.transient || fieldDef._meta?.transient) {
        continue;
      }

      // Skip relationship fields that don't create columns
      // oneToMany and manyToMany are relationship metadata, not actual database columns
      // foreignKey DOES create a column (it stores the foreign key ID)
      // NOTE: This must match the filtering in SmrtObject.toJSON()
      if (fieldDef.type === 'oneToMany' || fieldDef.type === 'manyToMany') {
        continue;
      }

      // Skip meta fields - they're stored in _meta_data JSONB column (STI only)
      // In CTI mode, meta fields shouldn't be used, but skip them anyway for safety
      if (fieldDef.type === 'meta') {
        continue;
      }

      const column: ColumnDefinition = {
        type: this.mapFieldTypeToSQL(fieldDef.type),
        // If _meta.nullable is true, the field can be null regardless of required
        // This handles field helpers like text({ required: true, nullable: true })
        notNull: fieldDef._meta?.nullable ? false : fieldDef.required || false,
        description: fieldDef.description,
      };

      // Handle default values
      if (fieldDef.default !== undefined) {
        column.defaultValue = fieldDef.default;
      }
      // Note: Removed automatic NOT NULL DEFAULT '' for TEXT columns
      // This was forcing all TEXT fields to be NOT NULL regardless of required option
      // If DuckDB ANY type inference is an issue, it should be handled at the adapter level
      // or with an explicit field option, not by silently changing schema semantics

      // Handle foreign keys
      if (fieldDef.type === 'foreignKey' && fieldDef.related) {
        const [table, columnName = 'id'] = fieldDef.related.split('.');
        column.foreignKey = {
          table,
          column: columnName,
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
    _objectDef: SmartObjectDefinition,
    tableName: string,
  ): TriggerDefinition[] {
    return [
      {
        name: `trg_${tableName}_updated_at`,
        when: 'BEFORE',
        event: 'UPDATE',
        body: `UPDATE "${tableName}" SET "updated_at" = current_timestamp WHERE "id" = NEW."id";`,
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
    return `${className
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '')
      .replace(/s$/, '')}s`; // Simple pluralization
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
    _className: string,
    tableName: string,
    fields: Map<string, any>,
  ): SchemaDefinition {
    const columns: Record<string, ColumnDefinition> = {};

    // Check for custom primary key
    let hasCustomPK = false;
    for (const [_fieldName, field] of fields.entries()) {
      if (field._meta?.primaryKey) {
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
      // Skip transient fields (non-persisted)
      if (field.transient || field._meta?.transient) {
        continue;
      }

      // Skip default fields if already added
      if (
        !hasCustomPK &&
        (fieldName === 'id' || fieldName === 'slug' || fieldName === 'context')
      ) {
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

      // Skip relationship fields that don't create columns
      // oneToMany and manyToMany are relationship metadata, not actual database columns
      // foreignKey DOES create a column (it stores the foreign key ID)
      if (field.type === 'oneToMany' || field.type === 'manyToMany') {
        continue;
      }

      // Skip meta fields - they're stored in _meta_data JSONB column (STI only)
      // In CTI mode, meta fields shouldn't be used, but skip them anyway for safety
      if (field.type === 'meta') {
        continue;
      }

      const sqlType = this.mapFieldTypeToSQL(field.type);

      const columnDef: ColumnDefinition = {
        type: sqlType,
        // If _meta.nullable is true, the field can be null regardless of required
        notNull: field._meta?.nullable ? false : field._meta?.required || false,
        primaryKey: field._meta?.primaryKey || false,
        unique: field._meta?.unique || false,
        description: field._meta?.description,
      };

      // Get default value
      if (field._meta?.default !== undefined) {
        columnDef.defaultValue = field._meta.default;
      }
      // Note: Removed automatic NOT NULL DEFAULT '' for TEXT columns
      // This was forcing all TEXT fields to be NOT NULL regardless of required option
      // If DuckDB ANY type inference is an issue, it should be handled at the adapter level
      // or with an explicit field option, not by silently changing schema semantics

      // Handle foreign keys
      if (field.type === 'foreignKey') {
        // Type cast to access relationship-specific properties
        const relatedName = field.related; // Top-level property
        const onDeleteAction = (field._meta as any)?.onDelete;

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
        type: 'TIMESTAMP',
        notNull: true,
        defaultValue: 'current_timestamp',
        description: 'Creation timestamp',
      };
    }
    if (!hasUpdatedAt) {
      columns.updated_at = {
        type: 'TIMESTAMP',
        notNull: true,
        defaultValue: 'current_timestamp',
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
      version: createHash('sha256')
        .update(JSON.stringify(columns))
        .digest('hex')
        .substring(0, 8),
      packageName: 'runtime',
      baseClass: 'SmrtObject',
    };
  }

  /**
   * Generate STI (Single Table Inheritance) schema from ObjectRegistry fields
   *
   * Creates a shared table for an inheritance hierarchy with:
   * - _meta_type: Discriminator column to identify class type
   * - _meta_data: JSON column for flexible field storage
   * - Union of all FK columns from descendants (all nullable)
   * - Partial indexes for FK columns (filtered by _meta_type)
   *
   * @param baseClassName - Base class name for the STI hierarchy
   * @param tableName - Shared table name (from base class)
   * @param fields - Map of Field definitions from base class
   * @returns Schema definition object for STI table
   * @example
   * ```typescript
   * @smrt({ tableStrategy: 'sti' })
   * class Event extends SmrtObject {
   *   title: string = '';
   * }
   *
   * @smrt()
   * class Meeting extends Event {
   *   roomId = foreignKey(Room);
   * }
   *
   * // Generates single table 'events' with:
   * // - title (from Event)
   * // - room_id (from Meeting, nullable)
   * // - _meta_type TEXT NOT NULL (discriminator)
   * // - _meta_data JSON (flexible storage)
   * ```
   */
  async generateSTISchemaFromRegistry(
    baseClassName: string,
    tableName: string,
    _fields: Map<string, any>,
  ): Promise<SchemaDefinition> {
    const { ObjectRegistry } = await import('../registry');
    const columns: Record<string, ColumnDefinition> = {};

    // Add default SMRT fields
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

    // Add STI discriminator column
    columns._meta_type = {
      type: 'TEXT',
      notNull: true,
      description: 'Class type discriminator for STI',
    };

    // Add meta column for flexible storage
    columns._meta_data = {
      type: 'JSON',
      notNull: false,
      description: 'Flexible JSON storage for meta() fields',
    };

    // Track timestamp fields to avoid duplicates
    let hasCreatedAt = false;
    let hasUpdatedAt = false;

    // Get all descendants to aggregate fields
    const descendants = ObjectRegistry.getDescendants(baseClassName);
    const allClassNames = [baseClassName, ...descendants];

    // Track FK columns by class for partial indexes
    const fkColumnsByClass = new Map<string, Set<string>>();

    // Aggregate fields from base and all descendants
    for (const className of allClassNames) {
      const classFields = await ObjectRegistry.getAllFields(className);
      fkColumnsByClass.set(className, new Set());

      for (const [fieldName, field] of classFields.entries()) {
        // Skip transient fields
        if (field.transient || field._meta?.transient) {
          continue;
        }

        // Skip default fields already added
        if (
          fieldName === 'id' ||
          fieldName === 'slug' ||
          fieldName === 'context'
        ) {
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

        // Skip relationship fields that don't create columns
        if (field.type === 'oneToMany' || field.type === 'manyToMany') {
          continue;
        }

        // Skip meta fields - they're stored in _meta_data JSONB column
        if (field.type === 'meta') {
          continue;
        }

        const columnName = this.toSnakeCase(fieldName);

        // Check if column already exists (inherited from parent)
        if (columns[columnName]) {
          continue;
        }

        const sqlType = this.mapFieldTypeToSQL(field.type);

        const columnDef: ColumnDefinition = {
          type: sqlType,
          // STI: All columns nullable (union of child fields)
          notNull: false,
          primaryKey: false,
          unique: false,
          description: field._meta?.description,
        };

        // Get default value (but not applied in STI - defaults handled by application)
        if (field._meta?.default !== undefined) {
          columnDef.defaultValue = field._meta.default;
        }

        // Handle foreign keys
        if (field.type === 'foreignKey') {
          const relatedName = field.related; // Top-level property
          const onDeleteAction = (field._meta as any)?.onDelete;

          if (relatedName) {
            columnDef.foreignKey = {
              table: this.classNameToTableName(relatedName),
              column: 'id',
              onDelete: onDeleteAction || 'CASCADE',
              onUpdate: 'CASCADE',
            };

            // Track FK column for this class (for partial indexes)
            fkColumnsByClass.get(className)?.add(columnName);
          }
        }

        columns[columnName] = columnDef;
      }
    }

    // Ensure timestamp columns exist
    if (!hasCreatedAt) {
      columns.created_at = {
        type: 'TIMESTAMP',
        notNull: true,
        defaultValue: 'current_timestamp',
        description: 'Creation timestamp',
      };
    }
    if (!hasUpdatedAt) {
      columns.updated_at = {
        type: 'TIMESTAMP',
        notNull: true,
        defaultValue: 'current_timestamp',
        description: 'Last update timestamp',
      };
    }

    // Generate indexes
    const indexes: IndexDefinition[] = [];

    // Primary key index
    indexes.push({
      name: `${tableName}_id_idx`,
      columns: ['id'],
      description: 'Primary key index',
    });

    // Unique index for slug, context, and type (STI variation)
    indexes.push({
      name: `${tableName}_slug_context_meta_type_idx`,
      columns: ['slug', 'context', '_meta_type'],
      unique: true,
      description: 'Unique index for slug, context, and type',
    });

    // Index on type column (for polymorphic queries)
    indexes.push({
      name: `${tableName}_meta_type_idx`,
      columns: ['_meta_type'],
      description: 'Index for type discriminator queries',
    });

    // Partial indexes for FK columns (filtered by type)
    for (const [className, fkColumns] of fkColumnsByClass.entries()) {
      for (const fkColumn of fkColumns) {
        indexes.push({
          name: `idx_${tableName}_${fkColumn}_${className.toLowerCase()}`,
          columns: [fkColumn],
          where: `_meta_type = '${className}'`,
          description: `Partial index for ${fkColumn} in ${className} rows`,
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
      version: createHash('sha256')
        .update(JSON.stringify({ columns, baseClassName, descendants }))
        .digest('hex')
        .substring(0, 8),
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

      // Column name and type - quote column name to handle SQL reserved keywords
      parts.push(`  "${columnName}" ${columnDef.type}`);

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
          columnDef.type,
        );
        parts.push(`DEFAULT ${defaultSQL}`);
      }

      sql += `${parts.join(' ')},\n`;
      addedColumns.push(columnName);
    }

    // Remove trailing comma and close table
    sql = `${sql.slice(0, -2)}\n);`;

    // Add indexes
    for (const index of schema.indexes) {
      const indexType = index.unique ? 'UNIQUE INDEX' : 'INDEX';
      // Quote column names in index to handle SQL reserved keywords
      const columnList = index.columns.map((col) => `"${col}"`).join(', ');
      const whereClause = index.where ? ` WHERE ${index.where}` : '';
      sql += `\nCREATE ${indexType} IF NOT EXISTS ${index.name} ON "${tableName}" (${columnList})${whereClause};`;
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
    // Handle SQL functions and keywords (like current_timestamp, datetime('now'), CURRENT_DATE, etc.)
    if (typeof value === 'string') {
      // SQL function with parentheses (e.g., datetime('now'))
      if (value.includes('(')) {
        return value;
      }
      // SQL standard keywords (e.g., current_timestamp, CURRENT_DATE, CURRENT_TIME)
      const sqlKeywords = [
        'current_timestamp',
        'current_date',
        'current_time',
        'now()',
        'uuid_generate_v4()',
      ];
      if (sqlKeywords.some((keyword) => value.toLowerCase() === keyword)) {
        return value;
      }
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

    if (type === 'TIMESTAMP') {
      if (typeof value === 'string') {
        return `CAST('${value}' AS TIMESTAMP)`;
      }
      return 'current_timestamp';
    }

    // Fallback for other types
    return `'${String(value).replace(/'/g, "''")}'`;
  }
}
