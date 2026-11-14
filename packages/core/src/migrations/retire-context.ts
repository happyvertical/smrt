/**
 * What a migrate run knows about declared table retirements (#5005): the
 * declarations of the packages loaded in this process and of the app's build,
 * and every table something still declares. Resolved from the registry and the
 * build schema, so the CLI, `migrateSmrtSchemas`, the doctor and the release
 * gate plan the same retirements.
 */
import { ObjectRegistry } from '../registry.js';
import { SYSTEM_TABLE_NAMES } from '../schema/system-table-shapes.js';
import type { SchemaDefinition } from '../schema/types.js';
import { resolveBuildSchema, resolveRetiredTables } from './build-schema.js';
import type { RetirementContext } from './retire-plan.js';

/**
 * The retirement context for a run, or undefined when no package declares a
 * retirement (nothing to plan, and nothing to read). `schemas` are the schemas
 * the run compares; the build's and the registry's complete set is read here,
 * since a run limited to tables must still see every model that declares a
 * table.
 */
export function resolveRetirementContext(
  schemas: Readonly<Record<string, SchemaDefinition>> = {},
): RetirementContext | undefined {
  const retired = resolveRetiredTables();
  if (retired.length === 0) return undefined;
  const declaredBy = new Map<string, string[]>();
  const declare = (table: string, owner: string) => {
    const owners = declaredBy.get(table) ?? [];
    if (!owners.includes(owner)) owners.push(owner);
    declaredBy.set(table, owners);
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
  for (const [table, packages] of Object.entries(
    resolveBuildSchema()?.tables ?? {},
  ))
    for (const name of packages) declare(table, `${name} (in the build)`);
  for (const table of SYSTEM_TABLE_NAMES) declare(table, 'smrt itself');
  return { retired, declaredBy, schemas: { ...full, ...schemas } };
}
