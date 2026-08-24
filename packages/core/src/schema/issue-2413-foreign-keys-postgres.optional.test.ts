import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationGenerator } from '../migrations/generator.js';
import { generateDDLForEngine } from './ddl/index.js';
import { foreignKeyConstraintName } from './foreign-key-ddl.js';
import { SchemaManager } from './schema-manager.js';
import type { SchemaDefinition } from './types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
const parents = `i2413_parents_${suffix}`;
const children = `i2413_children_${suffix}`;
const cycleLeft = `i2413_cycle_left_${suffix}`;
const cycleRight = `i2413_cycle_right_${suffix}`;
const managerLeft = `I2413_Manager_Left_${suffix}`;
const managerRight = `I2413_Manager_Right_${suffix}`;

function schema(
  tableName: string,
  foreignKey?: SchemaDefinition['foreignKeys'][number],
): SchemaDefinition {
  return {
    tableName,
    columns: {
      id: { type: 'UUID', primaryKey: true },
      ...(foreignKey
        ? {
            [foreignKey.column]: {
              type: 'UUID' as const,
              foreignKey: {
                table: foreignKey.referencesTable,
                column: foreignKey.referencesColumn,
                onDelete: foreignKey.onDelete,
                onUpdate: foreignKey.onUpdate,
              },
            },
          }
        : {}),
    },
    indexes: [],
    triggers: [],
    foreignKeys: foreignKey ? [foreignKey] : [],
    dependencies: foreignKey ? [foreignKey.referencesTable] : [],
    version: '2413',
  };
}

describe.skipIf(!pgUrl)('database foreign keys on PostgreSQL (#2413)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2413-${randomUUID()}`,
      max: 2,
    } as Parameters<typeof getDatabase>[0]);
    await db.query(
      generateDDLForEngine(schema(parents), 'postgres').createTable,
    );
    await db.query(
      generateDDLForEngine(
        schema(children, {
          column: 'parent_id',
          referencesTable: parents,
          referencesColumn: 'id',
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        }),
        'postgres',
      ).createTable,
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP TABLE IF EXISTS "${cycleLeft}" CASCADE`);
    await db.query(`DROP TABLE IF EXISTS "${cycleRight}" CASCADE`);
    await db.query(`DROP TABLE IF EXISTS "${managerLeft}" CASCADE`);
    await db.query(`DROP TABLE IF EXISTS "${managerRight}" CASCADE`);
    await db.query(`DROP TABLE IF EXISTS "${children}"`);
    await db.query(`DROP TABLE IF EXISTS "${parents}"`);
    await db.close?.();
  });

  it('creates the named constraint and cascades independently of the model layer', async () => {
    const foreignKey = {
      column: 'parent_id',
      referencesTable: parents,
      referencesColumn: 'id',
      onDelete: 'CASCADE' as const,
      onUpdate: 'CASCADE' as const,
    };
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.query(`INSERT INTO "${parents}" (id) VALUES ($1)`, [parentId]);
    await db.query(
      `INSERT INTO "${children}" (id, parent_id) VALUES ($1, $2)`,
      [childId, parentId],
    );
    await db.query(`DELETE FROM "${parents}" WHERE id = $1`, [parentId]);

    expect(await db.count(children, { id: childId })).toBe(0);
    const result = await db.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'`,
      [children],
    );
    expect(result.rows?.[0]?.conname).toBe(
      foreignKeyConstraintName(children, foreignKey),
    );
  });

  it('applies and rolls back a mutual cycle with deferred constraints', async () => {
    const left = schema(cycleLeft, {
      column: 'right_id',
      referencesTable: cycleRight,
      referencesColumn: 'id',
      onDelete: 'NO ACTION',
      onUpdate: 'CASCADE',
    });
    const right = schema(cycleRight, {
      column: 'left_id',
      referencesTable: cycleLeft,
      referencesColumn: 'id',
      onDelete: 'NO ACTION',
      onUpdate: 'CASCADE',
    });
    const migration = new MigrationGenerator({
      engine: 'postgres',
    }).generateFromDiff(
      {
        has_changes: true,
        added_tables: [right, left],
        dropped_tables: [],
        changes: [],
      },
      { name: 'issue_2413_postgres_cycle' },
    );

    for (const statement of migration.up) await db.query(statement);
    const constraints = await db.query(
      `SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid IN ($1::regclass, $2::regclass) AND contype = 'f'`,
      [cycleLeft, cycleRight],
    );
    expect(Number(constraints.rows?.[0]?.count)).toBe(2);

    for (const statement of migration.down) await db.query(statement);
    const remaining = await db.query(
      `SELECT to_regclass($1) AS left_table, to_regclass($2) AS right_table`,
      [cycleLeft, cycleRight],
    );
    expect(remaining.rows?.[0]).toMatchObject({
      left_table: null,
      right_table: null,
    });
  });

  it('creates deferred cycle constraints idempotently through SchemaManager', async () => {
    const left = schema(managerLeft, {
      column: 'right_id',
      referencesTable: managerRight,
      referencesColumn: 'id',
      onDelete: 'NO ACTION',
      onUpdate: 'CASCADE',
    });
    const right = schema(managerRight, {
      column: 'left_id',
      referencesTable: managerLeft,
      referencesColumn: 'id',
      onDelete: 'NO ACTION',
      onUpdate: 'CASCADE',
    });
    const manager = new SchemaManager(db, { engine: 'postgres' });

    await manager.ensureTables([right, left]);
    await manager.ensureTables([right, left]);

    const constraints = await db.query(
      `SELECT count(*)::int AS count FROM pg_constraint AS constraint_row JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid WHERE table_row.relname IN ($1, $2) AND constraint_row.contype = 'f'`,
      [managerLeft, managerRight],
    );
    expect(Number(constraints.rows?.[0]?.count)).toBe(2);
  });
});
