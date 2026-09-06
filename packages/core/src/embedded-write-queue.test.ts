/**
 * Unit tests for the in-process embedded write-queue's serialization
 * identity (#2707).
 *
 * `queueKey()` used to derive the queue identity from the literal `.url`
 * string whenever it was a non-empty string. `resolveDuckDBUrl(':memory:')`
 * (in `@happyvertical/sql`) returns `':memory:'` unchanged with no
 * per-instance suffix, so every independent `:memory:` database handle in
 * one process shared the SAME queue key -- unrelated in-memory test
 * databases serialized their writes against each other, contradicting
 * `getTestDatabase()`'s doc claim of being "safe for parallel test
 * execution". A `cache=shared` URL is the opposite case: it is SQLite's own
 * mechanism for making an in-memory database genuinely shared state across
 * connections, so it must keep serializing.
 *
 * These tests exercise `withEmbeddedWriteQueue()` (the public surface)
 * rather than the private `queueKey()`/`isPerConnectionMemoryUrl()`
 * helpers directly, using ordering rather than a fixed number of
 * microtask-tick waits so they aren't sensitive to internal `Promise`
 * chaining depth.
 */

import { describe, expect, it } from 'vitest';
import { withEmbeddedWriteQueue } from './embedded-write-queue';

/** A minimal deferred promise for controlling operation completion order. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('withEmbeddedWriteQueue', () => {
  it('does not serialize two independent `:memory:` instances', async () => {
    const dbA = { url: ':memory:' };
    const dbB = { url: ':memory:' };
    const gate = deferred();
    const order: string[] = [];

    const opA = withEmbeddedWriteQueue(dbA, true, async () => {
      order.push('A-start');
      await gate.promise;
      order.push('A-end');
    });

    const opB = withEmbeddedWriteQueue(dbB, true, async () => {
      order.push('B');
    });

    // If dbA and dbB shared a queue key, opB would be queued behind opA's
    // still-pending operation and this await would hang until gate.resolve()
    // -- it must settle on its own, with A still pending, because the two
    // instances are unrelated.
    await opB;
    expect(order).toEqual(['A-start', 'B']);

    gate.resolve();
    await opA;
    expect(order).toEqual(['A-start', 'B', 'A-end']);
  });

  it('serializes two instances sharing a `cache=shared` URL', async () => {
    const url = 'file::memory:?cache=shared';
    const dbA = { url };
    const dbB = { url };
    const gate = deferred();
    const order: string[] = [];

    const opA = withEmbeddedWriteQueue(dbA, true, async () => {
      order.push('A-start');
      await gate.promise;
      order.push('A-end');
    });
    const opB = withEmbeddedWriteQueue(dbB, true, async () => {
      order.push('B');
    });

    // dbA and dbB carry the identical cache=shared URL, so opB must queue
    // behind opA and only run once gate resolves and opA settles.
    gate.resolve();
    await Promise.all([opA, opB]);

    expect(order).toEqual(['A-start', 'A-end', 'B']);
  });

  it('serializes two instances sharing a file-backed URL', async () => {
    const url = '/tmp/embedded-write-queue-test.db';
    const dbA = { url };
    const dbB = { url };
    const gate = deferred();
    const order: string[] = [];

    const opA = withEmbeddedWriteQueue(dbA, true, async () => {
      order.push('A-start');
      await gate.promise;
      order.push('A-end');
    });
    const opB = withEmbeddedWriteQueue(dbB, true, async () => {
      order.push('B');
    });

    gate.resolve();
    await Promise.all([opA, opB]);

    expect(order).toEqual(['A-start', 'A-end', 'B']);
  });

  it('treats a bare `file::memory:` URL (no query string) as per-instance', async () => {
    const dbA = { url: 'file::memory:' };
    const dbB = { url: 'file::memory:' };
    const gate = deferred();

    const opA = withEmbeddedWriteQueue(dbA, true, () => gate.promise);
    let bCompleted = false;
    const opB = withEmbeddedWriteQueue(dbB, true, async () => {
      bCompleted = true;
    });

    await opB;
    expect(bCompleted).toBe(true);

    gate.resolve();
    await opA;
  });
});
