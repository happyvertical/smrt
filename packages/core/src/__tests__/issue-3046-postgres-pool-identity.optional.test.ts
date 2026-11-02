/**
 * Live PostgreSQL proof that a configured pool cap holds regardless of which
 * caller resolved the URL first (#3046).
 *
 * Runs only in the disposable PostgreSQL shard (`pnpm test:postgres`). The
 * unit suite proves the `pg.Pool` options; this proves the server-side effect
 * the iolaus incident hit: once an uncapped resolve of the same URL has
 * happened, a burst on the capped configuration still never holds more than
 * its `max` backends open.
 */

import {
  clearPostgresConnectionCache,
  type DatabaseInterface,
} from '@happyvertical/sql';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveDatabase } from '../database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const SLEEP_MARKER = 'issue_3046_pool_cap';

async function sleepingBackends(observer: DatabaseInterface): Promise<number> {
  const result = await observer.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND query LIKE '%${SLEEP_MARKER}%'
        AND state = 'active'`,
  );
  return Number((result.rows[0] as { n: number }).n);
}

describe.skipIf(!pgUrl)(
  'PostgreSQL pool cap under resolution order (#3046)',
  () => {
    afterAll(async () => {
      await clearPostgresConnectionCache();
    });

    it('caps a burst at the configured max after an uncapped resolve of the same URL', async () => {
      const url = pgUrl as string;
      // First resolver: the default-sized pool (the app-level probe in iolaus).
      const probe = await resolveDatabase({ type: 'postgres', url });
      await probe.query('SELECT 1');

      const capped = await resolveDatabase({ type: 'postgres', url, max: 2 });
      expect(capped).not.toBe(probe);

      const burst = Array.from({ length: 6 }, () =>
        capped.query(`SELECT pg_sleep(0.4) AS ${SLEEP_MARKER}`),
      );
      // Sample while the burst is in flight; the probe pool observes.
      let peak = 0;
      for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        peak = Math.max(peak, await sleepingBackends(probe));
      }
      await Promise.all(burst);

      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(2);
    });
  },
);
