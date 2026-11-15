/**
 * P22 (#4927), second review: a run limited to tables may only add to a table
 * the build owns, so the guard judges every effect a change carries, not only
 * its kind. Two ways a removal hid behind an additive kind:
 *
 * 1. SQLite folds a relaxation into the rebuild that adds a backfilled column;
 *    the relaxation itself is reported as `column.rebuild-covered`.
 * 2. `foreign-key.add` also replaces a key (PostgreSQL DROP/ADD, a rebuild on
 *    SQLite and DuckDB).
 *
 * SQLite and DuckDB run here; PostgreSQL runs on PGlite under `test:pglite`.
 */
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { foreignKeyConstraintName } from '../../schema/foreign-key-ddl.js';
import { inspectTableSchema } from '../../schema/inspection.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { getTestDatabase } from '../../testing/database.js';
import { registerBuildSchema } from '../build-schema.js';
import { migrateSmrtSchemas } from '../orchestrate.js';

type Engine = 'sqlite' | 'duckdb' | 'postgres';
const ENGINES: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['postgres'] : ['sqlite', 'duckdb'];

const table = (
  tableName: string,
  columns: SchemaDefinition['columns'],
  extra: Partial<SchemaDefinition> = {},
): SchemaDefinition => ({
  tableName,
  columns: {
    id: { type: 'TEXT', primaryKey: true, notNull: true },
    ...columns,
  },
  indexes: [],
  foreignKeys: [],
  triggers: [],
  dependencies: [],
  version: '',
  ...extra,
});

describe.each(
  ENGINES,
)('table-limited runs on %s: hidden removals', (engine) => {
  let db: DatabaseInterface;
  let run = 0;
  beforeEach(async () => {
    db =
      engine === 'postgres'
        ? await getTestDatabase({
            type: 'pglite',
            classes: [],
            includeSystemTables: false,
          })
        : await getDatabase({ type: engine, url: ':memory:' });
    registerBuildSchema({
      fingerprint: 'stamp',
      tables: { items: ['@app/a'], parents: ['@app/a'], others: ['@app/a'] },
      packages: ['@app/a'],
      source: 'registered',
    });
  });
  afterEach(async () => {
    registerBuildSchema(undefined);
    vi.restoreAllMocks();
    await db.close?.();
  });

  const registry = (schemas: Record<string, SchemaDefinition>) =>
    vi
      .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
      .mockReturnValue(schemas);
  const migrate = (tables: string[]) =>
    migrateSmrtSchemas({
      db,
      packageName: '@app/a',
      engineHint: engine,
      name: `hidden_${engine}_${++run}`,
      tables,
      relaxColumns: true,
      ...(engine === 'postgres'
        ? { atomic: true, postgresSafe: false, useConcurrentIndexes: false }
        : {}),
    });
  const columns = async (name: string) =>
    (await inspectTableSchema(db, name, engine))?.columns ?? {};

  it('refuses a backfilled column add that carries a relaxation of a build column', async () => {
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, a TEXT NOT NULL)',
    );
    await db.query("INSERT INTO items (id, a) VALUES ('one', 'kept')");
    registry({
      items: table('items', {
        a: { type: 'TEXT' },
        b: { type: 'TEXT', notNull: true, backfill: "'filled'" },
      }),
    });
    const result = await migrate(['items']);
    expect(result).toMatchObject({ applied: false, refused: true });
    expect(result.stops.some((stop) => stop.reason === 'build-table')).toBe(
      true,
    );
    const after = await columns('items');
    expect(after.a?.notNull).toBe(true);
    expect(after).not.toHaveProperty('b');
  });

  it('refuses replacing a foreign key on a build table', async () => {
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY NOT NULL)');
    await db.query('CREATE TABLE others (id TEXT PRIMARY KEY NOT NULL)');
    // Named as smrt names its keys, so PostgreSQL takes the in-place
    // replacement path (DROP and ADD under foreign-key.add, #3023) for an
    // action change. DuckDB has no CASCADE, so there the key changes target
    // and the rebuild replaces it; SQLite takes the action change by rebuild.
    const name = foreignKeyConstraintName('items', {
      column: 'parent_id',
      referencesTable: 'parents',
      referencesColumn: 'id',
    });
    const action = engine === 'duckdb' ? '' : ' ON DELETE CASCADE';
    await db.query(
      `CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT, CONSTRAINT ${name} FOREIGN KEY (parent_id) REFERENCES parents(id)${action})`,
    );
    registry({
      parents: table('parents', {}),
      others: table('others', {}),
      items: table(
        'items',
        { parent_id: { type: 'TEXT' } },
        {
          foreignKeys: [
            {
              column: 'parent_id',
              referencesTable: engine === 'duckdb' ? 'others' : 'parents',
              referencesColumn: 'id',
              onDelete: 'NO ACTION',
            },
          ],
        },
      ),
    });
    const before = (await inspectTableSchema(db, 'items', engine))?.foreignKeys;
    const result = await migrate(['items']);
    expect(result).toMatchObject({ applied: false, refused: true });
    const after = (await inspectTableSchema(db, 'items', engine))?.foreignKeys;
    expect(after).toEqual(before);
    if (engine === 'duckdb') {
      // The adapter's inspector lists no DuckDB foreign keys; read the catalog.
      const { rows } = await db.query(
        "SELECT constraint_text FROM duckdb_constraints() WHERE table_name = 'items' AND constraint_type = 'FOREIGN KEY'",
      );
      expect(rows.map((row) => String(row.constraint_text))).toEqual([
        expect.stringContaining('parents'),
      ]);
    } else {
      expect(after?.[0]?.referencesTable).toBe('parents');
    }
  });

  it('still adds a nullable column and an index to a build table', async () => {
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, a TEXT NOT NULL)',
    );
    registry({
      items: table(
        'items',
        { a: { type: 'TEXT', notNull: true }, note: { type: 'TEXT' } },
        { indexes: [{ name: 'idx_items_a', columns: ['a'] }] },
      ),
    });
    const result = await migrate(['items']);
    expect(result).toMatchObject({ refused: false });
    const after = await columns('items');
    expect(after).toHaveProperty('note');
    expect(after.a?.notNull).toBe(true);
  });

  it('still creates a missing build table', async () => {
    registry({ items: table('items', { a: { type: 'TEXT', notNull: true } }) });
    const result = await migrate(['items']);
    expect(result).toMatchObject({ applied: true, refused: false });
    expect(await columns('items')).toHaveProperty('a');
  });
});
