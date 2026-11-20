/**
 * A data step run once with its marker, on a real PostgreSQL server: two
 * processes that start it at once apply it once, and a caller-owned
 * transaction that catches its failure commits none of it.
 *
 * Runs only in the PostgreSQL lane (`DATABASE_URL` / `SMRT_TEST_POSTGRES_URL`).
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runBackfillOnceInTransaction } from '../backfill-once.js';
import { BackfillTracker } from '../backfill-tracker.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)(
  'runBackfillOnceInTransaction (real PostgreSQL)',
  () => {
    let admin: DatabaseInterface;
    let first: DatabaseInterface;
    let second: DatabaseInterface;
    let databaseName: string;
    let name: string;

    const balance = async () =>
      Number(
        (await first.query('SELECT n FROM counters WHERE name = ?', name))
          .rows[0].n,
      );
    const pause = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const connect = async (url: string) =>
      (await getDatabase({
        type: 'postgres',
        url,
        dbid: `backfill-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

    beforeAll(async () => {
      admin = (await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
      })) as DatabaseInterface;
      databaseName = `smrt_backfill_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const url = new URL(pgUrl as string);
      url.pathname = `/${databaseName}`;
      first = await connect(String(url));
      second = await connect(String(url));
      await first.query(
        'CREATE TABLE counters (name TEXT PRIMARY KEY, n BIGINT NOT NULL)',
      );
      await new BackfillTracker({ db: first }).initialize();
    });
    beforeEach(async () => {
      name = `times-ten-${randomUUID()}`;
      await first.query('INSERT INTO counters VALUES (?, 10)', name);
    });
    afterAll(async () => {
      await first?.close?.();
      await second?.close?.();
      await admin?.query(
        `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
      );
      await admin?.close?.();
    });

    it('two runners at once apply the work once', async () => {
      // Not safe to repeat, and slow enough that the runs overlap.
      const timesTen = async (unit: DatabaseInterface) => {
        await unit.query('UPDATE counters SET n = n * 10 WHERE name = ?', name);
        await pause(300);
      };

      const outcomes = await Promise.all([
        runBackfillOnceInTransaction(first, name, timesTen),
        runBackfillOnceInTransaction(second, name, timesTen),
      ]);

      expect(outcomes.map((outcome) => outcome.ran).sort()).toEqual([
        false,
        true,
      ]);
      expect(await balance()).toBe(100);
    });

    it('a failed run leaves nothing, and the next run applies the work once', async () => {
      await expect(
        runBackfillOnceInTransaction(first, name, async (unit) => {
          await unit.query(
            'UPDATE counters SET n = n * 10 WHERE name = ?',
            name,
          );
          throw new Error('stopped after the first statement');
        }),
      ).rejects.toThrow('stopped after the first statement');
      expect(await balance()).toBe(10);

      await runBackfillOnceInTransaction(second, name, (unit) =>
        unit.query('UPDATE counters SET n = n * 10 WHERE name = ?', name),
      );
      expect(await balance()).toBe(100);
    });

    it('leaves nothing in a caller-owned transaction that catches the failure and commits', async () => {
      await first.transaction?.(async (tx) => {
        const scoped = tx as unknown as DatabaseInterface;
        BackfillTracker.inheritInitialization(scoped, first);
        await expect(
          runBackfillOnceInTransaction(scoped, name, async (unit) => {
            await unit.query(
              'UPDATE counters SET n = n * 10 WHERE name = ?',
              name,
            );
            await unit.query('SELECT 1 / 0');
          }),
        ).rejects.toThrow();
        // The transaction is still usable and commits.
        await scoped.query(
          'INSERT INTO counters VALUES (?, 1)',
          `${name}-after`,
        );
      });

      expect(await balance()).toBe(10);
      expect(await new BackfillTracker({ db: first }).isApplied(name)).toBe(
        false,
      );
      expect(
        (
          await first.query(
            'SELECT n FROM counters WHERE name = ?',
            `${name}-after`,
          )
        ).rows,
      ).toHaveLength(1);
    });
  },
);
