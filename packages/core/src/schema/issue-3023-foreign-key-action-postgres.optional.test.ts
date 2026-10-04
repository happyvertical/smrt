/**
 * PostgreSQL coverage for #3023: `db:migrate` converges a framework-owned
 * foreign key whose ON DELETE action drifted from the manifest, inside one
 * transaction, and leaves an operator-named constraint alone.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` (or `DATABASE_URL`) is set.
 */
import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaComparer } from '../migrations/differ.js';
import { MigrationTracker } from '../migrations/tracker.js';
import { foreignKeyConstraintName } from './foreign-key-ddl.js';
import type { ForeignKeyAction, SchemaDefinition } from './types.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
const parents = `i3023_parents_${suffix}`;
const owned = `i3023_owned_${suffix}`;
const legacy = `i3023_legacy_${suffix}`;
const tracked = `i3023_tracked_${suffix}`;

function parentSchema(): SchemaDefinition {
  return {
    tableName: parents,
    columns: { id: { type: 'UUID', primaryKey: true } },
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '3023',
  };
}

function childSchema(
  tableName: string,
  onDelete: ForeignKeyAction,
): SchemaDefinition {
  return {
    tableName,
    columns: {
      id: { type: 'UUID', primaryKey: true },
      parent_id: {
        type: 'UUID',
        notNull: true,
        foreignKey: {
          table: parents,
          column: 'id',
          onDelete,
          onUpdate: 'CASCADE',
        },
      },
    },
    indexes: [],
    triggers: [],
    foreignKeys: [
      {
        column: 'parent_id',
        referencesTable: parents,
        referencesColumn: 'id',
        onDelete,
        onUpdate: 'CASCADE',
      },
    ],
    dependencies: [parents],
    version: '3023',
  };
}

describe.skipIf(!pgUrl)('ON DELETE convergence on PostgreSQL (#3023)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  const ownedName = foreignKeyConstraintName(owned, {
    column: 'parent_id',
    referencesTable: parents,
    referencesColumn: 'id',
  });

  async function deleteRule(table: string): Promise<string | undefined> {
    const result = await db.query(
      `SELECT confdeltype FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'`,
      [table],
    );
    return result.rows?.[0]?.confdeltype;
  }

  async function foreignKeyChange(table: string) {
    const diff = await new SchemaComparer(db as never, {
      engineHint: 'postgres',
    }).compare({
      [parents]: parentSchema(),
      [table]: childSchema(table, 'NO ACTION'),
    });
    return diff.changes.filter(
      (change) => change.type === 'add_foreign_key' && change.table === table,
    );
  }

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-3023-${randomUUID()}`,
      max: 2,
    } as Parameters<typeof getDatabase>[0]);
    await db.query(`CREATE TABLE "${parents}" (id UUID PRIMARY KEY)`);
    for (const [table, name] of [
      [owned, ownedName],
      [legacy, `${legacy}_parent_fk`],
      [
        tracked,
        foreignKeyConstraintName(tracked, {
          column: 'parent_id',
          referencesTable: parents,
          referencesColumn: 'id',
        }),
      ],
    ]) {
      await db.query(
        `CREATE TABLE "${table}" (id UUID PRIMARY KEY, parent_id UUID NOT NULL, ` +
          `CONSTRAINT "${name}" FOREIGN KEY (parent_id) REFERENCES "${parents}" (id) ON DELETE CASCADE ON UPDATE CASCADE)`,
      );
    }
    const parentId = randomUUID();
    await db.query(`INSERT INTO "${parents}" (id) VALUES ($1)`, [parentId]);
    await db.query(`INSERT INTO "${owned}" (id, parent_id) VALUES ($1, $2)`, [
      randomUUID(),
      parentId,
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP TABLE IF EXISTS "${owned}"`);
    await db.query(`DROP TABLE IF EXISTS "${legacy}"`);
    await db.query(`DROP TABLE IF EXISTS "${tracked}"`);
    await db
      .query(`DELETE FROM _smrt_migrations WHERE name LIKE 'i3023_%'`)
      .catch(() => undefined);
    await db.query(`DROP TABLE IF EXISTS "${parents}"`);
    await db.close?.();
  });

  it('replaces the owned constraint in one transaction and converges', async () => {
    expect(await deleteRule(owned)).toBe('c');
    const [change, ...rest] = await foreignKeyChange(owned);
    expect(rest).toHaveLength(0);
    expect(change?.advisory).toBeUndefined();
    expect(change?.note).toMatch(/ON DELETE CASCADE → NO ACTION/);

    await db.query('BEGIN');
    try {
      for (const statement of change?.sqlStatements ?? []) {
        await db.query(statement);
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }

    expect(await deleteRule(owned)).toBe('a');
    const names = await db.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'`,
      [owned],
    );
    expect(names.rows?.map((row) => row.conname as string)).toEqual([
      ownedName,
    ]);
    expect(await foreignKeyChange(owned)).toHaveLength(0);
  });

  it.each([
    // CASCADE (seeded) → NO ACTION under --postgres-safe, then back to
    // CASCADE in atomic mode.
    ['--postgres-safe', { atomic: true, postgresSafe: true }],
    ['atomic', { atomic: true }],
  ] as const)('converges through MigrationTracker.applyAll (%s), validating before the swap', async (mode, options) => {
    const target = mode === 'atomic' ? 'CASCADE' : 'NO ACTION';
    const diff = await new SchemaComparer(db as never, {
      engineHint: 'postgres',
    }).compare({
      [parents]: parentSchema(),
      [tracked]: childSchema(tracked, target),
    });
    const [change] = diff.changes.filter(
      (candidate) =>
        candidate.type === 'add_foreign_key' && candidate.table === tracked,
    );
    if (mode === 'atomic') {
      // NO ACTION/SET NULL → CASCADE is applied, but never silently.
      expect(change?.advisory?.severity).toBe('warning');
    }
    const statements = change?.sqlStatements ?? [];
    expect(statements).toHaveLength(4);
    const tracker = new MigrationTracker({ db: db as never });
    const results = await tracker.applyAll(
      [
        {
          id: `i3023_${mode.replace(/\W/g, '')}_${suffix}`,
          description: 'replace fk',
          version: '1.0.0',
          up: statements,
          down: [],
        },
      ],
      options,
    );
    expect(results.map((result) => result.error).filter(Boolean)).toEqual([]);
    const constraints = await db.query(
      `SELECT conname, convalidated, confdeltype FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'`,
      [tracked],
    );
    expect(constraints.rows).toHaveLength(1);
    expect(constraints.rows?.[0]?.convalidated).toBe(true);
    expect(constraints.rows?.[0]?.confdeltype).toBe(
      target === 'CASCADE' ? 'c' : 'a',
    );
    const again = await new SchemaComparer(db as never, {
      engineHint: 'postgres',
    }).compare({
      [parents]: parentSchema(),
      [tracked]: childSchema(tracked, target),
    });
    expect(
      again.changes.filter(
        (candidate) =>
          candidate.type === 'add_foreign_key' && candidate.table === tracked,
      ),
    ).toHaveLength(0);
  });

  it('leaves an operator-named constraint as a manual step', async () => {
    const [change] = await foreignKeyChange(legacy);
    expect(change?.sqlStatements).toBeUndefined();
    expect(change?.advisory?.message).toMatch(
      /exists with a different target or action/,
    );
    expect(await deleteRule(legacy)).toBe('c');
  });
});
