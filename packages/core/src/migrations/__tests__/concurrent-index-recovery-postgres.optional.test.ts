/**
 * Interrupted concurrent-index recovery on a real PostgreSQL server, with two
 * schemas on the search path that each hold an index of the same name.
 *
 * The recovery drops the INVALID index a failed `CREATE INDEX CONCURRENTLY`
 * left behind and builds it again. It must drop that index and no other: the
 * one in the schema of the table the pending statement indexes. A healthy
 * index of the same name in another schema stays.
 *
 * Runs only in the PostgreSQL lane (`DATABASE_URL` / `SMRT_TEST_POSTGRES_URL`).
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MigrationDefinition } from '../../schema/types.js';
import { MigrationTracker } from '../tracker.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)(
  'interrupted concurrent-index recovery across schemas (real PostgreSQL)',
  () => {
    let admin: DatabaseInterface;
    const databases: string[] = [];
    const handles: DatabaseInterface[] = [];
    const roles: string[] = [];

    /** A fresh database whose every connection searches `first`, then `second`. */
    async function databaseWithSearchPath(
      first: string,
      second: string,
    ): Promise<DatabaseInterface> {
      const name = `smrt_idxrec_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await admin.query(`CREATE DATABASE ${name}`);
      databases.push(name);
      await admin.query(
        `ALTER DATABASE ${name} SET search_path = ${first}, ${second}`,
      );
      const url = new URL(pgUrl as string);
      url.pathname = `/${name}`;
      const db = (await getDatabase({
        type: 'postgres',
        url: String(url),
        dbid: `idxrec-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      handles.push(db);
      await db.query(`CREATE SCHEMA ${first}`);
      await db.query(`CREATE SCHEMA ${second}`);
      return db;
    }

    /** A table whose UNIQUE index build failed and left an INVALID index. */
    async function tableWithInvalidIndex(
      db: DatabaseInterface,
      schema: string,
      table: string,
      index: string,
    ): Promise<void> {
      await db.query(`CREATE TABLE ${schema}.${table} (id INT, status TEXT)`);
      await db.query(
        `INSERT INTO ${schema}.${table} VALUES (1, 'same'), (2, 'same')`,
      );
      await expect(
        db.query(
          `CREATE UNIQUE INDEX CONCURRENTLY ${index} ON ${schema}.${table} (status)`,
        ),
      ).rejects.toThrow();
      await db.query(`DELETE FROM ${schema}.${table} WHERE id = 2`);
    }

    async function tableWithHealthyIndex(
      db: DatabaseInterface,
      schema: string,
      table: string,
      index: string,
    ): Promise<void> {
      await db.query(`CREATE TABLE ${schema}.${table} (id INT, email TEXT)`);
      await db.query(
        `CREATE UNIQUE INDEX ${index} ON ${schema}.${table} (email)`,
      );
    }

    /** `schema -> is valid` for every index called `index`. */
    async function indexValidity(
      db: DatabaseInterface,
      index: string,
    ): Promise<Record<string, boolean>> {
      const result = await db.query(
        `SELECT n.nspname AS schema_name, i.indisvalid AS is_valid
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = ?`,
        index,
      );
      return Object.fromEntries(
        result.rows.map((row) => [
          String(row.schema_name),
          row.is_valid === true,
        ]),
      );
    }

    const pendingIndex = (
      id: string,
      index: string,
      table: string,
    ): MigrationDefinition => ({
      id,
      description: `Unique index ${index} on ${table}`,
      version: '1.0.0',
      up: [
        `CREATE UNIQUE INDEX IF NOT EXISTS "${index}" ON ${table} ("status")`,
      ],
      down: [],
    });

    beforeAll(async () => {
      admin = (await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
      })) as DatabaseInterface;
    });

    afterAll(async () => {
      for (const handle of handles) await handle.close?.();
      for (const name of databases)
        await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      for (const role of roles)
        await admin?.query(`DROP ROLE IF EXISTS ${role}`);
      await admin?.close?.();
    });

    it('rebuilds the INVALID index and keeps a healthy index of the same name earlier on the search path', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await tableWithHealthyIndex(db, 'idx_first', 'accounts', 'shared_idx');
      await tableWithInvalidIndex(db, 'idx_second', 'jobs', 'shared_idx');
      expect(await indexValidity(db, 'shared_idx')).toEqual({
        idx_first: true,
        idx_second: false,
      });

      const results = await new MigrationTracker({ db }).applyAll(
        [pendingIndex('add_index_jobs_shared', 'shared_idx', '"jobs"')],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.success)).toEqual([true]);
      expect(await indexValidity(db, 'shared_idx')).toEqual({
        idx_first: true,
        idx_second: true,
      });
      // The healthy index still enforces what it enforced.
      await db.query(`INSERT INTO idx_first.accounts VALUES (1, 'a@x.test')`);
      await expect(
        db.query(`INSERT INTO idx_first.accounts VALUES (2, 'a@x.test')`),
      ).rejects.toThrow();
    });

    it('rebuilds the INVALID index when it is the one earlier on the search path', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await tableWithInvalidIndex(db, 'idx_first', 'jobs', 'shared_idx');
      await tableWithHealthyIndex(db, 'idx_second', 'accounts', 'shared_idx');

      const results = await new MigrationTracker({ db }).applyAll(
        [pendingIndex('add_index_jobs_shared', 'shared_idx', '"jobs"')],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.success)).toEqual([true]);
      expect(await indexValidity(db, 'shared_idx')).toEqual({
        idx_first: true,
        idx_second: true,
      });
    });

    it('follows a schema-qualified table to its own schema', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await tableWithHealthyIndex(db, 'idx_first', 'accounts', 'shared_idx');
      await tableWithInvalidIndex(db, 'idx_second', 'jobs', 'shared_idx');

      const results = await new MigrationTracker({ db }).applyAll(
        [
          pendingIndex(
            'add_index_jobs_shared',
            'shared_idx',
            'idx_second."jobs"',
          ),
        ],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.success)).toEqual([true]);
      expect(await indexValidity(db, 'shared_idx')).toEqual({
        idx_first: true,
        idx_second: true,
      });
    });

    it('leaves an INVALID index alone when the pending statement indexes a table in another schema', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await tableWithInvalidIndex(db, 'idx_second', 'jobs', 'shared_idx');
      await db.query('CREATE TABLE idx_first.tasks (id INT, status TEXT)');

      const results = await new MigrationTracker({ db }).applyAll(
        [pendingIndex('add_index_tasks_shared', 'shared_idx', '"tasks"')],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.success)).toEqual([true]);
      // The new index was built where its table lives; the other schema's
      // unfinished index is not this statement's to repair.
      expect(await indexValidity(db, 'shared_idx')).toEqual({
        idx_first: true,
        idx_second: false,
      });
    });

    it('reads a relation reference with a comment beside its dot whole, and touches no index of a prefix-named relation', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE SCHEMA app');
      await db.query('CREATE TABLE app.jobs (id INT, status TEXT)');
      // A relation called `app` elsewhere on the search path, whose index of
      // the pending name is INVALID.
      await tableWithInvalidIndex(db, 'idx_second', 'app', 'shared_idx');

      const results = await new MigrationTracker({ db }).applyAll(
        [
          {
            ...pendingIndex('add_index_app_jobs', 'shared_idx', 'unused'),
            up: [
              'CREATE UNIQUE INDEX IF NOT EXISTS "shared_idx" ON app /* c */ . jobs ("status")',
            ],
          },
        ],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.success)).toEqual([true]);
      expect(await indexValidity(db, 'shared_idx')).toEqual({
        app: true,
        idx_second: false,
      });
    });

    it('reads an identifier ending in "using" whole, and touches no index of the relation its prefix names', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE SCHEMA appusing');
      await db.query('CREATE TABLE appusing.jobs (id INT, status TEXT)');
      // A relation called `app` elsewhere on the search path, whose index of
      // the pending name is INVALID.
      await tableWithInvalidIndex(db, 'idx_second', 'app', 'shared_idx');

      const results = await new MigrationTracker({ db }).applyAll(
        [
          {
            ...pendingIndex('add_index_appusing_jobs', 'shared_idx', 'unused'),
            up: [
              'CREATE UNIQUE INDEX IF NOT EXISTS "shared_idx" ON appusing /* comment */ . jobs ("status")',
            ],
          },
        ],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.success)).toEqual([true]);
      expect(await indexValidity(db, 'shared_idx')).toEqual({
        appusing: true,
        idx_second: false,
      });
    });

    it('refuses a statement it cannot read, before anything runs, and leaves the INVALID index on its own table in place', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await tableWithInvalidIndex(db, 'idx_first', 'jobs', 'shared_idx');

      // A statement whose table reference the reader does not take apart (a
      // Unicode-escaped identifier) is refused before anything runs: nothing
      // is repaired, built or recorded, and the INVALID index stays.
      await expect(
        new MigrationTracker({ db }).applyAll(
          [
            {
              ...pendingIndex(
                'add_index_jobs_unreadable',
                'shared_idx',
                'unused',
              ),
              up: [
                'CREATE UNIQUE INDEX IF NOT EXISTS "shared_idx" ON U&"jobs" ("status")',
              ],
            },
          ],
          { atomic: true, postgresSafe: true },
        ),
      ).rejects.toThrow('could not be read with certainty');

      expect(await indexValidity(db, 'shared_idx')).toEqual({
        idx_first: false,
      });
    });

    it('reads a -- comment ended by CR as PostgreSQL does, and touches no index of the table a naive reader would see', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE SCHEMA app');
      await db.query('CREATE TABLE app.jobs (id INT, status TEXT)');
      // A table called `lower` whose index of the pending name is INVALID.
      await tableWithInvalidIndex(db, 'idx_second', 'lower', 'shared_idx');

      const results = await new MigrationTracker({ db }).applyAll(
        [
          {
            ...pendingIndex('add_index_app_jobs_cr', 'shared_idx', 'unused'),
            up: [
              'CREATE UNIQUE INDEX IF NOT EXISTS "shared_idx" ON -- note\r app.jobs (\n lower(status))',
            ],
          },
        ],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.success)).toEqual([true]);
      expect(await indexValidity(db, 'shared_idx')).toEqual({
        app: true,
        idx_second: false,
      });
    });

    it.each([
      [
        'an unquoted mixed-case name',
        'CREATE INDEX IF NOT EXISTS Jobs_Status_Idx ON jobs (status)',
      ],
      [
        'a partial index whose predicate holds a comment marker in a literal',
        "CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status) WHERE status <> '/*'",
      ],
      [
        'a leading comment',
        '/* nightly */ CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status)',
      ],
    ])('records a correctly built index with %s as done', async (_label, sql) => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE TABLE idx_first.jobs (id INT, status TEXT)');

      const results = await new MigrationTracker({ db }).applyAll(
        [
          {
            ...pendingIndex('add_index_variant', 'unused', 'unused'),
            up: [sql],
          },
        ],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.success)).toEqual([true]);
    });

    it('refuses an unnamed index before running anything, and builds none', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE TABLE idx_first.jobs (id INT, status TEXT)');

      await expect(
        migrateOne(db, 'add_unnamed', ['CREATE INDEX ON jobs (status)']),
      ).rejects.toThrow('names no index');
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS n FROM pg_index WHERE indrelid = 'idx_first.jobs'::regclass`,
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    });

    it('does not record a unique index as done when a non-unique index of the name already sits on the same table', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE TABLE idx_first.jobs (id INT, status TEXT)');
      await db.query('CREATE INDEX shared_idx ON idx_first.jobs (status)');

      const results = await new MigrationTracker({ db }).applyAll(
        [pendingIndex('add_unique_jobs_status', 'shared_idx', '"jobs"')],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.success)).toEqual([false]);
      // Nothing was dropped or replaced.
      expect(
        (
          await db.query(
            `SELECT i.indisunique AS is_unique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'shared_idx'`,
          )
        ).rows,
      ).toEqual([{ is_unique: false }]);
    });

    it("closes an interrupted unique-index swap in the schema of its table, and keeps another schema's index of the name", async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      // A healthy unique index of the name, earlier on the search path.
      await tableWithHealthyIndex(db, 'idx_first', 'accounts', 'shared_idx');
      // The swap's table, with the old (non-unique) index and the temporary
      // unique index an interrupted run already built.
      await db.query('CREATE TABLE idx_second.jobs (id INT, status TEXT)');
      await db.query('CREATE INDEX shared_idx ON idx_second.jobs (status)');
      await db.query(
        'CREATE UNIQUE INDEX shared_idx_smrt_swap ON idx_second.jobs (status)',
      );

      const results = await new MigrationTracker({ db }).applyAll(
        [
          {
            ...pendingIndex('swap_jobs_status', 'shared_idx', '"jobs"'),
            up: [
              'DROP INDEX IF EXISTS "shared_idx"',
              'CREATE UNIQUE INDEX IF NOT EXISTS "shared_idx" ON "jobs" ("status")',
            ],
          },
        ],
        { atomic: true, postgresSafe: true },
      );

      expect(results.map((result) => result.error ?? result.success)).toEqual([
        true,
      ]);
      const owners = await db.query(
        `SELECT n.nspname AS schema_name, t.relname AS table_name, i.indisunique AS is_unique
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'shared_idx'
          ORDER BY n.nspname`,
      );
      expect(owners.rows).toEqual([
        { schema_name: 'idx_first', table_name: 'accounts', is_unique: true },
        { schema_name: 'idx_second', table_name: 'jobs', is_unique: true },
      ]);
      // The earlier schema's index still enforces uniqueness.
      await db.query(`INSERT INTO idx_first.accounts VALUES (1, 'a@x.test')`);
      await expect(
        db.query(`INSERT INTO idx_first.accounts VALUES (2, 'a@x.test')`),
      ).rejects.toThrow();
    });

    const uniqueness = async (db: DatabaseInterface, index: string) =>
      (
        await db.query(
          `SELECT n.nspname AS schema_name, t.relname AS table_name, i.indisunique AS is_unique
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_class t ON t.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = ?
            ORDER BY n.nspname`,
          index,
        )
      ).rows;
    const migrateOne = (db: DatabaseInterface, id: string, up: string[]) =>
      new MigrationTracker({ db }).applyAll(
        [{ ...pendingIndex(id, 'unused', 'unused'), up }],
        { atomic: true, postgresSafe: true },
      );

    it('reads U+00A0 as part of a bare schema name, as PostgreSQL does, and touches no index of the schema without it', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE SCHEMA app');
      await db.query('CREATE SCHEMA " app"');
      await db.query('CREATE TABLE " app".jobs (id INT, status TEXT)');
      await tableWithInvalidIndex(db, 'app', 'jobs', 'shared_idx');

      const results = await migrateOne(db, 'add_nbsp', [
        'CREATE UNIQUE INDEX IF NOT EXISTS "shared_idx" ON  app.jobs ("status")',
      ]);

      expect(results.map((result) => result.success)).toEqual([true]);
      expect(await indexValidity(db, 'shared_idx')).toEqual({
        app: false,
        ' app': true,
      });
    });

    it.each([
      [
        'another collation',
        'CREATE UNIQUE INDEX shared_idx ON idx_first.jobs (status COLLATE "C")',
      ],
      [
        'another operator class',
        'CREATE UNIQUE INDEX shared_idx ON idx_first.jobs (status text_pattern_ops)',
      ],
      [
        'another ordering',
        'CREATE UNIQUE INDEX shared_idx ON idx_first.jobs (status DESC)',
      ],
      [
        'a predicate',
        "CREATE UNIQUE INDEX shared_idx ON idx_first.jobs (status) WHERE status <> 'x'",
      ],
    ])('does not record a unique index as done when the index of the name on the same table has %s', async (_label, existing) => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE TABLE idx_first.jobs (id INT, status TEXT)');
      await db.query(existing);

      const results = await migrateOne(db, 'add_unique_plain', [
        'CREATE UNIQUE INDEX IF NOT EXISTS shared_idx ON jobs (status)',
      ]);

      expect(results.map((result) => result.success)).toEqual([false]);
    });

    it.each([
      ['the same collation', 'status COLLATE "C"'],
      ['the same operator class', 'status text_pattern_ops'],
      [
        'the same predicate written differently',
        "status) WHERE (status::text <> ('x'::text)",
      ],
    ])('accepts an existing index with %s', async (_label, body) => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE TABLE idx_first.jobs (id INT, status TEXT)');
      const statement = `CREATE UNIQUE INDEX IF NOT EXISTS shared_idx ON jobs (${body})`;
      await db.query(statement.replace(' IF NOT EXISTS', ''));
      const results = await migrateOne(db, 'add_same', [
        body.includes('WHERE')
          ? "CREATE UNIQUE INDEX IF NOT EXISTS shared_idx ON jobs (status) WHERE status <> 'x'"
          : statement,
      ]);

      expect(results.map((result) => result.error ?? result.success)).toEqual([
        true,
      ]);
    });

    it('routes and checks a create with a comment inside its keywords', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE TABLE idx_first.jobs (id INT, status TEXT)');
      await db.query('CREATE INDEX shared_idx ON idx_first.jobs (status)');

      const results = await migrateOne(db, 'add_commented', [
        'CREATE /* rollout */ UNIQUE INDEX IF NOT EXISTS shared_idx ON jobs (status)',
      ]);

      expect(results.map((result) => result.success)).toEqual([false]);
      expect(await uniqueness(db, 'shared_idx')).toEqual([
        { schema_name: 'idx_first', table_name: 'jobs', is_unique: false },
      ]);
    });

    it('swaps a bare mixed-case unique index under the name PostgreSQL stores', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE TABLE idx_first.jobs (id INT, status TEXT)');
      await db.query('CREATE INDEX jobs_idx ON idx_first.jobs (status)');

      const results = await migrateOne(db, 'swap_mixed', [
        'DROP INDEX IF EXISTS Jobs_Idx',
        'CREATE UNIQUE INDEX IF NOT EXISTS Jobs_Idx ON jobs (status)',
      ]);

      expect(results.map((result) => result.error ?? result.success)).toEqual([
        true,
      ]);
      const names = await db.query(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'idx_first' AND c.relkind = 'i' AND c.relname ILIKE 'jobs%' ORDER BY c.relname`,
      );
      expect(names.rows).toEqual([{ name: 'jobs_idx' }]);
      expect(await uniqueness(db, 'jobs_idx')).toEqual([
        { schema_name: 'idx_first', table_name: 'jobs', is_unique: true },
      ]);
    });

    it("swaps with a leading-comment create in its table's schema, and keeps another schema's index of the name", async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await tableWithHealthyIndex(db, 'idx_first', 'accounts', 'shared_idx');
      await db.query('CREATE TABLE idx_second.jobs (id INT, status TEXT)');
      await db.query('CREATE INDEX shared_idx ON idx_second.jobs (status)');

      const results = await migrateOne(db, 'swap_commented', [
        'DROP INDEX IF EXISTS "shared_idx"',
        '/* rollout */ CREATE UNIQUE INDEX IF NOT EXISTS "shared_idx" ON "jobs" ("status")',
      ]);

      expect(results.map((result) => result.error ?? result.success)).toEqual([
        true,
      ]);
      expect(await uniqueness(db, 'shared_idx')).toEqual([
        { schema_name: 'idx_first', table_name: 'accounts', is_unique: true },
        { schema_name: 'idx_second', table_name: 'jobs', is_unique: true },
      ]);
    });

    it('verifies a correctly built index for a role without TEMPORARY on the database', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      const database = databases[databases.length - 1];
      const role = `smrt_notemp_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      roles.push(role);
      await db.query(`CREATE ROLE ${role} LOGIN PASSWORD 'notemp'`);
      await db.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
      await db.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
      await db.query(`GRANT USAGE, CREATE ON SCHEMA idx_first TO ${role}`);
      const url = new URL(pgUrl as string);
      url.pathname = `/${database}`;
      url.username = role;
      url.password = 'notemp';
      const owner = (await getDatabase({
        type: 'postgres',
        url: String(url),
        dbid: `idxrec-notemp-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      handles.push(owner);
      await owner.query('CREATE TABLE idx_first.jobs (id INT, status TEXT)');
      expect(
        (
          await owner.query(
            "SELECT has_database_privilege(current_user, current_database(), 'TEMPORARY') AS temp",
          )
        ).rows,
      ).toEqual([{ temp: false }]);

      const results = await migrateOne(owner, 'add_notemp', [
        'CREATE UNIQUE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status) WHERE jobs.status IS NOT NULL',
      ]);

      expect(results.map((result) => result.error ?? result.success)).toEqual([
        true,
      ]);
    });

    it('does not replay a plain CREATE INDEX that an earlier run built before failing its check', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE TABLE idx_first.jobs (id INT, status TEXT)');
      // Built by the earlier run, whose check then failed (a timeout).
      await db.query('CREATE INDEX shared_idx ON idx_first.jobs (status)');

      const results = await migrateOne(db, 'add_plain', [
        'CREATE INDEX shared_idx ON jobs (status)',
      ]);

      expect(results.map((result) => result.error ?? result.success)).toEqual([
        true,
      ]);
    });

    it('refuses an index whose expression cannot be checked against its table, before building anything', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      await db.query('CREATE TABLE idx_first.jobs (id INT, status TEXT)');

      const results = await migrateOne(db, 'add_bad_expression', [
        'CREATE INDEX IF NOT EXISTS bad_idx ON jobs ((no_such_column))',
      ]);

      expect(results.map((result) => result.success)).toEqual([false]);
      expect(String(results[0].error)).toContain(
        'refused under --postgres-safe before the concurrent index phase ran anything',
      );
      expect(await uniqueness(db, 'bad_idx')).toEqual([]);
    });

    it('drops only an INVALID index whose table is the pending statement target, and does not record the skipped create as done', async () => {
      const db = await databaseWithSearchPath('idx_first', 'idx_second');
      // Same schema, same index name, a different table.
      await tableWithInvalidIndex(db, 'idx_first', 'jobs', 'shared_idx');
      await db.query('CREATE TABLE idx_first.tasks (id INT, status TEXT)');

      const results = await new MigrationTracker({ db }).applyAll(
        [pendingIndex('add_index_tasks_shared', 'shared_idx', '"tasks"')],
        { atomic: true, postgresSafe: true },
      );
      // IF NOT EXISTS skipped the create: tasks has no such index, so the
      // migration is not completed and stays retryable.
      expect(results.map((result) => result.success)).toEqual([false]);

      const owner = await db.query(
        `SELECT t.relname AS table_name, i.indisvalid AS is_valid
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'shared_idx' AND n.nspname = 'idx_first'`,
      );
      expect(owner.rows).toEqual([{ table_name: 'jobs', is_valid: false }]);
    });
  },
);
