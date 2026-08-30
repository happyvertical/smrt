import type { DatabaseEngine } from './ddl/types.js';
import { requireForeignKeyAction } from './foreign-key-policy.js';
import { shortenIdentifier } from './index-utils.js';
import { quoteIdentifier, quoteStringLiteral } from './sql-identifiers.js';
import type { ForeignKeyDefinition, SchemaDefinition } from './types.js';

export function foreignKeyConstraintName(
  tableName: string,
  foreignKey: ForeignKeyDefinition,
): string {
  return shortenIdentifier(
    `${tableName}_${foreignKey.column}_${foreignKey.referencesTable}_${foreignKey.referencesColumn}_fkey`,
  );
}

export function renderForeignKeyConstraint(
  tableName: string,
  foreignKey: ForeignKeyDefinition,
): string {
  const action = (value: unknown, clause: 'DELETE' | 'UPDATE') => {
    if (value === undefined) return undefined;
    return requireForeignKeyAction(
      value,
      `${tableName}.${foreignKey.column} ON ${clause}`,
    );
  };
  const onDelete = action(foreignKey.onDelete, 'DELETE');
  const onUpdate = action(foreignKey.onUpdate, 'UPDATE');
  const name = foreignKeyConstraintName(tableName, foreignKey);
  const parts = [
    `CONSTRAINT ${quoteIdentifier(name)}`,
    `FOREIGN KEY (${quoteIdentifier(foreignKey.column)})`,
    `REFERENCES ${quoteIdentifier(foreignKey.referencesTable)} (${quoteIdentifier(foreignKey.referencesColumn)})`,
  ];
  if (onDelete) parts.push(`ON DELETE ${onDelete}`);
  if (onUpdate) parts.push(`ON UPDATE ${onUpdate}`);
  return parts.join(' ');
}

/** Render a PostgreSQL DROP CONSTRAINT statement for a catalog-owned FK. */
export function renderForeignKeyConstraintDrop(
  tableName: string,
  constraintName: string,
): string {
  return `ALTER TABLE ${quoteIdentifier(tableName)} DROP CONSTRAINT ${quoteIdentifier(constraintName)};`;
}

/** Render a PostgreSQL VALIDATE CONSTRAINT statement. */
export function renderForeignKeyConstraintValidate(
  tableName: string,
  constraintName: string,
): string {
  return `ALTER TABLE ${quoteIdentifier(tableName)} VALIDATE CONSTRAINT ${quoteIdentifier(constraintName)};`;
}

/** Render a PostgreSQL constraint comment used to identify framework ownership. */
export function renderForeignKeyConstraintComment(
  tableName: string,
  constraintName: string,
  comment: string,
): string {
  return `COMMENT ON CONSTRAINT ${quoteIdentifier(constraintName)} ON ${quoteIdentifier(tableName)} IS ${quoteStringLiteral(comment)};`;
}

export function renderForeignKeyOrphanDetector(
  tableName: string,
  foreignKey: ForeignKeyDefinition,
  options: {
    engine?: DatabaseEngine;
    limitOne?: boolean;
    uuidComparison?: boolean;
    uuidCastSide?: 'child' | 'parent' | 'both';
  } = {},
): string {
  const parts = foreignKeyOrphanParts(
    tableName,
    foreignKey,
    options.engine,
    options.uuidComparison,
    options.uuidCastSide,
  );
  return (
    `SELECT ${parts.childColumn} AS orphan_key FROM ${parts.childTable} ` +
    `LEFT JOIN ${parts.parentTable} ON ${parts.joinPredicate} ` +
    `WHERE ${parts.childColumn} IS NOT NULL AND ${parts.parentColumn} IS NULL` +
    (options.limitOne ? ' LIMIT 1' : '')
  );
}

export function renderForeignKeyOrphanRepair(
  tableName: string,
  foreignKey: ForeignKeyDefinition,
  options: {
    engine?: DatabaseEngine;
    uuidComparison?: boolean;
    uuidCastSide?: 'child' | 'parent' | 'both';
    nullable?: boolean;
  } = {},
): string {
  const parts = foreignKeyOrphanParts(
    tableName,
    foreignKey,
    options.engine,
    options.uuidComparison,
    options.uuidCastSide,
  );
  const orphanPredicate =
    `${parts.childColumn} IS NOT NULL AND NOT EXISTS (` +
    `SELECT 1 FROM ${parts.parentTable} WHERE ${parts.joinPredicate})`;
  if (options.nullable === false) {
    return `DELETE FROM ${parts.childTable} WHERE ${orphanPredicate}`;
  }
  return (
    `UPDATE ${quoteIdentifier(tableName)} AS ${parts.childAlias} ` +
    `SET ${quoteIdentifier(foreignKey.column)} = NULL ` +
    `WHERE ${orphanPredicate}`
  );
}

const FOREIGN_KEY_CHILD_ALIAS = 'smrt_fk_child';
const FOREIGN_KEY_PARENT_ALIAS = 'smrt_fk_parent';
const CANONICAL_UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

function foreignKeyOrphanParts(
  tableName: string,
  foreignKey: ForeignKeyDefinition,
  engine: DatabaseEngine = 'postgres',
  uuidComparison = false,
  uuidCastSide?: 'child' | 'parent' | 'both',
) {
  const childAlias = quoteIdentifier(FOREIGN_KEY_CHILD_ALIAS);
  const parentAlias = quoteIdentifier(FOREIGN_KEY_PARENT_ALIAS);
  const childColumn = `${childAlias}.${quoteIdentifier(foreignKey.column)}`;
  const parentColumn = `${parentAlias}.${quoteIdentifier(foreignKey.referencesColumn)}`;
  const guardedUuidValue = (column: string) =>
    `CASE WHEN ${column}::text ~* '${CANONICAL_UUID_PATTERN}' THEN ${column}::uuid ELSE NULL END`;
  const effectiveUuidCastSide =
    engine === 'postgres' && uuidComparison
      ? (uuidCastSide ?? 'child')
      : undefined;
  const childValue =
    effectiveUuidCastSide === 'child' || effectiveUuidCastSide === 'both'
      ? guardedUuidValue(childColumn)
      : childColumn;
  const parentValue =
    effectiveUuidCastSide === 'parent' || effectiveUuidCastSide === 'both'
      ? guardedUuidValue(parentColumn)
      : parentColumn;

  return {
    childAlias,
    childColumn,
    childTable: `${quoteIdentifier(tableName)} AS ${childAlias}`,
    joinPredicate: `${parentValue} = ${childValue}`,
    parentColumn,
    parentTable: `${quoteIdentifier(foreignKey.referencesTable)} AS ${parentAlias}`,
  };
}

export function schemaForeignKeys(
  schema: Pick<SchemaDefinition, 'columns'> &
    Partial<Pick<SchemaDefinition, 'foreignKeys'>>,
): ForeignKeyDefinition[] {
  if (schema.foreignKeys && schema.foreignKeys.length > 0) {
    return schema.foreignKeys;
  }
  return Object.entries(schema.columns).flatMap(([column, definition]) => {
    if (!definition.foreignKey) return [];
    return [
      {
        column,
        referencesTable: definition.foreignKey.table,
        referencesColumn: definition.foreignKey.column,
        onDelete: definition.foreignKey.onDelete,
        onUpdate: definition.foreignKey.onUpdate,
        ...(definition.foreignKey.engines
          ? { engines: definition.foreignKey.engines }
          : {}),
      },
    ];
  });
}

/** Stable identity for one physical relationship, independent of allocation. */
export function foreignKeyRelationshipKey(
  foreignKey: Pick<
    ForeignKeyDefinition,
    'column' | 'referencesColumn' | 'referencesTable'
  >,
): string {
  return JSON.stringify([
    foreignKey.column,
    foreignKey.referencesTable,
    foreignKey.referencesColumn,
  ]);
}

/** Return only physical constraints explicitly enabled for an engine. */
export function schemaForeignKeysForEngine(
  schema: Pick<SchemaDefinition, 'columns'> &
    Partial<Pick<SchemaDefinition, 'foreignKeys'>>,
  engine: DatabaseEngine,
): ForeignKeyDefinition[] {
  return schemaForeignKeys(schema).filter((foreignKey) => {
    if (foreignKey.engines === undefined) return true;

    const validEngines = new Set<DatabaseEngine>([
      'postgres',
      'sqlite',
      'duckdb',
      'json',
    ]);
    if (
      foreignKey.engines.length === 0 ||
      foreignKey.engines.some(
        (declaredEngine) => !validEngines.has(declaredEngine),
      )
    ) {
      throw new Error(
        `[DDL:${engine}] Foreign key ${foreignKey.column} declares an invalid physical constraint engine allowlist. Use one or more of: postgres, sqlite, duckdb, json.`,
      );
    }

    return foreignKey.engines.includes(engine);
  });
}

/** Return declared schema dependencies after excluding engine-disabled FKs. */
export function schemaDependenciesForEngine(
  schema: Pick<SchemaDefinition, 'columns'> &
    Partial<Pick<SchemaDefinition, 'dependencies' | 'foreignKeys'>>,
  engine: DatabaseEngine,
): string[] {
  const foreignKeys = schemaForeignKeys(schema);
  const enabledForeignKeys = schemaForeignKeysForEngine(schema, engine);
  const enabledKeys = new Set(
    enabledForeignKeys.map(foreignKeyRelationshipKey),
  );
  const enabledTargets = new Set(
    enabledForeignKeys.map((foreignKey) => foreignKey.referencesTable),
  );
  const disabledTargets = new Set(
    foreignKeys
      .filter(
        (foreignKey) => !enabledKeys.has(foreignKeyRelationshipKey(foreignKey)),
      )
      .map((foreignKey) => foreignKey.referencesTable),
  );

  return Array.from(
    new Set([
      ...(schema.dependencies ?? []).filter(
        (dependency) =>
          !disabledTargets.has(dependency) || enabledTargets.has(dependency),
      ),
      ...enabledTargets,
    ]),
  );
}
