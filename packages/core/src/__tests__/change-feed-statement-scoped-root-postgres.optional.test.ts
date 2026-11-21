/**
 * `_events` on a statement-scoped root, on PostgreSQL (#5291).
 *
 * The hosted engine hands core a root-shaped handle whose every statement
 * runs in a transaction of its own that first sets the app's schema
 * transaction-locally (`scopeDatabase` in app-shell, which owns that
 * invariant and pins it on the real proxy). This file pins core's side of the
 * contract on a fixture that mirrors it, so a change in core cannot silently
 * break that supported handle class:
 *
 * - every frame comes from the scoped schema's committed feed rows;
 * - a change committed after the stream subscribed is delivered even when its
 *   signal arrives after the head sample;
 * - a drain that skips a pass under contention moves no cursor, and the
 *   change is delivered once the contention clears.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` points at a DISPOSABLE database.
 * Each run uses schemas of its own, so parallel optional suites never meet.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  changeSignalSubscriberCount,
  publishChangeSignal,
  resetChangeSignals,
} from '../change-signals';
import {
  buildChangeEventStream,
  DEFAULT_EVENTS_HEARTBEAT_MS,
  handleEventsRoute,
} from '../generators/events-route';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'scoped_root_items';
const UNENFORCED = { enforced: false, tenantId: null } as const;
const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
const SCHEMA_A = `smrt_ssr_a_${suffix}`;
const SCHEMA_B = `smrt_ssr_b_${suffix}`;

type Raw = DatabaseInterface & {
  client?: { constructor?: unknown };
  transaction<T>(cb: (tx: any) => Promise<T>): Promise<T>;
  beginTransaction(): Promise<any>;
};

/** Hook run before one statement of a fixture, for interleavings. */
interface StatementHook {
  before?: () => Promise<void> | void;
}

/**
 * A fixture of the hosted engine's statement-scoped root: every statement
 * runs in its own transaction whose first statement sets the schema
 * transaction-locally; the raw client and every other member are hidden.
 */
function statementScoped(
  raw: Raw,
  schema: string,
  hook: StatementHook = {},
): DatabaseInterface {
  const path = `"${schema}", pg_temp`;
  const scoped = async <R>(run: (tx: any) => Promise<R>): Promise<R> => {
    const before = hook.before;
    if (before) {
      hook.before = undefined;
      await before();
    }
    return raw.transaction(async (tx: any) => {
      await tx.query(`SELECT set_config('search_path', $1, true)`, [path]);
      return run(tx);
    });
  };
  const token = {
    constructor: raw.client?.constructor,
    query: (sql: string, values?: unknown[]) =>
      scoped((tx) => (values ? tx.query(sql, values) : tx.query(sql))),
    exec: (sql: string) => scoped((tx) => tx.query(sql)),
  };
  const members: Record<string, unknown> = {
    client: token,
    query: (...args: unknown[]) => scoped((tx) => tx.query(...args)),
    execute: (...args: unknown[]) => scoped((tx) => tx.execute(...args)),
    tableExists: (...args: unknown[]) =>
      scoped((tx) => tx.tableExists(...args)),
    transaction: (cb: (tx: any) => Promise<unknown>) =>
      raw.transaction(async (tx: any) => {
        await tx.query(`SELECT set_config('search_path', $1, true)`, [path]);
        return cb(tx);
      }),
  };
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.hasOwn(members, prop))
        return members[prop];
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return undefined;
      if (value !== null && typeof value === 'object') return undefined;
      return value;
    },
  }) as DatabaseInterface;
}

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

async function open(label: string, extra = ''): Promise<Raw> {
  return (await getDatabase({
    type: 'postgres',
    url: `${pgUrl}${extra}`,
    dbid: `smrt-test-ssr-${label}-${randomUUID()}`,
  } as Parameters<typeof getDatabase>[0])) as Raw;
}

const rowsOf = (result: unknown): Array<Record<string, any>> =>
  ((result as { rows?: unknown[] }).rows ?? []) as Array<Record<string, any>>;

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe(
  '_events on a statement-scoped root (PostgreSQL, optional)',
  () => {
    let admin: Raw;
    let raw: Raw;
    let other: Raw;
    let a: DatabaseInterface;
    let b: DatabaseInterface;

    beforeAll(async () => {
      admin = await open('admin');
      for (const schema of [SCHEMA_A, SCHEMA_B]) {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        // The feed tables and helpers, provisioned in each app's own schema.
        const separator = (pgUrl as string).includes('?') ? '&' : '?';
        const setup = await open(
          `setup-${schema}`,
          `${separator}options=-c%20search_path%3D${schema}`,
        );
        await getTestDatabase({ db: setup, classes: [] });
        await setup.close?.();
      }
      raw = await open('raw');
      other = await open('other');
      a = statementScoped(raw, SCHEMA_A);
      b = statementScoped(raw, SCHEMA_B);
      registerChangeFeedWriter();
    });

    beforeEach(async () => {
      resetChangeFeedWarnings();
      resetChangeSignals();
      for (const schema of [SCHEMA_A, SCHEMA_B]) {
        await admin.query(`DELETE FROM "${schema}"._smrt_changes_pending`);
        await admin.query(`DELETE FROM "${schema}"._smrt_changes`);
      }
    });

    afterAll(async () => {
      await raw?.close?.();
      await other?.close?.();
      for (const schema of [SCHEMA_A, SCHEMA_B]) {
        await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      await admin?.close?.();
    });

    it('frames only the scoped schema committed rows', async () => {
      for (let i = 1; i <= 3; i++) {
        await appendChange(b, { table: TABLE, rowId: `b-${i}` });
      }
      const seqs: number[] = [];
      for (let i = 1; i <= 2; i++) {
        seqs.push(
          (await appendChange(a, { table: TABLE, rowId: `a-${i}` })) as number,
        );
      }
      const stream = buildChangeEventStream(a, {
        cursor: 0,
        tenantScope: UNENFORCED,
      });
      const text = await readUntil(stream, (t) => t.includes('"a-2"'));
      await stream.cancel().catch(() => {});
      expect(text).not.toContain('"b-');
      expect(changeIds(text)).toEqual(seqs);
    });

    it('delivers a change committed after subscribing whose signal arrives after the head sample, whatever other feeds signal', async () => {
      await appendChange(a, { table: TABLE, rowId: 'before' });
      const hook: StatementHook = {};
      const hooked = statementScoped(raw, SCHEMA_A, hook);
      // Another connection of the same app commits once the stream has
      // subscribed; its signal reaches the bus only later.
      const writer = statementScoped(other, SCHEMA_A);
      let seq: number | null = null;
      const arm = () => {
        if (changeSignalSubscriberCount(hooked) === 0) {
          hook.before = arm;
          return;
        }
        // Wake-ups from another feed on the same signal scope (S16), one below
        // this feed's head and one above it: neither may move the start.
        for (const foreign of [1, 10_000]) {
          publishChangeSignal(hooked, {
            table: 'other_feed_items',
            operation: 'update',
            rowId: 'foreign',
            tenantId: null,
            seq: foreign,
          });
        }
        return (async () => {
          seq = (await appendChange(writer, {
            table: TABLE,
            rowId: 'after-subscribe',
          })) as number;
          setTimeout(
            () =>
              publishChangeSignal(hooked, {
                table: TABLE,
                operation: 'update',
                rowId: 'after-subscribe',
                tenantId: null,
                seq: seq as number,
              }),
            50,
          );
        })();
      };
      hook.before = arm;
      const stream = buildChangeEventStream(hooked, {
        cursor: null,
        tenantScope: UNENFORCED,
        heartbeatMs: 100,
      });
      const text = await readUntil(stream, (t) =>
        t.includes('after-subscribe'),
      );
      // A later own change still arrives: the cursor follows this feed only.
      const next = (await appendChange(writer, {
        table: TABLE,
        rowId: 'own-next',
      })) as number;
      const more = await readUntil(stream, (t) => t.includes('own-next'));
      await stream.cancel().catch(() => {});
      expect(seq).toBe(2);
      expect(text + more).not.toContain('"before"');
      expect(changeIds(text + more)).toEqual([2, next]);
    });

    it('frames a commit made on another connection right after the route responded', async () => {
      await appendChange(a, { table: TABLE, rowId: 'before' });
      const writer = statementScoped(other, SCHEMA_A);
      const response = await handleEventsRoute(
        new Request('http://x/api/v1/_events'),
        { authMiddleware: () => async (req: Request) => req, db: a },
      );
      expect(response.status).toBe(200);
      const seq = (await appendChange(writer, {
        table: TABLE,
        rowId: 'after-response',
      })) as number;
      publishChangeSignal(a, {
        table: TABLE,
        operation: 'update',
        rowId: 'after-response',
        tenantId: null,
        seq,
      });
      const body = response.body as ReadableStream<Uint8Array>;
      const text = await readUntil(body, (t) => t.includes('after-response'));
      await body.cancel().catch(() => {});
      expect(text).not.toContain('"before"');
      expect(changeIds(text)).toEqual([seq]);
    });

    it(
      'frames a commit made right after the route responded that no signal announces',
      async () => {
        await appendChange(a, { table: TABLE, rowId: 'before' });
        const response = await handleEventsRoute(
          new Request('http://x/api/v1/_events'),
          { authMiddleware: () => async (req: Request) => req, db: a },
        );
        expect(response.status).toBe(200);
        // Committed on another connection by plain SQL: nothing publishes a
        // signal, so only the stream's own idle read can deliver it.
        const inserted = rowsOf(
          await admin.query(
            `INSERT INTO "${SCHEMA_A}"._smrt_changes (seq, table_name, row_id, operation, created_at) SELECT COALESCE(MAX(seq), 0) + 1, '${TABLE}', 'unsignalled', 'update', now() FROM "${SCHEMA_A}"._smrt_changes RETURNING seq`,
          ),
        );
        const seq = Number(inserted[0].seq);
        const body = response.body as ReadableStream<Uint8Array>;
        const text = await readUntil(
          body,
          (t) => t.includes('unsignalled'),
          DEFAULT_EVENTS_HEARTBEAT_MS + 5000,
        );
        await body.cancel().catch(() => {});
        expect(text).not.toContain('"before"');
        expect(changeIds(text)).toEqual([seq]);
      },
      DEFAULT_EVENTS_HEARTBEAT_MS + 15_000,
    );

    it('a drain skipped under contention keeps the cursor and delivers once it clears', async () => {
      const head = (await appendChange(a, {
        table: TABLE,
        rowId: 'head',
      })) as number;
      // Committed staged work, as a caller transaction leaves it.
      await admin.query(
        `INSERT INTO "${SCHEMA_A}"._smrt_changes_pending (table_name, row_id, operation, created_at) VALUES ($1, $2, 'update', now())`,
        [TABLE, 'staged'],
      );
      // Another app's drain holds the database-wide drain lock.
      const holder = await other.beginTransaction();
      try {
        await holder.query(
          `SELECT pg_advisory_xact_lock(hashtext('smrt'), hashtext('change-feed-drain'))`,
        );
        const stream = buildChangeEventStream(a, {
          cursor: head,
          tenantScope: UNENFORCED,
          heartbeatMs: 50,
        });
        const during = await readUntil(stream, () => false, 400);
        expect(changeIds(during)).toEqual([]);
        expect(during).not.toContain('event: resync');
        expect(
          rowsOf(
            await admin.query(
              `SELECT count(*)::int AS n FROM "${SCHEMA_A}"._smrt_changes_pending`,
            ),
          )[0].n,
        ).toBe(1);
        await holder.commit();
        const after = await readUntil(stream, (t) => t.includes('"staged"'));
        await stream.cancel().catch(() => {});
        expect(changeIds(after)).toEqual([head + 1]);
      } finally {
        if ((holder as { isActive?: () => boolean }).isActive?.() !== false) {
          await holder.rollback?.().catch(() => {});
        }
      }
    });
  },
);
