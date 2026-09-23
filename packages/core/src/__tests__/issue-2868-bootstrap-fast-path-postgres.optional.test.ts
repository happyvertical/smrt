/**
 * `ensureSystemTables()` on an already-provisioned PostgreSQL database must not
 * take the transaction-scoped `('smrt', 'system-tables')` advisory lock (#2868).
 *
 * The lock lives until the *enclosing* transaction ends. When a model's first
 * use happens inside a caller's transaction — an OIDC login, a request
 * handler — taking it even for a no-op version probe serialized every
 * concurrent transaction behind the first to commit. The PostgreSQL OIDC
 * provisioning scenarios in `packages/users` deadlocked on exactly that
 * against their two-party barrier.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemTables } from '../system/bootstrap';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const SCHEMA = `issue_2868_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

const HELD_BOOTSTRAP_LOCKS = `SELECT count(*)::int AS held
  FROM pg_locks
 WHERE locktype = 'advisory'
   AND pid = pg_backend_pid()
   AND classid = hashtext('smrt')::oid
   AND objid = hashtext('system-tables')::oid
   AND granted`;

describe.skipIf(!pgUrl)(
  'PostgreSQL system-table bootstrap fast path (#2868)',
  () => {
    let admin: DatabaseInterface | undefined;
    let db: DatabaseInterface | undefined;

    beforeAll(async () => {
      admin = (await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
        dbid: `smrt-test-2868-admin-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
      const separator = (pgUrl as string).includes('?') ? '&' : '?';
      db = (await getDatabase({
        type: 'postgres',
        url: `${pgUrl}${separator}options=-c%20search_path%3D${SCHEMA}`,
        dbid: `smrt-test-2868-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    });

    afterAll(async () => {
      await db?.close?.();
      await admin?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin?.close?.();
    });

    it('holds no bootstrap lock in a caller transaction once provisioned', async () => {
      const handle = db as DatabaseInterface;
      // Cold: provisions every system table and stamps the schema version.
      await ensureSystemTables(handle);

      const begin = handle.beginTransaction;
      if (typeof begin !== 'function') {
        throw new Error(
          'This spec requires a transactional PostgreSQL handle.',
        );
      }
      const tx = await begin.call(handle);
      try {
        await ensureSystemTables(tx as unknown as DatabaseInterface);
        const held = rowsOf(await tx.query(HELD_BOOTSTRAP_LOCKS));
        expect(Number(held[0]?.held)).toBe(0);
      } finally {
        await tx.rollback();
      }
    });

    it('still serializes a cold bootstrap under the lock', async () => {
      await admin?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin?.query(`CREATE SCHEMA "${SCHEMA}"`);
      const handle = db as DatabaseInterface;
      const tx = await (
        handle.beginTransaction as NonNullable<
          DatabaseInterface['beginTransaction']
        >
      ).call(handle);
      try {
        await ensureSystemTables(tx as unknown as DatabaseInterface);
        const held = rowsOf(await tx.query(HELD_BOOTSTRAP_LOCKS));
        expect(Number(held[0]?.held)).toBe(1);
      } finally {
        await tx.rollback();
      }
    });
  },
);
