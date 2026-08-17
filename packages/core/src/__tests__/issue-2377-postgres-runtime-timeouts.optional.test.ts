/**
 * Live PostgreSQL proof for the runtime pool timeouts (#2377).
 *
 * The unit test asserts the connection options SMRT emits; this one asserts
 * the server received them. `pg_settings.setting` is read instead of `SHOW`
 * because it reports the value in the GUC's base unit (milliseconds), so the
 * assertion does not depend on how PostgreSQL chooses to pretty-print
 * `30000ms`.
 *
 * Runs only in the dedicated disposable PostgreSQL shard.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDatabase } from '../database.js';
import { DEFAULT_POSTGRES_TIMEOUTS } from '../postgres-timeouts.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TIMEOUT_SETTINGS = [
  'statement_timeout',
  'idle_in_transaction_session_timeout',
  'lock_timeout',
];

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('runtime PostgreSQL pool timeouts (#2377)', () => {
  const opened: DatabaseInterface[] = [];

  async function connect(
    timeouts?: Record<string, string | number>,
  ): Promise<DatabaseInterface> {
    const db = await resolveDatabase(
      {
        type: 'postgres',
        url: pgUrl as string,
        ...(timeouts ? { timeouts } : {}),
      },
      { dbid: `smrt-test-2377-${randomUUID()}` },
    );
    opened.push(db);
    return db;
  }

  async function readTimeouts(
    db: DatabaseInterface,
  ): Promise<Record<string, number>> {
    const result = await db.query(
      `SELECT name, setting FROM pg_settings WHERE name IN ('${TIMEOUT_SETTINGS.join(
        "','",
      )}')`,
    );

    return Object.fromEntries(
      result.rows.map((row) => [String(row.name), Number(row.setting)]),
    );
  }

  afterEach(async () => {
    while (opened.length > 0) {
      await opened.pop()?.close?.();
    }
  });

  it('applies the default timeouts to a session opened through resolveDatabase', async () => {
    const settings = await readTimeouts(await connect());

    expect(settings.statement_timeout).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.statementTimeoutMs,
    );
    expect(settings.idle_in_transaction_session_timeout).toBe(
      DEFAULT_POSTGRES_TIMEOUTS.idleInTransactionSessionTimeoutMs,
    );
    expect(settings.lock_timeout).toBe(DEFAULT_POSTGRES_TIMEOUTS.lockTimeoutMs);
  });

  it('applies per-connection overrides', async () => {
    const settings = await readTimeouts(
      await connect({
        statementTimeout: '7s',
        idleInTransactionSessionTimeout: '11s',
        lockTimeout: '3s',
      }),
    );

    expect(settings.statement_timeout).toBe(7000);
    expect(settings.idle_in_transaction_session_timeout).toBe(11_000);
    expect(settings.lock_timeout).toBe(3000);
  });

  it('actually cancels a runaway statement instead of holding the client', async () => {
    const db = await connect({ statementTimeout: '250ms' });

    await expect(db.query('SELECT pg_sleep(5)')).rejects.toThrow();
  }, 20_000);
});
