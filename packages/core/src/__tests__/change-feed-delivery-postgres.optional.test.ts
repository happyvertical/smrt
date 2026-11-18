/**
 * PostgreSQL coverage for change-feed read consistency and delivery.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` points at a DISPOSABLE database.
 * The `test:postgres` shard runs every optional suite against one database
 * in parallel, and these tests reason about exact sequences and prune the
 * whole feed, so they run in a schema of their own: `options=-c search_path`
 * applies to every pooled connection, and the framework's unqualified feed
 * tables and helpers resolve there.
 *
 * @example
 * ```bash
 * SMRT_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/smrt_test \
 *   npx vitest run src/__tests__/change-feed-delivery-postgres.optional.test.ts
 * ```
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  getChangesSince,
  pruneChangeFeed,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { publishChangeSignal, resetChangeSignals } from '../change-signals';
import { buildChangeEventStream } from '../generators/events-route';
import { getTestDatabase } from '../testing/database';

/** Ordered `id:` values of the `change` frames in an SSE transcript. */
function changeIds(text: string): number[] {
  const ids: number[] = [];
  for (const block of text.split('\n\n')) {
    const match = /^id: (\d+)\nevent: change/m.exec(block);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  predicate: (text: string) => boolean,
  ms = 5000,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline && !predicate(text)) {
      const result = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) =>
          setTimeout(
            () => resolve('timeout'),
            Math.max(1, deadline - Date.now()),
          ),
        ),
      ]);
      if (result === 'timeout' || result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'delivery_pg_items';
const SCHEMA = 'change_feed_delivery_test';

async function connect(label: string): Promise<DatabaseInterface> {
  const separator = (pgUrl as string).includes('?') ? '&' : '?';
  return (await getDatabase({
    type: 'postgres',
    url: `${pgUrl}${separator}options=-c%20search_path%3D${SCHEMA}`,
    dbid: `smrt-test-delivery-${label}-${randomUUID()}`,
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
}

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('change feed delivery on PostgreSQL (optional)', () => {
  let admin: DatabaseInterface;
  let reader: DatabaseInterface;
  let sweeper: DatabaseInterface;

  beforeAll(async () => {
    admin = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-delivery-admin-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    // Distinct pools: the prune really runs on another connection, as a
    // retention sweep would.
    reader = await connect('reader');
    sweeper = await connect('sweeper');
    await getTestDatabase({ db: reader, classes: [] });
    registerChangeFeedWriter();
  });

  beforeEach(async () => {
    resetChangeFeedWarnings();
    resetChangeSignals();
    await reader.query('DELETE FROM _smrt_changes_pending');
    await reader.query('DELETE FROM _smrt_changes');
  });

  afterAll(async () => {
    await reader?.close?.();
    await sweeper?.close?.();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.close?.();
  });

  describe('getChangesSince with a prune committed on another connection', () => {
    function pruneOnSweeperAfterBoundsRead(maxRows: number): DatabaseInterface {
      let fired = false;
      return new Proxy(reader, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'query' && typeof value === 'function') {
            return async (sql: string, ...args: unknown[]) => {
              const result = await value.call(target, sql, ...args);
              if (!fired && /MAX\(seq\) AS horizon/.test(sql)) {
                fired = true;
                await pruneChangeFeed(sweeper, { maxRows });
              }
              return result;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }

    it('answers resyncRequired instead of skipping the pruned rows', async () => {
      for (let i = 1; i <= 15; i++) {
        await appendChange(reader, { table: TABLE, rowId: `r${i}` });
      }
      const page = await getChangesSince(pruneOnSweeperAfterBoundsRead(5), {
        since: 3,
      });
      expect(page.resyncRequired).toBe(true);
      expect(page.changes).toEqual([]);
      expect(page.cursor).toBe(3);
    });

    it('serves the page when the prune removed nothing after the cursor', async () => {
      for (let i = 1; i <= 15; i++) {
        await appendChange(reader, { table: TABLE, rowId: `r${i}` });
      }
      const page = await getChangesSince(pruneOnSweeperAfterBoundsRead(13), {
        since: 3,
      });
      expect(page.resyncRequired).toBeUndefined();
      expect(page.changes.map((change) => change.seq)).toHaveLength(12);
    });
  });

  describe('_events ordered delivery', () => {
    it('frames a write committed during a multi-page catch-up after the backlog', async () => {
      for (let i = 1; i <= 600; i++) {
        await appendChange(reader, { table: TABLE, rowId: `b${i}` });
      }
      const stream = buildChangeEventStream(reader, {
        cursor: 0,
        tenantScope: { enforced: false, tenantId: null },
      });
      // A write on another connection, signalled as the write path does.
      const seq = (await appendChange(sweeper, {
        table: TABLE,
        rowId: 'live',
      })) as number;
      publishChangeSignal(reader, {
        table: TABLE,
        operation: 'update',
        rowId: 'live',
        tenantId: null,
        seq,
      });
      const text = await readUntil(stream, (t) => t.includes('"live"'));
      await stream.cancel().catch(() => {});
      expect(changeIds(text)).toEqual(
        Array.from({ length: 601 }, (_, index) => index + 1),
      );
    });
  });

  describe('a failed append is recorded as a table-level gap', () => {
    it('writes the marker on the next append once appends succeed again', async () => {
      const notesTable = 'delivery_pg_gap_notes';
      await reader.query(
        `ALTER TABLE _smrt_changes ADD CONSTRAINT delivery_pg_gap_forced CHECK (table_name <> '${notesTable}')`,
      );
      try {
        // The framework path swallows the failure; recordInstanceChange is
        // the same path a save takes, without needing a model table.
        const { recordInstanceChange } = await import('../change-feed');
        const instance = {
          tableName: notesTable,
          db: reader,
          id: 'lost-row',
          tenantId: null,
          constructor: Object,
        } as unknown as Parameters<typeof recordInstanceChange>[0];
        await recordInstanceChange(instance, 'update');
      } finally {
        await reader.query(
          'ALTER TABLE _smrt_changes DROP CONSTRAINT delivery_pg_gap_forced',
        );
      }
      expect((await getChangesSince(reader, { since: 0 })).changes).toEqual([]);

      const { recordInstanceChange } = await import('../change-feed');
      await recordInstanceChange(
        {
          tableName: TABLE,
          db: reader,
          id: 'next-row',
          constructor: Object,
        } as unknown as Parameters<typeof recordInstanceChange>[0],
        'update',
      );
      const changes = (await getChangesSince(reader, { since: 0 })).changes;
      expect(changes.map(({ table, rowId }) => [table, rowId])).toEqual([
        [notesTable, null],
        [TABLE, 'next-row'],
      ]);
    });
  });
});
