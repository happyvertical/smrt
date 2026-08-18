/**
 * Issue #2369 — PostgreSQL lane for nullability/default drift, orphan NOT NULL
 * relax, and executable ADD COLUMN on populated tables.
 *
 * Runs only in the dedicated disposable PostgreSQL shard
 * (`pnpm test:postgres`, SMRT_TEST_POSTGRES_URL set by
 * scripts/run-with-ci-postgres.mjs). SQLite masks the engine-specific
 * renderings this exercises (`'x'::text`, `CURRENT_TIMESTAMP`, jsonb casts,
 * `column contains null values`).
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import type { SchemaDefinition } from '../../schema/types.js';
import {
  getSQLFromDiff,
  isAdvisoryOnlyChange,
  SchemaComparer,
} from '../differ.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

const PREFIX = `i2369_${randomUUID().slice(0, 8)}`;
const T = (name: string) => `${PREFIX}_${name}`;

function schema(
  tableName: string,
  columns: SchemaDefinition['columns'],
  indexes: SchemaDefinition['indexes'] = [],
): SchemaDefinition {
  return {
    tableName,
    ddl: '',
    columns,
    indexes,
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '1.0.0',
  };
}

postgresDescribe(
  'SchemaComparer column drift on real PostgreSQL (#2369)',
  () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;
    const created: string[] = [];

    beforeAll(async () => {
      db = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2369-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0]);
    });

    afterEach(async () => {
      for (const table of created.splice(0)) {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
      }
    });

    afterAll(async () => {
      await db.close?.();
    });

    async function create(sql: string, table: string) {
      created.push(table);
      await db.query(sql);
    }

    async function apply(statements: string[]) {
      for (const sql of statements) {
        await db.query(sql);
      }
    }

    const compare = (
      manifest: Record<string, SchemaDefinition>,
      options: ConstructorParameters<typeof SchemaComparer>[1] = {},
    ) => new SchemaComparer(db, options).compare(manifest);

    it('round-trips a strategy-created table with zero drift (jsonb/timestamptz/boolean/uuid defaults)', async () => {
      const table = T('widgets');
      const def = schema(
        table,
        {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          slug: { type: 'TEXT', notNull: true },
          context: { type: 'TEXT', notNull: true, defaultValue: '' },
          created_at: {
            type: 'TIMESTAMP',
            notNull: true,
            defaultValue: 'current_timestamp',
          },
          updated_at: {
            type: 'TIMESTAMP',
            notNull: true,
            defaultValue: 'current_timestamp',
          },
          name: { type: 'TEXT', defaultValue: 'anon' },
          count: { type: 'INTEGER', defaultValue: -1 },
          ratio: { type: 'REAL', defaultValue: 0.5 },
          active: { type: 'BOOLEAN', defaultValue: true },
          meta: { type: 'JSON', defaultValue: {} },
          tags: { type: 'JSON', defaultValue: [] },
          owner_id: { type: 'UUID', referenceKind: 'foreignKey' },
          email: { type: 'TEXT', unique: true },
          note: { type: 'TEXT' },
        },
        [
          {
            name: `${table}_slug_context_idx`,
            columns: ['slug', 'context'],
            unique: true,
          },
        ],
      );
      const strategy = getDDLStrategy('postgres');
      await create(strategy.generateCreateTable(def), table);
      await apply(strategy.generateIndexes(def));

      const diff = await compare(
        { [table]: def },
        { includeDroppedIndexes: true },
      );
      expect(diff.changes).toEqual([]);
      expect(diff.has_changes).toBe(false);
    });

    it('repairs nullability and default drift in place (backfill + SET NOT NULL, SET DEFAULT) and re-diffs clean', async () => {
      const table = T('items');
      await create(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, status TEXT, meta JSONB, kind TEXT DEFAULT 'a', hits INTEGER)`,
        table,
      );
      await db.query(
        `INSERT INTO "${table}" (id, status, hits) VALUES ('i1', NULL, 3), ('i2', 'live', 4)`,
      );
      const manifest = {
        [table]: schema(table, {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          status: { type: 'TEXT', notNull: true, defaultValue: 'draft' },
          meta: { type: 'JSON', defaultValue: {} },
          kind: { type: 'TEXT', defaultValue: 'b' },
          hits: { type: 'INTEGER', notNull: true },
        }),
      };

      const diff = await compare(manifest);
      expect(getSQLFromDiff(diff)).toEqual([
        `ALTER TABLE "${table}" ALTER COLUMN "status" SET DEFAULT 'draft'`,
        `UPDATE "${table}" SET "status" = 'draft' WHERE "status" IS NULL`,
        `ALTER TABLE "${table}" ALTER COLUMN "status" SET NOT NULL`,
        `ALTER TABLE "${table}" ALTER COLUMN "meta" SET DEFAULT '{}'::jsonb`,
        `ALTER TABLE "${table}" ALTER COLUMN "kind" SET DEFAULT 'b'`,
        `ALTER TABLE "${table}" ALTER COLUMN "hits" SET NOT NULL`,
      ]);
      await apply(getSQLFromDiff(diff));

      await db.query(`INSERT INTO "${table}" (id, hits) VALUES ('i3', 5)`);
      const rows = (
        await db.query(
          `SELECT id, status, meta::text AS meta, kind FROM "${table}" ORDER BY id`,
        )
      ).rows as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.status)).toEqual(['draft', 'live', 'draft']);
      expect(rows[2].meta).toBe('{}');
      expect(rows[2].kind).toBe('b');
      expect((await compare(manifest)).changes).toEqual([]);
    });

    it('reports (does not emit) SET NOT NULL when live NULLs exist and there is no default to backfill', async () => {
      const table = T('nulls');
      await create(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, owner_id TEXT)`,
        table,
      );
      await db.query(
        `INSERT INTO "${table}" (id, owner_id) VALUES ('i1', NULL)`,
      );
      const manifest = {
        [table]: schema(table, {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          owner_id: { type: 'TEXT', notNull: true },
        }),
      };
      const diff = await compare(manifest);
      expect(diff.changes).toEqual([
        expect.objectContaining({
          type: 'alter_column',
          alteration: 'set_not_null',
          advisory: expect.objectContaining({ severity: 'warning' }),
        }),
      ]);
      expect(getSQLFromDiff(diff).filter((s) => !s.startsWith('--'))).toEqual(
        [],
      );

      // Backfill, rerun: now executable and applied.
      await db.query(
        `UPDATE "${table}" SET owner_id = 'o1' WHERE owner_id IS NULL`,
      );
      const after = await compare(manifest);
      expect(getSQLFromDiff(after)).toEqual([
        `ALTER TABLE "${table}" ALTER COLUMN "owner_id" SET NOT NULL`,
      ]);
      await apply(getSQLFromDiff(after));
      expect((await compare(manifest)).changes).toEqual([]);
    });

    it('adds required (with default) and unique columns to a populated table on PostgreSQL', async () => {
      const table = T('adds');
      await create(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, name TEXT)`,
        table,
      );
      await db.query(
        `INSERT INTO "${table}" (id, name) VALUES ('a', 'x'), ('b', 'y')`,
      );
      const manifest = {
        [table]: schema(table, {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          name: { type: 'TEXT' },
          status: { type: 'TEXT', notNull: true, defaultValue: 'draft' },
          email: { type: 'TEXT', unique: true },
          meta: { type: 'JSON', notNull: true, defaultValue: {} },
        }),
      };
      const diff = await compare(manifest);
      expect(getSQLFromDiff(diff)).toEqual([
        `ALTER TABLE "${table}" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft'`,
        `ALTER TABLE "${table}" ADD COLUMN "email" TEXT UNIQUE`,
        `ALTER TABLE "${table}" ADD COLUMN "meta" JSONB NOT NULL DEFAULT '{}'`,
      ]);
      await apply(getSQLFromDiff(diff));
      await db.query(`INSERT INTO "${table}" (id, email) VALUES ('c', 'c@x')`);
      await expect(
        db.query(`INSERT INTO "${table}" (id, email) VALUES ('d', 'c@x')`),
      ).rejects.toThrow();
      // `<table>_email_key` is the constraint index: claimed by the unique
      // column, never reported or dropped.
      expect(
        (await compare(manifest, { includeDroppedIndexes: true })).changes,
      ).toEqual([]);
    });

    it('adds a required column without a default nullable on a populated table and reports the follow-up', async () => {
      const table = T('req');
      await create(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY)`, table);
      await db.query(`INSERT INTO "${table}" (id) VALUES ('a')`);
      const manifest = {
        [table]: schema(table, {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          owner_id: {
            type: 'UUID',
            notNull: true,
            referenceKind: 'foreignKey',
          },
        }),
      };
      const diff = await compare(manifest);
      expect(
        diff.changes.map((c) => `${c.type}:${c.alteration ?? ''}`),
      ).toEqual(['add_column:', 'alter_column:set_not_null']);
      const executable = getSQLFromDiff(diff).filter(
        (s) => !s.startsWith('--'),
      );
      expect(executable).toEqual([
        `ALTER TABLE "${table}" ADD COLUMN "owner_id" uuid`,
      ]);
      await apply(executable);
      // Still insertable through the model layer; the NOT NULL is reported until backfilled.
      await db.query(`INSERT INTO "${table}" (id) VALUES ('b')`);
      const after = await compare(manifest);
      expect(after.changes.map((c) => c.type)).toEqual(['alter_column']);
      expect(after.changes[0].advisory?.severity).toBe('warning');
    });

    it('rename-required-field scenario: orphan NOT NULL is warned, relaxed with relaxColumns, and inserts keep working', async () => {
      const table = T('posts');
      await create(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, title TEXT NOT NULL)`,
        table,
      );
      await db.query(`INSERT INTO "${table}" (id, title) VALUES ('p1', 'old')`);
      const manifest = {
        [table]: schema(table, {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          headline: { type: 'TEXT', notNull: true, defaultValue: '' },
        }),
      };

      const reportOnly = await compare(manifest);
      expect(reportOnly.changes.map((c) => c.type)).toEqual([
        'add_column',
        'orphan_column',
      ]);
      expect(reportOnly.changes[1].advisory?.severity).toBe('warning');
      expect(reportOnly.changes[1].advisory?.suggestedSql).toEqual([
        `ALTER TABLE "${table}" ALTER COLUMN "title" DROP NOT NULL`,
        `ALTER TABLE "${table}" DROP COLUMN "title"`,
      ]);
      // Without the flag the orphan is untouched: an ORM insert (which never
      // supplies `title`) fails with 23502 after the add.
      await apply(getSQLFromDiff(reportOnly));
      // (the SDK wraps the 23502 as a generic DatabaseError — E1 in the epic —
      // so only the rejection itself is asserted here)
      await expect(
        db.query(`INSERT INTO "${table}" (id, headline) VALUES ('p2', 'new')`),
      ).rejects.toThrow();

      const relaxed = await compare(manifest, { relaxColumns: true });
      expect(getSQLFromDiff(relaxed)).toEqual([
        `ALTER TABLE "${table}" ALTER COLUMN "title" DROP NOT NULL`,
      ]);
      await apply(getSQLFromDiff(relaxed));
      await db.query(
        `INSERT INTO "${table}" (id, headline) VALUES ('p2', 'new')`,
      );

      const after = await compare(manifest);
      expect(after.changes.map((c) => c.type)).toEqual(['orphan_column']);
      expect(after.changes[0].advisory?.severity).toBe('info');

      // --drop-columns removes it entirely.
      const dropped = await compare(manifest, { includeDroppedColumns: true });
      expect(getSQLFromDiff(dropped)).toEqual([
        `ALTER TABLE "${table}" DROP COLUMN "title"`,
      ]);
      await apply(getSQLFromDiff(dropped));
      expect((await compare(manifest)).changes).toEqual([]);
    });

    it('relaxes live columns stricter than the manifest only with relaxColumns, reporting them otherwise', async () => {
      const table = T('relax');
      await create(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, note TEXT NOT NULL, kind TEXT DEFAULT 'a')`,
        table,
      );
      const manifest = {
        [table]: schema(table, {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          note: { type: 'TEXT' },
          kind: { type: 'TEXT' },
        }),
      };
      const reportOnly = await compare(manifest);
      expect(reportOnly.changes.every(isAdvisoryOnlyChange)).toBe(true);
      expect(reportOnly.changes.map((c) => c.alteration).sort()).toEqual([
        'drop_default',
        'drop_not_null',
      ]);

      const relaxed = await compare(manifest, { relaxColumns: true });
      expect(getSQLFromDiff(relaxed).sort()).toEqual([
        `ALTER TABLE "${table}" ALTER COLUMN "kind" DROP DEFAULT`,
        `ALTER TABLE "${table}" ALTER COLUMN "note" DROP NOT NULL`,
      ]);
      await apply(getSQLFromDiff(relaxed));
      await db.query(`INSERT INTO "${table}" (id) VALUES ('r1')`);
      expect((await compare(manifest)).changes).toEqual([]);
    });

    it('reports a stale unique constraint (constraint index) once the manifest column stops being unique', async () => {
      const table = T('uq');
      await create(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, email TEXT UNIQUE)`,
        table,
      );
      const unique = {
        [table]: schema(table, {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          email: { type: 'TEXT', unique: true },
        }),
      };
      expect(
        (await compare(unique, { includeDroppedIndexes: true })).changes,
      ).toEqual([]);

      const plain = {
        [table]: schema(table, {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          email: { type: 'TEXT' },
        }),
      };
      const diff = await compare(plain, { includeDroppedIndexes: true });
      expect(diff.changes).toEqual([
        expect.objectContaining({
          type: 'orphan_index',
          name: `${table}_email_key`,
          advisory: expect.objectContaining({ severity: 'warning' }),
        }),
      ]);
      expect(diff.changes[0].advisory?.suggestedSql?.[0]).toBe(
        `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${table}_email_key"`,
      );
      expect(getSQLFromDiff(diff)).toEqual([]);
    });
  },
);
