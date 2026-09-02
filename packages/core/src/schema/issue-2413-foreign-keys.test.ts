import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import { MigrationGenerator } from '../migrations/generator.js';
import { resolveTestDatabaseDDLEngine } from '../testing/database.js';
import { generateDDLForEngine } from './ddl/index.js';
import {
  foreignKeyConstraintName,
  foreignKeyRelationshipKey,
  renderForeignKeyConstraint,
  renderForeignKeyConstraintComment,
  renderForeignKeyConstraintDrop,
  renderForeignKeyConstraintValidate,
  schemaDependenciesForEngine,
  schemaForeignKeys,
} from './foreign-key-ddl.js';
import { planForeignKeyCreation } from './foreign-key-planner.js';
import { resolveForeignKeyDeleteAction } from './foreign-key-policy.js';
import { identifierByteLength, MAX_IDENTIFIER_BYTES } from './index-utils.js';
import { SchemaManager } from './schema-manager.js';
import type { ForeignKeyAction, SchemaDefinition } from './types.js';

function schema(
  tableName: string,
  foreignKey?: {
    column: string;
    table: string;
    onDelete?: ForeignKeyAction;
  },
): SchemaDefinition {
  const columns: SchemaDefinition['columns'] = {
    id: { type: 'TEXT', primaryKey: true },
  };
  if (foreignKey) {
    columns[foreignKey.column] = {
      type: 'TEXT',
      foreignKey: {
        table: foreignKey.table,
        column: 'id',
        onDelete: foreignKey.onDelete ?? 'NO ACTION',
        onUpdate: 'CASCADE',
      },
    };
  }
  const foreignKeys = schemaForeignKeys({ columns, foreignKeys: [] });
  return {
    tableName,
    columns,
    indexes: [],
    triggers: [],
    foreignKeys,
    dependencies: foreignKeys.map((fk) => fk.referencesTable),
    version: '2413',
  };
}

function withoutUpdateAction(input: SchemaDefinition): SchemaDefinition {
  const foreignKeys = schemaForeignKeys(input).map((foreignKey) => ({
    ...foreignKey,
    onUpdate: undefined,
  }));
  return {
    ...input,
    columns: Object.fromEntries(
      Object.entries(input.columns).map(([name, column]) => [
        name,
        column.foreignKey
          ? {
              ...column,
              foreignKey: { ...column.foreignKey, onUpdate: undefined },
            }
          : column,
      ]),
    ),
    foreignKeys,
  };
}

describe('same-package foreign-key policy (#2413)', () => {
  it('quotes catalog-owned names when dropping a rendered constraint', () => {
    expect(renderForeignKeyConstraintDrop('child"table', 'parent"fkey')).toBe(
      'ALTER TABLE "child""table" DROP CONSTRAINT "parent""fkey";',
    );
  });

  it('quotes validation and ownership-comment statements', () => {
    expect(
      renderForeignKeyConstraintValidate('child"table', 'parent"fkey'),
    ).toBe('ALTER TABLE "child""table" VALIDATE CONSTRAINT "parent""fkey";');
    expect(
      renderForeignKeyConstraintComment(
        'child"table',
        'parent"fkey',
        "smrt's marker",
      ),
    ).toBe(
      `COMMENT ON CONSTRAINT "parent""fkey" ON "child""table" IS 'smrt''s marker';`,
    );
  });

  it('maps declared actions, natural keys, ordinary references, and tenancy exclusions explicitly', () => {
    expect(resolveForeignKeyDeleteAction({ declared: 'SET NULL' }).action).toBe(
      'SET NULL',
    );
    expect(
      resolveForeignKeyDeleteAction({ isConflictColumn: true }).action,
    ).toBe('CASCADE');
    expect(resolveForeignKeyDeleteAction({}).action).toBe('NO ACTION');
    expect(
      resolveForeignKeyDeleteAction({
        isConflictColumn: true,
        isTenantIdField: true,
      }).action,
    ).toBe('NO ACTION');
  });

  it('emits deterministic named constraints with the resolved action', () => {
    const child = schema('line_items', {
      column: 'order_id',
      table: 'orders',
      onDelete: 'CASCADE',
    });
    const name = foreignKeyConstraintName(
      child.tableName,
      child.foreignKeys[0],
    );
    const postgres = generateDDLForEngine(child, 'postgres').createTable;
    const sqlite = generateDDLForEngine(child, 'sqlite').createTable;

    expect(name).toBe('line_items_order_id_orders_id_fkey');
    for (const ddl of [postgres, sqlite]) {
      expect(ddl).toContain(`CONSTRAINT "${name}"`);
      expect(ddl).toContain(
        'FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE ON UPDATE CASCADE',
      );
    }
  });

  it('bounds long constraint identifiers without losing deterministic identity', () => {
    const child = schema(
      'stakeholder_coordination_workshop_registration_records',
      {
        column: 'primary_organizational_account_identifier',
        table: 'stakeholder_coordination_workshop_organizations',
      },
    );
    const name = foreignKeyConstraintName(
      child.tableName,
      child.foreignKeys[0],
    );
    expect(identifierByteLength(name)).toBeLessThanOrEqual(
      MAX_IDENTIFIER_BYTES,
    );
    expect(
      foreignKeyConstraintName(child.tableName, child.foreignKeys[0]),
    ).toBe(name);
  });

  it('rejects invalid manifest actions instead of interpolating them into SQL', () => {
    expect(() =>
      renderForeignKeyConstraint('children', {
        column: 'parent_id',
        referencesTable: 'parents',
        referencesColumn: 'id',
        onDelete: 'CASCADE; DROP TABLE parents' as ForeignKeyAction,
      }),
    ).toThrow(/Invalid foreign-key action/);
    expect(() =>
      resolveForeignKeyDeleteAction({
        declared: 'surprise',
        isConflictColumn: false,
        isTenantIdField: false,
      }),
    ).toThrow(/Invalid foreign-key action/);
  });
});

describe('deterministic creation planning (#2413)', () => {
  it('infers PostgreSQL DDL from an existing test database without a type override', () => {
    expect(
      resolveTestDatabaseDDLEngine(
        undefined,
        { url: 'postgresql://localhost/smrt_test' } as never,
        true,
      ),
    ).toBe('postgres');
  });

  it('keeps explicit native DuckDB separate from JSON-on-DuckDB', () => {
    expect(
      resolveTestDatabaseDDLEngine('duckdb', {
        exportTable: () => undefined,
      } as never),
    ).toBe('duckdb');
    expect(
      resolveTestDatabaseDDLEngine(
        undefined,
        {
          exportTable: () => undefined,
          inferSchemaFromJSON: () => undefined,
        } as never,
        true,
      ),
    ).toBe('json');
    expect(
      resolveTestDatabaseDDLEngine(
        undefined,
        {
          exportTable: () => undefined,
          getTableSchema: () => undefined,
          alterTable: { addColumn: () => undefined },
        } as never,
        true,
      ),
    ).toBe('duckdb');
  });

  it('orders an acyclic graph parent-first on every supported engine', () => {
    const parent = schema('parents');
    const child = schema('children', {
      column: 'parent_id',
      table: 'parents',
    });
    for (const engine of ['postgres', 'sqlite'] as const) {
      expect(
        planForeignKeyCreation([child, parent], engine).schemas.map(
          (item) => item.tableName,
        ),
      ).toEqual(['parents', 'children']);
    }
    expect(
      planForeignKeyCreation(
        [withoutUpdateAction(child), parent],
        'duckdb',
      ).schemas.map((item) => item.tableName),
    ).toEqual(['parents', 'children']);
  });

  it('applies the shared order in generated migration SQL', () => {
    const parent = schema('parents');
    const child = schema('children', {
      column: 'parent_id',
      table: 'parents',
    });
    const migration = new MigrationGenerator({ engine: 'postgres' })
      .generateFromDiff(
        {
          has_changes: true,
          added_tables: [child, parent],
          dropped_tables: [],
          changes: [],
        },
        { name: 'issue_2413_order' },
      )
      .up.join('\n');
    expect(
      migration.indexOf('CREATE TABLE IF NOT EXISTS "parents"'),
    ).toBeLessThan(migration.indexOf('CREATE TABLE IF NOT EXISTS "children"'));
  });

  it('drops children before parents and removes deferred cycle constraints first', () => {
    const parent = schema('parents');
    const child = schema('children', {
      column: 'parent_id',
      table: 'parents',
    });
    const acyclic = new MigrationGenerator({ engine: 'postgres' })
      .generateFromDiff(
        {
          has_changes: true,
          added_tables: [child, parent],
          dropped_tables: [],
          changes: [],
        },
        { name: 'issue_2413_down_order' },
      )
      .down.join('\n');
    expect(acyclic.indexOf('DROP TABLE IF EXISTS "children"')).toBeLessThan(
      acyclic.indexOf('DROP TABLE IF EXISTS "parents"'),
    );

    const left = schema('left_nodes', {
      column: 'right_id',
      table: 'right_nodes',
    });
    const right = schema('right_nodes', {
      column: 'left_id',
      table: 'left_nodes',
    });
    const cyclic = new MigrationGenerator({
      engine: 'postgres',
    }).generateFromDiff(
      {
        has_changes: true,
        added_tables: [right, left],
        dropped_tables: [],
        changes: [],
      },
      { name: 'issue_2413_cycle_down' },
    ).down;
    expect(cyclic.slice(0, 2)).toEqual([
      expect.stringMatching(/^ALTER TABLE .* DROP CONSTRAINT IF EXISTS /),
      expect.stringMatching(/^ALTER TABLE .* DROP CONSTRAINT IF EXISTS /),
    ]);
    expect(cyclic.slice(2).every((sql) => sql.startsWith('DROP TABLE'))).toBe(
      true,
    );
  });

  it('keeps SQLite cycles inline, defers PostgreSQL cycles, and refuses DuckDB cycles', () => {
    const left = schema('left_nodes', {
      column: 'right_id',
      table: 'right_nodes',
    });
    const right = schema('right_nodes', {
      column: 'left_id',
      table: 'left_nodes',
    });

    const sqlite = planForeignKeyCreation([right, left], 'sqlite');
    expect(sqlite.deferredStatements).toEqual([]);
    expect(sqlite.schemas.every((item) => item.foreignKeys.length === 1)).toBe(
      true,
    );

    const postgres = planForeignKeyCreation([right, left], 'postgres');
    expect(
      postgres.schemas.every((item) => item.foreignKeys.length === 0),
    ).toBe(true);
    expect(postgres.deferredStatements).toHaveLength(2);
    expect(postgres.deferredStatements[0]).toMatch(
      /^ALTER TABLE "left_nodes" ADD CONSTRAINT /,
    );

    expect(() =>
      planForeignKeyCreation(
        [withoutUpdateAction(right), withoutUpdateAction(left)],
        'duckdb',
      ),
    ).toThrow(/DuckDB does not support ALTER TABLE ADD CONSTRAINT/);
    expect(() =>
      planForeignKeyCreation(
        [withoutUpdateAction(right), withoutUpdateAction(left)],
        'json',
      ),
    ).toThrow(
      /\[DDL:json\].*DuckDB does not support ALTER TABLE ADD CONSTRAINT/,
    );
  });

  it('refuses unsupported DuckDB actions and self-reference instead of emitting a green no-op', () => {
    const cascade = schema('children', {
      column: 'parent_id',
      table: 'parents',
      onDelete: 'CASCADE',
    });
    expect(() => planForeignKeyCreation([cascade], 'duckdb')).toThrow(
      /DuckDB does not support/,
    );
    expect(() => generateDDLForEngine(cascade, 'duckdb')).toThrow(
      /DuckDB does not support/,
    );
    const updateCascade = schema('children', {
      column: 'parent_id',
      table: 'parents',
    });
    expect(() => planForeignKeyCreation([updateCascade], 'duckdb')).toThrow(
      /ON UPDATE CASCADE.*does not support/,
    );
    expect(() => generateDDLForEngine(updateCascade, 'duckdb')).toThrow(
      /ON UPDATE CASCADE.*does not support/,
    );
    expect(() =>
      generateDDLForEngine(
        schema('nodes', { column: 'parent_id', table: 'nodes' }),
        'duckdb',
      ),
    ).toThrow(/self-referential/);
  });

  it('honors an explicit physical-constraint engine allowlist without weakening other self-references (#2504)', () => {
    const portableHierarchy = schema('event_nodes', {
      column: 'parent_id',
      table: 'event_nodes',
    });
    const parentForeignKey = portableHierarchy.columns.parent_id.foreignKey;
    if (!parentForeignKey)
      throw new Error('fixture parent foreign key missing');
    portableHierarchy.columns.parent_id.foreignKey = {
      ...parentForeignKey,
      engines: ['postgres', 'sqlite'],
    };
    portableHierarchy.foreignKeys = schemaForeignKeys({
      columns: portableHierarchy.columns,
      foreignKeys: [],
    });

    for (const engine of ['postgres', 'sqlite'] as const) {
      expect(
        generateDDLForEngine(portableHierarchy, engine).createTable,
      ).toContain('FOREIGN KEY ("parent_id")');
      expect(
        planForeignKeyCreation([portableHierarchy], engine).schemas[0]
          .foreignKeys,
      ).toHaveLength(1);
    }
    for (const engine of ['duckdb', 'json'] as const) {
      expect(
        generateDDLForEngine(portableHierarchy, engine).createTable,
      ).not.toContain('FOREIGN KEY ("parent_id")');
      expect(
        planForeignKeyCreation([portableHierarchy], engine).schemas[0]
          .foreignKeys,
      ).toHaveLength(1);
    }

    expect(() =>
      generateDDLForEngine(
        schema('arbitrary_nodes', {
          column: 'parent_id',
          table: 'arbitrary_nodes',
        }),
        'duckdb',
      ),
    ).toThrow(/self-referential/);
  });

  it('excludes engine-disabled relationships from dependency planning (#2504)', () => {
    const child = schema('a_children', {
      column: 'parent_id',
      table: 'z_parents',
    });
    const childForeignKey = child.columns.parent_id.foreignKey;
    if (!childForeignKey) throw new Error('fixture foreign key missing');
    child.columns.parent_id.foreignKey = {
      ...childForeignKey,
      engines: ['postgres', 'sqlite'],
    };
    child.foreignKeys = schemaForeignKeys({
      columns: child.columns,
      foreignKeys: [],
    });
    const parent = schema('z_parents');

    expect(
      planForeignKeyCreation([child, parent], 'postgres').schemas.map(
        (item) => item.tableName,
      ),
    ).toEqual(['z_parents', 'a_children']);
    expect(
      planForeignKeyCreation([child, parent], 'duckdb').schemas.map(
        (item) => item.tableName,
      ),
    ).toEqual(['a_children', 'z_parents']);
  });

  it('matches derived foreign keys by stable relationship semantics instead of object identity (#2504)', () => {
    const derived = schema('derived_children', {
      column: 'parent_id',
      table: 'derived_parents',
    });
    derived.foreignKeys = [];
    const derivedForeignKey = derived.columns.parent_id.foreignKey;
    if (!derivedForeignKey) throw new Error('fixture foreign key missing');
    derived.columns.parent_id.foreignKey = {
      ...derivedForeignKey,
      engines: ['postgres', 'sqlite'],
    };

    const first = schemaForeignKeys(derived)[0];
    const second = schemaForeignKeys(derived)[0];
    expect(first).not.toBe(second);
    expect(foreignKeyRelationshipKey(first)).toBe(
      foreignKeyRelationshipKey(second),
    );
    expect(schemaDependenciesForEngine(derived, 'postgres')).toEqual([
      'derived_parents',
    ]);
    expect(schemaDependenciesForEngine(derived, 'duckdb')).toEqual([]);
  });

  it('fails closed for empty or unknown physical-constraint engine allowlists', () => {
    const invalid = schema('children', {
      column: 'parent_id',
      table: 'parents',
    });

    invalid.foreignKeys[0].engines = [];
    expect(() => generateDDLForEngine(invalid, 'duckdb')).toThrow(
      /invalid physical constraint engine allowlist/,
    );

    invalid.foreignKeys[0].engines = ['mysql'] as never;
    expect(() => planForeignKeyCreation([invalid], 'postgres')).toThrow(
      /invalid physical constraint engine allowlist/,
    );
  });
});

describe('SQLite database enforcement (#2413)', () => {
  it('enforces CASCADE and NO ACTION on real SQLite DDL', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query('PRAGMA foreign_keys = ON');
    await db.query(
      generateDDLForEngine(schema('parents'), 'sqlite').createTable,
    );
    await db.query(
      generateDDLForEngine(
        schema('cascade_children', {
          column: 'parent_id',
          table: 'parents',
          onDelete: 'CASCADE',
        }),
        'sqlite',
      ).createTable,
    );
    await db.query(
      generateDDLForEngine(
        schema('guarded_children', {
          column: 'parent_id',
          table: 'parents',
        }),
        'sqlite',
      ).createTable,
    );

    await db.query("INSERT INTO parents (id) VALUES ('cascade-parent')");
    await db.query(
      "INSERT INTO cascade_children (id, parent_id) VALUES ('child', 'cascade-parent')",
    );
    await db.query("DELETE FROM parents WHERE id = 'cascade-parent'");
    expect(await db.count('cascade_children')).toBe(0);

    await db.query("INSERT INTO parents (id) VALUES ('guarded-parent')");
    await db.query(
      "INSERT INTO guarded_children (id, parent_id) VALUES ('guard', 'guarded-parent')",
    );
    await expect(
      db.query("DELETE FROM parents WHERE id = 'guarded-parent'"),
    ).rejects.toThrow();
    expect(await db.count('parents', { id: 'guarded-parent' })).toBe(1);
  });

  it('rolls back populated mutual cycles by deferring checks until commit', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const left = schema('rollback_left', {
      column: 'right_id',
      table: 'rollback_right',
    });
    const right = schema('rollback_right', {
      column: 'left_id',
      table: 'rollback_left',
    });
    const migration = new MigrationGenerator({
      engine: 'sqlite',
    }).generateFromDiff(
      {
        has_changes: true,
        added_tables: [right, left],
        dropped_tables: [],
        changes: [],
      },
      { name: 'issue_2413_sqlite_cycle_down' },
    );
    expect(migration.down[0]).toBe('PRAGMA defer_foreign_keys = ON');
    for (const statement of migration.up) await db.query(statement);
    await db.query("INSERT INTO rollback_left (id) VALUES ('left')");
    await db.query(
      "INSERT INTO rollback_right (id, left_id) VALUES ('right', 'left')",
    );
    await db.query(
      "UPDATE rollback_left SET right_id = 'right' WHERE id = 'left'",
    );

    await db.query('BEGIN');
    for (const statement of migration.down) await db.query(statement);
    await db.query('COMMIT');
    const remaining = await db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('rollback_left', 'rollback_right')",
    );
    expect(remaining.rows).toEqual([]);
  });
});

describe('DuckDB database enforcement (#2413)', () => {
  it('enforces its supported NO ACTION constraint and refuses unsafe actions elsewhere', async () => {
    const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    try {
      await db.query(
        generateDDLForEngine(schema('duck_parents'), 'duckdb').createTable,
      );
      await db.query(
        generateDDLForEngine(
          withoutUpdateAction(
            schema('duck_children', {
              column: 'parent_id',
              table: 'duck_parents',
            }),
          ),
          'duckdb',
        ).createTable,
      );

      await db.query("INSERT INTO duck_parents (id) VALUES ('parent')");
      await db.query(
        "INSERT INTO duck_children (id, parent_id) VALUES ('child', 'parent')",
      );
      await expect(
        db.query("DELETE FROM duck_parents WHERE id = 'parent'"),
      ).rejects.toThrow();
      await expect(
        db.query(
          "INSERT INTO duck_children (id, parent_id) VALUES ('orphan', 'missing')",
        ),
      ).rejects.toThrow();
    } finally {
      await db.close?.();
    }
  });
});

describe('existing-table orphan safety (#2413)', () => {
  const child = schema('children', {
    column: 'parent_id',
    table: 'parents',
  });

  function postgresMock(orphan: boolean) {
    const queries: string[] = [];
    return {
      queries,
      db: {
        url: 'postgres://fixture/issue2413',
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.includes('information_schema.tables')) {
            return { rows: [{ table_name: 'children' }] };
          }
          if (sql.includes('orphan_key')) {
            return { rows: orphan ? [{ orphan_key: 'missing-parent' }] : [] };
          }
          return { rows: [] };
        },
        getTableSchema: async () => ({
          columns: {
            id: { name: 'id', type: 'text', primaryKey: true },
            parent_id: { name: 'parent_id', type: 'text' },
          },
          indexes: [],
          foreignKeys: [],
        }),
      },
    };
  }

  it('reports a required rebuild for a live constraint disabled on DuckDB (#2504)', async () => {
    const portableChild = structuredClone(child);
    portableChild.foreignKeys[0].engines = ['postgres', 'sqlite'];
    if (!portableChild.columns.parent_id.foreignKey) {
      throw new Error('fixture foreign key missing');
    }
    portableChild.columns.parent_id.foreignKey.engines = ['postgres', 'sqlite'];
    const mock = postgresMock(false);
    mock.db.getTableSchema = async () => ({
      columns: {
        id: { name: 'id', type: 'text', primaryKey: true },
        parent_id: { name: 'parent_id', type: 'text' },
      },
      indexes: [],
      foreignKeys: [
        {
          column: 'parent_id',
          referencesTable: 'parents',
          referencesColumn: 'id',
          onDelete: 'NO ACTION',
          onUpdate: 'CASCADE',
        },
      ],
    });
    const query = mock.db.query;
    mock.db.query = async (sql: string) => {
      if (sql.includes('sqlite_master')) {
        mock.queries.push(sql);
        return { rows: [{ name: 'children' }] } as never;
      }
      return query(sql);
    };

    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'duckdb',
    }).compare({ children: portableChild });

    expect(diff.has_changes).toBe(true);
    expect(diff.changes).toContainEqual(
      expect.objectContaining({
        type: 'drop_foreign_key',
        table: 'children',
        advisory: expect.objectContaining({
          message: expect.stringMatching(/table rebuild/),
        }),
      }),
    );
    const migration = new MigrationGenerator({ engine: 'duckdb' })
      .generateFromDiff(diff, { name: 'drop_disabled_duckdb_fk' })
      .up.join('\n');
    expect(migration).toContain(
      '-- WARNING: Foreign-key constraint children.children_parent_id_parents_id_fkey',
    );
    expect(migration).toContain('requires a table rebuild');
    expect(mock.queries.some((sql) => sql.includes('orphan_key'))).toBe(false);
  });

  it('does not claim a noncanonical live PostgreSQL constraint was removed (#2504)', async () => {
    const sqliteOnlyChild = structuredClone(child);
    sqliteOnlyChild.foreignKeys[0].engines = ['sqlite'];
    if (!sqliteOnlyChild.columns.parent_id.foreignKey) {
      throw new Error('fixture foreign key missing');
    }
    sqliteOnlyChild.columns.parent_id.foreignKey.engines = ['sqlite'];
    const mock = postgresMock(false);
    // The live database uses a legacy name such as
    // `legacy_children_parent_fk`, but @happyvertical/sql currently returns
    // only this relationship tuple. The differ must not substitute SMRT's
    // canonical generated name and claim that the legacy constraint was
    // removed.
    mock.db.getTableSchema = async () => ({
      columns: {
        id: { name: 'id', type: 'text', primaryKey: true },
        parent_id: { name: 'parent_id', type: 'text' },
      },
      indexes: [],
      foreignKeys: [
        {
          column: 'parent_id',
          referencesTable: 'parents',
          referencesColumn: 'id',
          onDelete: 'NO ACTION',
          onUpdate: 'CASCADE',
        },
      ],
    });
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: sqliteOnlyChild });

    expect(diff.changes).toContainEqual(
      expect.objectContaining({
        type: 'drop_foreign_key',
        table: 'children',
        advisory: expect.objectContaining({
          message: expect.stringMatching(
            /does not expose the live PostgreSQL constraint name/,
          ),
        }),
      }),
    );
    const change = diff.changes.find(
      (candidate) => candidate.type === 'drop_foreign_key',
    );
    expect(change?.sql).toBeUndefined();
    expect(getSQLFromDiff(diff)).not.toContain('DROP CONSTRAINT');
    const migration = new MigrationGenerator({ engine: 'postgres' })
      .generateFromDiff(diff, { name: 'manual_disabled_postgres_fk' })
      .up.join('\n');
    expect(migration).toContain('-- WARNING: Foreign-key constraint');
    expect(migration).not.toContain('DROP CONSTRAINT');
    expect(mock.queries.some((sql) => sql.includes('constraint_name'))).toBe(
      false,
    );
  });

  it('probes the exact child/parent target before adding and validating on PostgreSQL', async () => {
    const mock = postgresMock(false);
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: child });
    const change = diff.changes.find(
      (candidate) => candidate.type === 'add_foreign_key',
    );

    const detector = mock.queries.find((sql) => sql.includes('orphan_key'));
    expect(detector).toContain(
      'FROM "children" AS "smrt_fk_child" LEFT JOIN "parents" AS "smrt_fk_parent"',
    );
    expect(detector).toContain(
      '"smrt_fk_parent"."id" = "smrt_fk_child"."parent_id"',
    );
    expect(change?.sqlStatements).toEqual([
      'ALTER TABLE "children" ADD CONSTRAINT "children_parent_id_parents_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID',
      'ALTER TABLE "children" VALIDATE CONSTRAINT "children_parent_id_parents_id_fkey"',
    ]);
  });

  it('casts a legacy text child only when both manifest FK columns are UUID', async () => {
    const uuidChild = structuredClone(child);
    uuidChild.columns.id.type = 'UUID';
    uuidChild.columns.parent_id.type = 'UUID';
    const uuidParent = schema('parents');
    uuidParent.columns.id.type = 'UUID';
    const mock = postgresMock(false);
    mock.db.getTableSchema = async (tableName: string) =>
      tableName === 'parents'
        ? {
            columns: {
              id: { name: 'id', type: 'uuid', primaryKey: true },
            },
            indexes: [],
            foreignKeys: [],
          }
        : {
            columns: {
              id: { name: 'id', type: 'text', primaryKey: true },
              parent_id: { name: 'parent_id', type: 'text' },
            },
            indexes: [],
            foreignKeys: [],
          };

    await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: uuidChild, parents: uuidParent });

    expect(mock.queries.find((sql) => sql.includes('orphan_key'))).toContain(
      '"smrt_fk_child"."parent_id"::text ~*',
    );
  });

  it('keeps a UUID-compatible text/text probe as a direct comparison', async () => {
    const uuidChild = structuredClone(child);
    uuidChild.columns.id.type = 'UUID';
    uuidChild.columns.parent_id.type = 'UUID';
    const uuidParent = schema('parents');
    uuidParent.columns.id.type = 'UUID';
    const mock = postgresMock(false);

    await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: uuidChild, parents: uuidParent });

    const detector = mock.queries.find((sql) => sql.includes('orphan_key'));
    expect(detector).toContain(
      '"smrt_fk_parent"."id" = "smrt_fk_child"."parent_id"',
    );
    expect(detector).not.toContain('::uuid');
  });

  it('keeps a direct comparison when the manifest target is non-UUID', async () => {
    const uuidChild = structuredClone(child);
    uuidChild.columns.parent_id.type = 'UUID';
    const mock = postgresMock(false);

    await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: uuidChild, parents: schema('parents') });

    expect(
      mock.queries.find((sql) => sql.includes('orphan_key')),
    ).not.toContain('::uuid');
  });

  it('refuses automatic add when an orphan exists and returns detector/repair guidance', async () => {
    const mock = postgresMock(true);
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: child });
    const change = diff.changes.find(
      (candidate) => candidate.type === 'add_foreign_key',
    );

    expect(change?.sqlStatements).toBeUndefined();
    expect(change?.advisory?.message).toMatch(/Repair them, then rerun/);
    expect(change?.advisory?.suggestedSql).toHaveLength(2);
    expect(change?.advisory?.suggestedSql?.[0]).toContain(
      'FROM "children" AS "smrt_fk_child" LEFT JOIN "parents" AS "smrt_fk_parent"',
    );
  });

  it('requires an explicit repair decision when its FK column is required', async () => {
    const requiredChild = structuredClone(child);
    requiredChild.columns.parent_id.notNull = true;
    const mock = postgresMock(true);
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: requiredChild });
    const change = diff.changes.find(
      (candidate) => candidate.type === 'add_foreign_key',
    );

    expect(change?.advisory?.suggestedSql?.[1]).toContain(
      '-- Manual repair required:',
    );
    expect(change?.advisory?.suggestedSql?.[1]).not.toContain('DELETE FROM');
  });

  it('refuses automatic add when a bare-array adapter result contains an orphan', async () => {
    const mock = postgresMock(false);
    const originalQuery = mock.db.query;
    mock.db.query = async (sql: string) => {
      if (sql.includes('orphan_key')) {
        return [{ orphan_key: 'missing-parent' }] as never;
      }
      return originalQuery(sql);
    };

    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: child });
    const change = diff.changes.find(
      (candidate) => candidate.type === 'add_foreign_key',
    );

    expect(change?.sqlStatements).toBeUndefined();
    expect(change?.advisory?.message).toMatch(/Repair them, then rerun/);
  });

  it('defers the orphan check when the FK column is added in the same PostgreSQL diff', async () => {
    const mock = postgresMock(false);
    mock.db.getTableSchema = async () => ({
      columns: {
        id: { name: 'id', type: 'text', primaryKey: true },
      },
      indexes: [],
      foreignKeys: [],
    });

    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: child });
    const foreignKey = diff.changes.find(
      (candidate) => candidate.type === 'add_foreign_key',
    );

    expect(diff.changes.some((change) => change.type === 'add_column')).toBe(
      true,
    );
    expect(mock.queries.some((sql) => sql.includes('orphan_key'))).toBe(false);
    expect(foreignKey?.sqlStatements).toEqual([
      'ALTER TABLE "children" ADD CONSTRAINT "children_parent_id_parents_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID',
      'ALTER TABLE "children" VALIDATE CONSTRAINT "children_parent_id_parents_id_fkey"',
    ]);
  });

  it('normalizes accepted manifest action spellings before live comparison', async () => {
    const mock = postgresMock(false);
    mock.db.getTableSchema = async () => ({
      columns: {
        id: { name: 'id', type: 'text', primaryKey: true },
        parent_id: { name: 'parent_id', type: 'text' },
      },
      indexes: [],
      foreignKeys: [
        {
          column: 'parent_id',
          referencesTable: 'parents',
          referencesColumn: 'id',
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
      ],
    });
    const legacyActions = structuredClone(child);
    legacyActions.foreignKeys[0].onDelete = 'set_null' as ForeignKeyAction;
    legacyActions.foreignKeys[0].onUpdate = 'cascade' as ForeignKeyAction;

    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: legacyActions });

    expect(
      diff.changes.some((change) => change.type === 'add_foreign_key'),
    ).toBe(false);
    expect(mock.queries.some((sql) => sql.includes('orphan_key'))).toBe(false);
  });

  it('rejects invalid manifest actions during live comparison', async () => {
    const mock = postgresMock(false);
    const invalid = structuredClone(child);
    invalid.foreignKeys[0].onDelete = 'surprise' as ForeignKeyAction;

    await expect(
      new SchemaComparer(mock.db as never, {
        engineHint: 'postgres',
      }).compare({ children: invalid }),
    ).rejects.toThrow(/Invalid foreign-key action/);
  });

  it('surfaces a failed PostgreSQL orphan probe instead of reporting orphan data', async () => {
    const mock = postgresMock(false);
    const query = mock.db.query;
    mock.db.query = async (sql: string) => {
      if (sql.includes('orphan_key')) {
        throw new Error('operator does not exist');
      }
      return query(sql);
    };

    await expect(
      new SchemaComparer(mock.db as never, {
        engineHint: 'postgres',
      }).compare({ children: child }),
    ).rejects.toThrow(
      /Cannot probe children\.parent_id for orphan rows.*operator does not exist/,
    );
  });
});

describe('PostgreSQL foreign-key provisioning across uuid/text drift (#2608)', () => {
  const foreignKey = {
    column: 'parent_id',
    referencesTable: 'parents',
    referencesColumn: 'id',
    onDelete: 'NO ACTION' as ForeignKeyAction,
    onUpdate: 'CASCADE' as ForeignKeyAction,
  };

  function driftMock(childType: string, parentType: string) {
    const queries: string[] = [];
    return {
      queries,
      db: {
        url: 'postgres://fixture/issue2608',
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        },
        getTableSchema: async (tableName: string) =>
          tableName === 'parents'
            ? {
                columns: {
                  id: { name: 'id', type: parentType, primaryKey: true },
                },
                indexes: [],
                foreignKeys: [],
              }
            : {
                columns: {
                  id: { name: 'id', type: childType, primaryKey: true },
                  parent_id: { name: 'parent_id', type: childType },
                },
                indexes: [],
                foreignKeys: [],
              },
      },
    };
  }

  it('refuses to add a constraint whose live child is uuid and parent is text', async () => {
    const mock = driftMock('uuid', 'text');
    const manager = new SchemaManager(mock.db as never, { engine: 'postgres' });

    await expect(
      manager.ensurePostgresForeignKey('children', foreignKey, {
        nullable: true,
        uuidComparison: true,
      }),
    ).rejects.toThrow(
      /Cannot add children_parent_id_parents_id_fkey: incompatible column types\. children\.parent_id is uuid but parents\.id is text; PostgreSQL cannot cast inside FOREIGN KEY DDL \(SQLSTATE 42804\)/,
    );

    expect(mock.queries.some((sql) => sql.includes('ADD CONSTRAINT'))).toBe(
      false,
    );
    expect(
      mock.queries.some((sql) => sql.includes('VALIDATE CONSTRAINT')),
    ).toBe(false);
    // Deliberate: the orphan probe is skipped. Across mismatched types it can
    // only answer a question about casted values, and it must be re-run after
    // the columns converge anyway.
    expect(mock.queries.some((sql) => sql.includes('orphan_key'))).toBe(false);
  });

  it('refuses the reverse drift and names the text side in the repair', async () => {
    const mock = driftMock('text', 'uuid');
    const manager = new SchemaManager(mock.db as never, { engine: 'postgres' });

    await expect(
      manager.ensurePostgresForeignKey('children', foreignKey, {
        nullable: true,
        uuidComparison: true,
      }),
    ).rejects.toThrow(
      /children\.parent_id is text but parents\.id is uuid.*ALTER TABLE "children" ALTER COLUMN "parent_id" TYPE uuid USING "parent_id"::uuid/s,
    );
    expect(mock.queries.some((sql) => sql.includes('ADD CONSTRAINT'))).toBe(
      false,
    );
  });

  it('still adds and validates a constraint when both live types agree', async () => {
    const mock = driftMock('uuid', 'uuid');
    const manager = new SchemaManager(mock.db as never, { engine: 'postgres' });

    await manager.ensurePostgresForeignKey('children', foreignKey, {
      nullable: true,
      uuidComparison: true,
    });

    expect(mock.queries.some((sql) => sql.includes('orphan_key'))).toBe(true);
    expect(
      mock.queries.some((sql) =>
        sql.includes(
          'ADD CONSTRAINT "children_parent_id_parents_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id")',
        ),
      ),
    ).toBe(true);
    expect(
      mock.queries.some((sql) => sql.includes('VALIDATE CONSTRAINT')),
    ).toBe(true);
  });

  it('keeps the pre-#2608 behaviour when live types cannot be introspected', async () => {
    const mock = driftMock('uuid', 'uuid');
    (mock.db as { getTableSchema?: unknown }).getTableSchema = undefined;
    const manager = new SchemaManager(mock.db as never, { engine: 'postgres' });

    await manager.ensurePostgresForeignKey('children', foreignKey, {
      nullable: true,
      uuidComparison: true,
    });

    expect(mock.queries.some((sql) => sql.includes('ADD CONSTRAINT'))).toBe(
      true,
    );
  });
});
