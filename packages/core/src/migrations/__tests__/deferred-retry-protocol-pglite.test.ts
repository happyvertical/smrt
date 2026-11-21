/**
 * The retry protocol of a `--postgres-safe` migration whose deferred phase
 * partly committed (#5325), on every path that runs one, against a real
 * PostgreSQL server (PGlite): an atomic batch lists each migration once; a
 * dry run cannot change what a concurrent run checks and creates nothing; an
 * unreadable or pre-plan record never earns a skipped first half; and the
 * session is put back without clearing settings the caller set.
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

const SENTINEL = 'sentinel-4c19';

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'the deferred-phase retry protocol on a real server',
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
      await tracker().initialize();
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

    const tracker = (handle: DatabaseInterface = db) =>
      new MigrationTracker({
        db: handle,
        engineHint: 'postgres',
        useConcurrentIndexes: true,
      });

    const migrate = (
      definitions: MigrationDefinition[],
      options: ApplyMigrationsOptions = {},
    ) =>
      tracker().applyAll(definitions, {
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

    const constraintExists = async (name: string) =>
      (await db.query('SELECT 1 FROM pg_constraint WHERE conname = ?', name))
        .rows.length > 0;

    const setting = async (name: string) =>
      (await db.query('SELECT current_setting(?, true) AS value', name)).rows[0]
        ?.value;

    const fixDuplicates = () => db.query("DELETE FROM child WHERE tag = 'b'");

    const addForeignKey = [
      'ALTER TABLE child ADD CONSTRAINT child_pid_fk FOREIGN KEY (pid) REFERENCES parent (id) NOT VALID',
      'ALTER TABLE child VALIDATE CONSTRAINT child_pid_fk',
    ];

    /** Deferred: VALIDATE, a data change, a unique build that fails. */
    const withDataChange = definition('protocol_data_change', [
      ...addForeignKey,
      `UPDATE child SET n = n + 1 /* ${SENTINEL} */`,
      'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
    ]);

    /** First half: a data change; deferred: a unique build that fails. */
    const dataThenIndex = (id: string) =>
      definition(id, [
        `UPDATE child SET n = n + 1 /* ${SENTINEL} */`,
        'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
      ]);

    /** Deferred: VALIDATE and a unique build that fails. */
    const indexOnly = definition('protocol_index_only', [
      ...addForeignKey,
      'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
    ]);

    async function failOnce(
      def: MigrationDefinition,
      options: ApplyMigrationsOptions = {},
    ) {
      const [first] = await migrate([def], options);
      expect(first?.success, errorOf(first)).toBe(false);
      expect((await row(def.id))?.status).toBe('failed');
    }

    describe('a batch that lists a migration more than once', () => {
      it('is refused before anything runs', async () => {
        await expect(
          migrate([withDataChange, withDataChange], {
            reconcile: true,
            continueOnError: true,
          }),
        ).rejects.toThrow(/more than once/);

        expect(await counts()).toEqual(['a:0', 'b:0']);
        expect(await constraintExists('child_pid_fk')).toBe(false);
        expect(await row(withDataChange.id)).toBeUndefined();
      });
    });

    describe('a dry run on the same tracker', () => {
      it('does not change what a concurrent run checks', async () => {
        const def = dataThenIndex('protocol_dry_run');
        await failOnce(def);
        await fixDuplicates();
        expect(await counts()).toEqual(['a:1']);
        // A batch whose concurrent plan cannot be built: the dry run previews
        // it without the retry check.
        const unplannable = definition('protocol_unplannable', [
          '-- smrt:null-equal-conflict-index\nCREATE UNIQUE INDEX child_tag_uq ON child (tag)',
        ]);
        // Hold the dry run inside its batch while the real run reads its
        // record, so the two calls overlap.
        let enterDryRun = () => {};
        let releaseDryRun = () => {};
        const dryRunEntered = new Promise<void>((resolve) => {
          enterDryRun = resolve;
        });
        const dryRunReleased = new Promise<void>((resolve) => {
          releaseDryRun = resolve;
        });
        const gated: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) => {
            const reads = sql.includes('WHERE name = ?');
            if (reads && vars[0] === unplannable.id) {
              enterDryRun();
              await dryRunReleased;
            }
            if (reads && vars[0] === def.id) {
              await dryRunEntered;
              const result = await db.query(sql, ...vars);
              setTimeout(releaseDryRun, 0);
              return result;
            }
            return db.query(sql, ...vars);
          }) as DatabaseInterface['query'],
        };
        const shared = tracker(gated);

        const [, real] = await Promise.all([
          shared.applyAll([unplannable], {
            atomic: true,
            postgresSafe: true,
            dryRun: true,
          }),
          shared.apply(def, { reconcile: true }),
        ]);

        expect(real.success).toBe(false);
        expect(errorOf(real)).toContain('was not retried');
        expect(await counts()).toEqual(['a:1']);
      });
    });

    describe('a dry run', () => {
      it('creates and alters nothing, and needs no timestamp conversion', async () => {
        const def = dataThenIndex('protocol_dry_run_reads');
        await failOnce(def);
        await db.query('DROP INDEX idx_smrt_schema_migrations_batch');
        // A pending system-timestamp conversion: bootstrap would refuse it.
        await db.query(
          'ALTER TABLE _smrt_schema_migrations ALTER COLUMN rolled_back_at TYPE timestamp without time zone',
        );

        const results = await migrate([def], {
          reconcile: true,
          dryRun: true,
        });

        expect(results).toHaveLength(1);
        expect(
          (
            await db.query(
              "SELECT 1 FROM pg_class WHERE relname = 'idx_smrt_schema_migrations_batch'",
            )
          ).rows,
        ).toEqual([]);
      });

      it('reads no history where there is none, and creates none', async () => {
        await db.query('DROP TABLE _smrt_schema_migrations');

        const [result] = await migrate([dataThenIndex('protocol_dry_fresh')], {
          dryRun: true,
        });

        expect(result?.success, errorOf(result)).toBe(true);
        expect(
          (await db.query("SELECT to_regclass('_smrt_schema_migrations') AS t"))
            .rows[0]?.t,
        ).toBeNull();
      });
    });

    describe('the plan a record carries', () => {
      it('refuses a record whose plan digest is truncated', async () => {
        await failOnce(indexOnly);
        const recorded = (await row(indexOnly.id))?.error_message ?? '';
        const truncated = recorded.replace(
          /sha256:[0-9a-f]{64}/,
          'sha256:0123abcd',
        );
        expect(truncated).not.toBe(recorded);
        await db.query(
          'UPDATE _smrt_schema_migrations SET error_message = ? WHERE name = ?',
          truncated,
          indexOnly.id,
        );
        await fixDuplicates();

        const [retry] = await migrate([indexOnly], { reconcile: true });

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('unreadable');
        expect(errorOf(retry)).toContain('first statement');
        expect(await indexValid('child_id_uq')).not.toContain(true);
      });

      it('refuses a record whose plan digest is not hexadecimal', async () => {
        await failOnce(indexOnly);
        const recorded = (await row(indexOnly.id))?.error_message ?? '';
        await db.query(
          'UPDATE _smrt_schema_migrations SET error_message = ? WHERE name = ?',
          recorded.replace(/sha256:[0-9a-f]{64}/, `sha256:${'g'.repeat(64)}`),
          indexOnly.id,
        );
        await fixDuplicates();

        const [retry] = await migrate([indexOnly], { reconcile: true });

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('unreadable');
      });

      it('refuses a record whose plan tag is damaged, never reading it as an older record', async () => {
        const indexAlone = definition('protocol_index_alone', [
          'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
        ]);
        await failOnce(indexAlone);
        const recorded = (await row(indexAlone.id))?.error_message ?? '';
        await db.query(
          'UPDATE _smrt_schema_migrations SET error_message = ? WHERE name = ?',
          recorded.replace('] [smrt: plan', ']  [smrt: plan'),
          indexAlone.id,
        );
        await fixDuplicates();

        const [retry] = await migrate([indexAlone], { reconcile: true });

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('unreadable');
        expect(await indexValid('child_id_uq')).not.toContain(true);
      });

      describe('recorded before plans were recorded, with a first half to skip', () => {
        const legacy =
          '[smrt: concurrent-index phase 1 committed] Concurrent index build pending: the non-index half of this migration committed but the CONCURRENTLY index DDL had not completed. Re-run db:migrate to finish it.';
        const def = dataThenIndex('protocol_legacy_first_half');

        beforeEach(async () => {
          await failOnce(def);
          // As an older planner may have left it: the data change deferred
          // (a comment the checksum ignores moved the boundary) and never run.
          await db.query('UPDATE child SET n = 0');
          await db.query(
            'UPDATE _smrt_schema_migrations SET error_message = ? WHERE name = ?',
            legacy,
            def.id,
          );
          await fixDuplicates();
        });

        it('is refused until the first half is confirmed, and nothing runs', async () => {
          const [retry] = await migrate([def], { reconcile: true });

          expect(retry?.success).toBe(false);
          expect(errorOf(retry)).toContain('first half ended is not known');
          expect(errorOf(retry)).not.toContain('both halves');
          expect(await indexValid('child_id_uq')).not.toContain(true);
          expect(await counts()).toEqual(['a:0']);
        });

        it('runs the deferred list without the first half when forced by name', async () => {
          await db.query('UPDATE child SET n = 1');

          const [forced] = await migrate([def], {
            reconcile: true,
            forceMigrations: [def.id],
          });

          expect(forced?.success, errorOf(forced)).toBe(true);
          expect(await counts()).toEqual(['a:1']);
          expect(await indexValid('child_id_uq')).toEqual([true]);
        });
      });

      describe('recorded before plans were recorded, with a data change deferred', () => {
        const legacy =
          '[smrt: concurrent-index phase 1 committed] Concurrent index build pending: the non-index half of this migration committed but the CONCURRENTLY index DDL had not completed. Re-run db:migrate to finish it.';

        beforeEach(async () => {
          await failOnce(withDataChange);
          await db.query(
            'UPDATE _smrt_schema_migrations SET error_message = ? WHERE name = ?',
            legacy,
            withDataChange.id,
          );
          await fixDuplicates();
        });

        it('directs the operator to reconcile both halves', async () => {
          const [retry] = await migrate([withDataChange], { reconcile: true });

          expect(retry?.success).toBe(false);
          expect(errorOf(retry)).toContain('before statement plans');
          expect(errorOf(retry)).toContain('both halves');
          expect(errorOf(retry)).toContain('first statement');
          expect(await counts()).toEqual(['a:1']);
        });

        it('runs from the first statement when forced, never only the deferred half', async () => {
          const [forced] = await migrate([withDataChange], {
            reconcile: true,
            forceMigrations: [withDataChange.id],
          });

          // The first half's constraint already exists, so the full run stops
          // at its first statement; the deferred data change does not run.
          expect(forced?.success).toBe(false);
          expect(await counts()).toEqual(['a:1']);
        });
      });
    });

    describe('the session the deferred statements run on', () => {
      const tagIndex =
        'CREATE INDEX IF NOT EXISTS child_tag_idx ON child (tag)';

      it('keeps an application setting the migration does not touch', async () => {
        await db.query("SELECT set_config('app.tenant', 't1', false)");

        const [result] = await migrate([
          definition('session_untouched', [tagIndex]),
        ]);

        expect(result?.success, errorOf(result)).toBe(true);
        expect(await setting('app.tenant')).toBe('t1');
      });

      it('puts back an application setting a deferred statement changed', async () => {
        await db.query("SELECT set_config('app.tenant', 't1', false)");

        const [result] = await migrate([
          definition('session_changed', [
            ...addForeignKey,
            "SET app.tenant = 'migration'",
            tagIndex,
          ]),
        ]);

        expect(result?.success, errorOf(result)).toBe(true);
        expect(await setting('app.tenant')).toBe('t1');
      });

      it('puts back an application setting a deferred set_config changed', async () => {
        await db.query("SELECT set_config('app.tenant', 't1', false)");

        const [result] = await migrate([
          definition('session_set_config', [
            ...addForeignKey,
            "SELECT set_config('app.tenant', 'migration', false)",
            tagIndex,
          ]),
        ]);

        expect(result?.success, errorOf(result)).toBe(true);
        expect(await setting('app.tenant')).toBe('t1');
      });

      it('puts back an application setting named by a quoted identifier or function name', async () => {
        await db.query("SELECT set_config('app.tenant', 't1', false)");

        for (const statement of [
          `SET "app.tenant" = 'migration'`,
          `SELECT "set_config"('app.tenant', 'migration', false)`,
        ]) {
          await db.query(
            "DELETE FROM _smrt_schema_migrations WHERE name = 'session_quoted'",
          );
          const [result] = await migrate([
            definition('session_quoted', [
              ...addForeignKey,
              statement,
              tagIndex,
            ]),
          ]);

          expect(result?.success, errorOf(result)).toBe(true);
          expect(await setting('app.tenant')).toBe('t1');
          await db.query('ALTER TABLE child DROP CONSTRAINT child_pid_fk');
        }
      });

      it('refuses, before anything runs, a deferred statement whose changes cannot be named', async () => {
        for (const statement of [
          'RESET ALL',
          'DISCARD ALL',
          "SELECT set_config(current_user || '.x', 'y', false)",
          "SELECT set_config('app.' || 'tenant', 'migration', false)",
        ]) {
          await expect(
            migrate([
              definition('session_unnamed', [
                ...addForeignKey,
                statement,
                tagIndex,
              ]),
            ]),
          ).rejects.toThrow(/cannot be named/);
          expect(await constraintExists('child_pid_fk')).toBe(false);
          expect(await row('session_unnamed')).toBeUndefined();
        }
      });

      it('restores a restricted setting and then the caller role', async () => {
        await db.query('CREATE ROLE handed_role NOLOGIN');
        await db.query('GRANT ALL ON SCHEMA public TO handed_role');
        for (const table of ['child', 'parent', '_smrt_schema_migrations'])
          await db.query(`ALTER TABLE ${table} OWNER TO handed_role`);
        // An administrator configured the session, then handed it to a role.
        await db.query('SET session_replication_role = replica');
        await db.query('SET ROLE handed_role');

        const [result] = await migrate([
          definition('session_handed', [
            ...addForeignKey,
            'SET search_path TO public',
            tagIndex,
          ]),
        ]);

        expect(result?.success, errorOf(result)).toBe(true);
        expect(await setting('session_replication_role')).toBe('replica');
        expect(
          (await db.query('SELECT current_user AS name')).rows[0]?.name,
        ).toBe('handed_role');
      });
    });
  },
);
