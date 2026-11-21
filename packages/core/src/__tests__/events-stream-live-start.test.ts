/**
 * `_events` live-forward start (#5291): where a stream opened without a
 * cursor begins.
 *
 * A writer publishes its signal only after its own commit, so the signal can
 * reach the bus after the stream has already sampled the feed's head. And a
 * sequenced wake-up need not come from this stream's feed at all (a peer
 * notification for another schema on the same URL). The starting cursor must
 * therefore not depend on when, or from where, a signal arrives:
 *
 * - a change committed after the stream subscribed is delivered, whenever its
 *   signal arrives;
 * - a wake-up whose sequence is not from this feed never moves the start:
 *   it neither replays rows committed before the stream opened nor makes the
 *   stream wait for a sequence its feed will not reach.
 */
import http from 'node:http';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  ensureChangeFeedTable,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  changeSignalSubscriberCount,
  publishChangeSignal,
  resetChangeSignals,
} from '../change-signals';
import { withEmbeddedWriteTransaction } from '../embedded-write-queue';
import {
  buildChangeEventStream,
  handleEventsRoute,
  tryReserveChangeEventSubscriberSlot,
} from '../generators/events-route';
import { APIGenerator } from '../generators/rest';
import { getTestDatabase } from '../testing/database';

const TABLE = 'live_start_items';
const BACKLOG = 5;
const UNENFORCED = { enforced: false, tenantId: null } as const;

/** Ordered `id:` values of the `change` frames in an SSE transcript. */
function changeIds(text: string): number[] {
  const ids: number[] = [];
  for (const block of text.split('\n\n')) {
    const match = /^id: (\d+)\nevent: change/m.exec(block);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

/** Read until `predicate(text)` holds, the stream ends, or `ms` elapses. */
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  predicate: (text: string) => boolean,
  ms = 3000,
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

/**
 * Run `hook` once, before the first statement the stream issues while it is
 * subscribed. The hook's own statements pass straight through. `after` runs
 * once that first statement has returned.
 */
function onFirstSubscribedStatement(
  db: DatabaseInterface,
  hook: () => Promise<void> | void,
  after: () => void = () => {},
): void {
  const query = db.query.bind(db);
  let fired = false;
  let inHook = false;
  (db as { query: unknown }).query = async (
    sql: string,
    ...args: unknown[]
  ) => {
    if (fired || inHook || changeSignalSubscriberCount(db) === 0) {
      return query(sql, ...(args as []));
    }
    fired = true;
    inHook = true;
    try {
      await hook();
    } finally {
      inHook = false;
    }
    const result = await query(sql, ...(args as []));
    after();
    return result;
  };
}

describe('_events live-forward start (#5291)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await ensureChangeFeedTable(db);
    for (let index = 1; index <= BACKLOG; index++) {
      await appendChange(db, { table: TABLE, rowId: `before-${index}` });
    }
  });

  afterEach(async () => {
    resetChangeSignals();
    await db.close?.();
  });

  it('delivers a change committed after subscribing whose signal arrives after the head sample', async () => {
    let seq: number | null = null;
    onFirstSubscribedStatement(
      db,
      async () => {
        seq = (await appendChange(db, {
          table: TABLE,
          rowId: 'after-subscribe',
        })) as number;
      },
      // The writer's signal reaches the bus only after that statement
      // returned, as a post-commit publish on another connection can.
      () =>
        setTimeout(() =>
          publishChangeSignal(db, {
            table: TABLE,
            operation: 'update',
            rowId: 'after-subscribe',
            tenantId: null,
            seq: seq as number,
          }),
        ),
    );
    const stream = buildChangeEventStream(db, {
      cursor: null,
      tenantScope: UNENFORCED,
      heartbeatMs: 50,
    });
    const text = await readUntil(stream, (t) => t.includes('after-subscribe'));
    await stream.cancel().catch(() => {});
    expect(seq).toBe(BACKLOG + 1);
    expect(changeIds(text)).toEqual([BACKLOG + 1]);
  });

  it('a wake-up below the head from another feed replays nothing from before the stream opened', async () => {
    onFirstSubscribedStatement(db, () =>
      publishChangeSignal(db, {
        table: 'other_feed_items',
        operation: 'update',
        rowId: 'foreign',
        tenantId: null,
        seq: 1,
      }),
    );
    const stream = buildChangeEventStream(db, {
      cursor: null,
      tenantScope: UNENFORCED,
      heartbeatMs: 50,
    });
    await readUntil(stream, (t) => t.includes('retry:'), 1000);
    const seq = (await appendChange(db, {
      table: TABLE,
      rowId: 'own-live',
    })) as number;
    publishChangeSignal(db, {
      table: TABLE,
      operation: 'update',
      rowId: 'own-live',
      tenantId: null,
      seq,
    });
    const text = await readUntil(stream, (t) => t.includes('own-live'));
    await stream.cancel().catch(() => {});
    expect(text).not.toContain('before-');
    expect(changeIds(text)).toEqual([seq]);
  });

  it('a wake-up above the head from another feed never makes the stream wait for it', async () => {
    onFirstSubscribedStatement(db, () =>
      publishChangeSignal(db, {
        table: 'other_feed_items',
        operation: 'update',
        rowId: 'foreign',
        tenantId: null,
        seq: 10_000,
      }),
    );
    const stream = buildChangeEventStream(db, {
      cursor: null,
      tenantScope: UNENFORCED,
      heartbeatMs: 50,
    });
    await readUntil(stream, (t) => t.includes('retry:'), 1000);
    const seq = (await appendChange(db, {
      table: TABLE,
      rowId: 'own-live',
    })) as number;
    publishChangeSignal(db, {
      table: TABLE,
      operation: 'update',
      rowId: 'own-live',
      tenantId: null,
      seq,
    });
    const text = await readUntil(stream, (t) => t.includes('own-live'));
    // A later own change still arrives too: the cursor follows this feed.
    const next = (await appendChange(db, {
      table: TABLE,
      rowId: 'own-next',
    })) as number;
    const more = await readUntil(stream, (t) => t.includes('own-next'));
    await stream.cancel().catch(() => {});
    expect(text).not.toContain('before-');
    expect(changeIds(text + more)).toEqual([seq, next]);
  });
});

describe('_events route: the response implies a fixed start (#5291)', () => {
  let db: DatabaseInterface;
  const allowAuth =
    () =>
    async (req: Request): Promise<Request | Response> =>
      req;
  const open = () =>
    handleEventsRoute(new Request('http://x/api/v1/_events'), {
      authMiddleware: allowAuth,
      db,
    });
  const signal = (rowId: string, seq: number) =>
    publishChangeSignal(db, {
      table: TABLE,
      operation: 'update',
      rowId,
      tenantId: null,
      seq,
    });

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await ensureChangeFeedTable(db);
    for (let index = 1; index <= BACKLOG; index++) {
      await appendChange(db, { table: TABLE, rowId: `before-${index}` });
    }
  });

  afterEach(async () => {
    resetChangeSignals();
    await db.close?.();
  });

  it('frames a change committed right after the response, before the stream has read anything', async () => {
    const response = await open();
    expect(response.status).toBe(200);
    const seq = (await appendChange(db, {
      table: TABLE,
      rowId: 'after-response',
    })) as number;
    signal('after-response', seq);
    const body = response.body as ReadableStream<Uint8Array>;
    const text = await readUntil(body, (t) => t.includes('after-response'));
    await body.cancel().catch(() => {});
    expect(changeIds(text)).toEqual([seq]);
  });

  it('a request opened during a framework transaction responds only after it commits, and frames what follows', async () => {
    let releaseTransaction: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let released = false;
    const transaction = withEmbeddedWriteTransaction(db, true, async (tx) => {
      await appendChange(tx, { table: TABLE, rowId: 'in-transaction' });
      entered();
      await gate;
    });
    await inside;
    let respondedWhileOpen = false;
    const pending = open().then((response) => {
      if (!released) respondedWhileOpen = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    released = true;
    releaseTransaction();
    await transaction;
    const response = await pending;
    expect(respondedWhileOpen).toBe(false);
    // The transaction's change is visible to a state load at `onopen`; what
    // commits after the response is framed.
    const seq = (await appendChange(db, {
      table: TABLE,
      rowId: 'after-response',
    })) as number;
    signal('after-response', seq);
    const body = response.body as ReadableStream<Uint8Array>;
    const text = await readUntil(body, (t) => t.includes('after-response'));
    await body.cancel().catch(() => {});
    expect(changeIds(text)).toEqual([seq]);
  });
});

/** Resolve once `predicate()` holds; fail after `ms`. */
async function waitUntil(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Make every statement fail while `when()` holds, as a statement or pool
 * timeout would.
 */
function failStatementsWhile(db: DatabaseInterface, when: () => boolean): void {
  const query = db.query.bind(db);
  (db as { query: unknown }).query = async (
    sql: string,
    ...args: unknown[]
  ) => {
    if (when()) throw new Error('statement timeout');
    return query(sql, ...(args as []));
  };
}

/** Hold a framework write transaction open until the returned release runs. */
async function holdWriteTransaction(
  db: DatabaseInterface,
): Promise<{ release: () => Promise<void> }> {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let entered: () => void = () => {};
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const transaction = withEmbeddedWriteTransaction(db, true, async (tx) => {
    await appendChange(tx, { table: TABLE, rowId: 'in-transaction' });
    entered();
    await gate;
  });
  await inside;
  return {
    release: async () => {
      open();
      await transaction;
    },
  };
}

describe('_events start that cannot be resolved (#5291)', () => {
  let db: DatabaseInterface;
  const allowAuth =
    () =>
    async (req: Request): Promise<Request | Response> =>
      req;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await ensureChangeFeedTable(db);
    await appendChange(db, { table: TABLE, rowId: 'before-1' });
  });

  afterEach(async () => {
    resetChangeSignals();
    await db.close?.();
  });

  it('answers a failed head sample with a retryable stream and releases the slot', async () => {
    // Only the head sample runs while the route holds its slot.
    failStatementsWhile(db, () => changeSignalSubscriberCount(db) > 0);
    const response = await handleEventsRoute(
      new Request('http://x/api/v1/_events'),
      { authMiddleware: allowAuth, db },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toMatch(/^retry: \d+\nid: resync\nevent: unavailable\ndata: /);
    // No feed sequence and no detail of the failure reach the client.
    expect(text).not.toMatch(/id: \d/);
    expect(text).not.toContain('statement timeout');
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });

  it('answers a cursor-less open inside a framework transaction with a retryable stream and releases the slot', async () => {
    const response = await withEmbeddedWriteTransaction(db, true, () =>
      handleEventsRoute(new Request('http://x/api/v1/_events'), {
        authMiddleware: allowAuth,
        db,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(
      /^retry: \d+\nid: resync\nevent: unavailable\n/,
    );
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });

  it('the reconnect after a response without a start opens at the head and resyncs first', async () => {
    // Committed while the client had no start: it must not depend on a frame.
    const missed = (await appendChange(db, {
      table: TABLE,
      rowId: 'while-without-start',
    })) as number;
    const response = await handleEventsRoute(
      new Request('http://x/api/v1/_events?since=0', {
        headers: { 'Last-Event-ID': 'resync' },
      }),
      { authMiddleware: allowAuth, db },
    );
    expect(response.status).toBe(200);
    const body = response.body as ReadableStream<Uint8Array>;
    const opening = await readUntil(
      body,
      (t) => t.includes('event: resync'),
      1000,
    );
    const seq = (await appendChange(db, {
      table: TABLE,
      rowId: 'after-start',
    })) as number;
    publishChangeSignal(db, {
      table: TABLE,
      operation: 'update',
      rowId: 'after-start',
      tenantId: null,
      seq,
    });
    const text = await readUntil(body, (t) => t.includes('after-start'));
    await body.cancel().catch(() => {});
    expect(
      opening.startsWith(
        // One block: the start and the resync dispatch together or not at
        // all, so a drop after it never leaves an un-resynced numeric resume.
        `retry: 3000\nid: ${missed}\nevent: resync\ndata: {}\n\n`,
      ),
      opening,
    ).toBe(true);
    expect(opening + text).not.toContain('while-without-start');
    expect(changeIds(opening + text)).toEqual([seq]);
  });

  it('a numeric Last-Event-ID resumes without a resync', async () => {
    const response = await handleEventsRoute(
      new Request('http://x/api/v1/_events', {
        headers: { 'Last-Event-ID': '1' },
      }),
      { authMiddleware: allowAuth, db },
    );
    const body = response.body as ReadableStream<Uint8Array>;
    const text = await readUntil(body, () => false, 300);
    await body.cancel().catch(() => {});
    expect(text.startsWith('retry: 3000\nid: 1\n\n')).toBe(true);
    expect(text).not.toContain('event: resync');
  });

  it('a request with an explicit cursor inside a framework transaction still opens its stream', async () => {
    const response = await withEmbeddedWriteTransaction(db, true, () =>
      handleEventsRoute(
        new Request('http://x/api/v1/_events', {
          headers: { 'Last-Event-ID': '1' },
        }),
        { authMiddleware: allowAuth, db },
      ),
    );
    expect(response.status).toBe(200);
    const body = response.body as ReadableStream<Uint8Array>;
    const text = await readUntil(body, (t) => t.includes('retry:'), 1000);
    await body.cancel().catch(() => {});
    expect(text.startsWith('retry: 3000\nid: 1\n\n')).toBe(true);
    await waitUntil(() => changeSignalSubscriberCount(db) === 0);
  });

  it('releases the slot when a request is aborted while its start waits', async () => {
    const held = await holdWriteTransaction(db);
    const client = new AbortController();
    const pending = handleEventsRoute(
      new Request('http://x/api/v1/_events', { signal: client.signal }),
      { authMiddleware: allowAuth, db },
    );
    await waitUntil(() => changeSignalSubscriberCount(db) === 1);
    client.abort();
    await held.release();
    await pending;
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });

  it('a directly built live-forward stream whose head sample fails errors and releases everything', async () => {
    const release = tryReserveChangeEventSubscriberSlot(db) as () => void;
    expect(changeSignalSubscriberCount(db)).toBe(1);
    failStatementsWhile(db, () => true);
    const stream = buildChangeEventStream(db, {
      cursor: null,
      tenantScope: UNENFORCED,
      releaseSubscriberSlot: release,
    });
    await expect(stream.getReader().read()).rejects.toThrow(
      'statement timeout',
    );
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });
});

describe('_events over the Node server: a client gone before the response (#5291)', () => {
  let db: DatabaseInterface;
  const allowAuth =
    () =>
    async (req: Request): Promise<Request | Response> =>
      req;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await ensureChangeFeedTable(db);
  });

  afterEach(async () => {
    resetChangeSignals();
    await db.close?.();
  });

  it('releases the subscription of a client that disconnects while its start waits for a transaction', async () => {
    const generator = new APIGenerator(
      {
        basePath: '/api/v1',
        authMiddleware: allowAuth,
        port: 0,
        hostname: '127.0.0.1',
      },
      { db },
    );
    const { server } = generator.createServer();
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const held = await holdWriteTransaction(db);
      const req = http.get({
        host: '127.0.0.1',
        port,
        path: '/api/v1/_events',
      });
      req.on('error', () => {});
      // The route holds its slot and waits for the transaction.
      await waitUntil(() => changeSignalSubscriberCount(db) === 1);
      req.destroy();
      // Let the server observe the closed socket before the start resolves.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await held.release();
      await waitUntil(() => changeSignalSubscriberCount(db) === 0);
      // Nothing re-subscribes later.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(changeSignalSubscriberCount(db)).toBe(0);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
