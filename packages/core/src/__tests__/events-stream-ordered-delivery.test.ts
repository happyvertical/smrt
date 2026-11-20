/**
 * `_events` delivery order: every change frame comes from an ordered read of
 * the durable feed after the connection's own sent cursor, so the `id:` a
 * client resumes from always covers everything before it.
 *
 * Covers the shared `buildChangeEventStream` through the REST handler; the
 * generated SvelteKit route calls the same function (see
 * `vite-plugin/events-route.test.ts`).
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChange,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { publishChangeSignal, resetChangeSignals } from '../change-signals';
import { SmrtCollection } from '../collection';
import { resetCollectionCache } from '../collection-cache';
import {
  buildChangeEventStream,
  handleEventsRoute,
} from '../generators/events-route';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt()
class OrderedDeliveryWidget extends SmrtObject {
  name: string = '';
}
class OrderedDeliveryWidgetCollection extends SmrtCollection<OrderedDeliveryWidget> {
  static readonly _itemClass = OrderedDeliveryWidget;
}

const WIDGETS_TABLE = 'ordered_delivery_widgets';
const BACKLOG = 700;
const UNENFORCED = { enforced: false, tenantId: null } as const;

const allowAuth =
  () =>
  async (req: Request): Promise<Request | Response> =>
    req;

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
): Promise<{ text: string; done: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let done = false;
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
      if (result === 'timeout') break;
      if (result.done) {
        done = true;
        break;
      }
      text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return { text, done };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

describe('_events delivers changes in feed order from a per-connection cursor', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    resetCollectionCache();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['OrderedDeliveryWidget'],
    });
    for (let index = 1; index <= BACKLOG; index++) {
      await appendChange(db, {
        table: WIDGETS_TABLE,
        rowId: `backlog-${index}`,
      });
    }
  });

  afterEach(async () => {
    resetChangeSignals();
    resetCollectionCache();
    await db.close?.();
  });

  it('keeps a write made during a multi-page catch-up behind the backlog', async () => {
    const widgets = await OrderedDeliveryWidgetCollection.create({ db });
    const res = await handleEventsRoute(
      new Request('http://x/api/v1/_events', {
        headers: { 'Last-Event-ID': '10' },
      }),
      { authMiddleware: allowAuth, db },
    );
    const body = res.body as ReadableStream<Uint8Array>;
    const live = await widgets.create({ name: 'live' });
    const { text } = await readUntil(body, (t) => t.includes(String(live.id)));
    await body.cancel().catch(() => {});

    expect(changeIds(text)).toEqual(range(11, BACKLOG + 1));
  });

  it('a client resuming from any id it received misses nothing', async () => {
    const widgets = await OrderedDeliveryWidgetCollection.create({ db });
    const first = await handleEventsRoute(
      new Request('http://x/api/v1/_events', {
        headers: { 'Last-Event-ID': '10' },
      }),
      { authMiddleware: allowAuth, db },
    );
    const firstBody = first.body as ReadableStream<Uint8Array>;
    await widgets.create({ name: 'live' });
    const { text: firstText } = await readUntil(
      firstBody,
      (t) => changeIds(t).length >= 501,
    );
    await firstBody.cancel().catch(() => {});
    const received = changeIds(firstText);
    expect(received.length).toBeGreaterThanOrEqual(501);
    // The client drops the connection right after the first frame past one
    // catch-up page (500 rows) — where a write made during catch-up could
    // otherwise have been framed.
    const kept = received.slice(0, 501);
    const lastId = kept[kept.length - 1];

    const second = await handleEventsRoute(
      new Request('http://x/api/v1/_events', {
        headers: { 'Last-Event-ID': String(lastId) },
      }),
      { authMiddleware: allowAuth, db },
    );
    const secondBody = second.body as ReadableStream<Uint8Array>;
    const { text: secondText } = await readUntil(secondBody, (t) =>
      changeIds(t).includes(BACKLOG + 1),
    );
    await secondBody.cancel().catch(() => {});

    expect([...kept, ...changeIds(secondText)]).toEqual(range(11, BACKLOG + 1));
  });

  it('closes the stream instead of going live-only when a catch-up read fails', async () => {
    let failPageRead = true;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'query' && typeof value === 'function') {
          return async (sql: string, ...args: unknown[]) => {
            if (failPageRead && /ORDER BY seq ASC LIMIT/.test(sql)) {
              failPageRead = false;
              throw new Error('transient read failure');
            }
            return value.call(target, sql, ...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseInterface;

    const stream = buildChangeEventStream(flaky, {
      cursor: 10,
      tenantScope: UNENFORCED,
    });
    const seq = await appendChange(db, { table: WIDGETS_TABLE, rowId: 'live' });
    publishChangeSignal(flaky, {
      table: WIDGETS_TABLE,
      operation: 'update',
      rowId: 'live',
      tenantId: null,
      seq: seq as number,
    });
    const { text, done } = await readUntil(stream, () => false, 1000);

    expect(done).toBe(true);
    expect(changeIds(text)).toEqual([]);
  });

  it('treats a signal as a wake-up: nothing is framed without a feed row behind it', async () => {
    const stream = buildChangeEventStream(db, {
      cursor: null,
      tenantScope: UNENFORCED,
    });
    await readUntil(stream, (t) => t.includes('retry:'), 1000);
    publishChangeSignal(db, {
      table: WIDGETS_TABLE,
      operation: 'create',
      rowId: 'phantom',
      tenantId: null,
      seq: BACKLOG + 5,
    });
    const { text } = await readUntil(stream, () => false, 150);
    await stream.cancel().catch(() => {});
    expect(text).not.toContain('phantom');
  });

  it('never frames a sequence twice when its signal is repeated', async () => {
    const stream = buildChangeEventStream(db, {
      cursor: BACKLOG,
      tenantScope: UNENFORCED,
    });
    await readUntil(stream, (t) => t.includes('retry:'), 1000);
    const seq = (await appendChange(db, {
      table: WIDGETS_TABLE,
      rowId: 'once',
    })) as number;
    const sig = {
      table: WIDGETS_TABLE,
      operation: 'update' as const,
      rowId: 'once',
      tenantId: null,
      seq,
    };
    publishChangeSignal(db, sig);
    publishChangeSignal(db, sig);
    const { text: firstText } = await readUntil(stream, (t) =>
      t.includes('once'),
    );
    publishChangeSignal(db, sig);
    const { text: laterText } = await readUntil(stream, () => false, 150);
    await stream.cancel().catch(() => {});
    expect(changeIds(firstText + laterText)).toEqual([seq]);
  });

  it('delivers a change committed with no signal on the next idle heartbeat read', async () => {
    // Heartbeats are driven by hand; every other timer is real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let boundsReads = 0;
      const counted = new Proxy(db, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'query' && typeof value === 'function') {
            return async (sql: string, ...args: unknown[]) => {
              const result = await value.call(target, sql, ...args);
              if (/MAX\(seq\) AS horizon/.test(sql)) boundsReads++;
              return result;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as DatabaseInterface;
      const heartbeatMs = 60_000;
      const stream = buildChangeEventStream(counted, {
        cursor: null,
        tenantScope: UNENFORCED,
        heartbeatMs,
      });
      // The head read and the initial (empty) catch-up read are both done.
      const settledAt = Date.now() + 2000;
      while (boundsReads < 2 && Date.now() < settledAt) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(boundsReads).toBe(2);
      // As from another replica with no notification channel: no signal.
      const seq = (await appendChange(db, {
        table: WIDGETS_TABLE,
        rowId: 'unsignalled',
      })) as number;
      // No heartbeat yet: nothing reads the feed, so nothing is framed.
      const before = await readUntil(
        stream,
        (t) => t.includes('unsignalled'),
        150,
      );
      expect(before.text).not.toContain('unsignalled');
      vi.advanceTimersByTime(heartbeatMs);
      const { text } = await readUntil(stream, (t) =>
        t.includes('unsignalled'),
      );
      await stream.cancel().catch(() => {});
      expect(changeIds(text)).toEqual([seq]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('frames a signal that carries no feed sequence directly, without moving the resume id', async () => {
    const stream = buildChangeEventStream(db, {
      cursor: null,
      tenantScope: UNENFORCED,
    });
    await readUntil(stream, (t) => t.includes('retry:'), 1000);
    publishChangeSignal(db, {
      table: WIDGETS_TABLE,
      operation: 'update',
      rowId: 'signal-only',
      tenantId: null,
      seq: 0,
    });
    const { text } = await readUntil(stream, (t) => t.includes('signal-only'));
    await stream.cancel().catch(() => {});
    const frame = text
      .split('\n\n')
      .find((block) => block.includes('signal-only'));
    expect(frame).toBe(
      'event: change\ndata: {"table":"ordered_delivery_widgets","operation":"update","rowId":"signal-only","tenantId":null}',
    );
  });
});
