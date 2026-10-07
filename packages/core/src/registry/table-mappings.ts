import { getConfig, getRuntimeConfig } from '@happyvertical/smrt-config';
import { ConfigurationError } from '../errors.js';
import { ObjectRegistry } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import { schemaForeignKeys } from '../schema/foreign-key-ddl.js';
import { shortenIdentifier } from '../schema/index-utils.js';
import type { SchemaDefinition } from '../schema/types.js';
import { toSnakeCase } from '../utils.js';
import type { RegisteredClass } from './types.js';

function bindings(): Record<string, string> {
  const file = getConfig()?.smrt?.tableNames;
  const runtime = getRuntimeConfig().smrt?.tableNames;
  for (const value of [file, runtime]) {
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ConfigurationError(
        'smrt.tableNames must be a qualified model-to-table map',
        'CONFIG_TABLE_MAPPING',
      );
    }
    for (const [key, table] of Object.entries(value)) {
      if (
        !/^@[^/:\s]+\/[^:\s]+:[A-Za-z_$][\w$]*$/.test(key) ||
        typeof table !== 'string' ||
        !/^[a-z][a-z0-9_]{0,62}$/.test(table) ||
        table.startsWith('_smrt_')
      ) {
        throw new ConfigurationError(
          `Invalid smrt.tableNames binding for '${key}'; use an exact qualified model and a lowercase SQL table identifier`,
          'CONFIG_TABLE_MAPPING',
        );
      }
    }
  }
  return { ...file, ...runtime };
}

/** Resolve storage by model identity, never by a potentially shared table name. */
export function mappedTableName(
  registered: RegisteredClass,
): string | undefined {
  const map = bindings();
  if (!Object.keys(map).length) return registered.schema?.tableName;
  const key = registered.qualifiedName;
  if (!key) return registered.schema?.tableName;
  const base = ObjectRegistry.getSTIBase(key);
  if (map[base || key] && registered.config.sensitive === true) {
    throw new ConfigurationError(
      'smrt.tableNames cannot remap sensitive tables; their change-feed exclusion requires a published table identity',
      'CONFIG_TABLE_MAPPING',
    );
  }
  if (base && base !== key && map[key]) {
    throw new ConfigurationError(
      `smrt.tableNames must bind STI root '${base}', not subtype '${key}'`,
      'CONFIG_TABLE_MAPPING',
    );
  }
  return map[base || key] || registered.schema?.tableName;
}

/**
 * Project the deployment binding without changing published manifest metadata.
 * Both runtime objects/collections and migration planning use this projection.
 */
export function mappedSchema(
  registered: RegisteredClass,
): SchemaDefinition | undefined {
  const schema = registered.schema;
  if (!schema) return undefined;
  if (!Object.keys(bindings()).length) return schema;
  const tableName = mappedTableName(registered) || schema.tableName;
  const columns = { ...schema.columns };
  let changed = tableName !== schema.tableName;
  for (const [fieldName, field] of registered.fields) {
    const columnName = toSnakeCase(fieldName);
    const column = columns[columnName];
    if (field.type !== 'foreignKey' || !column?.foreignKey) continue;
    const targetKey = ObjectRegistry.resolveRelationshipTarget(
      registered.qualifiedName || registered.name,
      fieldName,
    );
    const target = targetKey ? ObjectRegistry.getClass(targetKey) : undefined;
    if (!target) continue;
    const targetTable = mappedTableName(target);
    if (
      targetTable &&
      targetTable !== target.schema?.tableName &&
      targetTable !== column.foreignKey.table
    ) {
      columns[columnName] = {
        ...column,
        foreignKey: { ...column.foreignKey, table: targetTable },
      };
      changed = true;
    }
  }
  if (!changed) return schema;
  const projected: SchemaDefinition = {
    ...schema,
    tableName,
    columns,
    indexes: schema.indexes.map((index) => ({
      ...index,
      name:
        tableName === schema.tableName
          ? index.name
          : shortenIdentifier(
              index.name.startsWith(`${schema.tableName}_`)
                ? `${tableName}${index.name.slice(schema.tableName.length)}`
                : `${tableName}_${index.name}`,
            ),
    })),
  };
  // Legacy inspection callers still receive coherent DDL. Native execution
  // always rematerializes these structured columns for its target dialect.
  projected.foreignKeys = schemaForeignKeys({ columns: projected.columns });
  projected.dependencies = [
    ...new Set(projected.foreignKeys.map((fk) => fk.referencesTable)),
  ];
  projected.ddl = getDDLStrategy('sqlite').generateCreateTable(projected);
  return projected;
}

/** Full-schema planning must not silently accept misspelled model identities. */
export function assertKnownTableMappings(): void {
  for (const key of Object.keys(bindings())) {
    if (!ObjectRegistry.getAllClasses().has(key)) {
      throw new ConfigurationError(
        `smrt.tableNames names unregistered model '${key}'`,
        'CONFIG_TABLE_MAPPING',
      );
    }
  }
}
