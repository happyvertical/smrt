/**
 * The deferred-phase retry protocol on a non-atomic `postgresSafe` run (a
 * direct `apply()` or `applyAll` without `atomic`, #5522), against a real
 * PostgreSQL server (PGlite): a definition whose plan is refused runs
 * nothing; a lost commit acknowledgement keeps the marker; a split needs a
 * transaction and writes its marker to the tracking table it resolved; and
 * the outcome is written on the pinned session, never on a second checkout.
 *
 * Runs under `pnpm test:pglite` (and so in the PostgreSQL lane); skipped on the
 * default SQLite run.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MigrationDefinition } from '../../schema/types.js';
import { getTestDatabase } from '../../testing/database.js';
import { MigrationTracker } from '../tracker.js';

const MARKER = '[smrt: concurrent-index phase 1 committed]';

/** Resolves to `timedOut` when `work` has not settled after `ms`. */
const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([
    work,
    new Promise<'timedOut'>((resolve) => setTimeout(resolve, ms, 'timedOut')),
  ]);

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'the deferred-phase retry protocol outside an atomic batch',
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

    const tracker = (handle: DatabaseInterface = db) =>
      new MigrationTracker({
        db: handle,
        engineHint: 'postgres',
        useConcurrentIndexes: true,
      });

    const definition = (id: string, up: string[]): MigrationDefinition => ({
      id,
      description: id,
      version: '1.0.0',
      up,
      down: [],
    });

    const errorOf = (result: { error?: unknown } | undefined) =>
      result?.error instanceof Error
        ? result.error.message
        : String(result?.error ?? '');

    const row = async (name: string) =>
      (
        await db.query(
          'SELECT status, error_message FROM public._smrt_schema_migrations WHERE name = ?',
          name,
        )
      ).rows[0] as { status: string; error_message: string | null } | undefined;

    const counts = async () =>
      (await db.query('SELECT tag, n FROM public.child ORDER BY tag')).rows.map(
        (r) => `${r.tag}:${r.n}`,
      );

    const fixDuplicates = () =>
      db.query("DELETE FROM public.child WHERE tag = 'b'");

    const uniqueIndex =
      'CREATE UNIQUE INDEX IF NOT EXISTS child_id_uq ON public.child (id)';

    /** First half: a data change; deferred: a unique build that fails. */
    const dataThenIndex = (id: string) =>
      definition(id, ['UPDATE public.child SET n = n + 1', uniqueIndex]);

    it('runs nothing of a definition whose plan is refused', async () => {
      const def = definition('nonatomic_unnamed', [
        'UPDATE child SET n = n + 1',
        'ALTER TABLE child ADD CONSTRAINT child_pid_fk FOREIGN KEY (pid) REFERENCES parent (id) NOT VALID',
        'ALTER TABLE child VALIDATE CONSTRAINT child_pid_fk',
        'RESET ALL',
        'CREATE INDEX IF NOT EXISTS child_tag_idx ON child (tag)',
      ]);

      const result = await tracker().apply(def, { postgresSafe: true });

      expect(result.success).toBe(false);
      expect(errorOf(result)).toMatch(/cannot be named/);
      expect(await counts()).toEqual(['a:0', 'b:0']);
      expect(await row(def.id)).toBeUndefined();
    });

    it('keeps the marker when the first half committed but its acknowledgement was lost', async () => {
      const def = dataThenIndex('nonatomic_lost_ack');
      let lose = true;
      const flaky: DatabaseInterface = {
        ...db,
        transaction: (async (work: (tx: DatabaseInterface) => unknown) => {
          const committed = await db.transaction?.(work as never);
          if (lose) {
            lose = false;
            throw new Error('connection lost after commit');
          }
          return committed;
        }) as DatabaseInterface['transaction'],
      };

      const first = await tracker(flaky).apply(def, { postgresSafe: true });

      expect(first.success).toBe(false);
      expect(await counts()).toEqual(['a:1', 'b:1']);
      expect((await row(def.id))?.error_message?.startsWith(MARKER)).toBe(true);
      await fixDuplicates();
      const retry = await tracker().apply(def, {
        postgresSafe: true,
        reconcile: true,
      });
      expect(retry.success, errorOf(retry)).toBe(true);
      expect(await counts()).toEqual(['a:1']);
    });

    it('refuses a split, before anything runs, on a handle without transactions', async () => {
      const def = dataThenIndex('nonatomic_no_transaction');
      const plain: DatabaseInterface = { ...db, transaction: undefined };

      const result = await tracker(plain).apply(def, { postgresSafe: true });

      expect(result.success).toBe(false);
      expect(errorOf(result)).toContain('transaction');
      expect(await counts()).toEqual(['a:0', 'b:0']);
      expect(await row(def.id)).toBeUndefined();
    });

    it('writes the marker to the tracking table it resolved, whatever the first half sets', async () => {
      await db.query('CREATE SCHEMA other_ns');
      await db.query(
        'CREATE TABLE other_ns._smrt_schema_migrations (LIKE public._smrt_schema_migrations INCLUDING ALL)',
      );
      const def = definition('nonatomic_search_path', [
        'SET LOCAL search_path TO other_ns',
        'UPDATE public.child SET n = n + 1',
        uniqueIndex,
      ]);

      const first = await tracker().apply(def, { postgresSafe: true });

      expect(first.success).toBe(false);
      expect(await counts()).toEqual(['a:1', 'b:1']);
      expect((await row(def.id))?.error_message?.startsWith(MARKER)).toBe(true);
      await fixDuplicates();
      const retry = await tracker().apply(def, {
        postgresSafe: true,
        reconcile: true,
      });
      expect(retry.success, errorOf(retry)).toBe(true);
      expect(await counts()).toEqual(['a:1']);
    });

    it('writes the outcome on the pinned session, never waiting on a second checkout', async () => {
      await fixDuplicates();
      // A pool of one connection: while the session is checked out, a query
      // on the handle waits for it to come back.
      let held = false;
      let waiting: Array<() => void> = [];
      const pool: DatabaseInterface = {
        ...db,
        query: (async (sql: string, ...vars: unknown[]) => {
          while (held) await new Promise<void>((r) => waiting.push(r));
          return db.query(sql, ...vars);
        }) as DatabaseInterface['query'],
        acquireSession: async () => {
          held = true;
          return {
            query: (sql: string, ...vars: unknown[]) => db.query(sql, ...vars),
            release: async () => {
              held = false;
              const ready = waiting;
              waiting = [];
              for (const resume of ready) resume();
            },
          };
        },
      } as DatabaseInterface;
      const def = dataThenIndex('nonatomic_pool_of_one');

      const result = await within(
        tracker(pool).apply(def, { postgresSafe: true }),
        15_000,
      );

      expect(result).not.toBe('timedOut');
      expect(
        result === 'timedOut' ? undefined : result.success,
        result === 'timedOut' ? '' : errorOf(result),
      ).toBe(true);
      expect((await row(def.id))?.status).toBe('completed');
    }, 30_000);
  },
);
