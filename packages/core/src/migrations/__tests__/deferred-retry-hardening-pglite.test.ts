/**
 * The deferred phase of a `--postgres-safe` migration under other runs and
 * failed cleanup (#5325), against a real PostgreSQL server (PGlite): a stale
 * read of a record never takes it over; runs that share one handle take
 * turns for their whole run; a record another run took over stops the
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
        // as they were, the record no longer says nothing has run. (Written in
        // the retry's own transaction, so it is rolled back with it.)
        const racing: DatabaseInterface = {
          ...db,
          transaction: (async (
            callback: (tx: DatabaseInterface) => Promise<unknown>,
          ) =>
            db.transaction?.((tx) =>
              callback({
                ...tx,
                query: (async (sql: string, ...vars: unknown[]) => {
                  const result = await tx.query(sql, ...vars);
                  if (
                    sql.includes('WHERE name = ? LIMIT 1') &&
                    vars[0] === withDataChange.id
                  ) {
                    const stale = String(result.rows[0]?.error_message ?? '');
                    await tx.query(
                      'UPDATE _smrt_schema_migrations SET error_message = ? WHERE name = ?',
                      stale.replace(' [smrt: deferred not started]', ''),
                      withDataChange.id,
                    );
                  }
                  return result;
                }) as DatabaseInterface['query'],
              } as DatabaseInterface),
            )) as DatabaseInterface['transaction'],
        };

        const [retry] = await migrate(
          [withDataChange],
          { reconcile: true },
          racing,
        );

        expect(retry?.success).toBe(false);
        expect(errorOf(retry)).toContain('changed by another run');
        expect(await counts()).toEqual(['a:0']);
        expect(await indexValid('child_tag_idx')).toEqual([]);
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

      it('never run another run between the deferred statements of one', async () => {
        const log: string[] = [];
        /** The handle as one run sees it, every statement logged. */
        const logged = (
          label: string,
          before: (sql: string) => Promise<void> = async () => {},
        ): DatabaseInterface => {
          const wrap = (inner: DatabaseInterface): DatabaseInterface['query'] =>
            (async (sql: string, ...vars: unknown[]) => {
              log.push(`${label}: ${sql}`);
              await before(sql);
              return inner.query(sql, ...vars);
            }) as DatabaseInterface['query'];
          return {
            ...db,
            query: wrap(db),
            transaction: (async (
              callback: (tx: DatabaseInterface) => Promise<unknown>,
            ) =>
              db.transaction?.((tx) =>
                callback({ ...tx, query: wrap(tx) } as DatabaseInterface),
              )) as DatabaseInterface['transaction'],
          };
        };
        /** What run B sent between two statements of run A. */
        const between = (first: string, second: string) => {
          const from = log.findIndex((entry) => entry.includes(first));
          const to = log.findIndex((entry) => entry.includes(second));
          expect(from).toBeGreaterThanOrEqual(0);
          expect(to).toBeGreaterThan(from);
          return log.slice(from + 1, to).filter((e) => e.startsWith('B'));
        };

        for (const direct of [false, true]) {
          log.length = 0;
          const suffix = direct ? 'direct' : 'batch';
          // Run A stops between two of its deferred statements for a moment.
          let paused = () => {};
          const atPause = new Promise<void>((resolve) => {
            paused = resolve;
          });
          const aDb = logged('A', async (sql) => {
            if (sql.includes(`items_a_${suffix} ON`)) {
              paused();
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          });
          const runA = migrate(
            [
              definition(`shared_a_${suffix}`, [
                `ALTER TABLE app_ns.items ADD CONSTRAINT items_${suffix}_check CHECK (v >= 0) NOT VALID`,
                `ALTER TABLE app_ns.items VALIDATE CONSTRAINT items_${suffix}_check`,
                `CREATE INDEX IF NOT EXISTS items_a_${suffix} ON app_ns.items (v)`,
                `CREATE INDEX IF NOT EXISTS items_a2_${suffix} ON app_ns.items (id)`,
              ]),
            ],
            {},
            aDb,
          );
          await atPause;
          const bDefinition = definition(`shared_b_${suffix}`, [
            `ALTER TABLE other_ns.items ADD COLUMN note_${suffix} TEXT`,
            `CREATE INDEX IF NOT EXISTS items_b_${suffix} ON other_ns.items (id)`,
          ]);
          const runB = direct
            ? tracker(logged('B'))
                .apply(bDefinition, { postgresSafe: true })
                .then((result) => [result])
            : migrate([bDefinition], {}, logged('B'));

          const [[a], [b]] = await Promise.all([runA, runB]);

          expect(a?.success, errorOf(a)).toBe(true);
          expect(b?.success, errorOf(b)).toBe(true);
          expect(
            between(`items_a_${suffix} ON`, `items_a2_${suffix} ON`),
            suffix,
          ).toEqual([]);
        }
      });
    });
  },
);
