/**
 * Schema generator for SMRT objects
 * Converts AST field definitions to database schema definitions
 */

import { createHash } from 'node:crypto';
import type {
  FieldDefinition,
  FieldMeta,
  ManifestColumnDefinition,
  ManifestIndexDefinition,
  ManifestSchema,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { classnameToTablename } from '../utils/naming.js';
import { getDDLStrategy } from './ddl/index.js';
import type { DatabaseEngine } from './ddl/types.js';
import {
  formatDefaultValue as formatDefaultValueShared,
  quoteIdentifier,
  quoteStringLiteral,
} from './sql-identifiers.js';
import type {
  ColumnDefinition,
  ForeignKeyDefinition,
  IndexDefinition,
  SchemaDefinition,
  SQLDataType,
  TriggerDefinition,
} from './types.js';

/**
 * Structural shape of a field as read from either the build-time manifest
 * (`FieldDefinition`) or the runtime ObjectRegistry (`getAllFields()` returns
 * `Map<string, any>` upstream). The schema generator consumes both through a
 * single set of property reads, so this interface captures every field key the
 * generator touches without coupling to either source's exact type.
 *
 * `_meta` carries the structured field-helper metadata (`FieldMeta`); a few
 * legacy fields (`indexed`, `idType`, `__tenancy`) may also appear at the top
 * level depending on the source, so they are declared here too.
 */
interface RegistryField {
  type?: FieldDefinition['type'];
  related?: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  transient?: boolean;
  indexed?: boolean;
  idType?: 'uuid' | 'text';
  __tenancy?: FieldMeta['__tenancy'];
  _meta?: FieldMeta;
}

type SchemaGeneratorConfig = {
  conflictColumns?: string[];
  idType?: 'uuid' | 'text';
  registry?: {
    getConfig?(className: string): { idType?: 'uuid' | 'text' };
    getDescendants(baseClassName: string): string[];
    getAllFields(className: string): Promise<Map<string, RegistryField>>;
    getSTIBase?(className: string): string | null;
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

    // The default list page orders by created_at (#2363) — before the
    // reference-column pass so the composite suppresses a standalone tenant
    // index.
    this.ensureDefaultListOrderingIndex(indexes, columns, tableName);

    // Reference columns (@foreignKey / @crossPackageRef / tenant_id) are
    // always indexed (#2356, #2359).
    this.ensureReferenceColumnIndexes(indexes, columns, tableName);

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

  private getRelationshipColumnType(field: RegistryField): SQLDataType {
    if (field?._meta?.sqlType) {
      return String(field._meta.sqlType).toUpperCase() as SQLDataType;
    }

    if (
      field?.type === 'crossPackageRef' &&
      (field._meta?.idType === 'text' || field.idType === 'text')
    ) {
      return 'TEXT';
    }

    return this.mapFieldTypeToSQL(field?.type || 'text');
  }

  private getReferenceKind(
    field: RegistryField,
  ): ColumnDefinition['referenceKind'] | undefined {
    if (
      field?.__tenancy?.isTenantIdField ||
      field?._meta?.__tenancy?.isTenantIdField
    ) {
      return 'tenantId';
    }

    if (field?.type === 'foreignKey') {
      return 'foreignKey';
    }

    if (field?.type === 'crossPackageRef') {
      return 'crossPackageRef';
    }

    return undefined;
  }

  private shouldEmitDefault(
    field: RegistryField,
    defaultValue: unknown,
  ): boolean {
    return !(
      this.getReferenceKind(field) === 'tenantId' &&
      this.getRelationshipColumnType(field) === 'UUID' &&
      defaultValue === ''
    );
  }

  private getRegistryTargetIdColumnType(
    relatedName: string | undefined,
    registry: SchemaGeneratorConfig['registry'] | undefined,
  ): SQLDataType | undefined {
    if (!relatedName || !registry?.getConfig) {
      return undefined;
    }

    const targetName = relatedName.split('.')[0];
    const targetNames = [targetName];
    const stiBase = registry.getSTIBase?.(targetName);
    if (stiBase && !targetNames.includes(stiBase)) {
      targetNames.push(stiBase);
    }

    for (const name of targetNames) {
      const idType = registry.getConfig(name)?.idType;
      if (idType === 'text') {
        return 'TEXT';
      }
      if (idType === 'uuid') {
        return 'UUID';
      }
    }

    return undefined;
  }

  private reconcileRegistryForeignKeyColumnTypes(
    columns: Record<string, ColumnDefinition>,
    fields: Map<string, RegistryField>,
    registry: SchemaGeneratorConfig['registry'] | undefined,
  ): void {
    if (!registry?.getConfig) {
      return;
    }

    for (const [fieldName, field] of fields.entries()) {
      if (field.type !== 'foreignKey' || field._meta?.sqlType) {
        continue;
      }

      const targetIdType = this.getRegistryTargetIdColumnType(
        field.related,
        registry,
      );
      if (!targetIdType) {
        continue;
      }

      const columnName = this.toSnakeCase(fieldName);
      if (columns[columnName]) {
        columns[columnName] = {
          ...columns[columnName],
          type: targetIdType,
        };
      }
    }
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
      referenceKind: 'id',
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
        type: this.getRelationshipColumnType(fieldDef),
        referenceKind: this.getReferenceKind(fieldDef),
        // If _meta.nullable is true, the field can be null regardless of required
        // This handles field helpers like text({ required: true, nullable: true })
        notNull: fieldDef._meta?.nullable ? false : fieldDef.required || false,
        unique: fieldDef._meta?.unique || false,
        description: fieldDef.description,
      };

      // Handle default values
      if (
        fieldDef.default !== undefined &&
        this.shouldEmitDefault(fieldDef, fieldDef.default)
      ) {
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
   * Whether an existing index already leads with `leadingColumns`, in order.
   *
   * Only an UNQUALIFIED index (no partial `WHERE`, no JSON-path expression)
   * counts. A partial index such as `... WHERE _meta_type = 'Article'` cannot
   * serve a base-class polymorphic query, which carries no subtype predicate,
   * so it must not suppress the standalone index (#2359, review of #2384).
   *
   * A B-tree serves any prefix of its column list, so an index over
   * `(tenant_id, created_at, status)` covers both `(tenant_id)` equality
   * lookups and `(tenant_id, created_at)` ordering — hence the prefix test
   * rather than an exact match (#2363).
   */
  private hasUnqualifiedLeadingColumns(
    indexes: ReadonlyArray<{
      columns: string[];
      where?: string;
      jsonPath?: unknown;
    }>,
    leadingColumns: readonly string[],
  ): boolean {
    return indexes.some(
      (index) =>
        !index.where &&
        !index.jsonPath &&
        (index.columns?.length ?? 0) >= leadingColumns.length &&
        leadingColumns.every((column, i) => index.columns[i] === column),
    );
  }

  /**
   * Whether an existing index already serves equality lookups on `column`.
   *
   * Single-column shorthand for {@link hasUnqualifiedLeadingColumns}.
   */
  private hasUnqualifiedLeadingIndex(
    indexes: ReadonlyArray<{
      columns: string[];
      where?: string;
      jsonPath?: unknown;
    }>,
    column: string,
  ): boolean {
    return this.hasUnqualifiedLeadingColumns(indexes, [column]);
  }

  /**
   * The column list of the default list-ordering index for a table.
   *
   * Every generated list surface — REST, MCP, and the SvelteKit list route —
   * pages with `ORDER BY created_at DESC, <pk> ASC` (`DEFAULT_LIST_ORDER_BY`,
   * #2367). On a tenant-scoped table that page is always preceded by a
   * `tenant_id = ?` equality filter from the tenancy interceptor, so the
   * serving index leads with the tenant column and orders inside it.
   *
   * `created_at` is generator-owned on every path — a declared `createdAt`
   * field is rewritten to the same `TIMESTAMP NOT NULL DEFAULT
   * current_timestamp` column — so it is never a primary key and never
   * inline-UNIQUE. That is why only `indexes` needs checking for existing
   * coverage: no constraint-backed index can already order this column.
   *
   * Returns `null` when the table has no `created_at` column (no path emits
   * such a table today, but the helper stays total).
   */
  private getDefaultListOrderingColumns(
    columns: Record<string, { referenceKind?: string } | undefined>,
  ): string[] | null {
    if (!columns.created_at) return null;

    // The tenant column name is configurable (`@smrt({ tenantScoped: { field } })`),
    // so find it by reference kind rather than by the `tenant_id` spelling.
    const tenantColumn = Object.entries(columns).find(
      ([, columnDef]) => columnDef?.referenceKind === 'tenantId',
    )?.[0];

    return tenantColumn ? [tenantColumn, 'created_at'] : ['created_at'];
  }

  /**
   * Ensure the table can serve its own default list page from an index.
   *
   * Generated REST/MCP/SvelteKit list routes all page with
   * `ORDER BY created_at DESC, <pk> ASC LIMIT n` and no `created_at` index
   * existed on any schema path (the dead AST path indexed `updated_at`
   * instead), so every default list page was a sequential scan plus a top-N
   * sort of the whole table — 21 ms against 0.1 ms with the right composite on
   * the workload the assessment measured (#2363, finding A2).
   *
   * Emitted shape:
   *
   * - tenant-scoped table → `(<tenant column>, created_at)`. The tenancy
   *   interceptor adds `tenant_id = ?` to every list, so the tenant column
   *   leads and `created_at` orders within it.
   * - otherwise → `(created_at)`.
   *
   * No `DESC` declaration: PostgreSQL scans a B-tree backwards just as
   * cheaply, and `IndexDefinition` carries no per-column direction. The
   * trailing primary-key tiebreak is left out deliberately — its direction is
   * opposite to `created_at`'s, so no single-direction index can satisfy the
   * whole key anyway; the leading columns turn a full sort into an index scan
   * with an incremental sort over rows that share a timestamp.
   *
   * Call this AFTER every declared/opt-in index and BEFORE
   * {@link ensureReferenceColumnIndexes}: a declared composite that already
   * leads with the same columns suppresses this one, and this composite in
   * turn suppresses the standalone tenant index that would otherwise be a
   * redundant prefix of it.
   */
  private ensureDefaultListOrderingIndex(
    indexes: Array<{
      name: string;
      columns: string[];
      unique?: boolean;
      where?: string;
      jsonPath?: unknown;
    }>,
    columns: Record<string, { referenceKind?: string } | undefined>,
    tableName: string,
  ): void {
    const orderingColumns = this.getDefaultListOrderingColumns(columns);
    if (!orderingColumns) return;
    if (this.hasUnqualifiedLeadingColumns(indexes, orderingColumns)) return;

    const name = `${tableName}_${orderingColumns.join('_')}_idx`;
    if (indexes.some((index) => index.name === name)) return;

    // No `description`: ManifestIndexDefinition has no such field, and this
    // helper feeds the manifest paths as well as the structured ones.
    indexes.push({ name, columns: orderingColumns });
  }

  /**
   * Ensure every reference column — `@foreignKey`, `@crossPackageRef`, and the
   * tenancy-injected `tenant_id` — has an index leading with it.
   *
   * These are the columns every relationship load, `include:` batch, reverse
   * ownership lookup and tenant-scoped read filters on. Before #2359 only the
   * registry (test) paths indexed foreign keys, the manifest (production)
   * paths indexed none of them, and `tenant_id` was indexed nowhere (#2356):
   * 196/231 `@foreignKey` and 91/92 `@crossPackageRef` columns shipped with no
   * serving index. Every schema path now calls this helper so the four paths
   * stay in step (see `schema-path-parity.test.ts`).
   *
   * "Leading with it" rather than "always add": a table that already has an
   * unqualified index starting on the column (commonly the `conflictColumns`
   * unique index, or an `indexed: true` opt-in) is already served, and a
   * standalone duplicate would only cost writes. A *partial* index does not
   * count — see {@link hasUnqualifiedLeadingIndex}.
   *
   * Reference columns are therefore always indexed; `indexed: true` on one of
   * them is redundant and harmless.
   *
   * Call this LAST in every path, after every other index (conflict, opt-in,
   * unique, the default list-ordering composite, and any future declared
   * composite index) has been appended, so the leads-with suppression sees the
   * full set. In particular {@link ensureDefaultListOrderingIndex} runs first
   * on a tenant-scoped table: its `(tenant_id, created_at)` composite serves
   * the tenant equality filter too, so no standalone tenant index is added
   * (#2363).
   */
  private ensureReferenceColumnIndexes(
    indexes: Array<{
      name: string;
      columns: string[];
      unique?: boolean;
      where?: string;
      jsonPath?: unknown;
    }>,
    columns: Record<
      string,
      | { referenceKind?: string; primaryKey?: boolean; unique?: boolean }
      | undefined
    >,
    tableName: string,
  ): void {
    for (const [columnName, columnDef] of Object.entries(columns)) {
      const kind = columnDef?.referenceKind;
      if (
        kind !== 'foreignKey' &&
        kind !== 'crossPackageRef' &&
        kind !== 'tenantId'
      ) {
        continue;
      }
      // The primary key, and a column-level UNIQUE (rendered inline on CTI
      // tables — PostgreSQL's implicit `_key` index), are already unique
      // indexes on every engine.
      if (columnDef?.primaryKey || columnDef?.unique) continue;
      if (this.hasUnqualifiedLeadingIndex(indexes, columnName)) continue;

      const name = `${tableName}_${columnName}_idx`;
      if (indexes.some((index) => index.name === name)) continue;

      // No `description`: ManifestIndexDefinition has no such field, and this
      // helper feeds the manifest paths as well as the structured ones.
      indexes.push({ name, columns: [columnName] });
    }
  }

  /**
   * Whether `conflictColumns` names exactly the primary key column(s).
   *
   * `ON CONFLICT (id)` binds to the primary-key constraint on every engine, so
   * a separate unique index over the same column set is a second B-tree over
   * the same random UUIDs with nothing to add (#2359, finding A5).
   */
  private conflictColumnsArePrimaryKey(
    conflictColumns: string[],
    columns: Record<string, { primaryKey?: boolean } | undefined>,
  ): boolean {
    const primaryKeyColumns = Object.entries(columns)
      .filter(([, columnDef]) => columnDef?.primaryKey === true)
      .map(([name]) => name);
    return (
      primaryKeyColumns.length > 0 &&
      primaryKeyColumns.length === conflictColumns.length &&
      primaryKeyColumns.every((column) => conflictColumns.includes(column))
    );
  }

  /**
   * Keep `(slug, context)` lookups served when `conflictColumns` are custom.
   *
   * The default conflict index is `(slug, context)`, and `loadFromSlug()`,
   * `getId()` and `getSavedId()` all filter on `slug`/`context` regardless of
   * the configured conflict key. A class that declares custom conflict
   * columns replaces that unique index and, before #2359, left those lookups
   * with no index at all — 120 tables (finding A7).
   *
   * Emitting a plain `(slug, context)` index is the safer of the two fixes:
   * routing the lookups through the conflict key would change which row a
   * slug resolves to on every such class, whereas an extra non-unique index
   * is purely additive. It is skipped when an unqualified index already leads
   * with `slug` (e.g. custom conflict columns that still start with it).
   */
  private ensureSlugLookupIndex(
    indexes: Array<{
      name: string;
      columns: string[];
      unique?: boolean;
      where?: string;
      jsonPath?: unknown;
    }>,
    columns: Record<string, unknown>,
    tableName: string,
  ): void {
    if (!columns.slug || !columns.context) return;
    if (this.hasUnqualifiedLeadingIndex(indexes, 'slug')) return;

    const name = `${tableName}_slug_context_idx`;
    if (indexes.some((index) => index.name === name)) return;

    indexes.push({ name, columns: ['slug', 'context'] });
  }

  /**
   * Emit unique indexes for `@field({ unique: true })` columns on an STI table.
   *
   * STI columns are the union of every class in the hierarchy, all nullable,
   * so a column-level `UNIQUE` (what CTI renders inline) is not enough on its
   * own: the migration differ cannot add a column constraint to an existing
   * table, but it can add an index. Two shapes (#2359, finding A4):
   *
   * - declared on the STI **base** (and therefore inherited by every class in
   *   the table): one full unique index, table-wide like CTI;
   * - declared only on a **descendant**: one partial unique index per class
   *   that carries the flag (the declaring class and, through inherited field
   *   metadata, its own descendants), `WHERE _meta_type = '<qualified>'`, so
   *   siblings that merely share the column name are not constrained.
   *   Uniqueness is then enforced per concrete class, not across the subtree
   *   — a documented limitation of the discriminator-partial shape. Engines
   *   without partial indexes (DuckDB, JSON) skip this shape entirely rather
   *   than widen it to a table-wide UNIQUE (see DuckDBStrategy.generateIndexes
   *   and SchemaComparer.compareIndexes).
   *
   * @param declarers - column name → classes whose field metadata carries
   *   `unique: true` for that column, in hierarchy order (base first).
   */
  private emitStiUniqueIndexes(
    indexes: Array<{
      name: string;
      columns: string[];
      unique?: boolean;
      where?: string;
    }>,
    declarers: Map<string, Set<string>>,
    baseClassName: string,
    tableName: string,
  ): void {
    for (const [columnName, classNames] of declarers.entries()) {
      if (classNames.has(baseClassName)) {
        indexes.push({
          name: `${tableName}_${columnName}_unique_idx`,
          columns: [columnName],
          unique: true,
        });
        continue;
      }
      for (const className of classNames) {
        const simpleName = className.includes(':')
          ? className.slice(className.lastIndexOf(':') + 1)
          : className;
        let name = `${tableName}_${columnName}_${this.toSnakeCase(simpleName)}_unique_idx`;
        // Two classes of one hierarchy may share a simple name across
        // packages (`@a:Event`, `@b:Event`); the merged index list dedupes by
        // name, so disambiguate with a short digest of the qualified name.
        if (indexes.some((index) => index.name === name)) {
          const digest = createHash('sha256')
            .update(className)
            .digest('hex')
            .slice(0, 6);
          name = `${tableName}_${columnName}_${this.toSnakeCase(simpleName)}_${digest}_unique_idx`;
        }
        indexes.push({
          name,
          columns: [columnName],
          unique: true,
          where: `_meta_type = ${quoteStringLiteral(className)}`,
        });
      }
    }
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
        body: `UPDATE ${quoteIdentifier(tableName)} SET "updated_at" = current_timestamp WHERE "id" = NEW."id";`,
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
    fields: Map<string, RegistryField>,
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
        referenceKind: 'id',
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

      const sqlType = this.getRelationshipColumnType(field);

      const columnDef: ColumnDefinition = {
        type: sqlType,
        referenceKind: this.getReferenceKind(field),
        // If _meta.nullable is true, the field can be null regardless of required
        notNull: field._meta?.nullable ? false : field._meta?.required || false,
        primaryKey: field._meta?.primaryKey || false,
        unique: field._meta?.unique || false,
        description: field._meta?.description,
      };

      // Get default value
      if (
        field._meta?.default !== undefined &&
        this.shouldEmitDefault(field, field._meta.default)
      ) {
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
        const onDeleteAction = field._meta?.onDelete;

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
      const isIndexed = field._meta?.indexed === true || field.indexed === true;
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

    this.reconcileRegistryForeignKeyColumnTypes(
      columns,
      fields,
      config?.registry,
    );

    // Generate indexes. No `<table>_id_idx`: the primary key is already a
    // unique index on every engine, and the second B-tree over the same
    // random UUIDs cost writes on 238/238 tables for nothing (#2359, A5).
    // The differ drops the legacy one from existing databases.
    const indexes: IndexDefinition[] = [];

    if (!hasCustomPK) {
      const conflictColumns = config?.conflictColumns || ['slug', 'context'];
      if (!this.conflictColumnsArePrimaryKey(conflictColumns, columns)) {
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
      }
    }

    // Custom conflict columns replace the (slug, context) index, but slug
    // loading still filters on it (#2359, A7).
    this.ensureSlugLookupIndex(indexes, columns, tableName);

    // Emit opt-in column indexes for regular fields tagged with `indexed: true`
    for (const colName of indexedColumns) {
      indexes.push({
        name: `${tableName}_${colName}_idx`,
        columns: [colName],
        description: `Index for ${colName}`,
      });
    }

    // The default list page orders by created_at (#2363) — before the
    // reference-column pass so the composite suppresses a standalone tenant
    // index.
    this.ensureDefaultListOrderingIndex(indexes, columns, tableName);

    // Reference columns (@foreignKey / @crossPackageRef / tenant_id) are
    // always indexed (#2356, #2359).
    this.ensureReferenceColumnIndexes(indexes, columns, tableName);

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
   * - One plain index per reference column (FK / cross-package ref /
   *   tenant_id). Plain rather than partial-by-class: base-class polymorphic
   *   queries carry no `_meta_type` predicate, so a partial index could not
   *   serve them, while a plain index serves both those and the child
   *   collections' `_meta_type = X AND fk = ?` filters — one index per column
   *   instead of one per (column, class) (#2359).
   * - Unique indexes for `@field({ unique: true })` columns — see
   *   {@link emitStiUniqueIndexes}.
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
    _fields: Map<string, RegistryField>,
    config?: SchemaGeneratorConfig,
  ): Promise<SchemaDefinition> {
    const ObjectRegistry =
      config?.registry ?? (await import('../registry.js')).ObjectRegistry;
    const columns: Record<string, ColumnDefinition> = {};

    // Add default SMRT fields
    columns.id = {
      type: this.getIdColumnType(config),
      primaryKey: true,
      referenceKind: 'id',
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

    // Track meta fields opted into JSON-path indexing (deduped across STI subtypes)
    const indexedMetaFields = new Set<string>();
    // Track regular-field columns opted into plain column indexing
    const indexedStiColumns = new Set<string>();
    // Track `unique: true` columns and the classes declaring them (#2359, A4)
    const uniqueColumnDeclarers = new Map<string, Set<string>>();

    // Aggregate fields from base and all descendants
    for (const className of allClassNames) {
      const classFields: Map<string, RegistryField> =
        await ObjectRegistry.getAllFields(className);

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

        // `unique: true` is recorded per declaring class (before the
        // inherited-column skip below, since descendants re-list inherited
        // fields) so the index shape can depend on where it was declared.
        if (field._meta?.unique === true) {
          let declarers = uniqueColumnDeclarers.get(columnName);
          if (!declarers) {
            declarers = new Set();
            uniqueColumnDeclarers.set(columnName, declarers);
          }
          declarers.add(className);
        }

        // Check if column already exists (inherited from parent)
        if (columns[columnName]) {
          continue;
        }

        const sqlType = this.getRelationshipColumnType(field);

        const columnDef: ColumnDefinition = {
          type: sqlType,
          referenceKind: this.getReferenceKind(field),
          // STI: All columns nullable (union of child fields)
          notNull: false,
          primaryKey: false,
          // Uniqueness is enforced through indexes (emitStiUniqueIndexes), not
          // an inline column constraint the differ could never add later.
          unique: false,
          description: field._meta?.description,
        };

        // Get default value (but not applied in STI - defaults handled by application)
        if (
          field._meta?.default !== undefined &&
          this.shouldEmitDefault(field, field._meta.default)
        ) {
          columnDef.defaultValue = field._meta.default;
        }

        // Handle foreign keys
        if (field.type === 'foreignKey') {
          const relatedName = field.related; // Top-level property
          const onDeleteAction = field._meta?.onDelete;

          if (relatedName) {
            columnDef.foreignKey = {
              table: this.classNameToTableName(relatedName),
              column: 'id',
              onDelete: onDeleteAction || 'CASCADE',
              onUpdate: 'CASCADE',
            };
          }
        }

        // Track opt-in column indexes for regular STI columns
        const isIndexed =
          field._meta?.indexed === true || field.indexed === true;
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

    for (const className of allClassNames) {
      const classFields = await ObjectRegistry.getAllFields(className);
      this.reconcileRegistryForeignKeyColumnTypes(
        columns,
        classFields,
        ObjectRegistry,
      );
    }

    // Generate indexes. No `<table>_id_idx` — see generateSchemaFromRegistry.
    const indexes: IndexDefinition[] = [];

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

    // Unique indexes for `@field({ unique: true })` columns (#2359, A4)
    this.emitStiUniqueIndexes(
      indexes,
      uniqueColumnDeclarers,
      baseClassName,
      tableName,
    );

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

    // The default list page orders by created_at (#2363) — before the
    // reference-column pass so the composite suppresses a standalone tenant
    // index.
    this.ensureDefaultListOrderingIndex(indexes, columns, tableName);

    // Reference columns (@foreignKey / @crossPackageRef / tenant_id) are
    // always indexed (#2356, #2359).
    this.ensureReferenceColumnIndexes(indexes, columns, tableName);

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
      referenceKind: 'id',
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

    // Find all descendants in manifest. Manifest keys are qualified names
    // while callers may pass the base's simple name (an external STI base is
    // reported that way); resolve to the key so the base's own fields are
    // aggregated and the base-declared unique check below sees the same
    // spelling the descendant loop records.
    const baseKey = this.resolveManifestClassKey(baseClassName, manifest);
    const descendants = this.findDescendantsInManifest(baseKey, manifest);
    const allClassNames = [baseKey, ...descendants];

    // Track meta fields opted into JSON-path indexing (deduped across STI subtypes)
    const indexedMetaFields = new Set<string>();
    // Track regular columns opted into plain column indexing
    const indexedStiColumns = new Set<string>();
    // Track `unique: true` columns and the classes declaring them (#2359, A4)
    const uniqueColumnDeclarers = new Map<string, Set<string>>();

    // Aggregate fields from base and all descendants
    for (const className of allClassNames) {
      const objDef = manifest.objects[className];
      if (!objDef) continue;

      for (const [fieldName, field] of Object.entries(objDef.fields)) {
        // Skip transient fields
        if (field.transient || field._meta?.transient) {
          continue;
        }

        // Capture indexed meta fields before the skip-meta branch below.
        // `indexed` is normally carried in `_meta`, but tolerate a legacy
        // top-level flag too — RegistryField models both placements.
        const indexedField: RegistryField = field;
        if (
          field.type === 'meta' &&
          (indexedField.indexed === true || field._meta?.indexed === true)
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

        // `unique: true` per declaring class — see generateSTISchemaFromRegistry.
        if (field._meta?.unique === true) {
          let declarers = uniqueColumnDeclarers.get(columnName);
          if (!declarers) {
            declarers = new Set();
            uniqueColumnDeclarers.set(columnName, declarers);
          }
          declarers.add(className);
        }

        // Check if column already exists (inherited from parent)
        if (columns[columnName]) {
          continue;
        }

        const sqlType = this.getRelationshipColumnType(field);

        const columnDef: ManifestColumnDefinition = {
          type: sqlType,
          referenceKind: this.getReferenceKind(field),
          // STI: All columns nullable (union of child fields)
          notNull: false,
        };

        // Get default value
        if (
          field.default !== undefined &&
          this.shouldEmitDefault(field, field.default)
        ) {
          columnDef.default = field.default;
        }

        // Track opt-in column indexes for regular STI columns
        const isIndexed =
          indexedField.indexed === true || field._meta?.indexed === true;
        if (isIndexed && field.type !== 'foreignKey') {
          indexedStiColumns.add(columnName);
        }

        columns[columnName] = columnDef;
      }
    }

    // Generate indexes. No `<table>_id_idx` — see generateSchemaFromRegistry.
    const indexes: ManifestIndexDefinition[] = [];

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

    // Unique indexes for `@field({ unique: true })` columns (#2359, A4)
    this.emitStiUniqueIndexes(
      indexes,
      uniqueColumnDeclarers,
      baseKey,
      tableName,
    );

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

    // The default list page orders by created_at (#2363) — before the
    // reference-column pass so the composite suppresses a standalone tenant
    // index.
    this.ensureDefaultListOrderingIndex(indexes, columns, tableName);

    // Reference columns (@foreignKey / @crossPackageRef / tenant_id) are
    // always indexed (#2356, #2359). `generateSQL()` below renders only the
    // CREATE TABLE statement; indexes travel separately in `indexes`, which
    // is what the migration differ and the DDL strategies consume.
    this.ensureReferenceColumnIndexes(indexes, columns, tableName);

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

    const ddl = this.generateSQL(schemaDefinition);

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

    // Track regular columns opted into a plain index via `@field({ indexed: true })`.
    // Mirrors the STI path (generateSTISchemaFromManifest) so CTI tables honor
    // the documented `FieldOptions.indexed` flag too.
    const indexedColumns = new Set<string>();

    // Add default SMRT fields
    columns.id = {
      type: this.getIdColumnType(config),
      primaryKey: true,
      referenceKind: 'id',
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
      const sqlType = this.getRelationshipColumnType(field);

      const columnDef: ManifestColumnDefinition = {
        type: sqlType,
        referenceKind: this.getReferenceKind(field),
        notNull: field._meta?.nullable ? false : field.required || false,
        unique: field._meta?.unique || false,
      };

      if (
        field.default !== undefined &&
        this.shouldEmitDefault(field, field.default)
      ) {
        columnDef.default = field.default;
      }

      // Opt-in plain column index. FK columns and unique columns get their own
      // indexes, so skip those here.
      const indexedField: RegistryField = field;
      const isIndexed =
        indexedField.indexed === true || field._meta?.indexed === true;
      if (isIndexed && field.type !== 'foreignKey' && !columnDef.unique) {
        indexedColumns.add(columnName);
      }

      columns[columnName] = columnDef;
    }

    // Generate indexes. No `<table>_id_idx` — see generateSchemaFromRegistry.
    const indexes: ManifestIndexDefinition[] = [];

    // Use custom conflict columns if provided, otherwise default to slug+context
    const conflictColumns = config?.conflictColumns || ['slug', 'context'];
    if (!this.conflictColumnsArePrimaryKey(conflictColumns, columns)) {
      const indexName =
        conflictColumns.length > 2
          ? `${tableName}_${conflictColumns.slice(0, 2).join('_')}_idx`
          : `${tableName}_${conflictColumns.join('_')}_idx`;

      indexes.push({
        name: indexName,
        columns: conflictColumns,
        unique: true,
      });
    }

    // Custom conflict columns replace the (slug, context) index, but slug
    // loading still filters on it (#2359, A7).
    this.ensureSlugLookupIndex(indexes, columns, tableName);

    // Plain column indexes for regular columns opted in via `indexed: true`.
    for (const colName of indexedColumns) {
      indexes.push({
        name: `${tableName}_${colName}_idx`,
        columns: [colName],
      });
    }

    // The default list page orders by created_at (#2363) — before the
    // reference-column pass so the composite suppresses a standalone tenant
    // index.
    this.ensureDefaultListOrderingIndex(indexes, columns, tableName);

    // Reference columns (@foreignKey / @crossPackageRef / tenant_id) are
    // always indexed (#2356, #2359). `generateSQL()` below renders only the
    // CREATE TABLE statement; indexes travel separately in `indexes`, which
    // is what the migration differ and the DDL strategies consume.
    this.ensureReferenceColumnIndexes(indexes, columns, tableName);

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

    const ddl = this.generateSQL(schemaDefinition);

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
   * Resolve a class name (simple or qualified) to the key it is stored under
   * in `manifest.objects`. Falls back to the input when the manifest does not
   * carry the class (e.g. an external STI base absent from the aggregated
   * manifest), so callers can keep using it as an opaque label.
   */
  private resolveManifestClassKey(
    className: string,
    manifest: SmartObjectManifest,
  ): string {
    if (manifest.objects[className]) return className;
    const simpleName = className.includes(':')
      ? className.slice(className.lastIndexOf(':') + 1)
      : className;
    for (const [key, obj] of Object.entries(manifest.objects)) {
      if (obj.qualifiedName === className || obj.className === simpleName) {
        return key;
      }
    }
    return className;
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
        referenceKind: col.referenceKind,
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
    let sql = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (\n`;

    for (const [columnName, columnDef] of Object.entries(columns)) {
      const parts = [`  ${quoteIdentifier(columnName)} ${columnDef.type}`];

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
  private formatDefaultValue(value: unknown, type: SQLDataType): string {
    // Delegate to the shared, injection-safe formatter so all DDL paths
    // converge on one set of rules (allowlisted keyword/function defaults
    // instead of "contains `(`", type-driven quoting, no string-"null" fold).
    // This path is engine-agnostic and never emits CAST expressions, so the
    // output stays valid for SQLite and DuckDB. Non-string TIMESTAMP defaults
    // fall back to lowercase `current_timestamp` to preserve prior output.
    return formatDefaultValueShared(value, type, {
      nonStringTimestampDefault: 'current_timestamp',
    });
  }
}
