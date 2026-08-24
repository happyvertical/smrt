/**
 * Schema building logic for the SMRT ObjectRegistry.
 *
 * Extracted from registry.ts as part of issue #1006.
 */

import { ObjectRegistry } from '../registry';
import type { FieldDefinition } from '../scanner/types.js';
import { conflictIndexName } from '../schema/conflict-target.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import {
  renderForeignKeyConstraint,
  schemaForeignKeys,
} from '../schema/foreign-key-ddl.js';
import {
  requireForeignKeyAction,
  resolveForeignKeyDeleteAction,
} from '../schema/foreign-key-policy.js';
import { shortenIdentifier } from '../schema/index-utils.js';
import {
  formatDefaultValue as formatDefaultValueShared,
  quoteIdentifier,
} from '../schema/sql-identifiers.js';
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
import { readFieldAttribute } from './manifest-field-merge';
import { findClass } from './name-resolver';
import { getClasses, getCollectionTableNames } from './shared-state';
import type { RegisteredClass } from './types';

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
  options?: FieldsToColumnsOptions,
): Record<string, ColumnDefinition> {
  const columnsToUse = { ...(schemaColumns || {}) };

  if (fields.size > 0) {
    const fieldColumns = fieldsToColumns(fields, options);
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

      const sqlType =
        fieldDef._meta?.sqlType ||
        (fieldDef as unknown as { sqlType?: string }).sqlType;
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
    (
      fieldDef as unknown as {
        __tenancy?: { isTenantIdField?: boolean };
      }
    ).__tenancy?.isTenantIdField ||
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

function shouldEmitDefault(
  fieldDef: FieldDefinition,
  sqlType: SQLDataType,
  defaultValue: unknown,
) {
  return !(
    getReferenceKind(fieldDef) === 'tenantId' &&
    sqlType === 'UUID' &&
    defaultValue === ''
  );
}

/**
 * Fallback base columns for a table whose contributing class carries no
 * manifest columns.
 *
 * These mirror what the manifest schema generators emit for the same table
 * (`generateSchemaFromManifest` / `generateSTISchemaFromManifest`), so a table
 * assembled from runtime field metadata alone has the same NOT NULL and
 * DEFAULT shape as one assembled from a manifest. Divergence here is what made
 * the merged table shape depend on which class registered first (#2372).
 */
function createBaseColumns(
  registered: {
    config?: { idType?: 'uuid' | 'text' };
  },
  isSTI: boolean,
): Record<string, ColumnDefinition> {
  const baseColumns: Record<string, ColumnDefinition> = {
    id: {
      type: registered.config?.idType === 'text' ? 'TEXT' : 'UUID',
      primaryKey: true,
      notNull: true,
      referenceKind: 'id',
    },
    slug: { type: 'TEXT', notNull: true },
    context: { type: 'TEXT', notNull: true, defaultValue: '' },
    created_at: {
      type: 'TIMESTAMP',
      notNull: true,
      defaultValue: 'current_timestamp',
    },
    updated_at: {
      type: 'TIMESTAMP',
      notNull: true,
      defaultValue: 'current_timestamp',
    },
  };

  // STI tables also carry the discriminator and the meta payload column
  // (issue #690: db:diff needs them to detect schema changes).
  if (isSTI) {
    baseColumns._meta_type = { type: 'TEXT', notNull: true };
    baseColumns._meta_data = { type: 'JSON', notNull: false };
  }

  return baseColumns;
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
 * Cached manifest DDL contains abstract types and is not safe to execute on
 * PostgreSQL. New executable paths must pass a target engine. Omitting it is
 * retained for backward compatibility with consumers that only inspect the
 * legacy engine-neutral manifest string.
 *
 * @param engine - Database engine that will execute the DDL
 * @returns Engine-specific SQL DDL, or the legacy cached DDL when omitted
 * @example
 * ```typescript
 * const ddl = ObjectRegistry.getSchemaDDL('Product', 'postgres');
 * await db.query(ddl);
 * ```
 */
export function getSchemaDDL(
  name: string,
  engine?: DatabaseEngine,
): string | undefined {
  const schema = getSchema(name);
  if (!schema) return undefined;
  if (engine && Object.keys(schema.columns).length === 0) {
    throw new Error(
      `Cannot materialize schema '${name}' for ${engine}: the manifest has no structured columns`,
    );
  }
  return engine
    ? getDDLStrategy(engine).generateCreateTable(schema)
    : schema.ddl;
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

function withConflictIndex(
  tableName: string,
  columns: Record<string, ColumnDefinition>,
  indexes: IndexDefinition[],
  conflictColumns: string[],
): IndexDefinition[] {
  if (
    conflictColumns.length === 0 ||
    !conflictColumns.every((column) => columns[column])
  ) {
    return indexes;
  }

  // `ON CONFLICT (id)` binds to the primary-key constraint itself; a second
  // unique index over the primary key column set adds nothing (#2359, A5).
  // Kept in step with SchemaGenerator.conflictColumnsArePrimaryKey().
  const primaryKeyColumns = Object.entries(columns)
    .filter(([, column]) => column.primaryKey === true)
    .map(([name]) => name);
  if (
    primaryKeyColumns.length > 0 &&
    primaryKeyColumns.length === conflictColumns.length &&
    primaryKeyColumns.every((column) => conflictColumns.includes(column))
  ) {
    return indexes;
  }

  const hasConflictIndex = indexes.some(
    (index) =>
      index.unique === true &&
      !index.where &&
      !index.jsonPath &&
      index.columns.length === conflictColumns.length &&
      index.columns.every((column) => conflictColumns.includes(column)),
  );
  if (hasConflictIndex) return indexes;

  // Same stable naming as SchemaGenerator (`schema/conflict-target.ts`), so
  // a manifest built before the runtime learned the tenant-aware default
  // (#2360) has its stale `<table>_slug_context_idx` REPLACED in place here
  // — the differ then swaps the live index by name — instead of a second,
  // suffixed unique index being appended beside the old global one.
  const tenantColumn = Object.entries(columns).find(
    ([, column]) => column.referenceKind === 'tenantId',
  )?.[0];
  // The composed name can exceed PostgreSQL's 63-byte limit on a long table.
  // Shortening here (rather than inside conflictIndexName) keeps the generator
  // paths, which run enforceIdentifierLimits() over their whole index list,
  // and this migrate leg agreeing on the final name (#2374).
  const name = shortenIdentifier(
    conflictIndexName(tableName, conflictColumns, tenantColumn),
  );
  const conflictIndex: IndexDefinition = {
    name,
    columns: conflictColumns,
    unique: true,
  };
  if (indexes.some((index) => index.name === name)) {
    return indexes.map((index) =>
      index.name === name ? conflictIndex : index,
    );
  }
  return [...indexes, conflictIndex];
}

/**
 * A registered class that contributes columns to one physical table.
 *
 * For a single-table-inheritance hierarchy every class in the hierarchy is a
 * contributor to the same table.
 */
interface TableContributor {
  registered: RegisteredClass;
  simpleName: string;
  qualifiedName: string;
  isSTI: boolean;
  /** True when this class is the STI base that owns the table. */
  isSTIBase: boolean;
  /** Inheritance depth; ancestors sort before descendants. */
  depth: number;
  /** Conflict-column lookup key (the STI base for STI members). */
  conflictKey: string;
}

/**
 * A merged physical table assembled from every class that contributes to it.
 */
interface MergedTableSchema {
  tableName: string;
  columns: Record<string, ColumnDefinition>;
  indexes: IndexDefinition[];
  ddl: string;
  isSTI: boolean;
  conflictColumns: string[];
}

function applyContributorForeignKeys(
  tableSchema: MergedTableSchema,
  contributor: TableContributor,
): void {
  const conflictColumns = new Set(tableSchema.conflictColumns);
  for (const [fieldName, field] of contributor.registered.fields) {
    if (field.type !== 'foreignKey' || !field.related) continue;
    const columnName = toSnakeCase(fieldName);
    const column = tableSchema.columns[columnName];
    if (!column) continue;
    if (
      field._meta?.__tenancy?.isTenantIdField === true ||
      (
        field as FieldDefinition & {
          __tenancy?: { isTenantIdField?: boolean };
        }
      ).__tenancy?.isTenantIdField === true
    ) {
      column.foreignKey = undefined;
      continue;
    }
    const [targetName, declaredTargetColumn] = field.related.split('.');
    const targetBase = ObjectRegistry.getSTIBase(targetName) || targetName;
    const registeredTarget = ObjectRegistry.getClass(targetBase);
    const targetColumn =
      declaredTargetColumn ||
      Array.from(ObjectRegistry.getFields(targetBase).entries()).find(
        ([, targetField]) => targetField._meta?.primaryKey === true,
      )?.[0] ||
      'id';
    if (registeredTarget && !field._meta?.sqlType) {
      const targetColumnName = toSnakeCase(targetColumn);
      const targetColumnType =
        registeredTarget.schema?.columns?.[targetColumnName]?.type ||
        (targetColumnName === 'id'
          ? registeredTarget.config.idType === 'text'
            ? 'TEXT'
            : 'UUID'
          : undefined);
      if (targetColumnType) {
        column.type = targetColumnType;
      }
    }
    if (field._meta?.constraint === false) {
      column.foreignKey = undefined;
      continue;
    }
    // A manifest may carry explicit actions that predate or differ from the
    // runtime decorator defaults. Merging runtime fields must not erase them.
    // The fallback produced from runtime fields, however, must be replaced so
    // conflict columns receive the same default CASCADE as app-side cleanup.
    const manifestForeignKey =
      contributor.registered.schema?.columns?.[columnName]?.foreignKey;
    if (manifestForeignKey) {
      column.foreignKey = manifestForeignKey;
      continue;
    }
    // A decorator-only runtime field has no authoritative physical target
    // until that target is registered. Scanner-produced manifests clear this
    // shape too; only an explicit manifest FK above may survive unloaded
    // runtime classes (the manifest-authority contract from #1120).
    if (!registeredTarget) {
      column.foreignKey = undefined;
      continue;
    }
    const targetTable =
      ObjectRegistry.getTableName(targetBase) ||
      classnameToTablename(targetBase);
    const { action } = resolveForeignKeyDeleteAction({
      declared: field._meta?.onDelete,
      isConflictColumn: conflictColumns.has(columnName),
      isTenantIdField: false,
    });
    column.foreignKey = {
      table: targetTable,
      column: toSnakeCase(targetColumn),
      onDelete: action,
      onUpdate: 'CASCADE',
    };
  }
}

/**
 * Resolve the physical table a registered class writes to.
 *
 * STI subclasses are folded onto their base's table. Returns `undefined` when
 * the class has no table (for example an unresolvable manifest stub).
 *
 * R5-canon: STI lookups use the qualified key so a colliding simple name in
 * another package cannot yield the wrong table strategy or STI base and move
 * this class's columns under that other package's table.
 */
function resolveContributorTable(
  registered: RegisteredClass,
  fallbackName: string,
): { tableName: string; contributor: TableContributor } | undefined {
  const simpleName = registered.name || fallbackName;
  const qualifiedName = registered.qualifiedName ?? simpleName;

  // STI subclasses loaded from external manifests can arrive with a null
  // tableName; registerFromManifest() then derives one from the class name.
  // Adopt the STI base's tableName instead so the subclass lands on the
  // shared table (issue #703).
  if (!registered.schema?.tableName && registered.extends) {
    if (ObjectRegistry.getTableStrategy(qualifiedName) === 'sti') {
      const stiBaseName = ObjectRegistry.getSTIBase(qualifiedName);
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

  if (!registered.schema?.tableName) {
    return undefined;
  }

  let tableName = registered.schema.tableName;
  const tableStrategy = ObjectRegistry.getTableStrategy(qualifiedName);
  const isSTI = tableStrategy === 'sti';
  let isSTIBase = isSTI;
  let conflictKey = qualifiedName;

  if (isSTI) {
    const stiBaseName = ObjectRegistry.getSTIBase(qualifiedName);
    if (stiBaseName) {
      conflictKey = stiBaseName;
      if (stiBaseName !== qualifiedName) {
        isSTIBase = false;
        // STI subclasses serialize to the base class's table even when they
        // carry a tableName of their own (issue #693).
        const stiBaseClass = findClass(stiBaseName);
        if (stiBaseClass?.schema?.tableName) {
          tableName = stiBaseClass.schema.tableName;
        }
      }
    }
  }

  return {
    tableName,
    contributor: {
      registered,
      simpleName,
      qualifiedName,
      isSTI,
      isSTIBase,
      depth: ObjectRegistry.getInheritanceChain(qualifiedName).length,
      conflictKey,
    },
  };
}

/**
 * Order the classes that share one table deterministically.
 *
 * The first contributor seeds the table: it supplies the base columns, the
 * `idType`, the conflict columns and the cached DDL, and its columns win every
 * merge conflict. Registration order must not decide that, or the same
 * hierarchy yields a different table shape depending on which class a manifest
 * happens to list first — child-first dropped NOT NULL and DEFAULT from the
 * base columns (#2372).
 *
 * Order: the STI base first, then ancestors before descendants, then by
 * qualified name so the result is a total order.
 */
function sortTableContributors(contributors: TableContributor[]) {
  return [...contributors].sort((a, b) => {
    if (a.isSTIBase !== b.isSTIBase) {
      return a.isSTIBase ? -1 : 1;
    }
    if (a.depth !== b.depth) {
      return a.depth - b.depth;
    }
    return a.qualifiedName.localeCompare(b.qualifiedName);
  });
}

/**
 * Assemble every physical table from the classes that contribute to it.
 *
 * Shared by {@link getAllSchemas} and {@link getAllSchemasAsDefinitions} so
 * both produce the same merged shape. The result depends only on what is
 * registered, never on the order it was registered in.
 */
function buildMergedTableSchemas(): Record<string, MergedTableSchema> {
  // Pass 1: group contributing classes by physical table.
  const contributorsByTable = new Map<string, TableContributor[]>();

  for (const [className, registered] of getClasses()) {
    // Collection classes have no table of their own; their schemas carry
    // collection properties (loaded, options, ...) rather than columns.
    if (
      isCollectionRegistration(
        className,
        registered,
        collectionRegistrationLookup,
      )
    ) {
      continue;
    }

    const resolved = resolveContributorTable(registered, className);
    if (!resolved) {
      continue;
    }

    const existing = contributorsByTable.get(resolved.tableName);
    if (existing) {
      existing.push(resolved.contributor);
    } else {
      contributorsByTable.set(resolved.tableName, [resolved.contributor]);
    }
  }

  // Pass 2: merge each table's contributors in deterministic order.
  const tableSchemas: Record<string, MergedTableSchema> = {};

  for (const [tableName, contributors] of contributorsByTable) {
    for (const contributor of sortTableContributors(contributors)) {
      const { registered, simpleName, isSTI } = contributor;
      const conflictColumns = ObjectRegistry.getConflictColumns(
        contributor.conflictKey,
      );

      // The manifest schema stays authoritative for the columns it defines.
      // Runtime field metadata backfills columns the manifest never had (for
      // example tenantScoped injections) and applies explicit sqlType
      // overrides, without erasing richer manifest metadata.
      const columnsToUse = mergeRuntimeFieldColumns(
        simpleName,
        registered.schema?.columns,
        registered.fields,
        { stiUnionColumns: isSTI, conflictColumns },
      );

      let tableSchema = tableSchemas[tableName];
      if (!tableSchema) {
        tableSchema = {
          tableName,
          columns: {
            ...createBaseColumns(registered, isSTI),
            ...columnsToUse,
          },
          indexes: [],
          ddl: registered.schema?.ddl || '',
          isSTI,
          conflictColumns,
        };
        tableSchemas[tableName] = tableSchema;
      } else {
        // Another class sharing this table (STI): add only columns the
        // seeding contributor did not already define.
        for (const [colName, colDef] of Object.entries(columnsToUse)) {
          if (!tableSchema.columns[colName]) {
            tableSchema.columns[colName] = colDef;
          }
        }
      }

      applyContributorForeignKeys(tableSchema, contributor);

      // Merge indexes, keeping the first definition of each name.
      const schemaIndexes = registered.schema?.indexes;
      if (schemaIndexes && schemaIndexes.length > 0) {
        const existingNames = new Set(
          tableSchema.indexes.map((index) => index.name),
        );
        for (const index of schemaIndexes) {
          // Legacy string-format indexes carry no columns and cannot be merged.
          if (typeof index === 'string') {
            continue;
          }
          if (!existingNames.has(index.name)) {
            tableSchema.indexes.push(index);
            existingNames.add(index.name);
          }
        }
      }
    }
  }

  return tableSchemas;
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
 * const schemas = ObjectRegistry.getAllSchemas('json');
 * const db = await getDatabase({ type: 'json', url: './data', schemas });
 * ```
 */
export function getAllSchemas(
  engine?: DatabaseEngine,
): Record<string, { tableName: string; ddl: string; indexes?: string[] }> {
  // Step 1: Assemble every table from its contributing classes. The merge is
  // deterministic, so the shape does not depend on registration order (#2372).
  const tableSchemas = buildMergedTableSchemas();

  // Step 2: Convert to output format, regenerating DDL for merged schemas
  const schemas: Record<
    string,
    { tableName: string; ddl: string; indexes?: string[] }
  > = {};

  for (const [tableName, tableSchema] of Object.entries(tableSchemas)) {
    const engineIndexes = engine
      ? withConflictIndex(
          tableName,
          tableSchema.columns,
          tableSchema.indexes,
          tableSchema.conflictColumns,
        )
      : tableSchema.indexes;
    const mergedSchema: SchemaDefinition = {
      tableName,
      ddl: tableSchema.ddl,
      columns: tableSchema.columns,
      indexes: engineIndexes,
      triggers: [],
      foreignKeys: [],
      version: '',
      dependencies: [],
    };
    mergedSchema.foreignKeys = schemaForeignKeys(mergedSchema);
    mergedSchema.dependencies = mergedSchema.foreignKeys
      .map((foreignKey) => foreignKey.referencesTable)
      .filter((dependency) => dependency !== tableName);

    // Generate DDL from merged columns (or use original DDL if columns are empty)
    let ddl: string;
    if (Object.keys(tableSchema.columns).length === 0 && tableSchema.ddl) {
      if (engine) {
        throw new Error(
          `Cannot materialize schema '${tableName}' for ${engine}: the manifest has no structured columns`,
        );
      }
      // Preserve legacy inspection of cached engine-neutral DDL. Executable
      // target-engine paths fail above rather than returning unsafe SQL.
      ddl = tableSchema.ddl;
    } else if (Object.keys(tableSchema.columns).length === 0) {
      // Skip schemas with no columns and no original DDL
      continue;
    } else if (engine) {
      // Target-engine materialization must route the complete structured
      // schema through its strategy. In particular, DuckDB/JSON require
      // UNIQUE constraints inline for ON CONFLICT, and every strategy owns
      // CHECK/default/index-expression rendering.
      ddl = getDDLStrategy(engine).generateCreateTable(mergedSchema);
    } else {
      ddl = generateDDLFromColumns(
        tableName,
        tableSchema.columns,
        tableSchema.isSTI,
      );
    }

    // Convert index definitions to SQL strings for SDK compatibility
    let indexSQL: string[] | undefined;
    if (engineIndexes.length > 0) {
      indexSQL = engine
        ? getDDLStrategy(engine).generateIndexes(mergedSchema)
        : engineIndexes.map((idx) => {
            const indexType = idx.unique ? 'UNIQUE INDEX' : 'INDEX';
            const columnList = idx.columns
              .map((col) => quoteIdentifier(col))
              .join(', ');
            return `CREATE ${indexType} IF NOT EXISTS ${quoteIdentifier(
              idx.name,
            )} ON ${quoteIdentifier(tableName)} (${columnList});`;
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
  // Step 1: Assemble every table from its contributing classes. The merge is
  // deterministic, so the shape does not depend on registration order (#2372).
  const tableSchemas = buildMergedTableSchemas();

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
    const foreignKeys = schemaForeignKeys({
      columns: tableSchema.columns,
      foreignKeys: [],
    });

    schemas[tableName] = {
      tableName,
      ddl,
      columns: tableSchema.columns,
      indexes: withConflictIndex(
        tableName,
        tableSchema.columns,
        tableSchema.indexes,
        tableSchema.conflictColumns,
      ),
      triggers: [],
      foreignKeys,
      version: '',
      dependencies: foreignKeys
        .map((foreignKey) => foreignKey.referencesTable)
        .filter((dependency) => dependency !== tableName),
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
  engine?: DatabaseEngine,
): string {
  let sql = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (\n`;

  const columnLines: string[] = [];
  for (const [columnName, columnDef] of Object.entries(columns)) {
    const parts: string[] = [];

    // Column name and type
    const strategy = engine ? getDDLStrategy(engine) : undefined;
    const columnType = strategy
      ? strategy.mapType(columnDef.type)
      : columnDef.type;
    parts.push(`  ${quoteIdentifier(columnName)} ${columnType}`);

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
      const defaultSQL = strategy
        ? strategy.formatDefaultValue(columnDef.defaultValue, columnDef.type)
        : formatDefaultValue(columnDef.defaultValue, columnDef.type);
      parts.push(`DEFAULT ${defaultSQL}`);
    }

    columnLines.push(parts.join(' '));
  }
  for (const foreignKey of schemaForeignKeys({ columns, foreignKeys: [] })) {
    columnLines.push(`  ${renderForeignKeyConstraint(tableName, foreignKey)}`);
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
 * Format default value for SQL DDL.
 *
 * Thin wrapper over the shared, injection-safe formatter
 * (`schema/sql-identifiers.ts`) so the registry schema-builder uses the same
 * rules as the DDL strategies and schema generator: an allowlist of SQL
 * keyword/function defaults (not "contains `(`"), type-driven literal quoting,
 * and no folding of a literal string `"null"` into the SQL NULL keyword.
 *
 * @param value - Default value
 * @param type - Column SQL type
 * @returns Formatted SQL default value
 */
export function formatDefaultValue(value: unknown, type: string): string {
  return formatDefaultValueShared(value, type);
}

/**
 * Options for {@link fieldsToColumns}.
 */
export interface FieldsToColumnsOptions {
  /**
   * Shape the columns for a single-table-inheritance table.
   *
   * An STI table holds the union of every subtype's fields, so a column that
   * only one subtype declares must stay nullable — rows of sibling subtypes
   * never populate it. This matches `generateSTISchemaFromManifest`, which
   * emits `notNull: false` for every non-system column on an STI table.
   * Declared defaults are still emitted.
   */
  stiUnionColumns?: boolean;
  /**
   * Physical column names that form the table's natural conflict key.
   * Undeclared delete actions on foreign-key members use the shared CASCADE
   * default, matching app-side relationship cleanup.
   */
  conflictColumns?: readonly string[];
}

/**
 * Convert a Map of field definitions to column definitions
 *
 * Used by getAllSchemas() to generate columns from fields when a class
 * has no pre-generated schema (e.g., STI subclasses registered from manifest).
 *
 * `required`, `default`, and `description` are read from either the top level
 * or `_meta`: registry-sourced fields normalize them into `_meta`, so reading
 * only the top level dropped NOT NULL and DEFAULT for every such field
 * (#2372).
 *
 * @param fields - Map of field name to field definition
 * @param options - Table-shape options (see {@link FieldsToColumnsOptions})
 * @returns Record of column name to column definition
 * @private
 */
export function fieldsToColumns(
  fields: Map<string, FieldDefinition>,
  options?: FieldsToColumnsOptions,
): Record<string, ColumnDefinition> {
  const columns: Record<string, ColumnDefinition> = {};
  const conflictColumns = new Set(
    (options?.conflictColumns ?? []).map((column) => toSnakeCase(column)),
  );

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
      (fieldDef._meta?.idType === 'text' ||
        (fieldDef as unknown as { idType?: string }).idType === 'text')
        ? 'TEXT'
        : mapFieldTypeToSQL(fieldDef.type));
    const normalizedSqlType = String(sqlType).toUpperCase() as SQLDataType;
    const referenceKind = getReferenceKind(fieldDef);

    const required = readFieldAttribute(fieldDef, 'required');
    const defaultValue = readFieldAttribute(fieldDef, 'default');
    const description = readFieldAttribute(fieldDef, 'description');

    const column: ColumnDefinition = {
      type: normalizedSqlType,
      referenceKind,
      notNull: options?.stiUnionColumns
        ? false
        : fieldDef._meta?.nullable
          ? false
          : Boolean(required),
      unique: fieldDef._meta?.unique || false,
      description: description as string | undefined,
    };

    // Handle default values
    if (
      defaultValue !== undefined &&
      shouldEmitDefault(fieldDef, normalizedSqlType, defaultValue)
    ) {
      column.defaultValue = defaultValue;
    }

    // Handle foreign keys
    if (
      fieldDef.type === 'foreignKey' &&
      fieldDef.related &&
      fieldDef._meta?.constraint !== false &&
      fieldDef._meta?.__tenancy?.isTenantIdField !== true &&
      !(
        fieldDef as FieldDefinition & {
          __tenancy?: { isTenantIdField?: boolean };
        }
      ).__tenancy?.isTenantIdField
    ) {
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
        onDelete: resolveForeignKeyDeleteAction({
          declared: fieldMeta?.onDelete,
          isConflictColumn: conflictColumns.has(toSnakeCase(fieldName)),
          isTenantIdField: false,
        }).action,
        onUpdate:
          fieldMeta?.onUpdate === undefined
            ? 'CASCADE'
            : requireForeignKeyAction(
                fieldMeta.onUpdate,
                `${fieldName} ON UPDATE`,
              ),
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
