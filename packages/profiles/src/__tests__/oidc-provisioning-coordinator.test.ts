import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { createProfileFromOidc } from '../auth/index.js';
import {
  coordinateOidcProvisioning,
  isOidcAbortedTransactionError,
} from '../auth/oidcProvisioningCoordinator';
import { ProfileTypeCollection } from '../collections/ProfileTypeCollection.js';
import { backfillProfileEmailKeys } from '../migrations/backfillProfileEmailKeys.js';

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

  /**
   * #2352: the ordering guard above only covers statements the coordinator
   * itself owns. A single flow can just as easily overlap its own statements
   * — the post-commit rebind used `Promise.all` over two or three primary-key
   * reads — and on one native connection that is the same defect. Counting
   * in-flight statements catches both without racing: an overlap is a
   * structural property of the call, not a timing accident.
   */
  it('never overlaps two statements on one shared DuckDB connection during concurrent provisioning', async () => {
    const db = (await getDatabase({
      type: 'duckdb',
      url: ':memory:',
    })) as DatabaseInterface;
    await ProfileTypeCollection.create({ db });
    await backfillProfileEmailKeys(db);

    let inFlight = 0;
    let maxInFlight = 0;
    const overlapped: string[] = [];
    const observe = (database: DatabaseInterface): DatabaseInterface =>
      new Proxy(database, {
        get(target, property, receiver) {
          if (property === 'query') {
            return async (sql: string, ...params: unknown[]) => {
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              if (inFlight > 1) {
                overlapped.push(sql.replace(/\s+/gu, ' ').trim());
              }
              try {
                return await target.query(sql, ...params);
              } finally {
                inFlight -= 1;
              }
            };
          }
          if (property === 'transaction') {
            const transaction = target.transaction;
            if (!transaction) return undefined;
            return async <T>(
              callback: (tx: DatabaseInterface) => Promise<T>,
            ): Promise<T> =>
              transaction.call(target, (tx) => callback(observe(tx)));
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as DatabaseInterface;

    const sharedClaims = {
      sub: 'overlap-guard-subject',
      iss: 'https://auth.example.com',
      email_verified: true,
      name: 'Overlap Guard',
    };
    try {
      await Promise.all([
        createProfileFromOidc(
          { ...sharedClaims, email: 'overlap-guard-first@example.com' },
          'example',
          { db: observe(db) },
        ),
        createProfileFromOidc(
          { ...sharedClaims, email: 'overlap-guard-second@example.com' },
          'example',
          { db: observe(db) },
        ),
      ]);

      expect(overlapped).toEqual([]);
      expect(maxInFlight).toBe(1);
    } finally {
      await db.close?.();
    }
  });
});

/**
 * `isOidcAbortedTransactionError` used to match a bare `/transaction.*aborted/`
 * against every message in the cause chain. #2366 narrowed it to the framework
 * classifier, which keys on PostgreSQL's own `25P02` SQLSTATE (or the exact
 * "current transaction is aborted" wording DuckDB also uses).
 *
 * Both directions of that narrowing are load-bearing and were previously
 * untested: the provisioning loop treats a true aborted transaction as a
 * retryable race, so a false negative stalls provisioning while a false
 * positive retries a deterministic constraint failure until it exhausts.
 */
describe('isOidcAbortedTransactionError narrowing (#2366)', () => {
  /** The shape `@happyvertical/sql` actually throws. */
  function wrappedDriverError(originalError: string): Error {
    return Object.assign(new Error('Failed to upsert record into table'), {
      code: 'DATABASE_ERROR',
      context: { originalError },
    });
  }

  it('detects a real aborted transaction through the adapter wrapper', () => {
    expect(
      isOidcAbortedTransactionError(
        wrappedDriverError(
          'current transaction is aborted, commands ignored until end of transaction block, code=25P02, severity=ERROR',
        ),
      ),
    ).toBe(true);
  });

  it('detects DuckDB wording, which carries no SQLSTATE', () => {
    expect(
      isOidcAbortedTransactionError(
        new Error(
          'TransactionContext Error: Current transaction is aborted (please ROLLBACK)',
        ),
      ),
    ).toBe(true);
  });

  it('no longer fires on a constraint failure that merely mentions a transaction', () => {
    // The old heuristic matched this and would have retried a deterministic
    // foreign-key violation as if it were a provisioning race.
    expect(
      isOidcAbortedTransactionError(
        wrappedDriverError(
          'insert or update on table "oidc_identities" violates foreign key constraint "oidc_identities_profile_id_fkey", code=23503, detail=the aborted transaction log is unrelated',
        ),
      ),
    ).toBe(false);
  });

  it('does not treat an idle-in-transaction session timeout as an aborted transaction', () => {
    // 25P03 terminates the session; a fresh connection can succeed, so it must
    // not be reported as a provisioning race conflict.
    expect(
      isOidcAbortedTransactionError(
        wrappedDriverError(
          'terminating connection due to idle-in-transaction timeout, code=25P03, severity=FATAL',
        ),
      ),
    ).toBe(false);
  });

  it('ignores an unrelated error', () => {
    expect(isOidcAbortedTransactionError(new Error('boom'))).toBe(false);
    expect(isOidcAbortedTransactionError(undefined)).toBe(false);
  });
});
