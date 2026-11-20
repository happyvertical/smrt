/**
 * The checks around a `--postgres-safe` CREATE INDEX, against a real
 * PostgreSQL server (PGlite): an index built as its statement describes is
 * accepted however PostgreSQL stores it, an index that differs is not, and
 * whatever cannot be checked is refused before anything runs. Runs under
 * `pnpm test:pglite` (and so in the PostgreSQL lane); skipped on the default
 * SQLite run.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestDatabase } from '../../testing/database.js';
import { MigrationTracker } from '../tracker.js';

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  '--postgres-safe CREATE INDEX checks on a real server',
  () => {
    let db: DatabaseInterface;
    let runs = 0;

    beforeEach(async () => {
      db = await getTestDatabase({
        type: 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      await db.query(
        'CREATE TABLE jobs (id INT, status TEXT, active BOOLEAN, archived BOOLEAN)',
      );
    });
    afterEach(async () => {
      await db.close?.();
    });

    const migrate = (up: string[]) =>
      new MigrationTracker({ db, engineHint: 'postgres' }).applyAll(
        [
          {
            id: `index_check_${++runs}`,
            description: 'index check',
            version: '1.0.0',
            up,
            down: [],
          },
        ],
        { atomic: true, postgresSafe: true },
      );
    const outcome = async (up: string[]) =>
      (await migrate(up)).map((result) =>
        result.error === undefined ? 'ok' : String(result.error),
      );
    const indexes = async (table = 'jobs') =>
      (
        await db.query(
          `SELECT c.relname AS name
             FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE i.indrelid = to_regclass(?) ORDER BY c.relname`,
          table,
        )
      ).rows.map((row) => String(row.name));

    describe('a key written as an expression that PostgreSQL stores as a column', () => {
      it.each([
        'CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs ((status))',
        'CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs ((status COLLATE "C"))',
        'CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs ((status::text))',
        'CREATE UNIQUE INDEX IF NOT EXISTS jobs_status_idx ON jobs ((status))',
      ])('accepts %s as built', async (sql) => {
        expect(await outcome([sql])).toEqual(['ok']);
        // And a later run finds it built as described, not different.
        expect(await outcome([sql])).toEqual(['ok']);
        expect(await indexes()).toEqual(['jobs_status_idx']);
      });

      it.each([
        'CREATE INDEX IF NOT EXISTS jobs_key_idx ON jobs ((id))',
        'CREATE INDEX IF NOT EXISTS jobs_key_idx ON jobs ((active))',
        'CREATE INDEX IF NOT EXISTS jobs_key_idx ON jobs ((created_at))',
        'CREATE UNIQUE INDEX IF NOT EXISTS jobs_key_idx ON jobs ((ref))',
      ])('accepts %s on a column of a type without collations as built', async (sql) => {
        await db.query(
          'ALTER TABLE jobs ADD COLUMN created_at TIMESTAMP, ADD COLUMN ref UUID',
        );
        expect(await outcome([sql])).toEqual(['ok']);
        expect(await outcome([sql])).toEqual(['ok']);
        expect(await indexes()).toEqual(['jobs_key_idx']);
      });

      it('does not accept an existing index of the column without the collation the expression carries', async () => {
        await db.query('CREATE INDEX jobs_status_idx ON jobs (status)');
        const [message] = await outcome([
          'CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs ((status COLLATE "C"))',
        ]);
        expect(message).toContain('is not the index its statement describes');
      });
    });

    describe('a collation or operator class named the same in two schemas', () => {
      beforeEach(async () => {
        await db.query('CREATE SCHEMA first_ns');
        await db.query('CREATE SCHEMA second_ns');
        await db.query('CREATE COLLATION first_ns.fold FROM "C"');
        await db.query('CREATE COLLATION second_ns.fold FROM "POSIX"');
        for (const schema of ['first_ns', 'second_ns'])
          await db.query(
            `CREATE OPERATOR CLASS ${schema}.cmp_ops FOR TYPE text USING btree AS
               OPERATOR 1 <, OPERATOR 2 <=, OPERATOR 3 =, OPERATOR 4 >=, OPERATOR 5 >,
               FUNCTION 1 bttextcmp(text, text)`,
          );
        await db.query('SET search_path TO first_ns, second_ns, public');
        await db.query('CREATE TABLE first_ns.tasks (id INT, status TEXT)');
      });

      it('does not accept an index with the other schema collation of the name', async () => {
        await db.query(
          'CREATE UNIQUE INDEX tasks_status_idx ON first_ns.tasks (status COLLATE second_ns.fold)',
        );
        const [message] = await outcome([
          'CREATE UNIQUE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status COLLATE fold)',
        ]);
        expect(message).toContain('is not the index its statement describes');
      });

      it('accepts an index with the collation the name resolves to', async () => {
        await db.query(
          'CREATE UNIQUE INDEX tasks_status_idx ON first_ns.tasks (status COLLATE first_ns.fold)',
        );
        expect(
          await outcome([
            'CREATE UNIQUE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status COLLATE fold)',
          ]),
        ).toEqual(['ok']);
      });

      it('does not accept an index with the other schema operator class of the name', async () => {
        await db.query(
          'CREATE UNIQUE INDEX tasks_status_idx ON first_ns.tasks (status second_ns.cmp_ops)',
        );
        const [message] = await outcome([
          'CREATE UNIQUE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status cmp_ops)',
        ]);
        expect(message).toContain('is not the index its statement describes');
      });

      it('accepts an index with the operator class a qualified name or the search path resolves to', async () => {
        expect(
          await outcome([
            'CREATE UNIQUE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status second_ns.cmp_ops)',
          ]),
        ).toEqual(['ok']);
        expect(
          await outcome([
            'CREATE UNIQUE INDEX IF NOT EXISTS tasks_other_idx ON tasks (status cmp_ops)',
          ]),
        ).toEqual(['ok']);
      });
    });

    it('does not accept a predicate on a column whose name ends in U+00A0 as the predicate on the column without it', async () => {
      await db.query('ALTER TABLE jobs ADD COLUMN "active " BOOLEAN');
      await db.query(
        'CREATE UNIQUE INDEX jobs_active_idx ON jobs (status) WHERE active',
      );
      const [message] = await outcome([
        'CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_idx ON jobs (status) WHERE active ',
      ]);
      expect(message).toContain('is not the index its statement describes');
    });

    describe('a table whose row-level security hides every row from the migrating role', () => {
      beforeEach(async () => {
        await db.query('CREATE ROLE smrt_idx_owner');
        await db.query('GRANT CREATE ON SCHEMA public TO smrt_idx_owner');
        await db.query('ALTER TABLE jobs OWNER TO smrt_idx_owner');
        await db.query(
          'CREATE UNIQUE INDEX jobs_status_idx ON jobs (status) WHERE active',
        );
        await db.query('ALTER TABLE jobs ENABLE ROW LEVEL SECURITY');
        await db.query('ALTER TABLE jobs FORCE ROW LEVEL SECURITY');
        await db.query(
          'CREATE POLICY jobs_hidden ON jobs FOR SELECT USING (false)',
        );
        await db.query('SET ROLE smrt_idx_owner');
      });
      afterEach(async () => {
        await db.query('RESET ROLE');
      });

      it('does not accept a partial index whose predicate differs', async () => {
        const [message] = await outcome([
          'CREATE UNIQUE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status) WHERE archived',
        ]);
        expect(message).toContain('is not the index its statement describes');
      });

      it('accepts the partial index its statement describes', async () => {
        expect(
          await outcome([
            'CREATE UNIQUE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status) WHERE active',
          ]),
        ).toEqual(['ok']);
      });
    });

    describe('refusals before anything runs', () => {
      it('refuses a create whose index name it cannot read, and builds nothing', async () => {
        await expect(
          migrate(['CREATE INDEX U&"jobs\\0061idx" ON jobs (status)']),
        ).rejects.toThrow('could not be read with certainty');
        expect(await indexes()).toEqual([]);
      });

      it('keeps the old unique index when the create that would replace it cannot be read', async () => {
        await db.query('CREATE UNIQUE INDEX jobs_status_idx ON jobs (status)');
        await expect(
          migrate([
            'DROP INDEX jobs_status_idx',
            'CREATE UNIQUE INDEX IF NOT EXISTS jobs_status_idx ON U&"jobs" (status)',
          ]),
        ).rejects.toThrow('could not be read with certainty');
        await db.query(`INSERT INTO jobs (id, status) VALUES (1, 'same')`);
        await expect(
          db.query(`INSERT INTO jobs (id, status) VALUES (2, 'same')`),
        ).rejects.toThrow();
      });

      it('keeps the old index when the create that would replace it cannot be checked', async () => {
        await db.query('CREATE INDEX jobs_status_idx ON jobs (status)');
        const [message] = await outcome([
          'DROP INDEX jobs_status_idx',
          'CREATE INDEX jobs_status_idx ON jobs ((lower(no_such_column)))',
        ]);
        expect(message).toContain(
          'refused under --postgres-safe before the concurrent index phase ran anything',
        );
        expect(await indexes()).toEqual(['jobs_status_idx']);
      });
    });

    describe('a batch whose migrations each commit on their own', () => {
      const definition = (id: string, up: string[]) => ({
        id,
        description: id,
        version: '1.0.0',
        up,
        down: [],
      });
      const migrateEach = (...definitions: ReturnType<typeof definition>[]) =>
        new MigrationTracker({ db, engineHint: 'postgres' }).applyAll(
          definitions,
          { postgresSafe: true },
        );

      it("keeps the old index when a later migration's create that would replace it cannot be checked", async () => {
        await db.query('CREATE INDEX jobs_status_idx ON jobs (status)');
        await expect(
          migrateEach(
            definition('drop_jobs_status_idx', ['DROP INDEX jobs_status_idx']),
            definition('add_jobs_status_idx', [
              'CREATE INDEX jobs_status_idx ON jobs ((lower(no_such_column)))',
            ]),
          ),
        ).rejects.toThrow(
          'Migration add_jobs_status_idx: The CREATE INDEX statement',
        );
        expect(await indexes()).toEqual(['jobs_status_idx']);
      });

      it("keeps the old unique index when a later migration's create that would replace it cannot be read", async () => {
        await db.query('CREATE UNIQUE INDEX jobs_status_idx ON jobs (status)');
        await expect(
          migrateEach(
            definition('drop_jobs_status_idx', ['DROP INDEX jobs_status_idx']),
            definition('add_jobs_status_idx', [
              'CREATE UNIQUE INDEX IF NOT EXISTS jobs_status_idx ON U&"jobs" (status)',
            ]),
          ),
        ).rejects.toThrow('could not be read with certainty');
        await db.query(`INSERT INTO jobs (id, status) VALUES (1, 'same')`);
        await expect(
          db.query(`INSERT INTO jobs (id, status) VALUES (2, 'same')`),
        ).rejects.toThrow();
      });

      it('builds a create on a column its own migration adds, after an earlier migration dropped another index', async () => {
        await db.query('CREATE INDEX jobs_old_idx ON jobs (id)');
        const results = await migrateEach(
          definition('drop_jobs_old_idx', ['DROP INDEX jobs_old_idx']),
          definition('add_jobs_owner_idx', [
            'ALTER TABLE jobs ADD COLUMN owner TEXT',
            'CREATE INDEX jobs_owner_idx ON jobs ((lower(owner)))',
          ]),
        );
        expect(results.map((result) => result.error)).toEqual([
          undefined,
          undefined,
        ]);
        expect(await indexes()).toEqual(['jobs_owner_idx']);
      });
    });

    describe('a batch that repeats a migration already recorded as applied', () => {
      const appliedUnnamed = {
        id: 'applied_unnamed_index',
        description: 'unnamed index',
        version: '1.0.0',
        up: ['CREATE INDEX ON jobs (status)'],
        down: [],
      };
      const pending = {
        id: 'add_jobs_active_idx',
        description: 'named index',
        version: '1.0.0',
        up: ['CREATE INDEX IF NOT EXISTS jobs_active_idx ON jobs (active)'],
        down: [],
      };
      const tracker = () =>
        new MigrationTracker({ db, engineHint: 'postgres' });

      beforeEach(async () => {
        // Recorded `completed` by an atomic run without --postgres-safe,
        // which keeps an unnamed create in the transaction.
        const [first] = await tracker().applyAll([appliedUnnamed], {
          atomic: true,
        });
        expect(first.success).toBe(true);
      });

      it('skips the applied migration without checking its statements, and applies the pending one', async () => {
        const results = await tracker().applyAll([appliedUnnamed, pending], {
          atomic: true,
          postgresSafe: true,
        });
        expect(
          results.map((result) => [result.success, result.skipped]),
        ).toEqual([
          [true, true],
          [true, false],
        ]);
        expect(await indexes()).toEqual(['jobs_active_idx', 'jobs_status_idx']);
      });

      it('still refuses the applied migration when it is forced to run again', async () => {
        await expect(
          tracker().applyAll([appliedUnnamed, pending], {
            atomic: true,
            postgresSafe: true,
            forceMigrations: [appliedUnnamed.id],
          }),
        ).rejects.toThrow('names no index');
        expect(await indexes()).toEqual(['jobs_status_idx']);
      });
    });

    describe('a create on a column a deferred statement adds', () => {
      beforeEach(async () => {
        await db.query('CREATE INDEX jobs_old_idx ON jobs (id)');
        await db.query(
          'ALTER TABLE jobs ADD CONSTRAINT jobs_id_check CHECK (id > 0) NOT VALID',
        );
      });
      const addColumnThenIndex = (create: string) => [
        'ALTER TABLE jobs VALIDATE CONSTRAINT jobs_id_check',
        'ALTER TABLE jobs ADD COLUMN owner TEXT',
        create,
      ];

      it.each([
        'CREATE INDEX jobs_owner_idx ON jobs ((lower(owner)))',
        'CREATE INDEX jobs_owner_idx ON jobs (id) WHERE owner IS NOT NULL',
      ])('builds %s after an earlier drop of another index', async (create) => {
        expect(
          await outcome([
            'DROP INDEX jobs_old_idx',
            ...addColumnThenIndex(create),
          ]),
        ).toEqual(['ok']);
        expect(await indexes()).toEqual(['jobs_owner_idx']);
      });

      it('builds it when an earlier migration of the batch dropped another index', async () => {
        const results = await new MigrationTracker({
          db,
          engineHint: 'postgres',
        }).applyAll(
          [
            {
              id: 'drop_jobs_old_idx',
              description: 'drop',
              version: '1.0.0',
              up: ['DROP INDEX jobs_old_idx'],
              down: [],
            },
            {
              id: 'add_jobs_owner_idx',
              description: 'add',
              version: '1.0.0',
              up: addColumnThenIndex(
                'CREATE INDEX jobs_owner_idx ON jobs ((lower(owner)))',
              ),
              down: [],
            },
          ],
          { atomic: true, postgresSafe: true },
        );
        expect(results.map((result) => result.error)).toEqual([
          undefined,
          undefined,
        ]);
        expect(await indexes()).toEqual(['jobs_owner_idx']);
      });

      it('replays the deferred column change on a retry after the index build failed, and fails loudly', async () => {
        // Known limit: deferred statements commit as they run and a retry
        // runs them all again, so a column the earlier attempt added makes
        // the retry fail; the record stays failed and retryable.
        const run = () =>
          new MigrationTracker({ db, engineHint: 'postgres' }).applyAll(
            [
              {
                id: 'add_jobs_owner_key',
                description: 'add owner and its key',
                version: '1.0.0',
                up: addColumnThenIndex(
                  'CREATE UNIQUE INDEX jobs_owner_key ON jobs ((coalesce(owner, status)))',
                ),
                down: [],
              },
            ],
            { atomic: true, postgresSafe: true, reconcile: true },
          );
        const record = async () =>
          (
            await db.query(
              `SELECT status, error_message FROM _smrt_schema_migrations
                WHERE name = 'add_jobs_owner_key'`,
            )
          ).rows[0] as { status: string; error_message: string };
        await db.query(
          `INSERT INTO jobs (id, status) VALUES (1, 'same'), (2, 'same')`,
        );
        const [first] = await run();
        expect(String(first.error)).toContain('jobs_owner_key');

        await db.query('DELETE FROM jobs WHERE id = 2');
        const [retry] = await run();
        expect(String(retry.error)).toContain('already exists');
        const after = await record();
        expect(after.status).toBe('failed');
        expect(after.error_message).toMatch(
          /^\[smrt: concurrent-index phase 1 committed\] /,
        );
        expect(after.error_message).not.toContain('deferred statements done');
      });

      it('refuses it before anything runs when an earlier statement dropped its own index name', async () => {
        await db.query('CREATE INDEX jobs_owner_idx ON jobs (status)');
        const [message] = await outcome([
          'DROP INDEX jobs_owner_idx',
          ...addColumnThenIndex(
            'CREATE INDEX jobs_owner_idx ON jobs ((lower(owner)))',
          ),
        ]);
        expect(message).toContain(
          'refused under --postgres-safe before the concurrent index phase ran anything',
        );
        expect(await indexes()).toEqual(['jobs_old_idx', 'jobs_owner_idx']);
      });
    });

    it('runs an authored drop and rename where PostgreSQL resolves them, not in the schema of an earlier create', async () => {
      await db.query('CREATE SCHEMA first_ns');
      await db.query('CREATE SCHEMA second_ns');
      await db.query('SET search_path TO first_ns, second_ns, public');
      await db.query(
        'CREATE TABLE first_ns.accounts (id INT PRIMARY KEY, email TEXT)',
      );
      await db.query('CREATE INDEX old_idx ON first_ns.accounts (email)');
      await db.query('CREATE INDEX tmp_idx ON first_ns.accounts (id, email)');
      await db.query(
        'CREATE TABLE second_ns.orders (id INT PRIMARY KEY, ref TEXT)',
      );
      await db.query(
        'ALTER TABLE second_ns.orders ADD CONSTRAINT orders_ref_check CHECK (ref IS NOT NULL) NOT VALID',
      );
      await db.query('CREATE UNIQUE INDEX old_idx ON second_ns.orders (ref)');

      expect(
        await outcome([
          'ALTER TABLE second_ns.orders VALIDATE CONSTRAINT orders_ref_check',
          'CREATE UNIQUE INDEX tmp_idx ON second_ns.orders (ref)',
          'DROP INDEX old_idx',
          'ALTER INDEX tmp_idx RENAME TO old_idx',
        ]),
      ).toEqual(['ok']);

      const owners = await db.query(
        `SELECT n.nspname AS schema_name, c.relname AS index_name
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname IN ('old_idx', 'tmp_idx')
          ORDER BY 1, 2`,
      );
      // As written: the drop removed first_ns.old_idx and the rename renamed
      // first_ns.tmp_idx; the second schema's unique index is untouched.
      expect(owners.rows).toEqual([
        { schema_name: 'first_ns', index_name: 'old_idx' },
        { schema_name: 'second_ns', index_name: 'old_idx' },
        { schema_name: 'second_ns', index_name: 'tmp_idx' },
      ]);
    });
  },
);
