import { requireForeignKeyAction } from './foreign-key-policy.js';
import { shortenIdentifier } from './index-utils.js';
import { quoteIdentifier } from './sql-identifiers.js';
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

export function renderForeignKeyOrphanDetector(
  tableName: string,
  foreignKey: ForeignKeyDefinition,
  options: { limitOne?: boolean } = {},
): string {
  const childTable = quoteIdentifier(tableName);
  const childColumn = quoteIdentifier(foreignKey.column);
  const parentTable = quoteIdentifier(foreignKey.referencesTable);
  const parentColumn = quoteIdentifier(foreignKey.referencesColumn);
  return (
    `SELECT ${childTable}.${childColumn} AS orphan_key FROM ${childTable} ` +
    `LEFT JOIN ${parentTable} ON ${parentTable}.${parentColumn} = ${childTable}.${childColumn} ` +
    `WHERE ${childTable}.${childColumn} IS NOT NULL AND ${parentTable}.${parentColumn} IS NULL` +
    (options.limitOne ? ' LIMIT 1' : '')
  );
}

export function renderForeignKeyOrphanRepair(
  tableName: string,
  foreignKey: ForeignKeyDefinition,
): string {
  const childTable = quoteIdentifier(tableName);
  const childColumn = quoteIdentifier(foreignKey.column);
  const parentTable = quoteIdentifier(foreignKey.referencesTable);
  const parentColumn = quoteIdentifier(foreignKey.referencesColumn);
  return (
    `DELETE FROM ${childTable} WHERE ${childColumn} IS NOT NULL AND NOT EXISTS (` +
    `SELECT 1 FROM ${parentTable} WHERE ${parentTable}.${parentColumn} = ${childTable}.${childColumn})`
  );
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
      },
    ];
  });
}
