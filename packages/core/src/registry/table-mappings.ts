import { getConfig, getRuntimeConfig } from '@happyvertical/smrt-config';
import { ConfigurationError } from '../errors.js';
import { ObjectRegistry } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import { schemaForeignKeys } from '../schema/foreign-key-ddl.js';
import { shortenIdentifier } from '../schema/index-utils.js';
import type { SchemaDefinition } from '../schema/types.js';
import {
  isQualifiedName,
  parseQualifiedName,
} from '../utils/qualified-names.js';
import { toSnakeCase } from '../utils.js';
import { isCollectionRegistration } from './collection-resolution.js';
import { isFrameworkBaseClass } from './framework-base-classes.js';
import { getRegistryGeneration } from './generation.js';
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
  map = bindings(),
): string | undefined {
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
  assertRuntimeTableBindings();
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

/** One ownership rule for native planning and runtime storage access. */
export function assertTableFamilies(
  tableName: string,
  familyKeys: string[],
): void {
  const families = [...new Set(familyKeys)].map((key) => ({
    key,
    ...(isQualifiedName(key)
      ? (() => {
          const parsed = parseQualifiedName(key);
          return { name: parsed.className, pkg: parsed.packageName };
        })()
      : { name: key, pkg: undefined }),
  }));
  for (let i = 0; i < families.length; i++) {
    for (let j = i + 1; j < families.length; j++) {
      const left = families[i],
        right = families[j];
      if (
        left.name === right.name &&
        (!left.pkg || !right.pkg || left.pkg === right.pkg)
      )
        continue;
      throw new ConfigurationError(
        `Table '${tableName}' is claimed by unrelated classes ${left.key} and ${right.key}. ` +
          'Classes share a table only as one single-table-inheritance family; give one of them its own @smrt({ tableName }).',
        'CONFIG_TABLE_NAME_COLLISION',
        { tableName, classes: [left.key, right.key] },
      );
    }
  }
}

let validatedGeneration = -1;
let validatedBindings = '';
// Only instances that have used a deployment binding need removal checks.
// Weak references preserve custom unbound table names without retaining objects.
const boundInstances = new WeakSet<object>();

/**
 * A valid binding may precede registration (partial registries are supported).
 * Once models exist, no runtime reader/writer may cross a table's ownership.
 * Cached object/collection table names call this too; registration and config
 * changes invalidate the memo before the next database operation.
 */
export function assertRuntimeTableBindings(cached?: {
  qualifiedName: string;
  tableName: string | undefined;
  instance: object;
}): void {
  const map = bindings(); // Validate malformed dormant declarations too.
  if (cached) {
    const registered = ObjectRegistry.getClass(cached.qualifiedName);
    const root =
      ObjectRegistry.getSTIBase(cached.qualifiedName) || cached.qualifiedName;
    if (
      registered &&
      cached.tableName &&
      (map[root] || boundInstances.has(cached.instance)) &&
      mappedTableName(ObjectRegistry.getClass(root) || registered, map) !==
        cached.tableName
    ) {
      throw new ConfigurationError(
        `Table binding for '${cached.qualifiedName}' changed after runtime storage was initialized; restart the process with consistent configuration`,
        'CONFIG_TABLE_MAPPING_CHANGED',
      );
    }
    if (map[root]) boundInstances.add(cached.instance);
  }
  if (!Object.keys(map).length) return;
  const fingerprint = JSON.stringify(map);
  const generation = getRegistryGeneration();
  if (validatedGeneration === generation && validatedBindings === fingerprint)
    return;
  const tables = new Map<string, string[]>();
  const lookup = {
    findClass: (name: string) => ObjectRegistry.getClass(name),
    findClassInPackage: (pkg: string, name: string) =>
      ObjectRegistry.getClassInPackage(pkg, name),
    getInheritanceChain: (name: string) =>
      ObjectRegistry.getInheritanceChain(name),
  };
  for (const [key, registered] of ObjectRegistry.getAllClasses()) {
    if (
      isFrameworkBaseClass(registered.name, registered.packageName) ||
      isCollectionRegistration(key, registered, lookup)
    )
      continue;
    // Validate each subtype, but compare ownership using its physical root.
    // Unbound subtype schema/index metadata must remain unchanged.
    const projectedTable = mappedTableName(registered, map);
    const family = ObjectRegistry.getSTIBase(key) || key;
    const owner = ObjectRegistry.getClass(family) || registered;
    const table = mappedTableName(owner, map) || projectedTable;
    if (!table) continue;
    const families = tables.get(table) || [];
    families.push(family);
    tables.set(table, families);
  }
  for (const [table, families] of tables) assertTableFamilies(table, families);
  validatedGeneration = getRegistryGeneration();
  validatedBindings = fingerprint;
}
