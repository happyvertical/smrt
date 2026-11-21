/**
 * Retrying a `--postgres-safe` migration whose deferred statements partly
 * committed (#5325), against a real PostgreSQL server (PGlite).
 *
 * Phase 1 commits a migration's transaction-safe statements; phase 2 runs the
 * rest (a `VALIDATE CONSTRAINT` and every later statement, and the index
 * builds) one by one. A retry skips phase 1. It must not run a deferred
 * statement it cannot confirm has not already taken effect, must refuse when
 * the plan it would follow is not the plan the earlier attempt recorded, and
 * must leave the session as it found it.
 *
 * Runs under `pnpm test:pglite` (and so in the PostgreSQL lane); skipped on the
 * default SQLite run.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MigrationDefinition } from '../../schema/types.js';
import { getTestDatabase } from '../../testing/database.js';
import { MigrationTracker } from '../tracker.js';
import type { ApplyMigrationsOptions } from '../types.js';

const SENTINEL = 'sentinel-7f3a';

/** A batch flag other than the targeted `--force-migration`. */
const BATCH_FORCE = /--force(?!-migration)/;

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'retrying a partly committed deferred phase on a real server',
  () => {
    let db: DatabaseInterface;

    beforeEach(async () => {
      db = await getTestDatabase({
        type: 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      await db.query('CREATE TABLE parent (id INT PRIMARY KEY)');
      await db.query(
        'CREATE TABLE child (id INT, pid INT, tag TEXT, n INT NOT NULL DEFAULT 0)',
      );
      await db.query('INSERT INTO parent VALUES (1)');
      // Two rows share an id: a unique index on it fails to build.
      await db.query(
        "INSERT INTO child (id, pid, tag) VALUES (1, 1, 'a'), (1, 1, 'b')",
      );
    });
    afterEach(async () => {
      await db.close?.();
    });

    const definition = (id: string, up: string[]): MigrationDefinition => ({
      id,
      description: id,
      version: '1.0.0',
      up,
      down: [],
    });

    const migrate = (
      definitions: MigrationDefinition[],
      options: ApplyMigrationsOptions = {},
      tracker: { useConcurrentIndexes?: boolean; db?: DatabaseInterface } = {},
    ) =>
      new MigrationTracker({
        db: tracker.db ?? db,
        engineHint: 'postgres',
        useConcurrentIndexes: tracker.useConcurrentIndexes ?? true,
      }).applyAll(definitions, {
        atomic: true,
        postgresSafe: true,
        ...options,
      });

    const errorOf = (result: { error?: unknown } | undefined) =>
      result?.error instanceof Error
        ? result.error.message
        : String(result?.error ?? '');

    const row = async (name: string) =>
      (
        await db.query(
          'SELECT status, error_message, attempts FROM _smrt_schema_migrations WHERE name = ?',
          name,
        )
      ).rows[0] as
        | { status: string; error_message: string | null; attempts: number }
        | undefined;

    const counts = async () =>
      (await db.query('SELECT tag, n FROM child ORDER BY tag')).rows.map(
        (r) => `${r.tag}:${r.n}`,
      );

    const indexValid = async (name: string) =>
      (
        await db.query(
          `SELECT i.indisvalid AS valid FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ?`,
          name,
        )
      ).rows.map((r) => r.valid);

    const fixDuplicates = () => db.query("DELETE FROM child WHERE tag = 'b'");

    const addForeignKey = [
      'ALTER TABLE child ADD CONSTRAINT child_pid_fk FOREIGN KEY (pid) REFERENCES parent (id) NOT VALID',
      'ALTER TABLE child VALIDATE CONSTRAINT child_pid_fk',
    ];

    /** Deferred: VALIDATE, a data change, a unique build that fails. */
    const withDataChange = definition('retry_data_change', [
      ...addForeignKey,
      `UPDATE child SET n = n + 1 /* ${SENTINEL} */`,
      'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
    ]);

    /** Deferred: VALIDATE and a unique build that fails. */
    const indexOnly = (id = 'retry_index_only') =>
      definition(id, [
        ...addForeignKey,
        'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
      ]);

    async function failOnce(def: MigrationDefinition) {
      const [first] = await migrate([def]);
      expect(first?.success, errorOf(first)).toBe(false);
      expect((await row(def.id))?.status).toBe('failed');
    }

    describe('a deferred statement that may already have taken effect', () => {
      it('is not run again on retry, and nothing else runs', async () => {
        await failOnce(withDataChange);
        expect(await counts()).toEqual(['a:1', 'b:1']);
        await fixDuplicates();

        const [retry] = await migrate([withDataChange], { reconcile: true });

        expect(retry?.success).toBe(false);
        expect(await counts()).toEqual(['a:1']);
        expect(await indexValid('child_id_uq')).not.toContain(true);
        const message = errorOf(retry);
        expect(message).toContain('retry_data_change');
        expect(message).toContain('statement 2 of 3');
        expect(message).toContain('data change');
        expect(message).not.toContain(SENTINEL);
        expect(message).not.toMatch(BATCH_FORCE);
        const record = await row('retry_data_change');
        expect(record?.status).toBe('failed');
        expect(record?.error_message ?? '').not.toContain(SENTINEL);
      });

      it('is refused the same way without a reconciling run', async () => {
        await failOnce(withDataChange);
        await fixDuplicates();

        const [retry] = await migrate([withDataChange]);

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('statement 2 of 3');
        expect(errorOf(retry)).not.toMatch(BATCH_FORCE);
        expect(await counts()).toEqual(['a:1']);
      });

      it('stays refused under the batch-wide force', async () => {
        await failOnce(withDataChange);
        await fixDuplicates();

        const [retry] = await migrate([withDataChange], { force: true });

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('statement 2 of 3');
        expect(await counts()).toEqual(['a:1']);
      });

      it('runs again only when that migration is forced by name', async () => {
        await failOnce(withDataChange);
        await fixDuplicates();

        const [retry] = await migrate([withDataChange], {
          forceMigrations: ['retry_data_change'],
        });

        expect(retry?.success, errorOf(retry)).toBe(true);
        // The documented consequence of the explicit recovery path.
        expect(await counts()).toEqual(['a:2']);
        expect(await indexValid('child_id_uq')).toEqual([true]);
      });

      it('is refused when the deferred statement creates a session object', async () => {
        const def = definition('retry_temp_table', [
          ...addForeignKey,
          'CREATE TEMP TABLE scratch (id INT)',
          'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
        ]);
        await failOnce(def);
        await fixDuplicates();

        const [retry] = await migrate([def], { reconcile: true });

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('statement 2 of 3');
      });

      it('is refused when a validation shares its string with another statement', async () => {
        const def = definition('retry_compound', [
          addForeignKey[0],
          `${addForeignKey[1]}; UPDATE child SET n = n + 1`,
          'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
        ]);
        await failOnce(def);
        await fixDuplicates();

        const [retry] = await migrate([def], { reconcile: true });

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('statement 1 of 2');
      });
    });

    describe('a deferred list of validations and index statements', () => {
      it('is retried to completion', async () => {
        const def = indexOnly();
        await failOnce(def);
        await fixDuplicates();

        const [retry] = await migrate([def], { reconcile: true });

        expect(retry?.success, errorOf(retry)).toBe(true);
        expect(await indexValid('child_id_uq')).toEqual([true]);
        expect((await row(def.id))?.status).toBe('completed');
      });

      it('is retried under the batch-wide force too', async () => {
        const def = indexOnly();
        await failOnce(def);
        await fixDuplicates();

        const [retry] = await migrate([def], { force: true });

        expect(retry?.success, errorOf(retry)).toBe(true);
      });
    });

    describe('the plan an earlier attempt followed', () => {
      it('refuses when the concurrency setting changed the routing', async () => {
        await db.query("INSERT INTO child (id, pid, tag) VALUES (2, 9, 'c')");
        await db.query("DELETE FROM child WHERE tag = 'b'");
        const def = definition('retry_routing', [
          ...addForeignKey,
          'ALTER TABLE child ADD COLUMN extra INT',
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS child_n_idx ON child (n)',
        ]);
        // The orphan row fails the validation.
        await failOnce(def);
        await db.query("DELETE FROM child WHERE tag = 'c'");

        const [retry] = await migrate(
          [def],
          { reconcile: true },
          { useConcurrentIndexes: false },
        );

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('retry_routing');
        expect(errorOf(retry)).toContain('plan');
        expect(errorOf(retry)).not.toMatch(BATCH_FORCE);
        const columns = (
          await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'child' AND column_name = 'extra'",
          )
        ).rows;
        expect(columns).toEqual([]);
        expect((await row('retry_routing'))?.status).toBe('failed');
      });

      it('refuses a retry outside concurrent-index mode', async () => {
        const def = definition('retry_mode_off', [
          `UPDATE child SET n = n + 1 /* ${SENTINEL} */`,
          'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
        ]);
        await failOnce(def);
        expect(await counts()).toEqual(['a:1', 'b:1']);
        await fixDuplicates();

        const [retry] = await migrate(
          [def],
          { reconcile: true, postgresSafe: false },
          { useConcurrentIndexes: false },
        );

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('plan');
        expect(errorOf(retry)).not.toContain(SENTINEL);
        expect(await counts()).toEqual(['a:1']);
      });

      it('refuses a marker copied from another migration', async () => {
        await failOnce(indexOnly('retry_source'));
        const def = definition('retry_target', [
          'ALTER TABLE child ADD COLUMN extra INT',
          'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
        ]);
        await failOnce(def);
        await db.query(
          `UPDATE _smrt_schema_migrations SET error_message =
             (SELECT error_message FROM _smrt_schema_migrations WHERE name = 'retry_source')
           WHERE name = 'retry_target'`,
        );
        await fixDuplicates();

        const [retry] = await migrate([def], { reconcile: true });

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('plan');
      });

      it('refuses a marker whose plan digest was altered', async () => {
        const def = indexOnly();
        await failOnce(def);
        const recorded = (await row(def.id))?.error_message ?? '';
        const forged = recorded.replace(/[0-9a-f]{64}/, '0'.repeat(64));
        expect(forged).not.toBe(recorded);
        await db.query(
          'UPDATE _smrt_schema_migrations SET error_message = ? WHERE name = ?',
          forged,
          def.id,
        );
        await fixDuplicates();

        const [retry] = await migrate([def], { reconcile: true });

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('plan');
      });

      describe('a marker recorded before plans were recorded', () => {
        const legacy =
          '[smrt: concurrent-index phase 1 committed] Concurrent index build pending: the non-index half of this migration committed but the CONCURRENTLY index DDL had not completed. Re-run db:migrate to finish it.';

        async function legacyRow(def: MigrationDefinition) {
          await failOnce(def);
          await db.query(
            'UPDATE _smrt_schema_migrations SET error_message = ? WHERE name = ?',
            legacy,
            def.id,
          );
          await fixDuplicates();
        }

        it('retries a list of validations and index statements', async () => {
          const def = indexOnly();
          await legacyRow(def);

          const [retry] = await migrate([def], { reconcile: true });

          expect(retry?.success, errorOf(retry)).toBe(true);
        });

        it('refuses when this run routes without concurrent indexes', async () => {
          const def = indexOnly();
          await legacyRow(def);

          const [retry] = await migrate(
            [def],
            { reconcile: true },
            { useConcurrentIndexes: false },
          );

          expect(retry?.success).toBe(false);
          expect(errorOf(retry)).toContain('plan');
        });

        it('refuses a list with a data change', async () => {
          await legacyRow(withDataChange);

          const [retry] = await migrate([withDataChange], { reconcile: true });

          expect(retry?.success).toBe(false);
          expect(await counts()).toEqual(['a:1']);
        });
      });
    });

    describe('the session the deferred statements run on', () => {
      beforeEach(async () => {
        await db.query('CREATE SCHEMA app_ns');
        await db.query('CREATE SCHEMA other_ns');
        for (const schema of ['app_ns', 'other_ns'])
          await db.query(`CREATE TABLE ${schema}.items (id INT, v INT)`);
        // The caller's own session setting, as an application sets it.
        await db.query('SET search_path TO app_ns, public');
        await new MigrationTracker({ db, engineHint: 'postgres' }).initialize();
      });

      const showSetting = async (name: string) =>
        String(
          (await db.query(`SELECT current_setting('${name}') AS value`)).rows[0]
            ?.value,
        );

      const indexSchemas = async (name: string) =>
        (
          await db.query(
            `SELECT n.nspname AS schema FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relname = ? ORDER BY 1`,
            name,
          )
        ).rows.map((r) => r.schema);

      const switchesPath = (id: string, extra: string[] = []) =>
        definition(id, [
          'ALTER TABLE items ADD CONSTRAINT items_v_check CHECK (v >= 0) NOT VALID',
          'ALTER TABLE items VALIDATE CONSTRAINT items_v_check',
          'SET search_path TO other_ns, public',
          ...extra,
        ]);

      it('returns the session with the caller settings and without the deferred ones', async () => {
        const lockTimeout = await showSetting('lock_timeout');

        const [result] = await migrate([
          switchesPath('switch_path', [
            'CREATE INDEX IF NOT EXISTS items_v_idx ON items (v)',
          ]),
        ]);

        expect(result?.success, errorOf(result)).toBe(true);
        // The authored setting applied to the statement after it.
        expect(await indexSchemas('items_v_idx')).toEqual(['other_ns']);
        expect(await showSetting('search_path')).toBe('app_ns, public');
        expect(await showSetting('lock_timeout')).toBe(lockTimeout);
      });

      it('writes the record to its own table after a deferred path change', async () => {
        await db.query(
          'CREATE TABLE other_ns._smrt_schema_migrations (LIKE app_ns._smrt_schema_migrations INCLUDING ALL)',
        );
        await db.query(
          `INSERT INTO other_ns._smrt_schema_migrations (id, name, version, checksum, status)
           VALUES ('decoy', 'switch_record', '1', 'x', 'failed')`,
        );

        const [result] = await migrate([switchesPath('switch_record')]);

        expect(result?.success, errorOf(result)).toBe(true);
        const own = await db.query(
          "SELECT status FROM app_ns._smrt_schema_migrations WHERE name = 'switch_record'",
        );
        const decoy = await db.query(
          "SELECT status FROM other_ns._smrt_schema_migrations WHERE name = 'switch_record'",
        );
        expect(own.rows).toEqual([{ status: 'completed' }]);
        expect(decoy.rows).toEqual([{ status: 'failed' }]);
      });

      it('starts every migration from the caller settings', async () => {
        const [first, second] = await migrate([
          switchesPath('switch_first'),
          definition('switch_second', [
            'CREATE INDEX IF NOT EXISTS items_id_idx ON items (id)',
          ]),
        ]);

        expect(first?.success, errorOf(first)).toBe(true);
        expect(second?.success, errorOf(second)).toBe(true);
        expect(await indexSchemas('items_id_idx')).toEqual(['app_ns']);
      });

      it('records the outcome as the caller after a deferred role change', async () => {
        await db.query('CREATE ROLE deferred_role NOLOGIN');
        const def = definition('switch_role', [
          'ALTER TABLE items ADD CONSTRAINT items_v_check CHECK (v >= 0) NOT VALID',
          'ALTER TABLE items VALIDATE CONSTRAINT items_v_check',
          'SET ROLE deferred_role',
        ]);

        const [result] = await migrate([def]);

        expect(result?.success, errorOf(result)).toBe(true);
        expect((await row('switch_role'))?.status).toBe('completed');
        expect(await showSetting('role')).toBe('none');
      });
    });

    describe('another run of the same migration', () => {
      /** The row as another runner leaves it, written behind this run's back. */
      const finishElsewhere = (name: string) =>
        db.query(
          `UPDATE _smrt_schema_migrations
              SET status = 'completed', error_message = NULL, attempts = attempts + 1
            WHERE name = ?`,
          name,
        );

      const firstRun = definition('runner_race', [
        ...addForeignKey,
        `UPDATE child SET n = n + 1 /* ${SENTINEL} */`,
        'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
      ]);

      it('does not run the deferred statements while another run holds the migration', async () => {
        await fixDuplicates();
        const held: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) =>
            /pg_try_advisory_lock/.test(sql)
              ? { rows: [{ locked: false }], rowCount: 1 }
              : db.query(sql, ...vars)) as DatabaseInterface['query'],
        };

        const [result] = await migrate([firstRun], {}, { db: held });

        expect(result?.success).toBe(false);
        expect(errorOf(result)).toContain('another run');
        expect(await counts()).toEqual(['a:0']);
      });

      it('does not run them after another run finished the migration', async () => {
        await fixDuplicates();
        const raced: DatabaseInterface = {
          ...db,
          transaction: (async (callback: never) => {
            const committed = await db.transaction?.(callback);
            await finishElsewhere('runner_race');
            return committed;
          }) as DatabaseInterface['transaction'],
        };

        await migrate([firstRun], {}, { db: raced });

        expect(await counts()).toEqual(['a:0']);
        expect((await row('runner_race'))?.status).toBe('completed');
      });

      it('does not take over a record another run changed after this run read it', async () => {
        const def = indexOnly();
        await failOnce(def);
        await fixDuplicates();
        const stale: DatabaseInterface = {
          ...db,
          transaction: (async (
            callback: (tx: DatabaseInterface) => Promise<unknown>,
          ) =>
            db.transaction?.(async (tx) =>
              callback({
                ...tx,
                query: (async (sql: string, ...vars: unknown[]) => {
                  const read = await tx.query(sql, ...vars);
                  if (
                    /^SELECT \* FROM _smrt_schema_migrations WHERE name/.test(
                      sql,
                    )
                  )
                    await tx.query(
                      'UPDATE _smrt_schema_migrations SET attempts = attempts + 1 WHERE name = ?',
                      def.id,
                    );
                  return read;
                }) as DatabaseInterface['query'],
              } as DatabaseInterface),
            )) as DatabaseInterface['transaction'],
        };

        const [result] = await migrate(
          [def],
          { reconcile: true },
          { db: stale },
        );

        expect(result?.success).toBe(false);
        expect(errorOf(result)).toContain('another run');
        expect(await indexValid('child_id_uq')).not.toContain(true);
      });

      it('does not record a late failure over a completed migration', async () => {
        await fixDuplicates();
        const late: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) => {
            if (/CREATE UNIQUE INDEX CONCURRENTLY/.test(sql)) {
              await finishElsewhere('runner_race');
              throw new Error('build interrupted');
            }
            return db.query(sql, ...vars);
          }) as DatabaseInterface['query'],
        };

        const [result] = await migrate([firstRun], {}, { db: late });

        expect(result?.success).toBe(false);
        expect((await row('runner_race'))?.status).toBe('completed');
      });
    });
  },
);
