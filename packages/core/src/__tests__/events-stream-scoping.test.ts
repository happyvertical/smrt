/**
 * `_events` connections stay inside their own scope: a signal with no feed
 * sequence is never framed before the connection's table authorization is
 * settled, a slow row hook cannot accumulate unbounded work for one
 * connection, and two per-connection in-memory databases never share a feed
 * page.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  allowAllChangeFeedTables,
  setChangeFeedAuthorizer,
  setChangeFeedEntryVisibility,
} from '../change-feed-authz';
import {
  changeSignalSubscriberCount,
  publishChangeSignal,
  resetChangeSignals,
  subscribeToChangeSignals,
} from '../change-signals';
import { withEmbeddedWriteTransaction } from '../embedded-write-queue';
import { buildChangeEventStream } from '../generators/events-route';
import { getTestDatabase } from '../testing/database';

const DENIED = 'scoping_denied';
const ALLOWED = 'scoping_allowed';
const UNENFORCED = { enforced: false, tenantId: null } as const;

async function readFor(
  stream: ReadableStream<Uint8Array>,
  until: (text: string) => boolean,
  ms = 1500,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  try {
    while (!until(text) && Date.now() < deadline) {
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

function unsequenced(table: string, rowId: string) {
  return { table, operation: 'update' as const, rowId, tenantId: null, seq: 0 };
}

describe('_events connection scoping', () => {
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
    await getChangesSince(db, { since: 0 });
    // The fixture tables belong to no registered model, which the default
    // table policy never serves (#5446); serve every table unless a case
    // registers its own authorizer.
    setChangeFeedAuthorizer(allowAllChangeFeedTables);
  });

  afterEach(async () => {
    setChangeFeedAuthorizer(undefined);
    setChangeFeedEntryVisibility(undefined);
    resetChangeSignals();
    await db.close?.();
  });

  it('frames no unsequenced signal while the table authorizer is still pending', async () => {
    let resolveAuthorization: (tables: string[]) => void = () => {};
    setChangeFeedAuthorizer(
      () =>
        new Promise<string[]>((resolve) => {
          resolveAuthorization = resolve;
        }),
    );
    const stream = buildChangeEventStream(db, {
      cursor: null,
      tenantScope: UNENFORCED,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Arrives while authorization is pending; the authorizer then denies it.
    publishChangeSignal(db, unsequenced(DENIED, 'early-denied'));
    resolveAuthorization([ALLOWED]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    publishChangeSignal(db, unsequenced(DENIED, 'late-denied'));
    publishChangeSignal(db, unsequenced(ALLOWED, 'late-allowed'));
    const text = await readFor(stream, (t) => t.includes('late-allowed'));
    await stream.cancel().catch(() => {});
    expect(text).not.toContain(DENIED);
    expect(text).toContain('late-allowed');
  });

  it('bounds outstanding row-hook checks and drops excess unsequenced signals before asking the hook', async () => {
    let calls = 0;
    // A hook that never answers: every check stays outstanding.
    setChangeFeedEntryVisibility(() => {
      calls++;
      return new Promise<boolean>(() => {});
    });
    const stream = buildChangeEventStream(db, {
      cursor: null,
      tenantScope: UNENFORCED,
    });
    await readFor(stream, (t) => t.includes('retry:'), 1000);
    for (let index = 0; index < 200; index++) {
      publishChangeSignal(db, unsequenced(ALLOWED, `signal-${index}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stream.cancel().catch(() => {});
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(16);
  });
});

describe('_events reads of two per-connection in-memory databases', () => {
  const handles: DatabaseInterface[] = [];

  beforeEach(() => {
    setChangeFeedAuthorizer(allowAllChangeFeedTables);
  });

  afterEach(async () => {
    setChangeFeedAuthorizer(undefined);
    resetChangeSignals();
    for (const handle of handles.splice(0)) await handle.close?.();
  });

  it('never serves one database a page read from the other', async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    // The same per-connection memory URL names two independent databases.
    const first = await getTestDatabase({
      type: 'sqlite',
      url: 'file::memory:',
      classes: [],
    });
    const second = await getTestDatabase({
      type: 'sqlite',
      url: 'file::memory:',
      classes: [],
    });
    handles.push(first, second);
    await getChangesSince(first, { since: 0 });
    await getChangesSince(second, { since: 0 });
    await appendChange(first, { table: ALLOWED, rowId: 'only-in-first' });
    await appendChange(second, { table: ALLOWED, rowId: 'only-in-second' });

    // Both catch-ups start together at the same cursor.
    const streamA = buildChangeEventStream(first, {
      cursor: 0,
      tenantScope: UNENFORCED,
    });
    const streamB = buildChangeEventStream(second, {
      cursor: 0,
      tenantScope: UNENFORCED,
    });
    const [textA, textB] = await Promise.all([
      readFor(streamA, (t) => t.includes('event: change')),
      readFor(streamB, (t) => t.includes('event: change')),
    ]);
    await streamA.cancel().catch(() => {});
    await streamB.cancel().catch(() => {});
    expect(textA).toContain('only-in-first');
    expect(textA).not.toContain('only-in-second');
    expect(textB).toContain('only-in-second');
    expect(textB).not.toContain('only-in-first');
  });
});

describe('_events signals and startup across databases and connections', () => {
  const handles: DatabaseInterface[] = [];

  beforeEach(() => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    setChangeFeedAuthorizer(allowAllChangeFeedTables);
  });

  afterEach(async () => {
    setChangeFeedAuthorizer(undefined);
    resetChangeSignals();
    for (const handle of handles.splice(0)) await handle.close?.();
  });

  async function open(url: string): Promise<DatabaseInterface> {
    const handle = await getTestDatabase({ type: 'sqlite', url, classes: [] });
    handles.push(handle);
    await getChangesSince(handle, { since: 0 });
    return handle;
  }

  it('delivers an unsequenced signal only to streams of the database it was published on', async () => {
    const first = await open('file::memory:');
    const second = await open('file::memory:');
    const streamA = buildChangeEventStream(first, {
      cursor: null,
      tenantScope: UNENFORCED,
    });
    const streamB = buildChangeEventStream(second, {
      cursor: null,
      tenantScope: UNENFORCED,
    });
    await Promise.all([
      readFor(streamA, (t) => t.includes('retry:'), 1000),
      readFor(streamB, (t) => t.includes('retry:'), 1000),
    ]);
    publishChangeSignal(first, unsequenced(ALLOWED, 'from-first'));
    const [textA, textB] = await Promise.all([
      readFor(streamA, (t) => t.includes('from-first'), 500),
      readFor(streamB, (t) => t.includes('from-first'), 300),
    ]);
    await streamA.cancel().catch(() => {});
    await streamB.cancel().catch(() => {});
    expect(textA).toContain('from-first');
    expect(textB).not.toContain('from-first');
  });

  it('delivers an unsequenced signal only to its own database when handles expose their URL through config', async () => {
    // Handles that carry their URL only as `config.url`.
    const configOnly = (handle: DatabaseInterface) =>
      new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'url') return undefined;
          if (prop === 'config')
            return { type: 'sqlite', url: 'file::memory:' };
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as DatabaseInterface;
    const first = configOnly(await open('file::memory:'));
    const second = configOnly(await open('file::memory:'));
    const streamA = buildChangeEventStream(first, {
      cursor: null,
      tenantScope: UNENFORCED,
    });
    const streamB = buildChangeEventStream(second, {
      cursor: null,
      tenantScope: UNENFORCED,
    });
    await Promise.all([
      readFor(streamA, (t) => t.includes('retry:'), 1000),
      readFor(streamB, (t) => t.includes('retry:'), 1000),
    ]);
    publishChangeSignal(first, unsequenced(ALLOWED, 'from-first'));
    const [textA, textB] = await Promise.all([
      readFor(streamA, (t) => t.includes('from-first'), 500),
      readFor(streamB, (t) => t.includes('from-first'), 300),
    ]);
    await streamA.cancel().catch(() => {});
    await streamB.cancel().catch(() => {});
    expect(textA).toContain('from-first');
    expect(textB).not.toContain('from-first');
  });

  it('keeps every signal on its own private database when handles expose their URL through config', async () => {
    const configOnly = (handle: DatabaseInterface) =>
      new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'url') return undefined;
          if (prop === 'config')
            return { type: 'sqlite', url: 'file::memory:' };
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as DatabaseInterface;
    const first = configOnly(await open('file::memory:'));
    const second = configOnly(await open('file::memory:'));
    const onFirst: string[] = [];
    const onSecond: string[] = [];
    const stopFirst = subscribeToChangeSignals(first, (signal) =>
      onFirst.push(String(signal.rowId)),
    );
    const stopSecond = subscribeToChangeSignals(second, (signal) =>
      onSecond.push(String(signal.rowId)),
    );
    publishChangeSignal(first, {
      table: ALLOWED,
      operation: 'update',
      rowId: 'sequenced-on-first',
      tenantId: null,
      seq: 1,
    });
    stopFirst();
    stopSecond();
    expect(onFirst).toEqual(['sequenced-on-first']);
    expect(onSecond).toEqual([]);
  });

  it('registers a callback once per handle however often it subscribes', async () => {
    const handle = await open('file::memory:');
    const seen: string[] = [];
    const callback = (signal: { rowId: string | null }) =>
      seen.push(String(signal.rowId));
    const stopFirst = subscribeToChangeSignals(handle, callback);
    const stopSecond = subscribeToChangeSignals(handle, callback);
    expect(changeSignalSubscriberCount(handle)).toBe(1);

    publishChangeSignal(handle, {
      table: ALLOWED,
      operation: 'update',
      rowId: 'sequenced',
      tenantId: null,
      seq: 1,
    });
    publishChangeSignal(handle, unsequenced(ALLOWED, 'unsequenced'));
    expect(seen).toEqual(['sequenced', 'unsequenced']);

    // Either unsubscribe function removes the one registration.
    stopSecond();
    expect(changeSignalSubscriberCount(handle)).toBe(0);
    publishChangeSignal(handle, unsequenced(ALLOWED, 'after-unsubscribe'));
    expect(seen).toEqual(['sequenced', 'unsequenced']);
    stopFirst();
    expect(changeSignalSubscriberCount(handle)).toBe(0);
  });

  it('delivers a write signalled after subscribing but before the head query samples it', async () => {
    const db = await open(':memory:');
    let delayHead = true;
    let headReached: () => void = () => {};
    const headSeen = new Promise<void>((resolve) => {
      headReached = resolve;
    });
    let releaseHead: () => void = () => {};
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    const gated = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'query' && typeof value === 'function') {
          return async (sql: string, ...args: unknown[]) => {
            if (delayHead && /MAX\(seq\) AS horizon/.test(sql)) {
              delayHead = false;
              headReached();
              await headGate;
            }
            return value.call(target, sql, ...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseInterface;
    const stream = buildChangeEventStream(gated, {
      cursor: null,
      tenantScope: UNENFORCED,
    });
    await headSeen;
    // Subscribed; the head query has not sampled MAX(seq) yet.
    const seq = (await appendChange(db, {
      table: ALLOWED,
      rowId: 'during-head',
    })) as number;
    publishChangeSignal(gated, {
      table: ALLOWED,
      operation: 'update',
      rowId: 'during-head',
      tenantId: null,
      seq,
    });
    releaseHead();
    const text = await readFor(stream, (t) => t.includes('during-head'));
    await stream.cancel().catch(() => {});
    expect(text).toContain(`id: ${seq}\nevent: change`);
  });

  it('leaves no queued feed read behind for clients that disconnect while a transaction holds the queue', async () => {
    const db = await open(':memory:');
    for (let index = 1; index <= 20; index++) {
      await appendChange(db, { table: ALLOWED, rowId: `r${index}` });
    }
    let feedReads = 0;
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'query' && typeof value === 'function') {
          return async (sql: string, ...args: unknown[]) => {
            if (/MAX\(seq\) AS horizon/.test(sql)) feedReads++;
            return value.call(target, sql, ...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseInterface;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = withEmbeddedWriteTransaction(
      counted,
      true,
      async () => {
        await held;
      },
    );
    // Churn: each client resumes from its own cursor, so no reads are shared,
    // and disconnects while its read waits behind the transaction.
    const streams = Array.from({ length: 20 }, (_, index) =>
      buildChangeEventStream(counted, {
        cursor: index,
        tenantScope: UNENFORCED,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await Promise.all(streams.map((stream) => stream.cancel()));
    const readsBeforeRelease = feedReads;
    release();
    await transaction;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(feedReads - readsBeforeRelease).toBe(0);
  });
});
