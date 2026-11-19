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
import {
  changeSignalSubscriberCount,
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
