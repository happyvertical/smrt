/**
 * `_events` resource bounds: an unread connection stops reading the feed
 * instead of buffering every live write, one principal cannot take every
 * subscriber slot, streams end after a bounded lifetime so the client
 * re-authenticates, and no timer outlives a cancelled stream.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChange,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { setChangeFeedAuthorizer } from '../change-feed-authz';
import {
  changeSignalSubscriberCount,
  publishChangeSignal,
  resetChangeSignals,
} from '../change-signals';
import {
  buildChangeEventStream,
  changeEventPrincipalSlotKeys,
  DEFAULT_EVENTS_MAX_SUBSCRIBERS_PER_PRINCIPAL,
  handleEventsRoute,
  resetChangeEventPrincipalSlots,
  resolveChangeEventPrincipalKey,
} from '../generators/events-route';
import { getTestDatabase } from '../testing/database';
import { sha256Hex } from '../utils/sha256';

const TABLE = 'backpressure_items';
const UNENFORCED = { enforced: false, tenantId: null } as const;

const allowAuth =
  () =>
  async (req: Request): Promise<Request | Response> =>
    req;

function changeIds(text: string): number[] {
  const ids: number[] = [];
  for (const block of text.split('\n\n')) {
    const match = /^id: (\d+)\nevent: change/m.exec(block);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

async function appendAndSignal(db: DatabaseInterface, rowId: string) {
  const seq = (await appendChange(db, { table: TABLE, rowId })) as number;
  publishChangeSignal(db, {
    table: TABLE,
    operation: 'update',
    rowId,
    tenantId: null,
    seq,
  });
  return seq;
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('_events resource bounds', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    resetChangeEventPrincipalSlots();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await appendChange(db, { table: TABLE, rowId: 'seed' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setChangeFeedAuthorizer(undefined);
    resetChangeSignals();
    resetChangeEventPrincipalSlots();
    await db.close?.();
  });

  it('stops reading for a client that is not draining, then delivers everything in order once it does', async () => {
    const enqueue = vi.spyOn(
      ReadableStreamDefaultController.prototype,
      'enqueue',
    );
    const stream = buildChangeEventStream(db, {
      cursor: null,
      tenantScope: UNENFORCED,
    });
    const reader = stream.getReader();
    await reader.read(); // retry preamble; the client then stops reading
    await settle();

    const written: number[] = [];
    for (let index = 0; index < 1500; index++) {
      written.push(await appendAndSignal(db, `row-${index}`));
    }
    await settle(100);
    // One page (500 rows) plus the high-water mark at most — never one
    // frame per write.
    expect(enqueue.mock.calls.length).toBeLessThan(600);

    const decoder = new TextDecoder();
    let text = '';
    while (changeIds(text).length < written.length) {
      const result = await Promise.race([
        reader.read(),
        settle(2000).then(() => 'timeout' as const),
      ]);
      if (result === 'timeout' || result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    await reader.cancel();
    expect(changeIds(text)).toEqual(written);
  });

  it('caps concurrent streams per principal while others can still subscribe', async () => {
    const open = (authorization: string) =>
      handleEventsRoute(
        new Request('http://x/api/v1/_events', {
          headers: { Authorization: authorization },
        }),
        { authMiddleware: allowAuth, db },
      );

    const held: Response[] = [];
    for (
      let index = 0;
      index < DEFAULT_EVENTS_MAX_SUBSCRIBERS_PER_PRINCIPAL;
      index++
    ) {
      const res = await open('Bearer alice');
      expect(res.status).toBe(200);
      held.push(res);
    }
    const overCap = await open('Bearer alice');
    expect(overCap.status).toBe(503);
    expect(overCap.headers.get('Retry-After')).toBeTruthy();

    const other = await open('Bearer bob');
    expect(other.status).toBe(200);

    // Closing one of alice's streams frees one of her slots.
    await held[0].body?.cancel();
    const reopened = await open('Bearer alice');
    expect(reopened.status).toBe(200);

    for (const res of [...held.slice(1), other, reopened]) {
      await res.body?.cancel();
    }
    await settle();
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });

  it('identifies the principal from locals before request credentials', () => {
    const request = new Request('http://x', {
      headers: { Authorization: 'Bearer token', Cookie: 'sid=abc' },
    });
    expect(
      resolveChangeEventPrincipalKey({
        locals: { user: { id: 'u1' } },
        request,
      }),
    ).toBe('user:u1');
    expect(
      resolveChangeEventPrincipalKey({
        locals: { session: { userId: 'u2' } },
        request,
      }),
    ).toBe('session:u2');
    expect(resolveChangeEventPrincipalKey({ request })).toBe(
      `authorization:${sha256Hex('Bearer token')}`,
    );
    expect(
      resolveChangeEventPrincipalKey({
        request: new Request('http://x', { headers: { Cookie: 'sid=abc' } }),
      }),
    ).toBe(`cookie:${sha256Hex('sid=abc')}`);
    expect(
      resolveChangeEventPrincipalKey({ request: new Request('http://x') }),
    ).toBeNull();
  });

  it('tracks header-identified principals by digest, never by the raw credential', async () => {
    const authorization = 'Bearer raw-credential-value';
    const cookie = 'sid=raw-cookie-value';
    const byHeader = await handleEventsRoute(
      new Request('http://x/api/v1/_events', {
        headers: { Authorization: authorization },
      }),
      { authMiddleware: allowAuth, db },
    );
    const byCookie = await handleEventsRoute(
      new Request('http://x/api/v1/_events', { headers: { Cookie: cookie } }),
      { authMiddleware: allowAuth, db },
    );
    const keys = changeEventPrincipalSlotKeys();
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).not.toContain('raw-credential-value');
      expect(key).not.toContain('raw-cookie-value');
    }
    expect(keys.some((key) => key.endsWith(sha256Hex(authorization)))).toBe(
      true,
    );
    expect(keys.some((key) => key.endsWith(sha256Hex(cookie)))).toBe(true);
    await byHeader.body?.cancel();
    await byCookie.body?.cancel();
    expect(changeEventPrincipalSlotKeys()).toEqual([]);
  });

  it('ends a stream after its maximum lifetime and releases its subscription', async () => {
    const stream = buildChangeEventStream(db, {
      cursor: null,
      tenantScope: UNENFORCED,
      maxConnectionMs: 60,
    });
    const reader = stream.getReader();
    let done = false;
    const deadline = Date.now() + 2000;
    while (!done && Date.now() < deadline) {
      done = (await reader.read()).done;
    }
    expect(done).toBe(true);
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });

  it('installs no timer for a stream cancelled while it is still starting', async () => {
    let resolveAuthorization: (tables: string[]) => void = () => {};
    setChangeFeedAuthorizer(
      () =>
        new Promise<string[]>((resolve) => {
          resolveAuthorization = resolve;
        }),
    );
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const stream = buildChangeEventStream(db, {
      cursor: 0,
      tenantScope: UNENFORCED,
    });
    await settle();
    await stream.cancel();
    const timeoutsBefore = setTimeoutSpy.mock.calls.length;
    resolveAuthorization([TABLE]);
    await Promise.resolve();
    await Promise.resolve();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    // No lifetime or retry timer was armed after the cancel either.
    expect(setTimeoutSpy.mock.calls.length).toBe(timeoutsBefore);
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });
});
