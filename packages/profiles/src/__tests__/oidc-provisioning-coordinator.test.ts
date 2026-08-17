import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { coordinateOidcProvisioning } from '../auth/oidcProvisioningCoordinator';

type DatabaseInterface = Awaited<ReturnType<typeof getDatabase>>;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Give a blocked flow every chance to reach its first statement. */
async function settleEventLoop(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('coordinateOidcProvisioning shared-connection ordering', () => {
  /**
   * #2352: SQLite and DuckDB root handles multiplex one native connection, so
   * any coordinator statement issued while a concurrent flow holds that
   * connection's transaction races it. DuckDB reports the loser as
   * `Failed to execute prepared statement` or aborts the worker outright, and
   * the shared `_smrt_backfills` initialization used to run before the adapter
   * lock. Every statement the coordinator owns must run inside that lock.
   */
  it('issues no statement on a shared DuckDB root handle while another flow holds its provisioning transaction', async () => {
    const db = (await getDatabase({
      type: 'duckdb',
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    })) as DatabaseInterface;
    const statementsDuringTransaction: string[] = [];
    let openTransactions = 0;

    const observeRoot = (database: DatabaseInterface): DatabaseInterface =>
      new Proxy(database, {
        get(target, property, receiver) {
          if (property === 'query') {
            return async (sql: string, ...params: unknown[]) => {
              if (openTransactions > 0) {
                // Record instead of executing. Really racing the connection
                // would corrupt it and hide the ordering defect behind an
                // adapter error.
                statementsDuringTransaction.push(
                  sql.replace(/\s+/gu, ' ').trim(),
                );
                throw new Error(
                  'A coordinator statement raced an open provisioning transaction.',
                );
              }
              return target.query(sql, ...params);
            };
          }
          if (property === 'transaction') {
            const transaction = target.transaction;
            if (!transaction) return undefined;
            return async <T>(
              callback: (tx: DatabaseInterface) => Promise<T>,
            ): Promise<T> => {
              openTransactions += 1;
              try {
                return await transaction.call(target, callback);
              } finally {
                openTransactions -= 1;
              }
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as DatabaseInterface;

    const firstTransactionOpen = createDeferred();
    const releaseFirstTransaction = createDeferred();
    const coordinate = (
      lockKey: string,
      provision: () => Promise<string>,
    ): Promise<string> =>
      coordinateOidcProvisioning<string>({
        db: observeRoot(db),
        lockKeys: [lockKey],
        isRaceConflict: () => false,
        createTransactionError: (message, cause) =>
          new Error(message, cause === undefined ? undefined : { cause }),
        createConcurrencyError: (cause) =>
          new Error(
            'Concurrent provisioning did not converge.',
            cause === undefined ? undefined : { cause },
          ),
        provision,
      });

    let first: Promise<string> | undefined;
    let second: Promise<string> | undefined;
    try {
      first = coordinate('identity:first', async () => {
        firstTransactionOpen.resolve();
        await releaseFirstTransaction.promise;
        return 'first';
      });
      first.catch(() => undefined);
      // Racing the flow itself turns an early failure into that failure
      // rather than a hook timeout waiting for a signal that never arrives.
      await Promise.race([firstTransactionOpen.promise, first]);

      // The second flow must block on the adapter lock rather than touch the
      // connection the first flow's transaction owns. Mark it handled up
      // front: when this guard catches a regression the flow rejects while
      // nothing awaits it yet, and the unhandled rejection would drown the
      // assertion that actually names the offending statement.
      second = coordinate('identity:second', async () => 'second');
      second.catch(() => undefined);
      await settleEventLoop();
      expect(statementsDuringTransaction).toEqual([]);

      releaseFirstTransaction.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual([
        'first',
        'second',
      ]);
      expect(statementsDuringTransaction).toEqual([]);
    } finally {
      releaseFirstTransaction.resolve();
      await Promise.allSettled([first, second]);
      await db.close?.();
    }
  });
});
