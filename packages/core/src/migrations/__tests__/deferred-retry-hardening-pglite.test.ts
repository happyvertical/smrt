/**
 * The deferred phase of a `--postgres-safe` migration under other runs and
 * failed cleanup (#5325), against a real PostgreSQL server (PGlite): a stale
 * read of a record never takes it over; runs that share one handle do not
 * interleave their session state; a record another run took over stops the
 * batch; cleanup that did not take effect is reported; and no deferred
 * statement runs while the tracking table's schema is unknown.
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

const SENTINEL = 'sentinel-9d27';

/** Resolves when `ready` resolves or after `ms`, whichever comes first. */
const within = (ready: Promise<void>, ms: number) =>
  Promise.race([ready, new Promise<void>((r) => setTimeout(r, ms))]);

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'the deferred phase under other runs and failed cleanup',
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
      await db.query(
        "INSERT INTO child (id, pid, tag) VALUES (1, 1, 'a'), (1, 1, 'b')",
      );
      await tracker().initialize();
    });
    afterEach(async () => {
      await db.close?.();
    });

    function tracker(handle: DatabaseInterface = db) {
      return new MigrationTracker({
        db: handle,
        engineHint: 'postgres',
        useConcurrentIndexes: true,
      });
    }

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
      handle: DatabaseInterface = db,
    ) =>
      tracker(handle).applyAll(definitions, {
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

    /** Deferred: a unique build that fails while the duplicates are there. */
    const failingIndex = definition('hardening_failing_index', [
      'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON child (id)',
    ]);

    /** Deferred: VALIDATE, a data change, an index build. */
    const withDataChange = definition('hardening_data_change', [
      ...addForeignKey,
      `UPDATE child SET n = n + 1 /* ${SENTINEL} */`,
      'CREATE INDEX IF NOT EXISTS child_tag_idx ON child (tag)',
    ]);

    describe('a retry whose record changed after it was read', () => {
      it('takes nothing over when another run started its deferred statements meanwhile', async () => {
        // The first migration fails; the second is recorded not attempted, so
        // its record says no deferred statement has run.
        const [first, second] = await migrate([failingIndex, withDataChange]);
        expect(first?.success).toBe(false);
        expect(errorOf(second)).toContain('Not attempted');
        expect((await row(withDataChange.id))?.error_message).toContain(
          'deferred not started',
        );
        await fixDuplicates();
        // Right after this run reads the record, another run claims it, runs
        // part of its deferred list and fails: status and attempt number stay
        // as they were, the record no longer says nothing has run.
        const racing: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) => {
            const result = await db.query(sql, ...vars);
            if (
              sql.includes('WHERE name = ? LIMIT 1') &&
              vars[0] === withDataChange.id
            ) {
              const stale = String(result.rows[0]?.error_message ?? '');
              await db.query(
                'UPDATE _smrt_schema_migrations SET error_message = ? WHERE name = ?',
                `${stale.replace(' [smrt: deferred not started]', '')} build interrupted`,
                withDataChange.id,
              );
              await db.query('UPDATE child SET n = n + 1');
            }
            return result;
          }) as DatabaseInterface['query'],
        };

        // Non-atomic, so the read and the takeover reach the handle itself;
        // forced by name, as a record with a phase-1 marker is otherwise
        // refused outside the batch that planned it.
        const [retry] = await migrate(
          [withDataChange],
          {
            atomic: false,
            reconcile: true,
            forceMigrations: [withDataChange.id],
          },
          racing,
        );

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('changed by another run');
        expect(await counts()).toEqual(['a:1']);
      });
    });

    describe('runs that share one handle', () => {
      beforeEach(async () => {
        await fixDuplicates();
        await db.query('CREATE SCHEMA app_ns');
        await db.query('CREATE SCHEMA other_ns');
        for (const schema of ['app_ns', 'other_ns'])
          await db.query(`CREATE TABLE ${schema}.items (id INT, v INT)`);
      });

      const indexSchemas = async (name: string) =>
        (
          await db.query(
            `SELECT n.nspname AS schema FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relname = ? ORDER BY 1`,
            name,
          )
        ).rows.map((r) => r.schema);

      it('do not interleave their deferred session state', async () => {
        await db.query('SET search_path TO app_ns, public');
        const switching = definition('shared_switching', [
          'ALTER TABLE items ADD CONSTRAINT items_v_check CHECK (v >= 0) NOT VALID',
          'ALTER TABLE items VALIDATE CONSTRAINT items_v_check',
          'SET search_path TO other_ns, public',
          'CREATE INDEX IF NOT EXISTS items_switched_idx ON items (v)',
        ]);
        const plain = definition('shared_plain', [
          'CREATE INDEX IF NOT EXISTS items_plain_idx ON items (id)',
        ]);
        // Steer the two runs toward the interleaving: the plain run captures
        // the session, the switching run sets its path, the plain run puts
        // its captured path back, then the switching run builds its index.
        // Each wait gives up after a moment, so runs that wait for each other
        // (as they must) still finish.
        const signal = () => {
          let fire = () => {};
          const fired = new Promise<void>((resolve) => {
            fire = resolve;
          });
          return { fire, fired };
        };
        const plainCaptured = signal();
        const pathSet = signal();
        const plainRestored = signal();
        let plainRestoring = false;
        const switchingDb: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) => {
            if (sql.includes('FROM pg_settings'))
              await within(plainCaptured.fired, 400);
            const result = await db.query(sql, ...vars);
            if (sql.startsWith('SET search_path TO other_ns')) {
              pathSet.fire();
              await within(plainRestored.fired, 400);
            }
            return result;
          }) as DatabaseInterface['query'],
        };
        const plainDb: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) => {
            if (sql === 'RESET ROLE' && !plainRestoring) {
              plainRestoring = true;
              await within(pathSet.fired, 400);
            }
            const result = await db.query(sql, ...vars);
            if (sql.includes("current_setting('role') AS role_name"))
              plainCaptured.fire();
            if (plainRestoring && sql.startsWith('SET lock_timeout'))
              plainRestored.fire();
            return result;
          }) as DatabaseInterface['query'],
        };

        const [[switched], [built]] = await Promise.all([
          migrate([switching], {}, switchingDb),
          migrate([plain], {}, plainDb),
        ]);

        expect(switched?.success, errorOf(switched)).toBe(true);
        expect(built?.success, errorOf(built)).toBe(true);
        expect(await indexSchemas('items_switched_idx')).toEqual(['other_ns']);
        expect(await indexSchemas('items_plain_idx')).toEqual(['app_ns']);
      });
    });
  },
);
