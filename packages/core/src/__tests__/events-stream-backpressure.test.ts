/**
 * `_events` resource bounds: an unread connection stops reading the feed
 * instead of buffering every live write, and no timer outlives a cancelled
 * stream.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChange,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  allowAllChangeFeedTables,
  setChangeFeedAuthorizer,
} from '../change-feed-authz';
import {
  changeSignalSubscriberCount,
  publishChangeSignal,
  resetChangeSignals,
} from '../change-signals';
import { buildChangeEventStream } from '../generators/events-route';
import { getTestDatabase } from '../testing/database';

const TABLE = 'backpressure_items';
const UNENFORCED = { enforced: false, tenantId: null } as const;

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
    // The fixture table belongs to no registered model, which the default
    // table policy never serves (#5446); this suite covers resource bounds.
    setChangeFeedAuthorizer(allowAllChangeFeedTables);
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
    // No retry timer was armed after the cancel either.
    expect(setTimeoutSpy.mock.calls.length).toBe(timeoutsBefore);
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });
});
