/**
 * Empirical PostgreSQL test for `runOnce()` (#3080).
 *
 * The SQLite suite (`issue-3080-run-once.test.ts`) cannot exercise this: on
 * PostgreSQL specifically, a statement that raises an error aborts the WHOLE
 * transaction ("current transaction is aborted, commands ignored until end
 * of transaction block"), so a plain `INSERT` caught for a classified
 * `unique_violation` would take the recovery `SELECT` down with it — every
 * replay and every losing side of a concurrent double submit would reject
 * instead of returning the stored result. SQLite never aborts the whole
 * transaction on a single failed statement, so that bug is invisible there.
 * `runOnce()` avoids it with `INSERT ... ON CONFLICT (claim_key) DO NOTHING
 * RETURNING claim_key`, which never raises — see `../run-once.ts`'s module
 * doc. This test proves the PostgreSQL-specific behavior empirically against
 * two genuinely concurrent connections, rather than trusting the SQLite
 * suite's single-connection serialization to stand in for it.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set — point local runs at a
 * DISPOSABLE database (the test deletes its own claim rows before and after).
 *
 * @example
 * ```bash
 * SMRT_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/smrt_test \
 *   npx vitest run src/__tests__/issue-3080-run-once-postgres.optional.test.ts
 * ```
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deriveRunOnceClaimKey,
  digestRunOnceContent,
  runOnce,
} from '../run-once';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)(
  'runOnce PostgreSQL concurrency (optional, #3080)',
  () => {
    let dbA: DatabaseInterface;
    let dbB: DatabaseInterface;

    const tenantId = 'pg-tenant';
    const actor = 'pg-actor';

    async function cleanup() {
      // Delete only rows this file's claim keys could have produced —
      // disposable-database convention, never a blanket TRUNCATE.
      const contentDigest = digestRunOnceContent({ pg: 'replay' });
      const replayKey = deriveRunOnceClaimKey({
        tenantId,
        actor,
        token: 'replay-token',
        contentDigest,
      });
      const concurrentDigest = digestRunOnceContent({ pg: 'concurrent' });
      const concurrentKey = deriveRunOnceClaimKey({
        tenantId,
        actor,
        token: 'concurrent-token',
        contentDigest: concurrentDigest,
      });
      await dbA.query(
        'DELETE FROM _smrt_run_once_claims WHERE claim_key = $1',
        replayKey,
      );
      await dbA.query(
        'DELETE FROM _smrt_run_once_claims WHERE claim_key = $1',
        concurrentKey,
      );
    }

    beforeAll(async () => {
      // Distinct dbids → distinct connection pools → genuine concurrency,
      // exactly like change-feed-concurrency.optional.test.ts.
      dbA = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: 'smrt-test-run-once-a',
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      dbB = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: 'smrt-test-run-once-b',
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

      // Bootstraps _smrt_run_once_claims (and every other system table) on
      // this real PostgreSQL database.
      await getTestDatabase({ db: dbA, classes: [] });
      await cleanup();
    });

    afterAll(async () => {
      try {
        await cleanup();
      } finally {
        await dbA?.close?.();
        await dbB?.close?.();
      }
    });

    it('replays the stored result on PostgreSQL instead of erroring on the recovery SELECT', async () => {
      const params = {
        db: dbA,
        tenantId,
        actor,
        token: 'replay-token',
        content: { pg: 'replay' },
      };
      let calls = 0;
      const work = async () => {
        calls += 1;
        return { id: `pg-po-${calls}` };
      };

      const first = await runOnce(params, work);
      // The buggy plain-INSERT-and-catch version rejects here with PostgreSQL
      // 25P02 ("current transaction is aborted") instead of resolving.
      const second = await runOnce(params, work);

      expect(second).toEqual(first);
      expect(calls).toBe(1);
    });

    it('concurrent double submit across two real connections produces one row and the same result for both', async () => {
      const content = { pg: 'concurrent' };
      let calls = 0;
      const work = async () => {
        calls += 1;
        return { id: `pg-concurrent-${calls}` };
      };

      const [r1, r2] = await Promise.all([
        runOnce(
          { db: dbA, tenantId, actor, token: 'concurrent-token', content },
          work,
        ),
        runOnce(
          { db: dbB, tenantId, actor, token: 'concurrent-token', content },
          work,
        ),
      ]);

      expect(r1).toEqual(r2);
      expect(calls).toBe(1);

      const contentDigest = digestRunOnceContent(content);
      const claimKey = deriveRunOnceClaimKey({
        tenantId,
        actor,
        token: 'concurrent-token',
        contentDigest,
      });
      const rows = await dbA.query(
        'SELECT status FROM _smrt_run_once_claims WHERE claim_key = $1',
        claimKey,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.status).toBe('completed');
    });
  },
);
