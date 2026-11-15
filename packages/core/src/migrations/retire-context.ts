/**
 * What a migrate run knows about declared table retirements (#5005): the
 * declarations `resolveRetiredTables` honours (the build's, or without a
 * build the registry's, the same set the migrate record stamps), and every
 * table something still declares. The differ resolves it itself when asked
 * to plan retirements (`DiffOptions.retireDeclaredTables`), so the CLI,
 * `migrateSmrtSchemas`, the doctor and the release gate plan the same
 * retirements and no caller can hand it a list or leave a declarer out.
 */
import { ObjectRegistry } from '../registry.js';
import { SYSTEM_TABLE_NAMES } from '../schema/system-table-shapes.js';
import type { SchemaDefinition } from '../schema/types.js';
import { resolveBuildSchema, resolveRetiredTables } from './build-schema.js';
import type { RetirementContext } from './retire-plan.js';

/**
 * The retirement context for a run, or undefined when nothing is declared
 * retired (nothing to plan, and nothing to read). `schemas` are the schemas
 * the run compares; the registry's and the build's complete sets are read
 * here as well, so every model that declares a table counts.
 * @internal
 */
export function resolveRetirementContext(
  schemas: Readonly<Record<string, SchemaDefinition>> = {},
): RetirementContext | undefined {
  const build = resolveBuildSchema();
  const retired = resolveRetiredTables(build);
  if (retired.length === 0) return undefined;
  // Lower-cased: SQLite and DuckDB compare table names without case, and on
  // PostgreSQL a model's `Orders` beside a retired `orders` is stopped too.
  const declaredBy = new Map<string, string[]>();
  const declare = (table: string, owner: string) => {
    const key = table.toLowerCase();
    const owners = declaredBy.get(key) ?? [];
    if (!owners.includes(owner)) owners.push(owner);
    declaredBy.set(key, owners);
  };
  const full = ObjectRegistry.getAllSchemasAsDefinitions();
  for (const [key] of ObjectRegistry.getAllClasses()) {
    const table = ObjectRegistry.getTableName(key);
    if (table) declare(table, key);
  }
  for (const table of Object.keys(full))
    declare(table, 'a model in this build');
  for (const table of Object.keys(schemas))
    declare(table, 'a model in this build');
  for (const [table, packages] of Object.entries(build?.tables ?? {}))
    for (const name of packages) declare(table, `${name} (in the build)`);
  for (const table of SYSTEM_TABLE_NAMES) declare(table, 'smrt itself');
  return { retired, declaredBy, schemas: { ...full, ...schemas } };
}
