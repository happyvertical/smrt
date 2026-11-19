/**
 * A transaction callback that opens an `_events` stream on the same embedded
 * database and awaits its first change frame.
 *
 * The stream's feed reads wait in the database's write queue, which the
 * transaction holds until its callback returns — so a callback awaiting a
 * frame that needs such a read can never be served. The stream refuses to
 * start there with a clear error instead of hanging the transaction and
 * every writer queued behind it.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { setChangeFeedAuthorizer } from '../change-feed-authz';
import {
  changeSignalSubscriberCount,
  publishChangeSignal,
  resetChangeSignals,
} from '../change-signals';
import { withEmbeddedWriteTransaction } from '../embedded-write-queue';
import { buildChangeEventStream } from '../generators/events-route';
import { getTestDatabase } from '../testing/database';

const TABLE = 'inside_transaction_items';

describe('an _events stream awaited inside a framework transaction', () => {
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
    await appendChange(db, { table: TABLE, rowId: 'committed' });
  });

  afterEach(async () => {
    resetChangeSignals();
    await db.close?.();
  });

  it('settles promptly instead of deadlocking the transaction', async () => {
    const outcome = await Promise.race([
      withEmbeddedWriteTransaction(db, true, async () => {
        const stream = buildChangeEventStream(db, {
          cursor: 0,
          tenantScope: { enforced: false, tenantId: null },
        });
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let text = '';
        try {
          while (!text.includes('event: change')) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
          return 'framed';
        } catch (error) {
          return `rejected: ${(error as Error).message}`;
        } finally {
          await reader.cancel().catch(() => {});
        }
      }),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('deadlocked'), 3000),
      ),
    ]);
    expect(outcome).not.toBe('deadlocked');
    expect(outcome).toMatch(/^rejected: .*write transaction/);
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });

  it('serves a stream started by a callback scheduled inside the transaction but run after it committed', async () => {
    let started: Promise<string> | undefined;
    await withEmbeddedWriteTransaction(db, true, async () => {
      // The timer inherits the transaction's async context, but fires after
      // the transaction has finished.
      started = new Promise<string>((resolve) => {
        setTimeout(async () => {
          try {
            const stream = buildChangeEventStream(db, {
              cursor: 0,
              tenantScope: { enforced: false, tenantId: null },
            });
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            let text = '';
            while (!text.includes('event: change')) {
              const { value, done } = await reader.read();
              if (done) break;
              text += decoder.decode(value, { stream: true });
            }
            await reader.cancel();
            resolve(text);
          } catch (error) {
            resolve(`rejected: ${(error as Error).message}`);
          }
        }, 30);
      });
    });
    expect(await started).toContain('"rowId":"committed"');
  });

  it('serves a stream built inside the transaction and read after it committed', async () => {
    const stream = await withEmbeddedWriteTransaction(db, true, async () =>
      buildChangeEventStream(db, {
        cursor: 0,
        tenantScope: { enforced: false, tenantId: null },
      }),
    );
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: change')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(text).toContain('"rowId":"committed"');
  });

  it('never frames a row rolled back by the transaction whose handle built the stream', async () => {
    let stream: ReadableStream<Uint8Array> | undefined;
    await expect(
      withEmbeddedWriteTransaction(db, true, async (tx) => {
        await appendChange(tx, { table: TABLE, rowId: 'rolled-back' });
        stream = buildChangeEventStream(tx, {
          cursor: 0,
          tenantScope: { enforced: false, tenantId: null },
        });
        // Give the stream's first read every chance to run before rollback.
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    // A committed change now takes the sequence the rollback freed.
    const seq = (await appendChange(db, {
      table: TABLE,
      rowId: 'real',
    })) as number;
    publishChangeSignal(db, {
      table: TABLE,
      operation: 'update',
      rowId: 'real',
      tenantId: null,
      seq,
    });
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 3000;
    while (!text.includes('"rowId":"real"') && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 300),
        ),
      ]);
      if (result === 'timeout') continue;
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    await reader.cancel();
    expect(text).not.toContain('"rowId":"rolled-back"');
    expect(text).toContain('"rowId":"committed"');
    expect(text).toContain(`id: ${seq}\nevent: change`);
    expect(text).toContain('"rowId":"real"');
  });

  it('still serves a stream opened outside any transaction', async () => {
    const stream = buildChangeEventStream(db, {
      cursor: 0,
      tenantScope: { enforced: false, tenantId: null },
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: change')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(text).toContain('"rowId":"committed"');
  });
});

describe('reads from a callback whose transaction has ended, while another is open', () => {
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
  });

  afterEach(async () => {
    resetChangeSignals();
    await db.close?.();
  });

  /**
   * Run `late` from a timer created inside transaction A, firing while a
   * second transaction B holds an uncommitted feed row and then rolls back.
   */
  async function lateCallbackDuringRolledBackTransaction<T>(
    late: () => Promise<T>,
  ): Promise<T> {
    let releaseB: () => void = () => {};
    const bOpen = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let lateResult: Promise<T> | undefined;
    let bStarted: () => void = () => {};
    const bHasRow = new Promise<void>((resolve) => {
      bStarted = resolve;
    });
    await withEmbeddedWriteTransaction(db, true, async () => {
      setTimeout(() => {
        lateResult = bHasRow.then(late);
      }, 10);
    });
    const b = withEmbeddedWriteTransaction(db, true, async (tx) => {
      await appendChange(tx, { table: TABLE, rowId: 'uncommitted-in-b' });
      bStarted();
      await bOpen;
      throw new Error('roll back');
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    releaseB();
    await expect(b).rejects.toThrow('roll back');
    return (await lateResult) as T;
  }

  it('a direct read waits for the open transaction and never returns its rolled-back row', async () => {
    const seqs = await lateCallbackDuringRolledBackTransaction(async () =>
      (await getChangesSince(db, { since: 0 })).changes.map((c) => c.rowId),
    );
    expect(seqs).toEqual([]);
  });

  it('a live-forward stream started there frames the committed change that reuses the sequence', async () => {
    // Hold the stream's first feed read until the real write has committed,
    // so its starting cursor alone decides whether that write is framed.
    let authorize: (tables: string[]) => void = () => {};
    setChangeFeedAuthorizer(
      () =>
        new Promise<string[]>((resolve) => {
          authorize = resolve;
        }),
    );
    const stream = await lateCallbackDuringRolledBackTransaction(async () =>
      buildChangeEventStream(db, {
        cursor: null,
        tenantScope: { enforced: false, tenantId: null },
      }),
    );
    // Let its head read settle after B's rollback, then commit the real row.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const seq = (await appendChange(db, {
      table: TABLE,
      rowId: 'real',
    })) as number;
    publishChangeSignal(db, {
      table: TABLE,
      operation: 'update',
      rowId: 'real',
      tenantId: null,
      seq,
    });
    authorize([TABLE]);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 3000;
    while (!text.includes('"rowId":"real"') && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 300),
        ),
      ]);
      if (result === 'timeout' || result.done) continue;
      text += decoder.decode(result.value, { stream: true });
    }
    await reader.cancel();
    setChangeFeedAuthorizer(undefined);
    expect(text).not.toContain('event: resync');
    expect(text).toContain('id: 1\nevent: change');
    expect(text).toContain('"rowId":"real"');
  });
});

describe('an _events stream built from a PostgreSQL framework transaction handle', () => {
  // A PostgreSQL root is a pool: the session settings of the transaction's
  // connection (search_path, role) do not carry over to it, so the stream
  // cannot read through the root on that handle's behalf.
  function postgresRoot(): DatabaseInterface {
    const bound = {
      url: 'postgres://feed-host/feed',
      query: async () => [],
      many: async () => [],
      single: async () => null,
    };
    return {
      url: 'postgres://feed-host/feed',
      query: async () => [],
      many: async () => [],
      single: async () => null,
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(bound),
    } as unknown as DatabaseInterface;
  }

  afterEach(() => {
    resetChangeSignals();
  });

  it("refuses to build the stream and releases the caller's subscriber slot", async () => {
    const root = postgresRoot();
    let released = 0;
    await expect(
      withEmbeddedWriteTransaction(root, false, async (tx) =>
        buildChangeEventStream(tx, {
          cursor: 0,
          tenantScope: { enforced: false, tenantId: null },
          releaseSubscriberSlot: () => {
            released++;
          },
        }),
      ),
    ).rejects.toThrow(/PostgreSQL framework transaction's handle/);
    expect(released).toBe(1);
    expect(changeSignalSubscriberCount(root)).toBe(0);
  });

  it('still builds a stream from the PostgreSQL root outside the transaction', async () => {
    const root = postgresRoot();
    const stream = buildChangeEventStream(root, {
      cursor: 0,
      tenantScope: { enforced: false, tenantId: null },
    });
    expect(changeSignalSubscriberCount(root)).toBe(1);
    await stream.cancel();
    expect(changeSignalSubscriberCount(root)).toBe(0);
  });
});
