/**
 * Issue #2369 — differ nullability/default drift, orphan NOT NULL report,
 * executable ADD COLUMN on every engine.
 *
 * Runs against REAL in-memory SQLite and DuckDB. The PostgreSQL lane lives in
 * `issue-2369-postgres-column-drift.optional.test.ts`; the PostgreSQL SQL
 * *shape* is asserted here through a mocked adapter so the statements the
 * differ emits are pinned even where the engine is not available.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import type { DatabaseEngine } from '../../schema/ddl/types.js';
import type { SchemaChange, SchemaDefinition } from '../../schema/types.js';
import {
  canonicalizeDefault,
  generateSchemaDiff,
  getSQLFromDiff,
  hasActionableChanges,
  isAdvisoryOnlyChange,
  SchemaComparer,
} from '../differ.js';
import { getPendingSchemaStatements } from '../orchestrate.js';

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

/** A representative SMRT-shaped table: system columns + every default kind. */
function representativeSchema(tableName = 'widgets'): SchemaDefinition {
  return schema(
    tableName,
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
      count: { type: 'INTEGER', defaultValue: 0 },
      ratio: { type: 'REAL', defaultValue: 0.5 },
      active: { type: 'BOOLEAN', defaultValue: true },
      meta: { type: 'JSON', defaultValue: {} },
      tags: { type: 'JSON', defaultValue: [] },
      owner_id: { type: 'UUID', referenceKind: 'foreignKey' },
      note: { type: 'TEXT' },
    },
    [
      {
        name: `${tableName}_slug_context_idx`,
        columns: ['slug', 'context'],
        unique: true,
      },
    ],
  );
}

async function applyStatements(db: DatabaseProvider, statements: string[]) {
  for (const sql of statements) {
    await db.query(sql);
  }
}

const engines: Array<{
  name: string;
  type: 'sqlite' | 'duckdb';
  engine: DatabaseEngine;
}> = [
  { name: 'SQLite', type: 'sqlite', engine: 'sqlite' },
  { name: 'DuckDB', type: 'duckdb', engine: 'duckdb' },
];

describe('canonicalizeDefault (#2369)', () => {
  it('folds engine renderings of the same default into one key', () => {
    expect(canonicalizeDefault("'anon'", 'TEXT')).toEqual({
      kind: 'text',
      key: 'anon',
    });
    expect(canonicalizeDefault("'anon'::text", 'TEXT')).toEqual({
      kind: 'text',
      key: 'anon',
    });
    expect(canonicalizeDefault("'anon'::character varying", 'TEXT')).toEqual({
      kind: 'text',
      key: 'anon',
    });
    expect(canonicalizeDefault("''::text", 'TEXT')).toEqual({
      kind: 'text',
      key: '',
    });
    expect(canonicalizeDefault("'it''s'", 'TEXT')).toEqual({
      kind: 'text',
      key: "it's",
    });
    expect(canonicalizeDefault('0', 'INTEGER')).toEqual({
      kind: 'number',
      key: '0',
    });
    expect(canonicalizeDefault("'-1'::integer", 'INTEGER')).toEqual({
      kind: 'number',
      key: '-1',
    });
    expect(canonicalizeDefault('0.5', 'REAL')).toEqual({
      kind: 'number',
      key: '0.5',
    });
    expect(canonicalizeDefault('0.0', 'REAL')).toEqual({
      kind: 'number',
      key: '0',
    });
    expect(canonicalizeDefault('TRUE', 'BOOLEAN')).toEqual({
      kind: 'bool',
      key: 'true',
    });
    expect(canonicalizeDefault('true', 'BOOLEAN')).toEqual({
      kind: 'bool',
      key: 'true',
    });
    expect(canonicalizeDefault('1', 'BOOLEAN')).toEqual({
      kind: 'bool',
      key: 'true',
    });
    expect(canonicalizeDefault("CAST('t' AS BOOLEAN)", 'BOOLEAN')).toEqual({
      kind: 'bool',
      key: 'true',
    });
    expect(canonicalizeDefault("CAST('f' AS BOOLEAN)", 'BOOLEAN')).toEqual({
      kind: 'bool',
      key: 'false',
    });
    expect(canonicalizeDefault("'{}'", 'JSON')).toEqual({
      kind: 'text',
      key: '{}',
    });
    expect(canonicalizeDefault("'{}'::jsonb", 'JSON')).toEqual({
      kind: 'text',
      key: '{}',
    });
    expect(canonicalizeDefault(`'{"a": 1}'::jsonb`, 'JSON')).toEqual({
      kind: 'text',
      key: '{"a":1}',
    });
    expect(canonicalizeDefault('current_timestamp', 'TIMESTAMP')).toEqual({
      kind: 'now',
      key: 'now',
    });
    expect(canonicalizeDefault('CURRENT_TIMESTAMP', 'TIMESTAMP')).toEqual({
      kind: 'now',
      key: 'now',
    });
    expect(canonicalizeDefault('now()', 'TIMESTAMP')).toEqual({
      kind: 'now',
      key: 'now',
    });
    expect(canonicalizeDefault("datetime('now')", 'TIMESTAMP')).toEqual({
      kind: 'now',
      key: 'now',
    });
    expect(canonicalizeDefault('gen_random_uuid()', 'UUID')).toEqual({
      kind: 'func',
      key: 'gen_random_uuid()',
    });
  });

  it('treats absent, empty and NULL as "no default"', () => {
    expect(canonicalizeDefault(undefined, 'TEXT').kind).toBe('none');
    expect(canonicalizeDefault('', 'TEXT').kind).toBe('none');
    expect(canonicalizeDefault('NULL', 'TEXT').kind).toBe('none');
    expect(canonicalizeDefault('null::text', 'TEXT').kind).toBe('none');
  });

  it('marks unclassifiable renderings as raw so callers skip them', () => {
    expect(
      canonicalizeDefault("nextval('seq'::regclass)", 'INTEGER').kind,
    ).toBe('func');
    expect(canonicalizeDefault('1 + 2', 'INTEGER').kind).toBe('raw');
    expect(canonicalizeDefault('maybe', 'BOOLEAN').kind).toBe('raw');
  });
});

for (const { name, type, engine } of engines) {
  describe(`SchemaComparer nullability/default drift on real ${name} (#2369)`, () => {
    let db: DatabaseProvider;

    beforeEach(async () => {
      db = await getDatabase({ type, url: ':memory:' });
    });

    afterEach(async () => {
      try {
        await db.close?.();
      } catch {
        // ignore
      }
    });

    const comparer = (
      options: ConstructorParameters<typeof SchemaComparer>[1] = {},
    ) => new SchemaComparer(db, { engineHint: engine, ...options });

    it('round-trips a strategy-created table with zero drift (no false positives on defaults/nullability)', async () => {
      const def = representativeSchema();
      const strategy = getDDLStrategy(engine);
      await db.query(strategy.generateCreateTable(def));
      await applyStatements(db, strategy.generateIndexes(def));

      const diff = await comparer().compare({ widgets: def });
      // DuckDB materializes the unique index as an inline table constraint
      // that `duckdb_indexes()` does not list, so the index comparison
      // re-adds it every run — a pre-existing DuckDB index-path limitation
      // outside #2369. Column-level parity is what this test pins.
      const columnChanges = diff.changes.filter(
        (c) => c.type !== 'add_index' && c.type !== 'drop_index',
      );
      expect(columnChanges).toEqual([]);
      expect(diff.orphan_tables).toEqual([]);
      if (engine === 'sqlite') {
        expect(diff.changes).toEqual([]);
        expect(diff.has_changes).toBe(false);
      }
    });

    it('always reports orphan columns; a NOT NULL orphan without a default is a blocking warning', async () => {
      await db.query(
        'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, legacy_note TEXT, legacy_code TEXT NOT NULL)',
      );
      const manifest = {
        users: schema('users', {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
        }),
      };

      const diff = await comparer().compare(manifest);
      const orphans = diff.changes.filter((c) => c.type === 'orphan_column');
      expect(orphans.map((c) => c.name).sort()).toEqual([
        'legacy_code',
        'legacy_note',
      ]);

      const harmless = orphans.find(
        (c) => c.name === 'legacy_note',
      ) as SchemaChange;
      expect(harmless.advisory?.severity).toBe('info');
      expect(harmless.sql).toBeUndefined();
      expect(isAdvisoryOnlyChange(harmless)).toBe(true);

      const blocking = orphans.find(
        (c) => c.name === 'legacy_code',
      ) as SchemaChange;
      expect(blocking.advisory?.severity).toBe('warning');
      expect(blocking.advisory?.message).toMatch(
        /every ORM insert into users will fail/,
      );
      expect(blocking.mismatch?.actual).toMatch(/NOT NULL/);
      expect(blocking.advisory?.suggestedSql?.join('\n')).toContain(
        'DROP COLUMN "legacy_code"',
      );

      // Report-only: nothing executable, so the diff is "drift but no
      // statements" — visible, never silently in sync. The blocking orphan
      // counts as a change; an info-only orphan on its own would not.
      expect(diff.has_changes).toBe(true);
      expect(hasActionableChanges(diff)).toBe(false);
      expect(getSQLFromDiff(diff)).toEqual([]);

      const infoOnly = await comparer().compare({
        users: schema('users', {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
          legacy_code: { type: 'TEXT', notNull: true },
        }),
      });
      expect(infoOnly.changes.map((c) => c.type)).toEqual(['orphan_column']);
      expect(infoOnly.has_changes).toBe(false);
    });

    it('drops orphan columns only when includeDroppedColumns is set (renamed required field scenario)', async () => {
      // A `required` field renamed title → headline: the old NOT NULL column
      // would break every insert. --drop-columns removes it.
      await db.query(
        "CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, headline TEXT NOT NULL DEFAULT '')",
      );
      await db.query(
        "INSERT INTO posts (id, title, headline) VALUES ('p1', 'old', 'new')",
      );
      const manifest = {
        posts: schema('posts', {
          id: { type: 'TEXT', primaryKey: true },
          headline: { type: 'TEXT', notNull: true, defaultValue: '' },
        }),
      };

      const reportOnly = await comparer().compare(manifest);
      expect(reportOnly.changes.map((c) => c.type)).toEqual(['orphan_column']);
      expect(reportOnly.changes[0].advisory?.severity).toBe('warning');

      const withDrop = await comparer({ includeDroppedColumns: true }).compare(
        manifest,
      );
      expect(withDrop.changes).toEqual([
        expect.objectContaining({
          type: 'drop_column',
          name: 'title',
          sql: 'ALTER TABLE "posts" DROP COLUMN "title"',
        }),
      ]);
      await applyStatements(db, getSQLFromDiff(withDrop));

      // Inserts that omit the orphan now succeed and the schema re-diffs clean.
      await db.query("INSERT INTO posts (id, headline) VALUES ('p2', 'x')");
      const after = await comparer().compare(manifest);
      expect(after.changes).toEqual([]);
    });

    it('adds a required column WITH a default to a populated table in one executable plan', async () => {
      await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT)');
      await db.query("INSERT INTO items (id, name) VALUES ('i1', 'a')");
      const manifest = {
        items: schema('items', {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
          status: { type: 'TEXT', notNull: true, defaultValue: 'draft' },
          hits: { type: 'INTEGER', notNull: true, defaultValue: 0 },
        }),
      };

      const diff = await comparer().compare(manifest);
      expect(diff.changes.map((c) => c.type)).toEqual([
        'add_column',
        'add_column',
      ]);
      const statements = getSQLFromDiff(diff);
      if (engine === 'duckdb') {
        // DuckDB rejects NOT NULL inline in ADD COLUMN: add with DEFAULT, then tighten.
        expect(statements).toEqual([
          `ALTER TABLE "items" ADD COLUMN "status" TEXT DEFAULT 'draft'`,
          `ALTER TABLE "items" ALTER COLUMN "status" SET NOT NULL`,
          `ALTER TABLE "items" ADD COLUMN "hits" INTEGER DEFAULT 0`,
          `ALTER TABLE "items" ALTER COLUMN "hits" SET NOT NULL`,
        ]);
      } else {
        expect(statements).toEqual([
          `ALTER TABLE "items" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft'`,
          `ALTER TABLE "items" ADD COLUMN "hits" INTEGER NOT NULL DEFAULT 0`,
        ]);
      }
      await applyStatements(db, statements);

      const row = (await db.query('SELECT status, hits FROM items'))
        .rows as Array<Record<string, unknown>>;
      expect(row[0].status).toBe('draft');
      expect(Number(row[0].hits)).toBe(0);
      const after = await comparer().compare(manifest);
      expect(after.changes).toEqual([]);
    });

    it('adds a required column WITHOUT a default nullable on a populated table and reports the NOT NULL as a manual follow-up', async () => {
      await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT)');
      await db.query("INSERT INTO items (id, name) VALUES ('i1', 'a')");
      const manifest = {
        items: schema('items', {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
          owner_id: { type: 'TEXT', notNull: true },
        }),
      };

      const diff = await comparer().compare(manifest);
      expect(diff.changes.map((c) => c.type)).toEqual([
        'add_column',
        'alter_column',
      ]);
      const [add, followUp] = diff.changes;
      expect(add.sqlStatements).toBeUndefined();
      expect(add.sql).toBe('ALTER TABLE "items" ADD COLUMN "owner_id" TEXT');
      expect(followUp.alteration).toBe('set_not_null');
      expect(followUp.advisory?.severity).toBe('warning');
      expect(followUp.sql).toMatch(/^-- items\.owner_id is required/);
      expect(followUp.advisory?.suggestedSql?.[0]).toContain(
        'UPDATE "items" SET "owner_id"',
      );

      // Only the ADD COLUMN executes; the comment is filtered by the
      // orchestrator and classified as manual by the CLI.
      const executable = getSQLFromDiff(diff).filter(
        (s) => !s.startsWith('--'),
      );
      expect(executable).toEqual([
        'ALTER TABLE "items" ADD COLUMN "owner_id" TEXT',
      ]);
      await applyStatements(db, executable);
      await db.query("INSERT INTO items (id, name) VALUES ('i2', 'b')"); // still insertable
    });

    it('enforces NOT NULL on a required column without a default when the table is empty', async () => {
      await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT)');
      const manifest = {
        items: schema('items', {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
          owner_id: { type: 'TEXT', notNull: true },
        }),
      };

      const diff = await comparer().compare(manifest);
      expect(diff.changes.map((c) => c.type)).toEqual(['add_column']);
      const statements = getSQLFromDiff(diff);
      if (engine === 'duckdb') {
        expect(statements).toEqual([
          'ALTER TABLE "items" ADD COLUMN "owner_id" TEXT',
          'ALTER TABLE "items" ALTER COLUMN "owner_id" SET NOT NULL',
        ]);
      } else {
        expect(statements).toEqual([
          'ALTER TABLE "items" ADD COLUMN "owner_id" TEXT NOT NULL',
        ]);
      }
      await applyStatements(db, statements);
      const after = await comparer().compare(manifest);
      expect(after.changes).toEqual([]);
    });

    it('adds a unique column to a populated table via ADD COLUMN + CREATE UNIQUE INDEX <table>_<col>_key', async () => {
      await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)');
      await db.query("INSERT INTO users (id, name) VALUES ('u1', 'a')");
      const manifest = {
        users: schema('users', {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
          email: { type: 'TEXT', unique: true },
        }),
      };

      const diff = await comparer().compare(manifest);
      expect(diff.changes).toEqual([
        expect.objectContaining({
          type: 'add_column',
          name: 'email',
          sqlStatements: [
            'ALTER TABLE "users" ADD COLUMN "email" TEXT',
            'CREATE UNIQUE INDEX "users_email_key" ON "users" ("email")',
          ],
        }),
      ]);
      await applyStatements(db, getSQLFromDiff(diff));
      await db.query(
        "INSERT INTO users (id, name, email) VALUES ('u2', 'b', 'b@x')",
      );
      await expect(
        db.query(
          "INSERT INTO users (id, name, email) VALUES ('u3', 'c', 'b@x')",
        ),
      ).rejects.toThrow();

      // The constraint index is claimed by the unique column: no orphan
      // report, no drop, no churn on re-diff.
      const after = await comparer({ includeDroppedIndexes: true }).compare(
        manifest,
      );
      expect(after.changes).toEqual([]);
    });

    it('reports a stale unique constraint index once the manifest column is no longer unique', async () => {
      await db.query('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)');
      await db.query(
        'CREATE UNIQUE INDEX "users_email_key" ON "users" ("email")',
      );
      const stillUnique = {
        users: schema('users', {
          id: { type: 'TEXT', primaryKey: true },
          email: { type: 'TEXT', unique: true },
        }),
      };
      expect((await comparer().compare(stillUnique)).changes).toEqual([]);

      const noLongerUnique = {
        users: schema('users', {
          id: { type: 'TEXT', primaryKey: true },
          email: { type: 'TEXT' },
        }),
      };
      const diff = await comparer({ includeDroppedIndexes: true }).compare(
        noLongerUnique,
      );
      expect(diff.changes).toEqual([
        expect.objectContaining({
          type: 'orphan_index',
          name: 'users_email_key',
          advisory: expect.objectContaining({
            severity: 'warning',
            suggestedSql: ['DROP INDEX IF EXISTS "users_email_key"'],
          }),
        }),
      ]);
      // Never auto-dropped, even with includeDroppedIndexes.
      expect(getSQLFromDiff(diff)).toEqual([]);
    });

    it('reports orphan tables without dropping them; includeDroppedTables opts into the drop', async () => {
      await db.query('CREATE TABLE users (id TEXT PRIMARY KEY)');
      await db.query('CREATE TABLE zombie (id TEXT PRIMARY KEY)');
      await db.query('CREATE TABLE _smrt_system (id TEXT PRIMARY KEY)');
      const manifest = {
        users: schema('users', { id: { type: 'TEXT', primaryKey: true } }),
      };

      const diff = await comparer().compare(manifest);
      expect(diff.orphan_tables).toEqual(['zombie']);
      expect(diff.dropped_tables).toEqual([]);
      expect(diff.has_changes).toBe(false);

      const withDrop = await comparer({ includeDroppedTables: true }).compare(
        manifest,
      );
      expect(withDrop.dropped_tables).toEqual(['zombie']);
      expect(withDrop.has_changes).toBe(true);
    });

    if (engine === 'sqlite') {
      it('reports nullability and default drift as manual on SQLite (no ALTER COLUMN) and leaves the rebuild seam for #2370', async () => {
        await db.query(
          "CREATE TABLE items (id TEXT PRIMARY KEY, status TEXT, note TEXT NOT NULL, kind TEXT DEFAULT 'a')",
        );
        const manifest = {
          items: schema('items', {
            id: { type: 'TEXT', primaryKey: true },
            status: { type: 'TEXT', notNull: true, defaultValue: 'draft' },
            note: { type: 'TEXT' },
            kind: { type: 'TEXT', defaultValue: 'b' },
          }),
        };

        const diff = await comparer().compare(manifest);
        const byKey = Object.fromEntries(
          diff.changes.map((c) => [`${c.name}:${c.alteration}`, c]),
        );
        // Strengthening → manual (comment-only SQL), never executable.
        expect(byKey['status:set_default'].sql).toMatch(
          /^-- SQLite: setting the default/,
        );
        expect(byKey['status:set_not_null'].sql).toMatch(
          /^-- SQLite: enforcing NOT NULL/,
        );
        expect(byKey['kind:set_default'].sql).toMatch(/^-- SQLite/);
        // Relaxing → advisory (no SQL) by default …
        expect(byKey['note:drop_not_null'].advisory?.severity).toBe('warning');
        expect(byKey['note:drop_not_null'].sql).toBeUndefined();
        expect(getSQLFromDiff(diff).every((s) => s.startsWith('--'))).toBe(
          true,
        );

        // … and manual (SQLite cannot relax in place) when opted in.
        const relaxed = await comparer({ relaxColumns: true }).compare(
          manifest,
        );
        const relaxNote = relaxed.changes.find(
          (c) => c.name === 'note' && c.alteration === 'drop_not_null',
        ) as SchemaChange;
        expect(relaxNote.advisory).toBeUndefined();
        expect(relaxNote.sql).toMatch(/^-- SQLite: dropping NOT NULL/);

        // Orchestrator: nothing executable, manual drift surfaced.
        const pending = await getPendingSchemaStatements(db, {
          engineHint: 'sqlite',
        });
        expect(pending.statements.every((s) => !s.startsWith('--'))).toBe(true);
      });

      it('an orphan NOT NULL column on SQLite points at --drop-columns (no in-place relax)', async () => {
        await db.query(
          'CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
        );
        const manifest = {
          posts: schema('posts', { id: { type: 'TEXT', primaryKey: true } }),
        };
        const relaxed = await comparer({ relaxColumns: true }).compare(
          manifest,
        );
        expect(relaxed.changes).toEqual([
          expect.objectContaining({
            type: 'orphan_column',
            name: 'title',
            advisory: expect.objectContaining({ severity: 'warning' }),
          }),
        ]);
        expect(relaxed.changes[0].advisory?.message).toMatch(/--drop-columns/);
      });
    }

    if (engine === 'duckdb') {
      it('repairs nullability drift with a backfill + SET NOT NULL when the manifest has a default', async () => {
        await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, status TEXT)');
        await db.query(
          "INSERT INTO items (id, status) VALUES ('i1', NULL), ('i2', 'live')",
        );
        const manifest = {
          items: schema('items', {
            id: { type: 'TEXT', primaryKey: true },
            status: { type: 'TEXT', notNull: true, defaultValue: 'draft' },
          }),
        };

        const diff = await comparer().compare(manifest);
        expect(
          diff.changes.map((c) => `${c.type}:${c.alteration}`).sort(),
        ).toEqual(['alter_column:set_default', 'alter_column:set_not_null']);
        expect(getSQLFromDiff(diff)).toEqual([
          `ALTER TABLE "items" ALTER COLUMN "status" SET DEFAULT 'draft'`,
          `UPDATE "items" SET "status" = 'draft' WHERE "status" IS NULL`,
          `ALTER TABLE "items" ALTER COLUMN "status" SET NOT NULL`,
        ]);
        await applyStatements(db, getSQLFromDiff(diff));

        const rows = (
          await db.query('SELECT id, status FROM items ORDER BY id')
        ).rows as Array<Record<string, unknown>>;
        expect(rows.map((r) => r.status)).toEqual(['draft', 'live']);
        expect((await comparer().compare(manifest)).changes).toEqual([]);
      });

      it('repairs nullability drift without a default when no NULLs exist, and reports it when they do', async () => {
        await db.query(
          'CREATE TABLE items (id TEXT PRIMARY KEY, owner_id TEXT)',
        );
        await db.query("INSERT INTO items (id, owner_id) VALUES ('i1', 'o1')");
        const manifest = {
          items: schema('items', {
            id: { type: 'TEXT', primaryKey: true },
            owner_id: { type: 'TEXT', notNull: true },
          }),
        };

        const clean = await comparer().compare(manifest);
        expect(getSQLFromDiff(clean)).toEqual([
          'ALTER TABLE "items" ALTER COLUMN "owner_id" SET NOT NULL',
        ]);

        await db.query("INSERT INTO items (id, owner_id) VALUES ('i2', NULL)");
        const blocked = await comparer().compare(manifest);
        expect(blocked.changes).toEqual([
          expect.objectContaining({
            type: 'alter_column',
            alteration: 'set_not_null',
            advisory: expect.objectContaining({ severity: 'warning' }),
          }),
        ]);
        expect(blocked.changes[0].sql).toMatch(
          /^-- items\.owner_id is required .* live rows hold NULL/,
        );
        // Not executable: the differ must not emit an ALTER the engine rejects mid-batch.
        expect(
          getSQLFromDiff(blocked).filter((s) => !s.startsWith('--')),
        ).toEqual([]);
      });

      it('relaxes a live column stricter than the manifest only when relaxColumns is set', async () => {
        await db.query(
          "CREATE TABLE items (id TEXT PRIMARY KEY, note TEXT NOT NULL, kind TEXT DEFAULT 'a')",
        );
        const manifest = {
          items: schema('items', {
            id: { type: 'TEXT', primaryKey: true },
            note: { type: 'TEXT' },
            kind: { type: 'TEXT' },
          }),
        };

        const reportOnly = await comparer().compare(manifest);
        expect(reportOnly.changes.map((c) => c.alteration).sort()).toEqual([
          'drop_default',
          'drop_not_null',
        ]);
        expect(reportOnly.changes.every(isAdvisoryOnlyChange)).toBe(true);
        expect(hasActionableChanges(reportOnly)).toBe(false);
        expect(
          reportOnly.changes.find((c) => c.alteration === 'drop_not_null')
            ?.advisory?.severity,
        ).toBe('warning');
        expect(
          reportOnly.changes.find((c) => c.alteration === 'drop_default')
            ?.advisory?.severity,
        ).toBe('info');

        const relaxed = await comparer({ relaxColumns: true }).compare(
          manifest,
        );
        expect(getSQLFromDiff(relaxed).sort()).toEqual([
          'ALTER TABLE "items" ALTER COLUMN "kind" DROP DEFAULT',
          'ALTER TABLE "items" ALTER COLUMN "note" DROP NOT NULL',
        ]);
        await applyStatements(db, getSQLFromDiff(relaxed));
        await db.query("INSERT INTO items (id) VALUES ('i1')");
        expect((await comparer().compare(manifest)).changes).toEqual([]);
      });

      it('relaxes an orphan NOT NULL column with relaxColumns so inserts keep working (rename-required-field scenario)', async () => {
        await db.query(
          'CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
        );
        await db.query("INSERT INTO posts (id, title) VALUES ('p1', 'old')");
        const manifest = {
          posts: schema('posts', {
            id: { type: 'TEXT', primaryKey: true },
            headline: { type: 'TEXT', notNull: true, defaultValue: '' },
          }),
        };

        // Without the flag: the new column is added, the orphan is a warning,
        // and inserts through the model layer would still fail on `title`.
        const reportOnly = await comparer().compare(manifest);
        expect(reportOnly.changes.map((c) => c.type)).toEqual([
          'add_column',
          'orphan_column',
        ]);
        expect(reportOnly.changes[1].advisory?.severity).toBe('warning');

        const relaxed = await comparer({ relaxColumns: true }).compare(
          manifest,
        );
        expect(
          relaxed.changes.map((c) => `${c.type}:${c.alteration ?? ''}`),
        ).toEqual(['add_column:', 'alter_column:drop_not_null']);
        await applyStatements(db, getSQLFromDiff(relaxed));

        // ORM-style insert that never mentions the orphan succeeds.
        await db.query("INSERT INTO posts (id, headline) VALUES ('p2', 'new')");
        const after = await comparer().compare(manifest);
        expect(after.changes.map((c) => c.type)).toEqual(['orphan_column']);
        expect(after.changes[0].advisory?.severity).toBe('info');
      });

      it('repairs default drift with SET DEFAULT', async () => {
        await db.query(
          "CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT DEFAULT 'a', flag BOOLEAN DEFAULT FALSE)",
        );
        const manifest = {
          items: schema('items', {
            id: { type: 'TEXT', primaryKey: true },
            kind: { type: 'TEXT', defaultValue: 'b' },
            flag: { type: 'BOOLEAN', defaultValue: true },
          }),
        };
        const diff = await comparer().compare(manifest);
        expect(getSQLFromDiff(diff).sort()).toEqual([
          `ALTER TABLE "items" ALTER COLUMN "flag" SET DEFAULT TRUE`,
          `ALTER TABLE "items" ALTER COLUMN "kind" SET DEFAULT 'b'`,
        ]);
        await applyStatements(db, getSQLFromDiff(diff));
        await db.query("INSERT INTO items (id) VALUES ('i1')");
        const row = (await db.query('SELECT kind, flag FROM items'))
          .rows as Array<Record<string, unknown>>;
        expect(row[0].kind).toBe('b');
        expect(row[0].flag).toBe(true);
        expect((await comparer().compare(manifest)).changes).toEqual([]);
      });
    }
  });
}

describe('SchemaComparer PostgreSQL SQL shape for #2369 (mocked adapter)', () => {
  function pgComparer(
    columns: Record<
      string,
      {
        type: string;
        notNull?: boolean;
        defaultValue?: unknown;
        primaryKey?: boolean;
      }
    >,
    options: ConstructorParameters<typeof SchemaComparer>[1] = {},
    queryRows: Record<string, Array<Record<string, unknown>>> = {},
  ) {
    const mockPostgresDb = {
      url: 'postgresql://localhost/test',
      query: async (sql: string) => {
        if (/information_schema\.tables/.test(sql))
          return { rows: [{ table_name: 'items' }] };
        if (/FROM pg_indexes/.test(sql)) return { rows: [] };
        for (const [pattern, rows] of Object.entries(queryRows)) {
          if (sql.includes(pattern)) return { rows };
        }
        return { rows: [] };
      },
      getTableSchema: async () => ({
        tableName: 'items',
        columns,
        indexes: [],
        foreignKeys: [],
      }),
    };
    return new SchemaComparer(
      mockPostgresDb as unknown as DatabaseProvider,
      options,
    );
  }

  it('does not flag PostgreSQL-rendered defaults that match the manifest', async () => {
    const comparer = pgComparer({
      id: { type: 'text', notNull: true, primaryKey: true },
      context: { type: 'text', notNull: true, defaultValue: "''::text" },
      created_at: {
        type: 'timestamp with time zone',
        notNull: true,
        defaultValue: 'CURRENT_TIMESTAMP',
      },
      meta: { type: 'jsonb', notNull: false, defaultValue: "'{}'::jsonb" },
      active: { type: 'boolean', notNull: false, defaultValue: 'true' },
      count: { type: 'integer', notNull: false, defaultValue: "'-1'::integer" },
      name: {
        type: 'character varying',
        notNull: false,
        defaultValue: "'anon'::character varying",
      },
    });
    const diff = await comparer.compare({
      items: schema('items', {
        id: { type: 'TEXT', primaryKey: true, notNull: true },
        context: { type: 'TEXT', notNull: true, defaultValue: '' },
        created_at: {
          type: 'TIMESTAMP',
          notNull: true,
          defaultValue: 'current_timestamp',
        },
        meta: { type: 'JSON', defaultValue: {} },
        active: { type: 'BOOLEAN', defaultValue: true },
        count: { type: 'INTEGER', defaultValue: -1 },
        name: { type: 'TEXT', defaultValue: 'anon' },
      }),
    });
    expect(diff.changes).toEqual([]);
  });

  it('emits backfill + SET NOT NULL, SET DEFAULT with a jsonb cast, and DROP NOT NULL / DROP DEFAULT only when relaxing', async () => {
    const columns = {
      id: { type: 'text', notNull: true, primaryKey: true },
      status: { type: 'text', notNull: false, defaultValue: null },
      meta: { type: 'jsonb', notNull: false, defaultValue: null },
      note: { type: 'text', notNull: true, defaultValue: "'x'::text" },
    };
    const manifest = {
      items: schema('items', {
        id: { type: 'TEXT', primaryKey: true, notNull: true },
        status: { type: 'TEXT', notNull: true, defaultValue: 'draft' },
        meta: { type: 'JSON', defaultValue: {} },
        note: { type: 'TEXT' },
      }),
    };

    const reportOnly = await pgComparer(columns).compare(manifest);
    expect(getSQLFromDiff(reportOnly)).toEqual([
      `ALTER TABLE "items" ALTER COLUMN "status" SET DEFAULT 'draft'`,
      `UPDATE "items" SET "status" = 'draft' WHERE "status" IS NULL`,
      `ALTER TABLE "items" ALTER COLUMN "status" SET NOT NULL`,
      `ALTER TABLE "items" ALTER COLUMN "meta" SET DEFAULT '{}'::jsonb`,
    ]);
    const relaxations = reportOnly.changes.filter(isAdvisoryOnlyChange);
    expect(relaxations.map((c) => `${c.name}:${c.alteration}`).sort()).toEqual([
      'note:drop_default',
      'note:drop_not_null',
    ]);

    const relaxed = await pgComparer(columns, { relaxColumns: true }).compare(
      manifest,
    );
    expect(getSQLFromDiff(relaxed)).toEqual(
      expect.arrayContaining([
        `ALTER TABLE "items" ALTER COLUMN "note" DROP DEFAULT`,
        `ALTER TABLE "items" ALTER COLUMN "note" DROP NOT NULL`,
      ]),
    );
  });

  it('keeps NOT NULL/UNIQUE inline on PostgreSQL ADD COLUMN when the table is empty and defers NOT NULL on a populated table without a default', async () => {
    const columns = { id: { type: 'text', notNull: true, primaryKey: true } };
    const manifest = {
      items: schema('items', {
        id: { type: 'TEXT', primaryKey: true, notNull: true },
        email: { type: 'TEXT', unique: true, notNull: true },
        status: { type: 'TEXT', notNull: true, defaultValue: 'draft' },
      }),
    };

    const empty = await pgComparer(columns).compare(manifest);
    expect(getSQLFromDiff(empty)).toEqual([
      `ALTER TABLE "items" ADD COLUMN "email" TEXT NOT NULL UNIQUE`,
      `ALTER TABLE "items" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft'`,
    ]);

    const populated = await pgComparer(
      columns,
      {},
      {
        'SELECT 1 AS present FROM "items" LIMIT 1': [{ present: 1 }],
      },
    ).compare(manifest);
    expect(populated.changes.map((c) => `${c.type}:${c.name}`)).toEqual([
      'add_column:email',
      'alter_column:email',
      'add_column:status',
    ]);
    expect(
      getSQLFromDiff(populated).filter((s) => !s.startsWith('--')),
    ).toEqual([
      `ALTER TABLE "items" ADD COLUMN "email" TEXT UNIQUE`,
      `ALTER TABLE "items" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft'`,
    ]);
  });

  it('skips constraint drift on a column whose type is also drifting', async () => {
    const comparer = pgComparer({
      id: { type: 'text', notNull: true, primaryKey: true },
      amount: { type: 'text', notNull: false, defaultValue: null },
    });
    const diff = await comparer.compare({
      items: schema('items', {
        id: { type: 'TEXT', primaryKey: true, notNull: true },
        amount: { type: 'INTEGER', notNull: true, defaultValue: 0 },
      }),
    });
    expect(diff.changes.map((c) => c.type)).toEqual(['type_upgrade']);
  });
});
