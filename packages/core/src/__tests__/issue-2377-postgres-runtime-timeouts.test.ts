/**
 * Runtime PostgreSQL pool timeouts (#2377).
 *
 * The regression these lock down: `@happyvertical/sql` builds its pool as
 * `new Pool({ connectionString, max })`, so before this change a SMRT runtime
 * pool inherited `pg`'s unbounded defaults on every PostgreSQL deployment.
 *
 * The assertions are on the *emitted connection options* — the URL parameters
 * `pg` lifts into the startup packet plus the `connectionTimeoutMillis` pool
 * option — because that is the only thing SMRT controls: the pool object
 * itself lives inside the SDK. `issue-2377-postgres-runtime-timeouts.optional.test.ts`
 * proves the same URL actually lands as `SHOW statement_timeout` on a live
 * server.
 */

import { describe, expect, it } from 'vitest';
import { parsePostgresTimeoutMs as migrationsParser } from '../migrations/index.js';
import {
  applyPostgresRuntimeTimeouts,
  applyPostgresTimeoutsToUrl,
  DEFAULT_POSTGRES_TIMEOUTS,
  isPostgresTarget,
  POSTGRES_TIMEOUT_ENV_VARS,
  parsePostgresTimeoutMs,
  resolvePostgresTimeouts,
} from '../postgres-timeouts.js';

const PG_URL = 'postgres://user:pass@localhost:5432/appdb';

/** Read the emitted parameters the way `pg-connection-string` does. */
function connectionParams(url: string): URLSearchParams {
  const queryStart = url.indexOf('?');
  return new URLSearchParams(
    queryStart === -1 ? '' : url.slice(queryStart + 1),
  );
}

describe('parsePostgresTimeoutMs', () => {
  it('reads bare numbers as milliseconds', () => {
    expect(parsePostgresTimeoutMs(1500, 99)).toBe(1500);
    expect(parsePostgresTimeoutMs('1500', 99)).toBe(1500);
  });

  it('reads the duration suffixes migrations config already uses', () => {
    expect(parsePostgresTimeoutMs('30s', 99)).toBe(30_000);
    expect(parsePostgresTimeoutMs('250ms', 99)).toBe(250);
    expect(parsePostgresTimeoutMs('2min', 99)).toBe(120_000);
    expect(parsePostgresTimeoutMs('2m', 99)).toBe(120_000);
    expect(parsePostgresTimeoutMs('1h', 99)).toBe(3_600_000);
    expect(parsePostgresTimeoutMs(' 5S ', 99)).toBe(5000);
  });

  it('preserves 0 as PostgreSQL disabled rather than treating it as missing', () => {
    expect(parsePostgresTimeoutMs(0, 99)).toBe(0);
    expect(parsePostgresTimeoutMs('0', 99)).toBe(0);
    expect(parsePostgresTimeoutMs('0s', 99)).toBe(0);
  });

  it('falls back for missing, empty, negative, or unparseable input', () => {
    expect(parsePostgresTimeoutMs(undefined, 99)).toBe(99);
    expect(parsePostgresTimeoutMs('', 99)).toBe(99);
    expect(parsePostgresTimeoutMs('   ', 99)).toBe(99);
    expect(parsePostgresTimeoutMs(-1, 99)).toBe(99);
    expect(parsePostgresTimeoutMs(Number.NaN, 99)).toBe(99);
    expect(parsePostgresTimeoutMs('soon', 99)).toBe(99);
    expect(parsePostgresTimeoutMs('30 seconds', 99)).toBe(99);
  });

  it('is the same function the migrations subpath publishes (#2362)', () => {
    // `migrations.postgres.*` and a runtime `timeouts` config are written in the
    // same spelling, so they are parsed by one implementation rather than two
    // that can drift. `@happyvertical/smrt-core/migrations` re-exports this
    // exact binding; identity is the assertion, not behavioural agreement.
    expect(migrationsParser).toBe(parsePostgresTimeoutMs);
  });
});

describe('resolvePostgresTimeouts', () => {
  it('defaults every timeout when nothing is configured', () => {
    expect(resolvePostgresTimeouts({}, {})).toEqual(DEFAULT_POSTGRES_TIMEOUTS);
  });

  it('bounds every documented failure mode by default', () => {
    // The point of the issue: none of these may be 0/unbounded out of the box.
    for (const value of Object.values(DEFAULT_POSTGRES_TIMEOUTS)) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it('reads environment variables when configuration is silent', () => {
    const resolved = resolvePostgresTimeouts(
      {},
      {
        [POSTGRES_TIMEOUT_ENV_VARS.connectionTimeout]: '3s',
        [POSTGRES_TIMEOUT_ENV_VARS.statementTimeout]: '7s',
        [POSTGRES_TIMEOUT_ENV_VARS.idleInTransactionSessionTimeout]: '11s',
        [POSTGRES_TIMEOUT_ENV_VARS.lockTimeout]: '13s',
      },
    );

    expect(resolved).toEqual({
      connectionTimeoutMs: 3000,
      statementTimeoutMs: 7000,
      idleInTransactionSessionTimeoutMs: 11_000,
      lockTimeoutMs: 13_000,
    });
  });

  it('prefers explicit configuration over the environment', () => {
    const resolved = resolvePostgresTimeouts(
      { statementTimeout: '5s' },
      {
        [POSTGRES_TIMEOUT_ENV_VARS.statementTimeout]: '90s',
        [POSTGRES_TIMEOUT_ENV_VARS.lockTimeout]: '4s',
      },
    );

    expect(resolved.statementTimeoutMs).toBe(5000);
    // ...without the explicit key swallowing the others.
    expect(resolved.lockTimeoutMs).toBe(4000);
  });

  it('lets each key fall back to its own default, never to a sibling', () => {
    const resolved = resolvePostgresTimeouts({ lockTimeout: 'nonsense' }, {});
    expect(resolved.lockTimeoutMs).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.lockTimeoutMs,
    );
    expect(resolved.statementTimeoutMs).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.statementTimeoutMs,
    );
  });

  it('honours an explicit 0 as disabled', () => {
    expect(resolvePostgresTimeouts({ statementTimeout: 0 }, {})).toMatchObject({
      statementTimeoutMs: 0,
    });
  });
});

describe('isPostgresTarget', () => {
  it('detects PostgreSQL from the URL scheme', () => {
    expect(isPostgresTarget(PG_URL)).toBe(true);
    expect(isPostgresTarget('postgresql://localhost/db')).toBe(true);
    expect(isPostgresTarget('POSTGRES://localhost/db')).toBe(true);
  });

  it('detects PostgreSQL from an explicit type', () => {
    expect(isPostgresTarget(undefined, 'postgres')).toBe(true);
    expect(isPostgresTarget(undefined, 'postgresql')).toBe(true);
    expect(isPostgresTarget(undefined, 'pg')).toBe(true);
  });

  it('is false for every other engine', () => {
    expect(isPostgresTarget(':memory:')).toBe(false);
    expect(isPostgresTarget('file:./local.db')).toBe(false);
    expect(isPostgresTarget('products.db')).toBe(false);
    expect(isPostgresTarget('./data/warehouse.duckdb')).toBe(false);
    expect(isPostgresTarget(undefined, 'sqlite')).toBe(false);
    expect(isPostgresTarget(undefined, 'duckdb')).toBe(false);
    expect(isPostgresTarget(undefined, 'json')).toBe(false);
  });

  it('lets an explicit non-PostgreSQL type win over a PostgreSQL-looking URL', () => {
    expect(isPostgresTarget(PG_URL, 'sqlite')).toBe(false);
  });

  it('treats an empty type as unspecified and reads the URL', () => {
    expect(isPostgresTarget(PG_URL, '')).toBe(true);
    expect(isPostgresTarget(PG_URL, '  ')).toBe(true);
    expect(isPostgresTarget(':memory:', '')).toBe(false);
  });
});

describe('applyPostgresTimeoutsToUrl', () => {
  const timeouts = {
    connectionTimeoutMs: 10_000,
    statementTimeoutMs: 30_000,
    idleInTransactionSessionTimeoutMs: 60_000,
    lockTimeoutMs: 10_000,
  };

  it('emits the three parameters pg forwards in the startup packet', () => {
    const params = connectionParams(
      applyPostgresTimeoutsToUrl(PG_URL, timeouts),
    );

    expect(params.get('statement_timeout')).toBe('30000');
    expect(params.get('idle_in_transaction_session_timeout')).toBe('60000');
    expect(params.get('lock_timeout')).toBe('10000');
    // connectionTimeoutMillis has no connection-string spelling in pg; it is a
    // pool option and is asserted through applyPostgresRuntimeTimeouts.
    expect(params.has('connectionTimeoutMillis')).toBe(false);
  });

  it('preserves the base URL and any existing parameters', () => {
    const url = applyPostgresTimeoutsToUrl(
      `${PG_URL}?sslmode=require&application_name=smrt`,
      timeouts,
    );

    expect(url.startsWith(`${PG_URL}?`)).toBe(true);
    const params = connectionParams(url);
    expect(params.get('sslmode')).toBe('require');
    expect(params.get('application_name')).toBe('smrt');
    expect(params.get('statement_timeout')).toBe('30000');
  });

  it('never overrides a timeout the operator spelled into the DSN', () => {
    const url = applyPostgresTimeoutsToUrl(
      `${PG_URL}?statement_timeout=1234`,
      timeouts,
    );

    const params = connectionParams(url);
    expect(params.get('statement_timeout')).toBe('1234');
    // ...while the parameters the DSN did not set are still bounded.
    expect(params.get('lock_timeout')).toBe('10000');
  });

  it('is idempotent, so re-resolving the same config keeps one pool identity', () => {
    const once = applyPostgresTimeoutsToUrl(PG_URL, timeouts);
    expect(applyPostgresTimeoutsToUrl(once, timeouts)).toBe(once);
  });

  it('writes an explicit 0 so a disabled timeout overrides a server default', () => {
    const params = connectionParams(
      applyPostgresTimeoutsToUrl(PG_URL, {
        ...timeouts,
        statementTimeoutMs: 0,
      }),
    );
    expect(params.get('statement_timeout')).toBe('0');
  });

  it('keeps a URL fragment after the query string', () => {
    const url = applyPostgresTimeoutsToUrl(`${PG_URL}#note`, timeouts);
    expect(url.endsWith('#note')).toBe(true);
    expect(
      connectionParams(url.slice(0, url.indexOf('#'))).get('statement_timeout'),
    ).toBe('30000');
  });
});

describe('applyPostgresRuntimeTimeouts', () => {
  it('returns non-PostgreSQL configurations untouched', () => {
    for (const config of [
      { url: ':memory:' },
      { url: 'file:./local.db', type: 'sqlite' },
      { url: './data/warehouse.duckdb', type: 'duckdb' },
      { url: './data', type: 'json' },
    ]) {
      expect(applyPostgresRuntimeTimeouts(config, {})).toBe(config);
    }
  });

  it('bounds a PostgreSQL URL and emits the pool connection timeout', () => {
    const bounded = applyPostgresRuntimeTimeouts(
      { type: 'postgres', url: PG_URL },
      {},
    );

    expect(bounded.connectionTimeoutMillis).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.connectionTimeoutMs,
    );
    const params = connectionParams(bounded.url as string);
    expect(params.get('statement_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.statementTimeoutMs),
    );
    expect(params.get('idle_in_transaction_session_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.idleInTransactionSessionTimeoutMs),
    );
    expect(params.get('lock_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.lockTimeoutMs),
    );
  });

  it('applies per-connection configuration and does not forward the timeouts key', () => {
    const bounded = applyPostgresRuntimeTimeouts(
      {
        type: 'postgres',
        url: PG_URL,
        timeouts: { statementTimeout: '5s', connectionTimeout: '2s' },
      },
      {},
    );

    expect('timeouts' in bounded).toBe(false);
    expect(bounded.connectionTimeoutMillis).toBe(2000);
    expect(
      connectionParams(bounded.url as string).get('statement_timeout'),
    ).toBe('5000');
  });

  it('preserves unrelated adapter options', () => {
    const bounded = applyPostgresRuntimeTimeouts(
      { type: 'postgres', url: PG_URL, max: 5, dbid: 'smrt:custom' },
      {},
    );

    expect(bounded.max).toBe(5);
    expect(bounded.dbid).toBe('smrt:custom');
  });

  it('still bounds acquisition when a PostgreSQL config carries no URL', () => {
    const bounded = applyPostgresRuntimeTimeouts(
      { type: 'postgres', host: 'db', database: 'appdb' },
      {},
    );

    expect(bounded.url).toBeUndefined();
    expect(bounded.connectionTimeoutMillis).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.connectionTimeoutMs,
    );
  });

  it('produces one identical result for one configuration, so the dbid is stable', () => {
    const first = applyPostgresRuntimeTimeouts({ url: PG_URL }, {});
    const second = applyPostgresRuntimeTimeouts({ url: PG_URL }, {});
    expect(first.url).toBe(second.url);
  });
});
