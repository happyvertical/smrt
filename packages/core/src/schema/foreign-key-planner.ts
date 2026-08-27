import type { DatabaseEngine } from './ddl/types.js';
import {
  foreignKeyConstraintName,
  renderForeignKeyConstraint,
  schemaDependenciesForEngine,
  schemaForeignKeys,
  schemaForeignKeysForEngine,
} from './foreign-key-ddl.js';
import { quoteIdentifier } from './sql-identifiers.js';
import type { ForeignKeyDefinition, SchemaDefinition } from './types.js';

export interface ForeignKeyCreationPlan {
  schemas: SchemaDefinition[];
  deferredStatements: string[];
  /** Tables participating in a multi-table strongly connected component. */
  cyclicTables: string[];
  /** PostgreSQL constraints omitted from CREATE TABLE and added afterward. */
  deferredConstraints: Array<{
    table: string;
    foreignKey: ForeignKeyDefinition;
  }>;
}

/** Render a PostgreSQL deferred ADD CONSTRAINT statement. */
export function renderDeferredForeignKeyAdd(
  table: string,
  foreignKey: ForeignKeyDefinition,
): string {
  return `ALTER TABLE ${quoteIdentifier(table)} ADD ${renderForeignKeyConstraint(table, foreignKey)};`;
}

/** Render the inverse of a PostgreSQL deferred ADD CONSTRAINT statement. */
export function renderDeferredForeignKeyDrop(
  table: string,
  foreignKey: ForeignKeyDefinition,
): string {
  return `ALTER TABLE ${quoteIdentifier(table)} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(
    foreignKeyConstraintName(table, foreignKey),
  )};`;
}

function stronglyConnectedComponents(
  names: string[],
  dependencies: Map<string, string[]>,
): Map<string, number> {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const componentByName = new Map<string, number>();
  let component = 0;

  const visit = (name: string): void => {
    indexes.set(name, nextIndex);
    lowLinks.set(name, nextIndex);
    nextIndex++;
    stack.push(name);
    onStack.add(name);

    for (const dependency of dependencies.get(name) || []) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          name,
          Math.min(lowLinks.get(name) ?? 0, lowLinks.get(dependency) ?? 0),
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          name,
          Math.min(lowLinks.get(name) ?? 0, indexes.get(dependency) ?? 0),
        );
      }
    }

    if (lowLinks.get(name) !== indexes.get(name)) return;
    while (stack.length > 0) {
      const member = stack.pop() as string;
      onStack.delete(member);
      componentByName.set(member, component);
      if (member === name) break;
    }
    component++;
  };

  for (const name of names) {
    if (!indexes.has(name)) visit(name);
  }
  return componentByName;
}

function omitForeignKeys(
  schema: SchemaDefinition,
  omitted: Set<string>,
): SchemaDefinition {
  if (omitted.size === 0) return schema;
  const columns = Object.fromEntries(
    Object.entries(schema.columns).map(([name, definition]) => [
      name,
      omitted.has(name) ? { ...definition, foreignKey: undefined } : definition,
    ]),
  );
  return {
    ...schema,
    columns,
    foreignKeys: schemaForeignKeys(schema).filter(
      (foreignKey) => !omitted.has(foreignKey.column),
    ),
  };
}

/** Deterministically order new tables and define safe behavior for FK cycles. */
export function planForeignKeyCreation(
  input: readonly SchemaDefinition[],
  engine: DatabaseEngine,
): ForeignKeyCreationPlan {
  const byName = new Map(
    [...input]
      .sort((a, b) => a.tableName.localeCompare(b.tableName))
      .map((schema) => [schema.tableName, schema]),
  );
  const names = [...byName.keys()];
  const dependencies = new Map<string, string[]>();
  for (const [name, schema] of byName) {
    for (const foreignKey of schemaForeignKeysForEngine(schema, engine)) {
      // Validate externally supplied manifest actions before a dry-run can
      // report an executable plan.
      renderForeignKeyConstraint(name, foreignKey);
    }
    dependencies.set(
      name,
      Array.from(
        new Set(
          schemaDependenciesForEngine(schema, engine).filter(
            (target) => target !== name && byName.has(target),
          ),
        ),
      ).sort(),
    );
  }

  const components = stronglyConnectedComponents(names, dependencies);
  const componentSizes = new Map<number, number>();
  for (const id of components.values()) {
    componentSizes.set(id, (componentSizes.get(id) || 0) + 1);
  }
  const isMutualCycle = (source: string, target: string): boolean => {
    const component = components.get(source);
    return (
      source !== target &&
      component !== undefined &&
      component === components.get(target) &&
      (componentSizes.get(component) || 0) > 1
    );
  };

  if (engine === 'duckdb' || engine === 'json') {
    for (const [source, schema] of byName) {
      for (const foreignKey of schemaForeignKeysForEngine(schema, engine)) {
        if (source === foreignKey.referencesTable) {
          throw new Error(
            `[DDL:${engine}] Foreign key ${source}.${foreignKey.column} is self-referential; DuckDB cannot insert self-referencing foreign keys safely.`,
          );
        }
        if (
          foreignKey.onDelete === 'CASCADE' ||
          foreignKey.onDelete === 'SET NULL'
        ) {
          throw new Error(
            `[DDL:${engine}] Foreign key ${source}.${foreignKey.column} uses ON DELETE ${foreignKey.onDelete}, which DuckDB does not support. Use PostgreSQL/SQLite or keep this relationship app-side only with @crossPackageRef.`,
          );
        }
        if (foreignKey.onUpdate !== undefined) {
          throw new Error(
            `[DDL:${engine}] Foreign key ${source}.${foreignKey.column} uses ON UPDATE ${foreignKey.onUpdate}, which DuckDB does not support. DuckDB cannot preserve SMRT's ON UPDATE CASCADE contract; use PostgreSQL/SQLite or keep this relationship app-side only with @crossPackageRef.`,
          );
        }
        if (isMutualCycle(source, foreignKey.referencesTable)) {
          throw new Error(
            `[DDL:${engine}] Foreign-key cycle ${source}.${foreignKey.column} -> ${foreignKey.referencesTable}.${foreignKey.referencesColumn} cannot be created safely because DuckDB does not support ALTER TABLE ADD CONSTRAINT.`,
          );
        }
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const orderedNames: string[] = [];
  const visit = (name: string): void => {
    if (visited.has(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const dependency of dependencies.get(name) || []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    orderedNames.push(name);
  };
  for (const name of names) visit(name);

  const deferred: Array<{ table: string; foreignKey: ForeignKeyDefinition }> =
    [];
  const schemas = orderedNames.map((name) => {
    const schema = byName.get(name) as SchemaDefinition;
    if (engine !== 'postgres') return schema;
    const omitted = new Set<string>();
    for (const foreignKey of schemaForeignKeysForEngine(schema, engine)) {
      if (isMutualCycle(name, foreignKey.referencesTable)) {
        omitted.add(foreignKey.column);
        deferred.push({ table: name, foreignKey });
      }
    }
    return omitForeignKeys(schema, omitted);
  });

  deferred.sort((a, b) =>
    `${a.table}.${a.foreignKey.column}`.localeCompare(
      `${b.table}.${b.foreignKey.column}`,
    ),
  );
  return {
    schemas,
    cyclicTables: names.filter(
      (name) => (componentSizes.get(components.get(name) ?? -1) || 0) > 1,
    ),
    deferredConstraints: deferred,
    deferredStatements: deferred.map(({ table, foreignKey }) =>
      renderDeferredForeignKeyAdd(table, foreignKey),
    ),
  };
}
