/**
 * Schema generator for SMRT objects
 * Converts AST field definitions to database schema definitions
 */

import { createHash } from 'node:crypto';
import type {
  FieldDefinition,
  ManifestColumnDefinition,
  ManifestIndexDefinition,
  ManifestSchema,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { classnameToTablename } from '../utils/naming.js';
import { getDDLStrategy } from './ddl/index.js';
import type { DatabaseEngine } from './ddl/types.js';
import type {
  ColumnDefinition,
  ForeignKeyDefinition,
  IndexDefinition,
  SchemaDefinition,
  SQLDataType,
  TriggerDefinition,
} from './types.js';

type SchemaGeneratorConfig = {
  conflictColumns?: string[];
  idType?: 'uuid' | 'text';
  registry?: {
    getDescendants(baseClassName: string): string[];
    getAllFields(className: string): Promise<Map<string, any>>;
  };
};

export class SchemaGenerator {
  /**
   * Generate schema definition from SMRT object definition
   */
  generateSchema(objectDef: SmartObjectDefinition): SchemaDefinition {
    const tableName = this.getTableName(objectDef);
    const columns = this.generateColumns(
      objectDef.fields,
      objectDef.decoratorConfig,
    );
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
        return 'UUID'; // Foreign keys default to UUID, then same-package refs can be reconciled to target idType
      case 'crossPackageRef':
        return 'UUID'; // Cross-package refs are UUID ids with no DDL FK constraint
      default:
        return 'TEXT'; // Default fallback
    }
  }

  private getIdColumnType(config?: { idType?: 'uuid' | 'text' }): SQLDataType {
    return config?.idType === 'text' ? 'TEXT' : 'UUID';
  }

  /**
   * Generate column definitions
   */
  private generateColumns(
    fields: Record<string, FieldDefinition>,
    config?: { idType?: 'uuid' | 'text' },
  ): Record<string, ColumnDefinition> {
    const columns: Record<string, ColumnDefinition> = {};

    // Always include base SMRT fields
    columns.id = {
      type: this.getIdColumnType(config),
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
        type: fieldDef._meta?.sqlType || this.mapFieldTypeToSQL(fieldDef.type),
        // If _meta.nullable is true, the field can be null regardless of required
        // This handles field helpers like text({ required: true, nullable: true })
        notNull: fieldDef._meta?.nullable ? false : fieldDef.required || false,
        unique: fieldDef._meta?.unique || false,
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
    return classnameToTablename(className);
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
    fields: Map<string, any>,
    config?: SchemaGeneratorConfig,
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
        type: this.getIdColumnType(config),
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
    // Track regular (column-backed) fields that opted into a plain column index
    // via `indexed: true`. FK, unique, and meta fields each go through their
    // own dedicated index emission paths and are excluded from this set.
    const indexedColumns = new Set<string>();

    // Add fields from ObjectRegistry
    for (const [fieldName, field] of fields.entries()) {
      // Skip transient fields (non-persisted)
      if (field.transient || field._meta?.transient) {
        continue;
      }

      const isDefaultSmrtColumn =
        fieldName === 'id' || fieldName === 'slug' || fieldName === 'context';

      // Default SMRT columns are added above when we use the standard primary
      // key path. When a class declares a custom primary key, only explicitly
      // declared id/slug/context fields should survive this loop.
      if (
        isDefaultSmrtColumn &&
        (!hasCustomPK || field._meta?.__smrtSystemField === true)
      ) {
        continue;
      }

      // Track timestamp fields
      if (fieldName === 'created_at' || fieldName === 'createdAt') {
        if (hasCreatedAt) continue;
        hasCreatedAt = true;
        columns.created_at = {
          type: 'TIMESTAMP',
          notNull: true,
          defaultValue: 'current_timestamp',
          description: 'Creation timestamp',
        };
        continue;
      }
      if (fieldName === 'updated_at' || fieldName === 'updatedAt') {
        if (hasUpdatedAt) continue;
        hasUpdatedAt = true;
        columns.updated_at = {
          type: 'TIMESTAMP',
          notNull: true,
          defaultValue: 'current_timestamp',
          description: 'Last update timestamp',
        };
        continue;
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

      const sqlType =
        field._meta?.sqlType || this.mapFieldTypeToSQL(field.type);

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

      // Track opt-in column indexes for regular (non-FK, non-unique) fields.
      // FK columns already get auto-indexed below; unique columns produce
      // their own unique index; meta fields go through the jsonPath path.
      const isIndexed =
        field._meta?.indexed === true || (field as any).indexed === true;
      if (
        isIndexed &&
        !columnDef.foreignKey &&
        !columnDef.unique &&
        !columnDef.primaryKey
      ) {
        indexedColumns.add(this.toSnakeCase(fieldName));
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

      const conflictColumns = config?.conflictColumns || ['slug', 'context'];
      const conflictIndexName =
        conflictColumns.length > 2
          ? `${tableName}_${conflictColumns.slice(0, 2).join('_')}_idx`
          : `${tableName}_${conflictColumns.join('_')}_idx`;

      indexes.push({
        name: conflictIndexName,
        columns: conflictColumns,
        unique: true,
        description: `Unique conflict index for ${className}`,
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

    // Emit opt-in column indexes for regular fields tagged with `indexed: true`
    for (const colName of indexedColumns) {
      indexes.push({
        name: `${tableName}_${colName}_idx`,
        columns: [colName],
        description: `Index for ${colName}`,
      });
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
    config?: SchemaGeneratorConfig,
  ): Promise<SchemaDefinition> {
    const ObjectRegistry =
      config?.registry ?? (await import('../registry.js')).ObjectRegistry;
    const columns: Record<string, ColumnDefinition> = {};

    // Add default SMRT fields
    columns.id = {
      type: this.getIdColumnType(config),
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
    // Track meta fields opted into JSON-path indexing (deduped across STI subtypes)
    const indexedMetaFields = new Set<string>();
    // Track regular-field columns opted into plain column indexing
    const indexedStiColumns = new Set<string>();

    // Aggregate fields from base and all descendants
    for (const className of allClassNames) {
      const classFields = await ObjectRegistry.getAllFields(className);
      fkColumnsByClass.set(className, new Set());

      for (const [fieldName, field] of classFields.entries()) {
        // Skip transient fields
        if (field.transient || field._meta?.transient) {
          continue;
        }

        // Capture indexed meta fields before the skip-meta branch below
        if (
          field.type === 'meta' &&
          (field.indexed === true || field._meta?.indexed === true)
        ) {
          indexedMetaFields.add(fieldName);
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
          columns.created_at = {
            type: 'TIMESTAMP',
            notNull: true,
            defaultValue: 'current_timestamp',
            description: 'Creation timestamp',
          };
          continue;
        }
        if (fieldName === 'updated_at' || fieldName === 'updatedAt') {
          if (hasUpdatedAt) continue;
          hasUpdatedAt = true;
          columns.updated_at = {
            type: 'TIMESTAMP',
            notNull: true,
            defaultValue: 'current_timestamp',
            description: 'Last update timestamp',
          };
          continue;
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

        const sqlType =
          field._meta?.sqlType || this.mapFieldTypeToSQL(field.type);

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

        // Track opt-in column indexes for regular STI columns
        const isIndexed =
          field._meta?.indexed === true || (field as any).indexed === true;
        if (isIndexed && !columnDef.foreignKey) {
          indexedStiColumns.add(columnName);
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

    // Unique index for slug, context, and type (STI variation).
    // STI subclasses share a table, so the discriminator participates in
    // identity — two subtypes can share the same (slug, context). PostgreSQL
    // UPSERT requires the live schema to carry a matching unique index; the
    // migration differ repairs older deployments where this index was created
    // non-unique or never created at all (issue #1165).
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

    // JSON-path indexes for @meta({ indexed: true }) fields
    for (const fieldName of indexedMetaFields) {
      indexes.push({
        name: `${tableName}_meta_${this.toSnakeCase(fieldName)}_idx`,
        columns: [],
        jsonPath: { column: '_meta_data', path: fieldName },
        description: `JSON-path index for @meta({ indexed: true }) field ${fieldName}`,
      });
    }

    // Plain column indexes for regular STI columns opted in via `indexed: true`
    for (const colName of indexedStiColumns) {
      indexes.push({
        name: `${tableName}_${colName}_idx`,
        columns: [colName],
        description: `Index for ${colName}`,
      });
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
   * Generate STI schema from manifest data (build-time, no runtime registry)
   *
   * This method generates STI schema purely from manifest data, without depending
   * on ObjectRegistry. This enables pre-generating schemas at build time for
   * efficient external package consumption.
   *
   * @param baseClassName - Base class name for the STI hierarchy
   * @param tableName - Shared table name (from base class)
   * @param baseFields - Fields from the base class
   * @param manifest - Full manifest containing all objects
   * @returns ManifestSchema for storage in manifest.json
   */
  generateSTISchemaFromManifest(
    baseClassName: string,
    tableName: string,
    _baseFields: Record<string, FieldDefinition>,
    manifest: SmartObjectManifest,
    config?: SchemaGeneratorConfig,
  ): ManifestSchema {
    const columns: Record<string, ManifestColumnDefinition> = {};

    // Add default SMRT fields
    columns.id = {
      type: this.getIdColumnType(config),
      primaryKey: true,
      notNull: true,
    };

    columns.slug = {
      type: 'TEXT',
      notNull: true,
    };

    columns.context = {
      type: 'TEXT',
      notNull: true,
      default: '',
    };

    // Add STI discriminator column
    columns._meta_type = {
      type: 'TEXT',
      notNull: true,
    };

    // Add meta column for flexible storage
    columns._meta_data = {
      type: 'JSON',
      notNull: false,
    };

    // Timestamp fields
    columns.created_at = {
      type: 'TIMESTAMP',
      notNull: true,
      default: 'current_timestamp',
    };

    columns.updated_at = {
      type: 'TIMESTAMP',
      notNull: true,
      default: 'current_timestamp',
    };

    // Find all descendants in manifest
    const descendants = this.findDescendantsInManifest(baseClassName, manifest);
    const allClassNames = [baseClassName, ...descendants];

    // Track FK columns by class for partial indexes
    const fkColumnsByClass = new Map<string, Set<string>>();
    // Track meta fields opted into JSON-path indexing (deduped across STI subtypes)
    const indexedMetaFields = new Set<string>();
    // Track regular columns opted into plain column indexing
    const indexedStiColumns = new Set<string>();

    // Aggregate fields from base and all descendants
    for (const className of allClassNames) {
      const objDef = manifest.objects[className];
      if (!objDef) continue;

      fkColumnsByClass.set(className, new Set());

      for (const [fieldName, field] of Object.entries(objDef.fields)) {
        // Skip transient fields
        if (field.transient || field._meta?.transient) {
          continue;
        }

        // Capture indexed meta fields before the skip-meta branch below
        if (
          field.type === 'meta' &&
          ((field as any).indexed === true ||
            (field as any)._meta?.indexed === true)
        ) {
          indexedMetaFields.add(fieldName);
        }

        // Skip default fields already added
        if (
          fieldName === 'id' ||
          fieldName === 'slug' ||
          fieldName === 'context' ||
          fieldName === 'created_at' ||
          fieldName === 'createdAt' ||
          fieldName === 'updated_at' ||
          fieldName === 'updatedAt'
        ) {
          continue;
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

        const sqlType =
          field._meta?.sqlType || this.mapFieldTypeToSQL(field.type);

        const columnDef: ManifestColumnDefinition = {
          type: sqlType,
          // STI: All columns nullable (union of child fields)
          notNull: false,
        };

        // Get default value
        if (field.default !== undefined) {
          columnDef.default = field.default;
        }

        // Track FK columns for this class (for partial indexes)
        if (field.type === 'foreignKey') {
          fkColumnsByClass.get(className)?.add(columnName);
        }

        // Track opt-in column indexes for regular STI columns
        const isIndexed =
          (field as any).indexed === true ||
          (field as any)._meta?.indexed === true;
        if (isIndexed && field.type !== 'foreignKey') {
          indexedStiColumns.add(columnName);
        }

        columns[columnName] = columnDef;
      }
    }

    // Generate indexes
    const indexes: ManifestIndexDefinition[] = [];

    // Primary key index
    indexes.push({
      name: `${tableName}_id_idx`,
      columns: ['id'],
    });

    // Unique index for slug, context, and type (STI variation) — see
    // generateSTISchemaFromRegistry for the rationale.
    indexes.push({
      name: `${tableName}_slug_context_meta_type_idx`,
      columns: ['slug', 'context', '_meta_type'],
      unique: true,
    });

    // Index on type column (for polymorphic queries)
    indexes.push({
      name: `${tableName}_meta_type_idx`,
      columns: ['_meta_type'],
    });

    // JSON-path indexes for @meta({ indexed: true }) fields
    for (const fieldName of indexedMetaFields) {
      indexes.push({
        name: `${tableName}_meta_${this.toSnakeCase(fieldName)}_idx`,
        columns: [],
        jsonPath: { column: '_meta_data', path: fieldName },
      });
    }

    // Plain column indexes for regular STI columns opted in via `indexed: true`
    for (const colName of indexedStiColumns) {
      indexes.push({
        name: `${tableName}_${colName}_idx`,
        columns: [colName],
      });
    }

    // Generate DDL
    const schemaDefinition: SchemaDefinition = {
      tableName,
      columns: this.convertManifestColumnsToSchemaColumns(columns),
      indexes: indexes.map((idx) => ({
        name: idx.name,
        columns: idx.columns,
        unique: idx.unique,
        where: idx.where,
        jsonPath: idx.jsonPath,
      })),
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '',
      packageName: '',
    };

    const ddl = this.generateSQL(schemaDefinition, 'postgres');

    // Generate version hash
    const version = createHash('sha256')
      .update(JSON.stringify({ columns, baseClassName, descendants }))
      .digest('hex')
      .substring(0, 8);

    return {
      tableName,
      ddl,
      columns,
      indexes,
      version,
    };
  }

  /**
   * Generate CTI (Class Table Inheritance) schema from manifest data
   *
   * @param className - Class name
   * @param tableName - Table name
   * @param fields - Fields from the class
   * @returns ManifestSchema for storage in manifest.json
   */
  generateCTISchemaFromManifest(
    className: string,
    tableName: string,
    fields: Record<string, FieldDefinition>,
    config?: SchemaGeneratorConfig,
  ): ManifestSchema {
    const columns: Record<string, ManifestColumnDefinition> = {};

    // Add default SMRT fields
    columns.id = {
      type: this.getIdColumnType(config),
      primaryKey: true,
      notNull: true,
    };

    columns.slug = {
      type: 'TEXT',
      notNull: true,
    };

    columns.context = {
      type: 'TEXT',
      notNull: true,
      default: '',
    };

    // Timestamp fields
    columns.created_at = {
      type: 'TIMESTAMP',
      notNull: true,
      default: 'current_timestamp',
    };

    columns.updated_at = {
      type: 'TIMESTAMP',
      notNull: true,
      default: 'current_timestamp',
    };

    // Add class fields
    for (const [fieldName, field] of Object.entries(fields)) {
      // Skip transient fields
      if (field.transient || field._meta?.transient) {
        continue;
      }

      // Skip default fields already added
      if (
        fieldName === 'id' ||
        fieldName === 'slug' ||
        fieldName === 'context' ||
        fieldName === 'created_at' ||
        fieldName === 'createdAt' ||
        fieldName === 'updated_at' ||
        fieldName === 'updatedAt'
      ) {
        continue;
      }

      // Skip relationship fields that don't create columns
      if (field.type === 'oneToMany' || field.type === 'manyToMany') {
        continue;
      }

      // Skip meta fields
      if (field.type === 'meta') {
        continue;
      }

      const columnName = this.toSnakeCase(fieldName);
      const sqlType =
        field._meta?.sqlType || this.mapFieldTypeToSQL(field.type);

      const columnDef: ManifestColumnDefinition = {
        type: sqlType,
        notNull: field._meta?.nullable ? false : field.required || false,
        unique: field._meta?.unique || false,
      };

      if (field.default !== undefined) {
        columnDef.default = field.default;
      }

      columns[columnName] = columnDef;
    }

    // Generate indexes
    const indexes: ManifestIndexDefinition[] = [];

    indexes.push({
      name: `${tableName}_id_idx`,
      columns: ['id'],
    });

    // Use custom conflict columns if provided, otherwise default to slug+context
    const conflictColumns = config?.conflictColumns || ['slug', 'context'];
    const indexName =
      conflictColumns.length > 2
        ? `${tableName}_${conflictColumns.slice(0, 2).join('_')}_idx`
        : `${tableName}_${conflictColumns.join('_')}_idx`;

    indexes.push({
      name: indexName,
      columns: conflictColumns,
      unique: true,
    });

    // Generate DDL
    const schemaDefinition: SchemaDefinition = {
      tableName,
      columns: this.convertManifestColumnsToSchemaColumns(columns),
      indexes: indexes.map((idx) => ({
        name: idx.name,
        columns: idx.columns,
        unique: idx.unique,
        where: idx.where,
        jsonPath: idx.jsonPath,
      })),
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '',
      packageName: '',
    };

    const ddl = this.generateSQL(schemaDefinition, 'postgres');

    // Generate version hash
    const version = createHash('sha256')
      .update(JSON.stringify({ columns, className }))
      .digest('hex')
      .substring(0, 8);

    return {
      tableName,
      ddl,
      columns,
      indexes,
      version,
    };
  }

  /**
   * Find all descendants of a class in the manifest
   *
   * Note: Manifest keys are now qualified names (@pkg:ClassName) but `extends` field
   * stores simple PascalCase class names. We need to handle both qualified and simple
   * name lookups.
   *
   * Issue #713: Updated to handle qualified names in manifest keys
   */
  private findDescendantsInManifest(
    baseClassName: string,
    manifest: SmartObjectManifest,
    visited: Set<string> = new Set(),
  ): string[] {
    const descendants: string[] = [];

    // Prevent infinite recursion (e.g., class extends same-named class from another package)
    if (visited.has(baseClassName)) return descendants;
    visited.add(baseClassName);

    // Extract the simple class name from qualified name if needed
    // e.g., '@happyvertical/smrt-core:PolyEvent' -> 'PolyEvent'
    const simpleBaseClassName = baseClassName.includes(':')
      ? baseClassName.split(':').pop() || baseClassName
      : baseClassName;
    const baseClassLower = simpleBaseClassName.toLowerCase();

    for (const [name, obj] of Object.entries(manifest.objects)) {
      // Skip self-references (class extending same-named class from another package)
      if (
        obj.className.toLowerCase() === baseClassLower &&
        obj.extends?.toLowerCase() === baseClassLower
      ) {
        continue;
      }
      // obj.extends is a simple class name (e.g., 'PolyEvent')
      // Compare with the simple (non-qualified) version of the base class name
      if (obj.extends?.toLowerCase() === baseClassLower) {
        descendants.push(name);
        // Recursively find descendants of this class
        // Pass the qualified name (manifest key) for recursive lookup
        descendants.push(
          ...this.findDescendantsInManifest(name, manifest, visited),
        );
      }
    }

    return descendants;
  }

  /**
   * Convert ManifestColumnDefinition to ColumnDefinition
   */
  private convertManifestColumnsToSchemaColumns(
    manifestColumns: Record<string, ManifestColumnDefinition>,
  ): Record<string, ColumnDefinition> {
    const columns: Record<string, ColumnDefinition> = {};

    for (const [name, col] of Object.entries(manifestColumns)) {
      columns[name] = {
        type: col.type as SQLDataType,
        primaryKey: col.primaryKey,
        notNull: col.notNull,
        unique: col.unique,
        defaultValue: col.default,
      };
    }

    return columns;
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
  generateSQL(schema: SchemaDefinition, engine?: DatabaseEngine): string {
    // NOTE: We no longer append indexes to DDL string here.
    // The SDK expects ddl to contain ONLY the CREATE TABLE statement.
    // Indexes are stored separately in schema.indexes as SQL strings
    // and the SDK handles them via syncSchema() or dedicated index creation.
    if (engine) {
      return getDDLStrategy(engine).generateCreateTable(schema);
    }

    const { tableName, columns } = schema;
    let sql = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n`;

    for (const [columnName, columnDef] of Object.entries(columns)) {
      const parts = [`  "${columnName}" ${columnDef.type}`];

      if (columnDef.primaryKey) {
        parts.push('PRIMARY KEY');
      }

      if (columnDef.notNull) {
        parts.push('NOT NULL');
      }

      if (columnDef.unique && !columnDef.primaryKey) {
        parts.push('UNIQUE');
      }

      if (columnDef.defaultValue !== undefined) {
        parts.push(
          `DEFAULT ${this.formatDefaultValue(
            columnDef.defaultValue,
            columnDef.type,
          )}`,
        );
      }

      sql += `${parts.join(' ')},\n`;
    }

    return `${sql.slice(0, -2)}\n);`;
  }

  /**
   * Format default value for SQL
   *
   * SQLite doesn't support CAST expressions in DEFAULT values (only literal values are allowed).
   * This method generates DEFAULT values that work with both SQLite and DuckDB.
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

    // Handle different types - use plain literals (SQLite doesn't support CAST in DEFAULT)
    if (type === 'TEXT') {
      const stringValue = String(value);
      return `'${stringValue.replace(/'/g, "''")}'`;
    }

    if (type === 'INTEGER' || type === 'REAL') {
      // For null values, return NULL
      if (value === null || value === undefined) {
        return 'NULL';
      }
      return String(value);
    }

    if (type === 'BOOLEAN') {
      return value ? 'TRUE' : 'FALSE';
    }

    if (type === 'TIMESTAMP') {
      if (typeof value === 'string') {
        return `'${value}'`;
      }
      return 'current_timestamp';
    }

    if (type === 'JSON') {
      // Handle null/undefined
      if (value === null || value === undefined) {
        return "'null'";
      }

      // Handle string inputs - need to validate they're valid JSON
      if (typeof value === 'string') {
        // Empty string is not valid JSON
        if (value === '') {
          return "'null'";
        }
        // '[object Object]' is a common bug from accidental toString()
        if (value === '[object Object]') {
          return "'{}'";
        }
        // Try to parse as JSON to validate
        try {
          JSON.parse(value);
          // It's valid JSON, use it as-is (escaped for SQL)
          return `'${value.replace(/'/g, "''")}'`;
        } catch {
          // Not valid JSON - encode the string as a JSON string
          const json = JSON.stringify(value);
          return `'${json.replace(/'/g, "''")}'`;
        }
      }

      // Objects and arrays - stringify them
      const json = JSON.stringify(value);
      return `'${json.replace(/'/g, "''")}'`;
    }

    // Fallback for other types
    return `'${String(value).replace(/'/g, "''")}'`;
  }
}
