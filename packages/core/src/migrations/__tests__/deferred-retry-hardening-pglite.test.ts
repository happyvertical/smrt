/**
 * The deferred phase of a `--postgres-safe` migration under other runs and
 * failed cleanup (#5325), against a real PostgreSQL server (PGlite): a stale
 * read of a record never takes it over; runs that share one handle take
 * turns for their whole run; a record another run took over stops the
 * batch; cleanup that did not take effect is reported; a batch check that
 * fails without refusing a definition rejects the batch; and the deferred
 * phase records its outcomes on its own session.
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

    describe('a record another run took over while its deferred statements ran', () => {
      it('stops the batch: later migrations are not attempted', async () => {
        await fixDuplicates();
        const first = definition('takeover_first', [
          'CREATE INDEX IF NOT EXISTS child_n_idx ON child (n)',
        ]);
        const second = definition('takeover_second', [
          'CREATE INDEX IF NOT EXISTS child_pid_idx ON child (pid)',
        ]);
        const bumping: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) => {
            const result = await db.query(sql, ...vars);
            if (/CONCURRENTLY.*child_n_idx/.test(sql))
              await db.query(
                'UPDATE _smrt_schema_migrations SET attempts = attempts + 1 WHERE name = ?',
                first.id,
              );
            return result;
          }) as DatabaseInterface['query'],
        };

        const [taken, later] = await migrate([first, second], {}, bumping);

        expect(taken?.success).toBe(false);
        expect(errorOf(taken)).toContain('another run');
        expect(later?.success).toBe(false);
        expect(errorOf(later)).toContain('Not attempted');
        expect(await indexValid('child_pid_idx')).toEqual([]);
      });
    });

    describe('cleanup that does not take effect', () => {
      it('is reported when a row lock could not be released on a shared handle', async () => {
        await fixDuplicates();
        const stuck: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) =>
            /pg_advisory_unlock/.test(sql)
              ? { rows: [{ unlocked: false }], rowCount: 1 }
              : db.query(sql, ...vars)) as DatabaseInterface['query'],
        };

        await expect(
          migrate(
            [
              definition('cleanup_lock', [
                'CREATE INDEX IF NOT EXISTS child_n_idx ON child (n)',
              ]),
            ],
            {},
            stuck,
          ),
        ).rejects.toThrow(/could not be put back/);
        // The record itself was written.
        expect((await row('cleanup_lock'))?.status).toBe('completed');
        await db.query('SELECT pg_advisory_unlock_all()');
      });

      it('refuses every later run on a shared handle that could not be put back', async () => {
        await fixDuplicates();
        let paused = () => {};
        const atPause = new Promise<void>((resolve) => {
          paused = resolve;
        });
        const failing: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) => {
            if (sql.startsWith('RESET lock_timeout'))
              throw new Error('connection lost');
            if (sql.includes('CONCURRENTLY IF NOT EXISTS child_n_idx')) {
              paused();
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            return db.query(sql, ...vars);
          }) as DatabaseInterface['query'],
        };

        const first = migrate(
          [
            definition('unusable_first', [
              'CREATE INDEX IF NOT EXISTS child_n_idx ON child (n)',
            ]),
          ],
          {},
          failing,
        );
        await atPause;
        const queued = migrate([
          definition('unusable_queued', [
            'CREATE INDEX IF NOT EXISTS child_pid_idx ON child (pid)',
          ]),
        ]);

        await expect(first).rejects.toThrow(/Close and reopen/);
        await expect(queued).rejects.toThrow(/earlier migration run/);
        expect(await indexValid('child_pid_idx')).toEqual([]);
        expect(await row('unusable_queued')).toBeUndefined();
        await expect(
          migrate([
            definition('unusable_later', [
              'CREATE INDEX IF NOT EXISTS child_tag_idx ON child (tag)',
            ]),
          ]),
        ).rejects.toThrow(/earlier migration run/);
      });
    });
    describe('a non-atomic batch check that fails without refusing a definition', () => {
      it.each([
        ['an error', new Error('connection reset')],
        ['a falsy value', undefined],
      ])('rejects the batch with %s, never checking it again', async (_, rejection) => {
        await fixDuplicates();
        const done = definition('check_done', [
          'CREATE INDEX IF NOT EXISTS child_n_idx ON child (n)',
        ]);
        const pending = definition('check_pending', [
          'CREATE INDEX IF NOT EXISTS child_pid_idx ON child (pid)',
        ]);
        const [applied] = await tracker().applyAll([done], {
          postgresSafe: true,
        });
        expect(applied?.success, errorOf(applied)).toBe(true);
        let failed = false;
        const failingOnce: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) => {
            if (!failed && sql.startsWith('SET lock_timeout')) {
              failed = true;
              throw rejection;
            }
            return db.query(sql, ...vars);
          }) as DatabaseInterface['query'],
        };

        const run = tracker(failingOnce).applyAll([done, pending], {
          postgresSafe: true,
        });

        if (rejection) await expect(run).rejects.toBe(rejection);
        else await expect(run).rejects.toBeUndefined();
        expect(await row(pending.id)).toBeUndefined();
        expect(await indexValid('child_pid_idx')).toEqual([]);
      });
    });
    describe('a pool that hands out one connection', () => {
      it('records the deferred phase without asking it for a second', async () => {
        await fixDuplicates();
        let held = false;
        const secondCheckouts: string[] = [];
        // The pool's one connection is the pinned session while it is held:
        // any other query would wait for it, with no checkout timeout.
        const poolOfOne: DatabaseInterface = {
          ...db,
          query: (async (sql: string, ...vars: unknown[]) => {
            if (held) secondCheckouts.push(sql);
            return db.query(sql, ...vars);
          }) as DatabaseInterface['query'],
          acquireSession: async () => {
            held = true;
            return {
              query: (sql: string, ...vars: unknown[]) =>
                db.query(sql, ...vars),
              release: async () => {
                held = false;
              },
            };
          },
        } as DatabaseInterface;

        const [built, refused] = await migrate(
          [
            definition('pool_built', [
              'CREATE INDEX IF NOT EXISTS child_n_idx ON child (n)',
            ]),
            definition('pool_failed', [
              'CREATE INDEX IF NOT EXISTS child_n_idx ON child (no_such_column)',
            ]),
          ],
          { continueOnError: true },
          poolOfOne,
        );

        expect(built?.success, errorOf(built)).toBe(true);
        expect(refused?.success).toBe(false);
        expect(secondCheckouts).toEqual([]);
        expect((await row('pool_built'))?.status).toBe('completed');
        expect((await row('pool_failed'))?.status).toBe('failed');
      });
    });
  },
);
