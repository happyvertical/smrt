import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { SchemaComparer } from '../migrations/differ.js';
import { MigrationGenerator } from '../migrations/generator.js';
import { resolveTestDatabaseDDLEngine } from '../testing/database.js';
import { generateDDLForEngine } from './ddl/index.js';
import {
  foreignKeyConstraintName,
  renderForeignKeyConstraint,
  schemaForeignKeys,
} from './foreign-key-ddl.js';
import { planForeignKeyCreation } from './foreign-key-planner.js';
import { resolveForeignKeyDeleteAction } from './foreign-key-policy.js';
import { identifierByteLength, MAX_IDENTIFIER_BYTES } from './index-utils.js';
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

  it('probes the exact child/parent target before adding and validating on PostgreSQL', async () => {
    const mock = postgresMock(false);
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare({ children: child });
    const change = diff.changes.find(
      (candidate) => candidate.type === 'add_foreign_key',
    );

    expect(mock.queries.find((sql) => sql.includes('orphan_key'))).toContain(
      'FROM "children" LEFT JOIN "parents" ON "parents"."id" = "children"."parent_id"',
    );
    expect(change?.sqlStatements).toEqual([
      'ALTER TABLE "children" ADD CONSTRAINT "children_parent_id_parents_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID',
      'ALTER TABLE "children" VALIDATE CONSTRAINT "children_parent_id_parents_id_fkey"',
    ]);
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
      'FROM "children" LEFT JOIN "parents"',
    );
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
});
