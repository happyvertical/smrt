/**
 * The off-loop liveness ticker opens a bounded one-client pool (#3046).
 *
 * It used to call `getDatabase({ url, type })` directly: a separate
 * PostgreSQL pool with the SDK's default `max` of 20 and none of the runtime
 * timeout bounds, for a thread that issues one `UPDATE` per tick. This suite
 * pins the options the ticker hands the SDK; the live pool it builds is proven
 * against a real server in `issue-3046-liveness-pool.optional.test.ts`.
 */

import { DEFAULT_POSTGRES_TIMEOUTS } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { livenessConnectionOptions } from '../worker-liveness-ticker.js';

const PG_URL = 'postgres://smrt:secret@127.0.0.1:1/liveness_3046';

type Options = {
  url: string;
  max?: number;
  dbid?: string;
  connectionTimeoutMillis?: number;
};

describe('livenessConnectionOptions (#3046)', () => {
  it('asks for a one-client PostgreSQL pool with the runtime bounds and no shared dbid', () => {
    const options = livenessConnectionOptions({
      url: PG_URL,
      type: 'postgres',
    }) as Options;

    expect(options.max).toBe(1);
    // No dbid: the SDK keys the pool on its effective options, so it can never
    // be the application's pool for the same URL (or resize it).
    expect(options.dbid).toBeUndefined();
    expect(options.connectionTimeoutMillis).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.connectionTimeoutMs,
    );
    const params = new URLSearchParams(options.url.split('?')[1]);
    expect(params.get('statement_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.statementTimeoutMs),
    );
    expect(params.get('lock_timeout')).toBe(
      String(DEFAULT_POSTGRES_TIMEOUTS.lockTimeoutMs),
    );
  });

  it('keeps an operator-spelled timeout in the runner URL', () => {
    const options = livenessConnectionOptions({
      url: `${PG_URL}?statement_timeout=5000`,
      type: 'postgres',
    }) as Options;
    const params = new URLSearchParams(options.url.split('?')[1]);
    expect(params.getAll('statement_timeout')).toEqual(['5000']);
  });

  it('detects PostgreSQL from the URL when no type is given', () => {
    expect((livenessConnectionOptions({ url: PG_URL }) as Options).max).toBe(1);
  });

  it('passes SQLite options through unchanged', () => {
    expect(
      livenessConnectionOptions({ url: 'file:/tmp/x.db', type: 'sqlite' }),
    ).toEqual({ url: 'file:/tmp/x.db', type: 'sqlite' });
  });
});
