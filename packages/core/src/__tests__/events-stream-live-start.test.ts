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
import { buildChangeEventStream } from '../generators/events-route';
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
