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
  recordInstanceChange,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  type ChangeSignal,
  publishChangeSignal,
  resetChangeSignals,
  subscribeToChangeSignals,
} from '../change-signals';
import { withEmbeddedWriteTransaction } from '../embedded-write-queue';
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

  describe('live signals follow the commit of a framework transaction', () => {
    function instanceOn(db: DatabaseInterface, rowId: string) {
      return {
        tableName: TABLE,
        db,
        id: rowId,
        constructor: Object,
      } as unknown as Parameters<typeof recordInstanceChange>[0];
    }

    it('publishes nothing for an append that is rolled back with its transaction', async () => {
      const received: ChangeSignal[] = [];
      const unsubscribe = subscribeToChangeSignals(reader, (signal) =>
        received.push(signal),
      );
      try {
        await expect(
          withEmbeddedWriteTransaction(reader, false, async (tx) => {
            // The transaction's first statement: allocated directly, not
            // staged, so before this fix its signal went out pre-commit.
            await recordInstanceChange(instanceOn(tx, 'rolled-back'));
            throw new Error('roll back');
          }),
        ).rejects.toThrow('roll back');
        expect(received).toEqual([]);

        await withEmbeddedWriteTransaction(reader, false, async (tx) => {
          await recordInstanceChange(instanceOn(tx, 'committed'));
          expect(received).toEqual([]);
        });
        expect(received.map((signal) => signal.rowId)).toEqual(['committed']);
      } finally {
        unsubscribe();
      }
    });
  });

  describe('_events shared reads across PostgreSQL sessions', () => {
    const OTHER_SCHEMA = 'change_feed_delivery_other';
    let other: DatabaseInterface | undefined;

    afterAll(async () => {
      await other?.close?.();
      await admin?.query(`DROP SCHEMA IF EXISTS ${OTHER_SCHEMA} CASCADE`);
    });

    it('never shares a page between two handles on one URL whose sessions see different schemas', async () => {
      await admin.query(`DROP SCHEMA IF EXISTS ${OTHER_SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${OTHER_SCHEMA}`);
      const separator = (pgUrl as string).includes('?') ? '&' : '?';
      other = (await getDatabase({
        type: 'postgres',
        url: `${pgUrl}${separator}options=-c%20search_path%3D${OTHER_SCHEMA}`,
        dbid: `smrt-test-delivery-other-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      await getTestDatabase({ db: other, classes: [] });
      await appendChange(reader, {
        table: TABLE,
        rowId: 'only-in-test-schema',
      });
      await appendChange(other, {
        table: TABLE,
        rowId: 'only-in-other-schema',
      });
      // The same URL as `reader`, but a session that sees the other schema.
      const sameUrl = new Proxy(other, {
        get(target, prop, receiver) {
          if (prop === 'url') return (reader as { url?: string }).url;
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as DatabaseInterface;

      const streamA = buildChangeEventStream(reader, {
        cursor: 0,
        tenantScope: { enforced: false, tenantId: null },
      });
      const streamB = buildChangeEventStream(sameUrl, {
        cursor: 0,
        tenantScope: { enforced: false, tenantId: null },
      });
      const [textA, textB] = await Promise.all([
        readUntil(streamA, (t) => t.includes('event: change')),
        readUntil(streamB, (t) => t.includes('event: change')),
      ]);
      await streamA.cancel().catch(() => {});
      await streamB.cancel().catch(() => {});
      expect(textA).toContain('only-in-test-schema');
      expect(textA).not.toContain('only-in-other-schema');
      expect(textB).toContain('only-in-other-schema');
      expect(textB).not.toContain('only-in-test-schema');
    });

    it('frames an unsequenced signal only for the handle it was published on, not another schema on the same URL', async () => {
      await other?.close?.();
      await admin.query(`DROP SCHEMA IF EXISTS ${OTHER_SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${OTHER_SCHEMA}`);
      const separator = (pgUrl as string).includes('?') ? '&' : '?';
      other = (await getDatabase({
        type: 'postgres',
        url: `${pgUrl}${separator}options=-c%20search_path%3D${OTHER_SCHEMA}`,
        dbid: `smrt-test-delivery-other-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      await getTestDatabase({ db: other, classes: [] });
      const sameUrl = new Proxy(other, {
        get(target, prop, receiver) {
          if (prop === 'url') return (reader as { url?: string }).url;
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as DatabaseInterface;

      const streamA = buildChangeEventStream(reader, {
        cursor: null,
        tenantScope: { enforced: false, tenantId: null },
      });
      const streamB = buildChangeEventStream(sameUrl, {
        cursor: null,
        tenantScope: { enforced: false, tenantId: null },
      });
      await Promise.all([
        readUntil(streamA, (t) => t.includes('retry:'), 2000),
        readUntil(streamB, (t) => t.includes('retry:'), 2000),
      ]);
      publishChangeSignal(reader, {
        table: TABLE,
        operation: 'update',
        rowId: 'unsequenced-in-test-schema',
        tenantId: null,
        seq: 0,
      });
      const [textA, textB] = await Promise.all([
        readUntil(
          streamA,
          (t) => t.includes('unsequenced-in-test-schema'),
          1000,
        ),
        readUntil(
          streamB,
          (t) => t.includes('unsequenced-in-test-schema'),
          600,
        ),
      ]);
      await streamA.cancel().catch(() => {});
      await streamB.cancel().catch(() => {});
      expect(textA).toContain('unsequenced-in-test-schema');
      expect(textB).not.toContain('unsequenced-in-test-schema');
    });

    it('refuses a stream built from a transaction handle whose session reads another schema', async () => {
      await other?.close?.();
      await admin.query(`DROP SCHEMA IF EXISTS ${OTHER_SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${OTHER_SCHEMA}`);
      const separator = (pgUrl as string).includes('?') ? '&' : '?';
      other = (await getDatabase({
        type: 'postgres',
        url: `${pgUrl}${separator}options=-c%20search_path%3D${OTHER_SCHEMA}`,
        dbid: `smrt-test-delivery-other-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      await getTestDatabase({ db: other, classes: [] });
      await appendChange(reader, { table: TABLE, rowId: 'root-schema-row' });
      await appendChange(other, { table: TABLE, rowId: 'tx-schema-row' });

      let released = 0;
      let stream: ReadableStream<Uint8Array> | undefined;
      await expect(
        withEmbeddedWriteTransaction(reader, false, async (tx) => {
          await tx.query(`SET LOCAL search_path TO ${OTHER_SCHEMA}`);
          stream = buildChangeEventStream(tx, {
            cursor: 0,
            tenantScope: { enforced: false, tenantId: null },
            releaseSubscriberSlot: () => {
              released++;
            },
          });
          return stream;
        }),
      ).rejects.toThrow(/PostgreSQL framework transaction's handle/);
      if (stream) {
        // Only reached without the guard: show what the stream would serve.
        const text = await readUntil(stream, (t) =>
          t.includes('event: change'),
        );
        await stream.cancel().catch(() => {});
        expect(text).not.toContain('root-schema-row');
      }
      expect(released).toBe(1);
    });
  });
});
