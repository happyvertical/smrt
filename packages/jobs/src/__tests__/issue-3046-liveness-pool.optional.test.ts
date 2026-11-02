/**
 * Live PostgreSQL proof of the liveness ticker's bounded pool (#3046).
 *
 * Runs only in the disposable PostgreSQL shard (`pnpm test:postgres`): the
 * options the ticker passes build a real one-client `pg.Pool` whose sessions
 * carry the runtime timeout bounds.
 */

import { DEFAULT_POSTGRES_TIMEOUTS } from '@happyvertical/smrt-core';
import { clearPostgresConnectionCache, getDatabase } from '@happyvertical/sql';
import { afterAll, describe, expect, it } from 'vitest';
import { livenessConnectionOptions } from '../worker-liveness-ticker.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)('liveness ticker pool on PostgreSQL (#3046)', () => {
  afterAll(async () => {
    await clearPostgresConnectionCache();
  });

  it('opens a one-client pool with bounded sessions', async () => {
    const db = await getDatabase(
      livenessConnectionOptions({ url: pgUrl as string, type: 'postgres' }),
    );
    const pool = (
      db as unknown as {
        client: {
          options: { max: number; connectionTimeoutMillis: number };
          totalCount: number;
        };
      }
    ).client;

    expect(pool.options.max).toBe(1);
    expect(pool.options.connectionTimeoutMillis).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.connectionTimeoutMs,
    );

    const results = await Promise.all(
      Array.from({ length: 3 }, () => db.query('SHOW statement_timeout')),
    );
    expect(pool.totalCount).toBeLessThanOrEqual(1);
    for (const result of results) {
      expect(
        (result.rows[0] as { statement_timeout: string }).statement_timeout,
      ).toBe('30s');
    }
  });
});
