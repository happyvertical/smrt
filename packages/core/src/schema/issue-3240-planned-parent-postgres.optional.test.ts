import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaComparer } from '../migrations/differ.js';
import { collectStatementsFromDiff } from '../migrations/orchestrate.js';
import { MigrationTracker } from '../migrations/tracker.js';
import type { SchemaDefinition } from './types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;

function schemas(
  child: string,
  parent: string,
): Record<string, SchemaDefinition> {
  const base = {
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '3240',
  };
  return {
    [child]: {
      ...base,
      tableName: child,
      columns: {
        id: { type: 'UUID', primaryKey: true },
        parent_id: { type: 'UUID' },
      },
      foreignKeys: [
        {
          column: 'parent_id',
          referencesTable: parent,
          referencesColumn: 'id',
        },
      ],
      dependencies: [parent],
    },
    [parent]: {
      ...base,
      tableName: parent,
      columns: { id: { type: 'UUID', primaryKey: true } },
    },
  };
}

describe.skipIf(!pgUrl)('planned parent foreign-key preflight (#3240)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  async function tableSchema(tableName: string) {
    if (!db.getTableSchema) throw new Error('Expected schema introspection');
    return db.getTableSchema(tableName);
  }
  let child: string;
  let parent: string;
  let manifest: Record<string, SchemaDefinition>;

  beforeEach(async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    child = `i3240_children_${suffix}`;
    parent = `i3240_parents_${suffix}`;
    manifest = schemas(child, parent);
    db = await getDatabase({ type: 'postgres', url: pgUrl, dbid: suffix });
    await db.query(
      `CREATE TABLE "${child}" (id UUID PRIMARY KEY, parent_id UUID)`,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (!db) return;
    await db.query(`DROP TABLE IF EXISTS "${child}"`);
    await db.query(`DROP TABLE IF EXISTS "${parent}"`);
    await db.close?.();
  });

  async function apply(statements: string[]) {
    return new MigrationTracker({ db }).applyAll(
      [
        {
          id: `i3240_${randomUUID()}`,
          description: 'planned parent',
          version: '3240',
          up: statements,
          down: [],
        },
      ],
      { atomic: true },
    );
  }

  it('creates the parent before adding a validated FK to an empty existing child and converges', async () => {
    const comparer = new SchemaComparer(db);
    const diff = await comparer.compare(manifest);
    const statements = collectStatementsFromDiff(diff, db, 'postgres');
    expect(diff.added_tables.map((table) => table.tableName)).toEqual([parent]);
    const fk = diff.changes.find((change) => change.type === 'add_foreign_key');
    expect(fk?.sqlStatements).toHaveLength(2);
    expect(
      statements.findIndex((sql) =>
        sql.includes(`CREATE TABLE IF NOT EXISTS "${parent}"`),
      ),
    ).toBeLessThan(
      statements.findIndex((sql) => sql.includes('ADD CONSTRAINT')),
    );
    expect((await apply(statements)).every((result) => result.success)).toBe(
      true,
    );
    const id = randomUUID();
    await db.query(`INSERT INTO "${parent}" VALUES ($1)`, [id]);
    await db.query(`INSERT INTO "${child}" VALUES ($1, $2)`, [
      randomUUID(),
      id,
    ]);
    await expect(
      db.query(`INSERT INTO "${child}" VALUES ($1, $2)`, [
        randomUUID(),
        randomUUID(),
      ]),
    ).rejects.toThrow();
    expect(
      (await comparer.compare(manifest)).changes.filter(
        (change) => change.type === 'add_foreign_key',
      ),
    ).toEqual([]);
  });

  it('withholds the FK for nonempty children and preserves their data', async () => {
    const id = randomUUID();
    await db.query(`INSERT INTO "${child}" VALUES ($1, $2)`, [
      id,
      randomUUID(),
    ]);
    const diff = await new SchemaComparer(db).compare(manifest);
    const fk = diff.changes.find((change) => change.type === 'add_foreign_key');
    expect(fk?.sqlStatements).toBeUndefined();
    expect(fk?.advisory?.message).toMatch(
      /not empty.*planned|planned.*not empty/,
    );
    expect(fk?.orphanBlocked).not.toBe(true);
    expect((await db.query(`SELECT id FROM "${child}"`)).rows).toEqual([
      { id },
    ]);
    expect(await tableSchema(parent)).toBeNull();
  });

  it('rolls back parent creation and constraint addition if a writer inserts after preflight', async () => {
    const diff = await new SchemaComparer(db).compare(manifest);
    const id = randomUUID();
    await db.query(`INSERT INTO "${child}" VALUES ($1, $2)`, [
      id,
      randomUUID(),
    ]);
    const results = await apply(
      collectStatementsFromDiff(diff, db, 'postgres'),
    );
    expect(results.some((result) => !result.success)).toBe(true);
    expect(await tableSchema(parent)).toBeNull();
    expect((await tableSchema(child))?.foreignKeys ?? []).toEqual([]);
    expect((await db.query(`SELECT id FROM "${child}"`)).rows).toEqual([
      { id },
    ]);
  });

  it('does not reuse planned-parent authorization for standalone comparisons', async () => {
    const comparer = new SchemaComparer(db);
    await comparer.compare(manifest);
    await expect(
      comparer.compareTable(child, manifest[child], manifest),
    ).rejects.toThrow(/Cannot probe/);
    await expect(
      comparer.compare({ [child]: manifest[child] }),
    ).rejects.toThrow(/Cannot probe/);
  });

  it('fails closed when the empty-child probe fails', async () => {
    const original = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation((sql, ...args) => {
      if (sql === `SELECT 1 FROM "${child}" LIMIT 1`)
        return Promise.reject(new Error('probe unavailable'));
      return original(sql, ...args);
    });
    await expect(new SchemaComparer(db).compare(manifest)).rejects.toThrow(
      /probe unavailable/,
    );
    expect(await tableSchema(parent)).toBeNull();
  });

  it('retains type safety for an integer child pointing at a new UUID parent', async () => {
    await db.query(
      `ALTER TABLE "${child}" ALTER COLUMN parent_id TYPE INTEGER USING NULL`,
    );
    const diff = await new SchemaComparer(db).compare(manifest);
    const fk = diff.changes.find((change) => change.type === 'add_foreign_key');
    expect(fk?.sqlStatements).toBeUndefined();
    expect(fk?.advisory?.message).toMatch(/incompatible column types/);
  });

  it('accepts a live TIMESTAMPTZ child against a planned TIMESTAMP parent using its PostgreSQL DDL type', async () => {
    await db.query(
      `ALTER TABLE "${child}" ALTER COLUMN parent_id TYPE TIMESTAMPTZ USING NULL`,
    );
    manifest[child].columns.parent_id.type = 'TIMESTAMP';
    manifest[parent].columns.id.type = 'TIMESTAMP';
    const diff = await new SchemaComparer(db).compare(manifest);
    const fk = diff.changes.find((change) => change.type === 'add_foreign_key');
    expect(fk?.sqlStatements).toHaveLength(2);
    const statements = collectStatementsFromDiff(diff, db, 'postgres');
    expect(
      statements.some((sql) => sql.includes('TIMESTAMPTZ PRIMARY KEY')),
    ).toBe(true);
    expect((await apply(statements)).every((result) => result.success)).toBe(
      true,
    );
    const instant = '2026-09-30T20:00:00.000Z';
    await db.query(`INSERT INTO "${parent}" VALUES ($1)`, [instant]);
    await db.query(`INSERT INTO "${child}" VALUES ($1, $2)`, [
      randomUUID(),
      instant,
    ]);
    expect((await tableSchema(child))?.foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: 'parent_id',
          referencesTable: parent,
        }),
      ]),
    );
    expect((await new SchemaComparer(db).compare(manifest)).has_changes).toBe(
      false,
    );
  });

  it('withholds an incompatible INTEGER reference column being added against a planned UUID parent', async () => {
    await db.query(`ALTER TABLE "${child}" DROP COLUMN parent_id`);
    manifest[child].columns.parent_id.type = 'INTEGER';
    const diff = await new SchemaComparer(db).compare(manifest);
    const fk = diff.changes.find((change) => change.type === 'add_foreign_key');
    expect(fk?.sqlStatements).toBeUndefined();
    expect(fk?.advisory?.message).toMatch(/incompatible column types/);
    expect(fk?.advisory?.message).toMatch(/BIGINT/);
    const statements = collectStatementsFromDiff(diff, db, 'postgres');
    expect(
      statements.some((sql) => sql.includes('ADD COLUMN "parent_id" BIGINT')),
    ).toBe(true);
    expect(statements.some((sql) => sql.includes('ADD CONSTRAINT'))).toBe(
      false,
    );
    expect((await apply(statements)).every((result) => result.success)).toBe(
      true,
    );
    expect((await tableSchema(child))?.foreignKeys ?? []).toEqual([]);
    expect((await tableSchema(parent))?.columns.id.type.toUpperCase()).toBe(
      'UUID',
    );
  });

  it('blocks a planned parent with a missing target column', async () => {
    manifest[parent].columns = { other_id: { type: 'UUID', primaryKey: true } };
    const diff = await new SchemaComparer(db).compare(manifest);
    const fk = diff.changes.find((change) => change.type === 'add_foreign_key');
    expect(fk?.sqlStatements).toBeUndefined();
    expect(fk?.advisory?.message).toMatch(/has no column id/);
  });

  it('does not bypass emptiness proof for a newly added child column with a default', async () => {
    await db.query(`ALTER TABLE "${child}" DROP COLUMN parent_id`);
    await db.query(`INSERT INTO "${child}" VALUES ($1)`, [randomUUID()]);
    manifest[child].columns.parent_id.defaultValue = randomUUID();
    const diff = await new SchemaComparer(db).compare(manifest);
    const fk = diff.changes.find((change) => change.type === 'add_foreign_key');
    expect(fk?.sqlStatements).toBeUndefined();
    expect(fk?.advisory?.message).toMatch(/not empty/);
  });

  it('allows an empty child with a newly added reference column', async () => {
    await db.query(`ALTER TABLE "${child}" DROP COLUMN parent_id`);
    const diff = await new SchemaComparer(db).compare(manifest);
    expect(
      (await apply(collectStatementsFromDiff(diff, db, 'postgres'))).every(
        (result) => result.success,
      ),
    ).toBe(true);
  });

  it('keeps the old-target FK refusal before planned-parent preflight', async () => {
    await db.query(
      `ALTER TABLE "${child}" ADD CONSTRAINT old_parent FOREIGN KEY (parent_id) REFERENCES "${child}" (id)`,
    );
    const diff = await new SchemaComparer(db).compare(manifest);
    const fk = diff.changes.find((change) => change.type === 'add_foreign_key');
    expect(fk?.sqlStatements).toBeUndefined();
    expect(fk?.advisory?.message).toMatch(/different target or action/);
  });
});

describe.each([
  'sqlite',
  'duckdb',
  'json',
] as const)('planned parent on %s (#3240)', (engine) => {
  it('retains the unsupported existing-table ALTER refusal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-3240-'));
    const db = await getDatabase({
      type: engine,
      url: engine === 'json' ? directory : ':memory:',
    });
    try {
      await db.query(
        'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT)',
      );
      if (engine === 'json')
        await db.insert('children', {
          id: randomUUID(),
          parent_id: randomUUID(),
        });
      const diff = await new SchemaComparer(db, { engineHint: engine }).compare(
        schemas('children', 'parents'),
      );
      const fk = diff.changes.find(
        (change) => change.type === 'add_foreign_key',
      );
      // The JSON adapter does not expose getTableSchema, so it cannot
      // inspect an existing constraint; SQLite/DuckDB report the refusal.
      if (engine === 'json') expect(fk).toBeUndefined();
      else expect(fk?.engineUnsupported).toBe(true);
      expect(fk?.sqlStatements).toBeUndefined();
    } finally {
      await db.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
