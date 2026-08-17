/**
 * Every runtime path that builds a PostgreSQL pool must go through the
 * timeout bounds (#2377).
 *
 * `@happyvertical/sql` caches one pool per URL/dbid, so a single call site
 * that still passes the raw URL does not merely stay unbounded — it mints a
 * *second*, unbounded pool alongside the bounded one. These tests therefore
 * assert the options each site hands to `getDatabase()`, including the dbid,
 * which must be derived from the bounded URL so all the sites agree on one
 * pool identity.
 *
 * `.claude/rules/testing.md` says never to mock database operations, and this
 * file mocks `getDatabase` deliberately: the assertion target is the options
 * object handed *to* the adapter, which no real database can report back. The
 * behaviour those options produce is proven against a live server in
 * `issue-2377-postgres-runtime-timeouts.optional.test.ts`; nothing here asserts
 * a query result.
 */

import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDatabase } from '../database.js';
import { resolveChangesDb } from '../generators/changes-route.js';
import {
  DEFAULT_POSTGRES_TIMEOUTS,
  POSTGRES_TIMEOUT_ENV_VARS,
} from '../postgres-timeouts.js';

vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();
  return { ...actual, getDatabase: vi.fn() };
});

const getDatabaseMock = vi.mocked(getDatabase);
const PG_URL = 'postgres://user:pass@localhost:5432/appdb';
const SQLITE_URL = 'file:./local.db';

function lastOptions(): Record<string, unknown> {
  const call = getDatabaseMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return (call as unknown[])[0] as Record<string, unknown>;
}

function timeoutParams(url: unknown): URLSearchParams {
  expect(typeof url).toBe('string');
  const raw = url as string;
  const queryStart = raw.indexOf('?');
  return new URLSearchParams(
    queryStart === -1 ? '' : raw.slice(queryStart + 1),
  );
}

beforeEach(() => {
  // These assertions are against DEFAULT_POSTGRES_TIMEOUTS, so a developer
  // machine (or a CI runner) that happens to export SMRT_PG_* must not change
  // the answer.
  for (const name of Object.values(POSTGRES_TIMEOUT_ENV_VARS)) {
    vi.stubEnv(name, undefined as unknown as string);
  }
  getDatabaseMock.mockReset();
  getDatabaseMock.mockResolvedValue(
    undefined as unknown as Awaited<ReturnType<typeof getDatabase>>,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveDatabase', () => {
  it('bounds a PostgreSQL URL passed as a string shortcut', async () => {
    await resolveDatabase(PG_URL);

    const options = lastOptions();
    const params = timeoutParams(options.url);
    expect(params.get('statement_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.statementTimeoutMs),
    );
    expect(params.get('idle_in_transaction_session_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.idleInTransactionSessionTimeoutMs),
    );
    expect(params.get('lock_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.lockTimeoutMs),
    );
    expect(options.connectionTimeoutMillis).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.connectionTimeoutMs,
    );
    expect(options.dbid).toBe(`smrt:${options.url}`);
  });

  it('bounds a PostgreSQL config object and honours its timeouts key', async () => {
    await resolveDatabase({
      type: 'postgres',
      url: PG_URL,
      timeouts: { statementTimeout: '5s' },
    });

    const options = lastOptions();
    expect(timeoutParams(options.url).get('statement_timeout')).toBe('5000');
    expect(options.timeouts).toBeUndefined();
    expect(options.dbid).toBe(`smrt:${options.url}`);
  });

  it('leaves a SQLite URL and its dbid untouched', async () => {
    await resolveDatabase(SQLITE_URL);

    const options = lastOptions();
    expect(options.url).toBe(SQLITE_URL);
    expect(options.connectionTimeoutMillis).toBeUndefined();
    expect(options.dbid).toBe(`smrt:${SQLITE_URL}`);
  });

  it('keeps :memory: isolated, without a dbid', async () => {
    await resolveDatabase(':memory:');

    const options = lastOptions();
    expect(options.url).toBe(':memory:');
    expect(options.dbid).toBeUndefined();
  });

  it('respects an explicit dbid from the caller', async () => {
    await resolveDatabase(PG_URL, { dbid: 'caller-owned' });

    expect(lastOptions().dbid).toBe('caller-owned');
  });
});

describe('resolveChangesDb', () => {
  it('bounds the _changes route URL and derives its dbid from it', async () => {
    // A distinct URL per assertion: the route memoizes per option value.
    const url = `${PG_URL}?application_name=changes`;
    await resolveChangesDb(url);

    const options = lastOptions();
    expect(timeoutParams(options.url).get('statement_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.statementTimeoutMs),
    );
    expect(options.dbid).toBe(`smrt:${options.url}`);
  });

  it('bounds a _changes route config object', async () => {
    await resolveChangesDb({ type: 'postgres', url: PG_URL });

    const options = lastOptions();
    expect(timeoutParams(options.url).get('lock_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.lockTimeoutMs),
    );
    expect(options.connectionTimeoutMillis).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.connectionTimeoutMs,
    );
  });
});

describe('createDispatchBus', () => {
  it('bounds the dispatch bus connection', async () => {
    const { createDispatchBus } = await import('../dispatch/bus.js');

    // The stubbed getDatabase resolves to nothing, so initialization fails
    // after the options we care about have already been handed over.
    await createDispatchBus({
      db: { type: 'postgres', url: PG_URL },
    }).catch(() => undefined);

    const options = lastOptions();
    expect(timeoutParams(options.url).get('statement_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.statementTimeoutMs),
    );
    expect(options.connectionTimeoutMillis).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.connectionTimeoutMs,
    );
  });

  it('bounds the string-shortcut branch too', async () => {
    const { createDispatchBus } = await import('../dispatch/bus.js');

    // `DispatchBusOptions.db` does not admit a bare string, but the branch is
    // live code — it must not be the one unbounded pool in the file.
    await createDispatchBus({
      db: PG_URL as unknown as { type: 'postgres'; url: string },
    }).catch(() => undefined);

    expect(timeoutParams(lastOptions().url).get('statement_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.statementTimeoutMs),
    );
  });
});

describe('SmrtClass', () => {
  it('bounds a PostgreSQL URL handed to an object as a string', async () => {
    const { SmrtObject } = await import('../object.js');

    await new SmrtObject({ db: PG_URL }).initialize().catch(() => undefined);

    const options = lastOptions();
    expect(timeoutParams(options.url).get('statement_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.statementTimeoutMs),
    );
    expect(options.dbid).toBe(`smrt:${options.url}`);
  });

  it('bounds a PostgreSQL config object handed to an object', async () => {
    const { SmrtObject } = await import('../object.js');

    await new SmrtObject({ db: { type: 'postgres', url: PG_URL } })
      .initialize()
      .catch(() => undefined);

    const options = lastOptions();
    expect(timeoutParams(options.url).get('lock_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.lockTimeoutMs),
    );
    expect(options.dbid).toBe(`smrt:${options.url}`);
  });

  it('leaves a SQLite object database untouched', async () => {
    const { SmrtObject } = await import('../object.js');

    await new SmrtObject({ db: SQLITE_URL })
      .initialize()
      .catch(() => undefined);

    const options = lastOptions();
    expect(options.url).toBe(SQLITE_URL);
    expect(options.connectionTimeoutMillis).toBeUndefined();
  });
});
