/**
 * PostgreSQL coverage for the change-feed table-authorization deny-all path
 * (#3020 P1 follow-up).
 *
 * `change-feed-authz.ts`'s table hook denies a request by setting
 * `getChangesSince`'s explicit `denyAllTables` option rather than passing a
 * synthesized "match nothing" table name through the ordinary
 * `table_name IN (...)` clause. An earlier version used a NUL-prefixed
 * sentinel table name there; PostgreSQL rejects a NUL byte in a text
 * parameter, so a denied `_changes`/`_events` request threw a database error
 * (surfaced as a 500) instead of answering 200 with an empty page and an
 * advancing cursor — the documented fail-closed contract
 * (`change-feed-authz.ts`'s "Fail-closed" section). SQLite/DuckDB never
 * rejected the NUL byte, so the SQLite suite
 * (`issue-3020-change-feed-authz.test.ts`) could not catch this; it needs a
 * real PostgreSQL connection.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set — point local runs at a
 * disposable database.
 *
 * @example
 * ```bash
 * SMRT_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/smrt_test \
 *   npx vitest run src/__tests__/issue-3020-deny-all-postgres.optional.test.ts
 * ```
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appendChange,
  ensureChangeFeedTable,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  getAuthorizedTenantScopedChangesSince,
  setChangeFeedAuthorizer,
} from '../change-feed-authz';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const PUNCHES_TABLE = 'issue3020_pg_deny_all_punches';

describe.skipIf(!pgUrl)(
  'change-feed table-authorization deny-all on PostgreSQL (#3020 P1)',
  () => {
    let db: DatabaseInterface;

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-3020-deny-all-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      // Same "existing PostgreSQL handle" init path the concurrency optional
      // test exercises: installs the append helper alongside system tables.
      await getTestDatabase({ db, classes: [] });
      await ensureChangeFeedTable(db);
      registerChangeFeedWriter();
      resetChangeFeedWarnings();
    });

    afterEach(() => {
      setChangeFeedAuthorizer(undefined);
    });

    afterAll(async () => {
      await db?.close?.();
    });

    it('a deny-all authorizer answers 200/empty with an advancing cursor, never a NUL-byte database error', async () => {
      setChangeFeedAuthorizer(() => []);
      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: 'p1',
        operation: 'create',
      });

      const request = new Request('http://localhost/api/_changes');
      const page = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: undefined,
        request,
      });

      expect(page.changes).toHaveLength(0);
      // The cursor still advances past the denied entry — never resyncRequired
      // for what is, from the caller's own database, an ordinary filtered page.
      expect(page.cursor).toBeGreaterThan(0);
      expect(page.resyncRequired).toBeUndefined();

      // Polling again from the advanced cursor is stable (idempotent) — the
      // station is never stuck re-polling `since: 0` forever.
      const next = await getAuthorizedTenantScopedChangesSince(db, {
        since: page.cursor,
        locals: undefined,
        request,
      });
      expect(next.changes).toHaveLength(0);
      expect(next.cursor).toBe(page.cursor);
    });
  },
);
