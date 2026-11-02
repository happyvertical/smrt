/**
 * PostgreSQL pool identity honors pool configuration (#3046).
 *
 * `@happyvertical/sql` caches a connection by `dbid` alone when one is given.
 * SMRT used to derive that dbid from the URL only (`smrt:<url>`), so the first
 * caller to resolve a URL fixed the pool's `max` and timeouts for the whole
 * process and every later caller asking for a different cap silently shared it.
 *
 * These tests drive the real SDK `getDatabase()` and read the real `pg.Pool`
 * options it built. A `pg.Pool` does not connect until a client is checked
 * out, so no server is needed; the live engine proof is in
 * `issue-3046-postgres-pool-identity.optional.test.ts`.
 */

import {
  clearPostgresConnectionCache,
  type DatabaseInterface,
} from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDatabase } from '../database';
import { createDispatchBus } from '../dispatch/bus';
import {
  applyPostgresRuntimeTimeouts,
  DEFAULT_POSTGRES_TIMEOUTS,
  resolveRuntimePoolDbid,
} from '../postgres-timeouts';

// Unreachable on purpose: nothing here may open a connection.
const PG_URL = 'postgres://smrt:secret@127.0.0.1:1/pool_identity_3046';

interface PoolOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
}

function poolOptions(db: DatabaseInterface): PoolOptions {
  return (db as unknown as { client: { options: PoolOptions } }).client.options;
}

afterEach(async () => {
  await clearPostgresConnectionCache();
});

describe('resolveRuntimePoolDbid (#3046)', () => {
  it('derives no dbid for PostgreSQL, so the SDK keys the pool on its pool options', () => {
    const bounded = applyPostgresRuntimeTimeouts({ url: PG_URL }, {});
    expect(resolveRuntimePoolDbid(bounded)).toBeUndefined();
    expect(
      resolveRuntimePoolDbid(
        applyPostgresRuntimeTimeouts({ type: 'postgres', host: 'db' }, {}),
        'memory',
      ),
    ).toBeUndefined();
  });

  it('keeps the historical smrt:<url> identity for file-backed engines', () => {
    expect(resolveRuntimePoolDbid({ url: 'app.db' })).toBe('smrt:app.db');
    expect(resolveRuntimePoolDbid({ type: 'duckdb', url: 'data.duckdb' })).toBe(
      'smrt:data.duckdb',
    );
    expect(resolveRuntimePoolDbid({ type: 'sqlite' }, 'fallback.db')).toBe(
      'smrt:fallback.db',
    );
  });

  it('returns a caller-owned dbid unchanged on every engine', () => {
    expect(resolveRuntimePoolDbid({ url: PG_URL, dbid: 'mine' })).toBe('mine');
    expect(resolveRuntimePoolDbid({ url: 'app.db', dbid: 'mine' })).toBe(
      'mine',
    );
  });
});

describe('applyPostgresRuntimeTimeouts keeps an explicit pool timeout (#3046)', () => {
  it('honours a caller connectionTimeoutMillis instead of the default', () => {
    const bounded = applyPostgresRuntimeTimeouts(
      { type: 'postgres', url: PG_URL, connectionTimeoutMillis: 1500 },
      {},
    );
    expect(bounded.connectionTimeoutMillis).toBe(1500);
  });

  it('ranks it above the environment but below the timeouts key', () => {
    const env = { SMRT_PG_CONNECTION_TIMEOUT: '7s' };
    expect(
      applyPostgresRuntimeTimeouts(
        { url: PG_URL, connectionTimeoutMillis: 1500 },
        env,
      ).connectionTimeoutMillis,
    ).toBe(1500);
    expect(
      applyPostgresRuntimeTimeouts(
        {
          url: PG_URL,
          connectionTimeoutMillis: 1500,
          timeouts: { connectionTimeout: '2s' },
        },
        env,
      ).connectionTimeoutMillis,
    ).toBe(2000);
    expect(
      applyPostgresRuntimeTimeouts({ url: PG_URL }, env)
        .connectionTimeoutMillis,
    ).toBe(7000);
  });

  it('is idempotent on its own output', () => {
    const once = applyPostgresRuntimeTimeouts(
      { url: PG_URL, timeouts: { connectionTimeout: '3s' } },
      {},
    );
    expect(applyPostgresRuntimeTimeouts(once, {})).toEqual(once);
  });
});

describe('resolveDatabase honours pool options regardless of resolution order (#3046)', () => {
  it('gives a later max: 5 caller its own 5-client pool after a default-sized resolve', async () => {
    // The iolaus sequence: an app-level probe resolves `{ type, url }` first.
    const probe = await resolveDatabase({ type: 'postgres', url: PG_URL });
    const capped = await resolveDatabase({
      type: 'postgres',
      url: PG_URL,
      max: 5,
    });

    expect(capped).not.toBe(probe);
    expect(poolOptions(capped).max).toBe(5);
    expect(poolOptions(probe).max).toBe(20);
  });

  it('gives the same capped pool to the same configuration in either order', async () => {
    const capped = await resolveDatabase({
      type: 'postgres',
      url: PG_URL,
      max: 5,
    });
    const again = await resolveDatabase({
      type: 'postgres',
      url: PG_URL,
      max: 5,
    });
    expect(again).toBe(capped);
    // Equal configurations share regardless of which spelling resolved first.
    const uncapped = await resolveDatabase({ type: 'postgres', url: PG_URL });
    const uncappedAgain = await resolveDatabase({
      url: PG_URL,
      type: 'postgres',
    });
    expect(uncappedAgain).toBe(uncapped);
    expect(uncapped).not.toBe(capped);
  });

  it('separates pools that differ only in pool timeouts', async () => {
    const short = await resolveDatabase({
      type: 'postgres',
      url: PG_URL,
      idleTimeoutMillis: 1000,
    });
    const long = await resolveDatabase({
      type: 'postgres',
      url: PG_URL,
      idleTimeoutMillis: 60_000,
    });
    expect(short).not.toBe(long);
    expect(poolOptions(short).idleTimeoutMillis).toBe(1000);
    expect(poolOptions(long).idleTimeoutMillis).toBe(60_000);

    const fastFail = await resolveDatabase({
      type: 'postgres',
      url: PG_URL,
      connectionTimeoutMillis: 250,
    });
    expect(poolOptions(fastFail).connectionTimeoutMillis).toBe(250);
    expect(poolOptions(short).connectionTimeoutMillis).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.connectionTimeoutMs,
    );
  });

  it('still shares one pool for an explicit caller-owned dbid', async () => {
    const first = await resolveDatabase(
      { type: 'postgres', url: PG_URL, max: 3 },
      { dbid: 'caller-owned-3046' },
    );
    const second = await resolveDatabase({
      type: 'postgres',
      url: PG_URL,
      max: 3,
      dbid: 'caller-owned-3046',
    });
    expect(second).toBe(first);
  });
});

describe('createDispatchBus forwards pool options from a config (#3046)', () => {
  function cachedPostgresPools(): number {
    return (
      (
        globalThis as unknown as {
          __haveSqlPostgresConnectionCache?: { size: number };
        }
      ).__haveSqlPostgresConnectionCache?.size ?? 0
    );
  }

  it('reuses the application pool for the same capped config instead of a default-sized one', async () => {
    const app = await resolveDatabase({
      type: 'postgres',
      url: PG_URL,
      max: 4,
    });
    expect(poolOptions(app).max).toBe(4);
    expect(cachedPostgresPools()).toBe(1);

    // `initialize()` needs a live server, so the bus rejects against the
    // unreachable URL — but only after opening (or reusing) its pool. Before
    // #3046 it rebuilt `{ type, url }`, dropped `max`, and cached a second,
    // 20-client pool next to the application's.
    const outcome = await createDispatchBus({
      db: { type: 'postgres', url: PG_URL, max: 4 },
      startupRetry: false,
    }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(cachedPostgresPools()).toBe(1);
  });

  it('forwards a caller-owned dbid', async () => {
    const owned = await resolveDatabase(
      { type: 'postgres', url: PG_URL, max: 2 },
      { dbid: 'bus-owned-3046' },
    );
    expect(cachedPostgresPools()).toBe(1);
    await createDispatchBus({
      db: { type: 'postgres', url: PG_URL, max: 9, dbid: 'bus-owned-3046' },
      startupRetry: false,
    }).catch(() => undefined);
    expect(cachedPostgresPools()).toBe(1);
    expect(poolOptions(owned).max).toBe(2);
  });
});
