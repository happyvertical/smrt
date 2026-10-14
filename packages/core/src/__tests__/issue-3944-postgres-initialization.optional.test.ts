import { randomUUID } from 'node:crypto';
import type { DatabaseInterface, TransactionHandle } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { SmrtClass } from '../class';

class TransactionBootstrapProbe extends SmrtClass {
  async ready() {
    await this.initializeCoreResources();
  }
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)(
  'PostgreSQL initialization transaction lifetime (#3944)',
  () => {
    it.each([
      'commit',
      'rollback',
    ] as const)('waits for the owning transaction to %s before another handle proceeds', async (outcome) => {
      const schema = `bootstrap_3944_${randomUUID().replaceAll('-', '')}`;
      const monitor = await getDatabase({ type: 'postgres', url: pgUrl });
      await monitor.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(pgUrl!);
      url.searchParams.set(
        'options',
        `${url.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim(),
      );
      const sharedUrl = url.toString();
      const first = await getDatabase({
        type: 'postgres',
        url: sharedUrl,
        dbid: `${schema}-first`,
      });
      const second = await getDatabase({
        type: 'postgres',
        url: sharedUrl,
        dbid: `${schema}-second`,
      });
      const firstQueryEntered = gate();
      const allowFirstQuery = gate();
      const firstInitialized = gate();
      const releaseOwner = gate();
      const rolledBack = new Error('intentional owning transaction rollback');
      let waiting: TransactionHandle | undefined;
      let owner: Promise<unknown> | undefined;
      let waiter: Promise<unknown> | undefined;
      try {
        waiting = await second.beginTransaction!();
        const pidResult = await waiting.query('SELECT pg_backend_pid() AS pid');
        const waitingPid = pidResult.rows[0].pid;
        let waitingReady = false;
        let waitingFailed = false;
        owner = first.transaction!(async (tx: DatabaseInterface) => {
          // Native callback and manual handles retain the same URL. Do not
          // synthesize a cache identity to make the regression reachable.
          expect(tx.url).toBe(sharedUrl);
          expect(waiting?.url).toBe(sharedUrl);
          const query = tx.query.bind(tx);
          let intercepted = false;
          tx.query = async (
            ...args: Parameters<DatabaseInterface['query']>
          ) => {
            const result = await query(...args);
            if (!intercepted && args[0].includes('pg_advisory_xact_lock')) {
              intercepted = true;
              firstQueryEntered.resolve();
              await allowFirstQuery.promise;
            }
            return result;
          };
          await new TransactionBootstrapProbe({ db: tx }).ready();
          firstInitialized.resolve();
          await releaseOwner.promise;
          if (outcome === 'rollback') throw rolledBack;
        }).catch((error) => error);
        await firstQueryEntered.promise;
        waiter = new TransactionBootstrapProbe({ db: waiting }).ready().then(
          () => {
            waitingReady = true;
          },
          (error) => {
            waitingFailed = true;
            return error;
          },
        );
        allowFirstQuery.resolve();
        await firstInitialized.promise;

        // Wait for a concrete database lock or premature completion, not an
        // arbitrary sleep that might hide a slow incorrect initializer.
        let lockObserved = false;
        const deadline = Date.now() + 10_000;
        while (!waitingReady && !waitingFailed && Date.now() < deadline) {
          const state = await monitor.query(
            'SELECT wait_event FROM pg_stat_activity WHERE pid = $1',
            waitingPid,
          );
          if (state.rows[0]?.wait_event === 'advisory') {
            lockObserved = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const beforeCompletion = { waitingReady, waitingFailed, lockObserved };
        // Always release both transactions before asserting, including on the
        // buggy implementation, so the regression cannot leak blocked clients.
        releaseOwner.resolve();
        const ownerResult = await owner;
        const waiterResult = await waiter;
        expect(beforeCompletion).toEqual({
          waitingReady: false,
          waitingFailed: false,
          lockObserved: true,
        });
        expect(ownerResult).toBe(
          outcome === 'rollback' ? rolledBack : undefined,
        );
        expect(waiterResult).toBeUndefined();
        const visible = await waiting.query(
          "SELECT to_regclass('_smrt_run_once_claims') IS NOT NULL AS present",
        );
        expect(visible.rows[0]?.present).toBe(true);
      } finally {
        allowFirstQuery.resolve();
        releaseOwner.resolve();
        await owner;
        await waiter;
        if (waiting?.isActive()) await waiting.rollback();
        await first.close?.();
        await second.close?.();
        await monitor.query(`DROP SCHEMA ${schema} CASCADE`);
        await monitor.close?.();
      }
    });
  },
);
