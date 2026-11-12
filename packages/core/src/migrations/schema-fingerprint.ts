/** Engine-neutral database shape. Safe to call in build tooling and browsers. */
import { schemaForeignKeys } from '../schema/foreign-key-ddl.js';
import { formatDefaultValue } from '../schema/sql-identifiers.js';
import type { SchemaDefinition } from '../schema/types.js';
import { sha256Hex } from '../utils/sha256.js';

// The knowledge graph's stableStringify entry also loads filesystem tooling.
// Keep this projection import-free apart from pure schema/hash helpers.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return entry;
  });
}

function defaultDDL(value: unknown, type: string): string {
  // JSON object key order is not physical shape. Other values retain their
  // runtime type so the DDL formatter can normalize numeric/boolean values
  // and dynamic timestamp defaults exactly as CREATE TABLE does.
  const normalized =
    type.toUpperCase() === 'JSON' && value && typeof value === 'object'
      ? JSON.parse(canonicalJson(value))
      : value;
  return formatDefaultValue(normalized, type);
}

function sorted(values: unknown[]): unknown[] {
  return values.sort((a, b) => {
    const left = canonicalJson(a);
    const right = canonicalJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * SHA-256 of the whole abstract schema, independent of engine and ordering.
 * Only physical declarations participate; preview DDL is used only for legacy
 * schemas with no structured columns. Array order within an index is semantic.
 */
export function computeSchemaFingerprint(
  schemas:
    | Readonly<Record<string, SchemaDefinition>>
    | readonly SchemaDefinition[],
): string {
  const tables = Object.values(schemas).map((schema) => ({
    table: schema.tableName,
    columns: Object.fromEntries(
      Object.entries(schema.columns).map(([name, column]) => [
        name,
        {
          type: column.type.toUpperCase(),
          primaryKey: Boolean(column.primaryKey),
          notNull: Boolean(column.notNull),
          unique: Boolean(column.unique),
          // Undefined means no DEFAULT; null is an explicit default.
          ...(column.defaultValue !== undefined
            ? { default: defaultDDL(column.defaultValue, column.type) }
            : {}),
          ...(column.check ? { check: column.check } : {}),
        },
      ]),
    ),
    indexes: sorted(
      (schema.indexes ?? []).map((index) => ({
        name: index.name,
        ...(index.jsonPath
          ? { jsonPath: index.jsonPath }
          : { columns: index.columns }),
        unique: Boolean(index.unique),
        nullsNotDistinct: Boolean(index.nullsNotDistinct),
        where: index.where || null,
      })),
    ),
    foreignKeys: sorted(
      schemaForeignKeys(schema).map((fk) => ({
        column: fk.column,
        table: fk.referencesTable,
        target: fk.referencesColumn,
        onDelete: fk.onDelete ?? 'NO ACTION',
        onUpdate: fk.onUpdate ?? 'NO ACTION',
        engines: [
          ...(fk.engines ?? ['postgres', 'sqlite', 'duckdb', 'json']),
        ].sort(),
      })),
    ),
    triggers: sorted(
      (schema.triggers ?? []).map((trigger) => ({
        name: trigger.name,
        when: trigger.when,
        event: trigger.event,
        condition: trigger.condition || null,
        body: trigger.body,
      })),
    ),
    ...(Object.keys(schema.columns).length === 0
      ? { ddl: schema.ddl ?? '' }
      : {}),
  }));
  // STI manifests can repeat the identical shared-table definition.
  const uniqueTables = [...new Set(tables.map(canonicalJson))].sort();
  return sha256Hex(`[${uniqueTables.join(',')}]`);
}
